import SwiftUI
import WebKit

/// WKWebView wrapper that loads the OpenTask server URL.
///
/// Cookies persist via the default WKWebsiteDataStore — the user logs in
/// through the normal web login form and stays logged in across launches.
///
/// Pull-to-refresh: A UIRefreshControl is attached to the WKWebView's scroll
/// view so the user can swipe down to reload the page. WKWebView doesn't
/// natively support this — we add it manually and trigger webView.reload().
///
/// JavaScript bridge: Injects `window.__OPENTASK_IOS = true` so the web app
/// can detect it's running inside the native wrapper. Listens for messages
/// on `window.webkit.messageHandlers.opentask` to handle native actions
/// like disconnect.
///
/// Dynamic Type: WKWebView doesn't respect iOS Dynamic Type settings for web
/// content. We read the preferred content size category, map it to a CSS
/// font-size scale factor, and inject it as a root font-size override.
/// Tailwind's rem-based sizing scales the entire layout proportionally.
///
/// Session bootstrap: the web session cookie expires after 7 days but the
/// Keychain Bearer token does not, so a cold launch with a token in hand first
/// trades that token for a fresh session cookie (`SessionBootstrapper`) and
/// only then issues the initial load. See `makeUIView` for the sequencing and
/// `Coordinator.rescueFromLogin` for the mid-session equivalent.
struct WebView: UIViewRepresentable {
    let url: URL

    /// Called when a navigation error occurs — triggers the error fallback view.
    var onNavigationError: ((Error) -> Void)?

    func makeCoordinator() -> Coordinator {
        Coordinator(onNavigationError: onNavigationError)
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()

        // Allow inline media playback (avoids fullscreen for any embedded media)
        config.allowsInlineMediaPlayback = true

        // Inject __OPENTASK_IOS flag so the web app can detect the native wrapper
        let script = WKUserScript(
            source: "window.__OPENTASK_IOS = true;",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(script)

        // Inject Dynamic Type font scale as a CSS root font-size override.
        // Runs at document end so <html> exists. Persists across navigations
        // since it's added to the configuration's user content controller.
        let scale = Coordinator.fontScalePercent(for: UIApplication.shared.preferredContentSizeCategory)
        let dtScript = WKUserScript(
            source: "document.documentElement.style.fontSize = '\(scale)%';",
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(dtScript)

        // Inject APNs device token info so the web app can register it via session cookie.
        // This ensures push notifications follow the web-logged-in user, not the bearer token user.
        if let deviceToken = AppConfig.shared.deviceToken {
            let bundleId = Bundle.main.bundleIdentifier ?? "io.mcnitt.opentask"
            #if DEBUG
            let env = "development"
            #else
            let env = "production"
            #endif
            let tokenScript = WKUserScript(
                source: "window.__OPENTASK_DEVICE_INFO = { token: '\(deviceToken)', bundleId: '\(bundleId)', environment: '\(env)' };",
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
            config.userContentController.addUserScript(tokenScript)
        }

        // Tell the web app whether native has a Bearer token in Keychain, and
        // which token it is. Used by the auto-provisioning flow to decide
        // whether to create a new token, and by the web side to notice that
        // the stored token belongs to a *different* user than the one logged
        // in — the preview is the token's last 8 characters, matching the
        // `token_preview` column the server exposes for API tokens.
        let hasTokenScript = WKUserScript(
            source: Coordinator.tokenFlagsJS(),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(hasTokenScript)

        // Register JS bridge for native actions (disconnect, etc.)
        config.userContentController.add(context.coordinator, name: "opentask")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsLinkPreview = false
        webView.navigationDelegate = context.coordinator

        // Pull-to-refresh
        let refreshControl = UIRefreshControl()
        refreshControl.addTarget(
            context.coordinator,
            action: #selector(Coordinator.handleRefresh(_:)),
            for: .valueChanged
        )
        webView.scrollView.addSubview(refreshControl)
        context.coordinator.refreshControl = refreshControl

        // Observe cookie changes to flush to disk immediately (survives force-quit)
        config.websiteDataStore.httpCookieStore.add(context.coordinator)

        // Store references for live Dynamic Type updates
        context.coordinator.webView = webView
        context.coordinator.startObservingContentSize()

        // Check for pending deep link (cold launch from notification tap or quick action)
        let initialURL = WebViewManager.shared.consumePendingPath()
            .flatMap { URL(string: AppConfig.shared.serverURL + $0) } ?? url

        // Cold-launch gate. With a Bearer token in the Keychain, the session
        // bootstrap runs to completion BEFORE the first request leaves the app.
        // Two things depend on that ordering:
        //
        //   1. A session cookie that expired while the app sat unused is
        //      replaced silently, so a widget or notification tap opens the
        //      page it promised instead of /login.
        //   2. It closes a pre-existing race: WKWebsiteDataStore hydrates its
        //      cookies from disk asynchronously, and a load issued in the same
        //      turn as the web view's creation could go out unauthenticated.
        //
        // makeUIView cannot await, so the load is issued from a Task. Until it
        // fires, `WebViewManager.shared.webView` is deliberately left nil —
        // that is what makes a deep link arriving mid-bootstrap park itself in
        // pendingPath (the existing cold-launch path) rather than sneak out a
        // request ahead of the cookie. A native cover hides the unpainted web
        // view for the duration.
        guard SessionBootstrapper.hasCredentials else {
            WebViewManager.shared.webView = webView
            webView.load(URLRequest(url: initialURL))
            return webView
        }

        context.coordinator.showLoadingCover(over: webView)
        Task { @MainActor in
            await SessionBootstrapper.bootstrap()

            WebViewManager.shared.webView = webView

            // A deep link that landed during the bootstrap window wins over the
            // URL captured above — it is the newer intent.
            let loadURL = WebViewManager.shared.consumePendingPath()
                .flatMap { URL(string: AppConfig.shared.serverURL + $0) } ?? initialURL
            webView.load(URLRequest(url: loadURL))
        }

        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // No updates needed — URL doesn't change during the view's lifecycle.
        // Deliberately does not load: a load here would race ahead of the
        // cold-launch session bootstrap kicked off in makeUIView.
    }

    class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler, WKHTTPCookieStoreObserver {
        var refreshControl: UIRefreshControl?
        var onNavigationError: ((Error) -> Void)?
        weak var webView: WKWebView?
        private var contentSizeObserver: NSObjectProtocol?

        /// Native cover shown while the cold-launch session bootstrap runs.
        /// Without it the user stares at an unpainted WKWebView — white even in
        /// dark mode — for the length of a network round-trip. Torn down on the
        /// first navigation outcome, success or failure, so it can never strand
        /// the UI behind a spinner.
        private var loadingCover: UIView?

        /// Loop guard for the /login rescue: at most one bootstrap attempt per
        /// landing on the login page. Reset when any non-login page finishes,
        /// which is the only evidence that the rescue (or a manual login) took.
        private var loginRescueAttempted = false

        init(onNavigationError: ((Error) -> Void)?) {
            self.onNavigationError = onNavigationError
        }

        /// Flush cookies to disk whenever any cookie changes (e.g., after login).
        /// WKWebView doesn't guarantee immediate persistence — force-quit can lose
        /// in-memory cookies. getAllCookies triggers a sync to disk.
        func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
            cookieStore.getAllCookies { _ in }
        }

        deinit {
            if let observer = contentSizeObserver {
                NotificationCenter.default.removeObserver(observer)
            }
        }

        // MARK: - Dynamic Type

        /// Map iOS content size categories to CSS font-size percentages.
        /// Values approximate Apple's standard Dynamic Type scaling ratios.
        /// Default (Large) = 100%.
        static func fontScalePercent(for category: UIContentSizeCategory) -> Int {
            switch category {
            case .extraSmall:                               return 82
            case .small:                                    return 88
            case .medium:                                   return 94
            case .large:                                    return 100
            case .extraLarge:                               return 106
            case .extraExtraLarge:                           return 112
            case .extraExtraExtraLarge:                      return 119
            case .accessibilityMedium:                       return 125
            case .accessibilityLarge:                        return 131
            case .accessibilityExtraLarge:                   return 138
            case .accessibilityExtraExtraLarge:              return 144
            case .accessibilityExtraExtraExtraLarge:         return 150
            default:                                         return 100
            }
        }

        /// Listen for Dynamic Type changes and re-apply the font scale live.
        func startObservingContentSize() {
            contentSizeObserver = NotificationCenter.default.addObserver(
                forName: UIContentSizeCategory.didChangeNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.applyDynamicTypeScale()
            }
        }

        private func applyDynamicTypeScale() {
            let scale = Self.fontScalePercent(for: UIApplication.shared.preferredContentSizeCategory)
            let js = "document.documentElement.style.fontSize = '\(scale)%';"
            webView?.evaluateJavaScript(js)
        }

        // MARK: - Loading Cover

        /// Cover the web view with a native background + spinner. Pinned with
        /// constraints rather than a frame because `makeUIView` builds the web
        /// view at `.zero` and SwiftUI sizes it a layout pass later.
        func showLoadingCover(over webView: WKWebView) {
            guard loadingCover == nil else { return }

            let cover = UIView()
            cover.backgroundColor = .systemBackground
            cover.translatesAutoresizingMaskIntoConstraints = false

            let spinner = UIActivityIndicatorView(style: .large)
            spinner.color = .secondaryLabel
            spinner.translatesAutoresizingMaskIntoConstraints = false
            spinner.startAnimating()
            cover.addSubview(spinner)

            webView.addSubview(cover)
            NSLayoutConstraint.activate([
                cover.leadingAnchor.constraint(equalTo: webView.leadingAnchor),
                cover.trailingAnchor.constraint(equalTo: webView.trailingAnchor),
                cover.topAnchor.constraint(equalTo: webView.topAnchor),
                cover.bottomAnchor.constraint(equalTo: webView.bottomAnchor),
                spinner.centerXAnchor.constraint(equalTo: cover.centerXAnchor),
                spinner.centerYAnchor.constraint(equalTo: cover.centerYAnchor),
            ])

            loadingCover = cover
        }

        private func hideLoadingCover() {
            loadingCover?.removeFromSuperview()
            loadingCover = nil
        }

        // MARK: - Navigation

        @objc func handleRefresh(_ sender: UIRefreshControl) {
            guard let webView = sender.superview?.superview as? WKWebView else {
                sender.endRefreshing()
                return
            }
            webView.reload()
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            refreshControl?.endRefreshing()
            hideLoadingCover()
            injectDeviceInfo(into: webView)
            injectTokenFlags(into: webView)

            // Force WKWebView to flush cookies to disk so session survives force-quit.
            // WKWebView doesn't guarantee immediate persistence — getAllCookies triggers a sync.
            webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { _ in }

            if isLoginPage(webView.url) {
                rescueFromLogin(webView)
            } else {
                // Any page that isn't /login is proof the session is good again;
                // arm the rescue for the next time one expires.
                loginRescueAttempted = false
            }
        }

        /// The web session cookie outlives its usefulness after 7 days while the
        /// Keychain Bearer token does not, so landing on /login with a token in
        /// hand is a recoverable state, not a dead end: mint a new session and
        /// replay the path the user actually asked for.
        ///
        /// Exactly one attempt per landing. If the bootstrap fails — bad token,
        /// server down — the login page is left exactly as it is and the user
        /// signs in by hand. If it succeeds but the server bounces us back to
        /// /login anyway, the guard is still set, so there is no redirect loop.
        private func rescueFromLogin(_ webView: WKWebView) {
            guard !loginRescueAttempted, SessionBootstrapper.hasCredentials else { return }
            loginRescueAttempted = true

            Task { @MainActor in
                guard await SessionBootstrapper.bootstrap() else {
                    print("[OpenTask] /login rescue declined — leaving login page")
                    return
                }
                let path = WebViewManager.shared.lastRequestedPath
                print("[OpenTask] /login rescue succeeded — resuming \(path)")
                WebViewManager.shared.navigate(path: path)
            }
        }

        /// NextAuth's login route, whether or not it carries a `callbackUrl`
        /// query or a trailing slash.
        private func isLoginPage(_ url: URL?) -> Bool {
            guard var path = url?.path else { return false }
            if path.count > 1 && path.hasSuffix("/") { path.removeLast() }
            return path == "/login"
        }

        /// Inject device token info into the page after every navigation.
        /// The WKUserScript set at WebView creation may have missed the token
        /// (APNs responds async), so this ensures it's available after logout → login.
        private func injectDeviceInfo(into webView: WKWebView) {
            guard let token = AppConfig.shared.deviceToken else { return }
            let bundleId = Bundle.main.bundleIdentifier ?? "io.mcnitt.opentask"
            #if DEBUG
            let env = "development"
            #else
            let env = "production"
            #endif
            let js = "window.__OPENTASK_DEVICE_INFO = { token: '\(token)', bundleId: '\(bundleId)', environment: '\(env)' };"
            webView.evaluateJavaScript(js)
        }

        /// Re-inject the Keychain token flags after every navigation.
        ///
        /// Separate from `injectDeviceInfo` because that one returns early when
        /// APNs hasn't answered yet, and these flags have nothing to do with
        /// push: the document-start user script is a snapshot from web view
        /// creation, so without this a token provisioned mid-session (or wiped
        /// by a disconnect) would never be reflected in the page.
        private func injectTokenFlags(into webView: WKWebView) {
            webView.evaluateJavaScript(Self.tokenFlagsJS())
        }

        /// `window.__OPENTASK_HAS_TOKEN` / `window.__OPENTASK_TOKEN_PREVIEW`.
        ///
        /// The preview is the last 8 characters of the stored Bearer token —
        /// the same suffix the server keeps in `api_tokens.token_preview` — so
        /// the web app can tell that the native token belongs to a different
        /// user than the one whose session is loaded. `null` when there is no
        /// token; never the token itself.
        static func tokenFlagsJS() -> String {
            let token = KeychainHelper.read(key: "bearerToken")
            let preview = token.map { String($0.suffix(8)) }
            return """
                window.__OPENTASK_HAS_TOKEN = \(token != nil);
                window.__OPENTASK_TOKEN_PREVIEW = \(jsStringLiteral(preview));
                """
        }

        /// Render a Swift string as a JS single-quoted literal (or `null`).
        /// Token previews are opaque server-generated strings — escape rather
        /// than assume they are alphanumeric.
        static func jsStringLiteral(_ value: String?) -> String {
            guard let value else { return "null" }
            var escaped = ""
            for character in value.unicodeScalars {
                switch character {
                case "\\": escaped += "\\\\"
                case "'": escaped += "\\'"
                case "\n": escaped += "\\n"
                case "\r": escaped += "\\r"
                case "\u{2028}": escaped += "\\u2028"
                case "\u{2029}": escaped += "\\u2029"
                default: escaped.unicodeScalars.append(character)
                }
            }
            return "'\(escaped)'"
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            refreshControl?.endRefreshing()
            // Ignore cancelled navigations — happens when a quick action or deep link
            // navigation replaces an in-flight load. Not a real connectivity error.
            if (error as NSError).code == NSURLErrorCancelled { return }
            hideLoadingCover()
            onNavigationError?(error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            refreshControl?.endRefreshing()
            if (error as NSError).code == NSURLErrorCancelled { return }
            hideLoadingCover()
            onNavigationError?(error)
        }

        // MARK: - JavaScript Bridge

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard let body = message.body as? [String: Any],
                  let action = body["action"] as? String else { return }

            switch action {
            case "disconnect":
                Task {
                    await AppConfig.shared.disconnect()
                }
            case "provisionToken":
                if let token = body["token"] as? String, !token.isEmpty {
                    KeychainHelper.save(key: "bearerToken", value: token)
                    if let appDelegate = UIApplication.shared.delegate as? AppDelegate {
                        appDelegate.sendCredentialsToWatch()
                    }
                    print("[OpenTask] Bearer token provisioned via JS bridge")
                }
            default:
                print("[OpenTask] Unknown JS bridge action: \(action)")
            }
        }
    }
}
