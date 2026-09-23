import AppKit
import SwiftUI
import WebKit

/// The OpenTask PWA in a macOS WKWebView.
///
/// A native-macOS rewrite rather than a port of `ios/OpenTask/WebView.swift`:
/// three quarters of that file is iOS plumbing that has no macOS equivalent —
/// a `UIRefreshControl` bolted to the scroll view (⌘R and the page's own
/// refresh do the job here), the Dynamic Type → CSS `font-size` bridge (macOS
/// has no Dynamic Type), and `ignoresSafeArea` (no safe areas in a window).
/// What is kept is the part that is about the *server*, not the platform:
/// the session bootstrap and the /login rescue.
///
/// **Session bootstrap.** The PWA's NextAuth cookie expires after 7 days; the
/// Keychain Bearer token does not. A cold launch with a token in hand trades it
/// for a fresh cookie BEFORE the first request leaves the app, so a Mac window
/// left alone over a holiday opens on the dashboard instead of a login form.
/// Mid-session, `decidePolicyFor` catches a redirect to /login and does the
/// same thing without the user ever seeing the login page.
///
/// **JavaScript bridge.** `window.__OPENTASK_IOS` is injected here too. The
/// name is historical — the web app uses it to mean "running inside a native
/// wrapper" (it gates the Settings ▸ Disconnect button), and `src/` is not
/// this pass's to rename. `__OPENTASK_MAC` is injected alongside it for any
/// future check that genuinely needs to tell the two apart.
struct WebViewHost: NSViewRepresentable {
    let url: URL

    /// Called when a navigation fails — raises the native error view.
    var onNavigationError: ((Error) -> Void)?

    func makeCoordinator() -> Coordinator {
        Coordinator(onNavigationError: onNavigationError)
    }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()

        config.userContentController.addUserScript(
            WKUserScript(
                source: "window.__OPENTASK_IOS = true; window.__OPENTASK_MAC = true;",
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )

        // APNs token, if one has already arrived. The web app registers it with
        // the server under the session cookie, so push follows whoever is
        // logged in in this window rather than whoever owns the Bearer token.
        if let deviceToken = AppConfig.shared.deviceToken {
            config.userContentController.addUserScript(
                WKUserScript(
                    source: Coordinator.deviceInfoJS(token: deviceToken),
                    injectionTime: .atDocumentStart,
                    forMainFrameOnly: true
                )
            )
        }

        config.userContentController.addUserScript(
            WKUserScript(
                source: Coordinator.tokenFlagsJS(),
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )

        config.userContentController.add(context.coordinator, name: "opentask")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsMagnification = true
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        // Paints the window background behind and around the page instead of
        // white, so first paint and rubber-band overscroll don't flash in dark
        // mode.
        webView.underPageBackgroundColor = .windowBackgroundColor
        #if DEBUG
        // Lets Safari's Develop menu attach to the page. The iPhone app never
        // set this, which is why its web content cannot be inspected at all.
        webView.isInspectable = true
        #endif

        config.websiteDataStore.httpCookieStore.add(context.coordinator)
        context.coordinator.webView = webView

        WebViewManager.shared.onNewNavigationIntent = { [weak coordinator = context.coordinator] in
            coordinator?.newNavigationIntent()
        }

        let initialURL = WebViewManager.shared.consumePendingPath()
            .flatMap { URL(string: AppConfig.shared.serverURL + $0) } ?? url

        // Cold-launch gate, same ordering as the iPhone app: with a Bearer
        // token in the Keychain, the session bootstrap completes BEFORE the
        // first request goes out. `WebViewManager.shared.webView` is left nil
        // until then, so a notification tap arriving mid-bootstrap parks its
        // path instead of racing a request ahead of the cookie.
        guard SessionBootstrapper.hasCredentials else {
            WebViewManager.shared.webView = webView
            webView.load(URLRequest(url: initialURL))
            return webView
        }

        context.coordinator.showLoadingCover(over: webView)
        Task { @MainActor in
            await SessionBootstrapper.bootstrap()
            WebViewManager.shared.webView = webView

            // A tap that landed during the bootstrap window wins — it is the
            // newer intent.
            let loadURL = WebViewManager.shared.consumePendingPath()
                .flatMap { URL(string: AppConfig.shared.serverURL + $0) } ?? initialURL
            webView.load(URLRequest(url: loadURL))
        }

        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        // Deliberately empty. Loading here would race the cold-launch session
        // bootstrap started in makeNSView.
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate,
                             WKScriptMessageHandler, WKHTTPCookieStoreObserver {
        var onNavigationError: ((Error) -> Void)?
        weak var webView: WKWebView?

        /// Native cover shown while the cold-launch bootstrap runs, so the user
        /// sees the window background rather than an unpainted web view for the
        /// length of a round trip. Torn down on the first navigation outcome,
        /// success or failure, so it can never strand the UI behind a spinner.
        private var loadingCover: NSView?

        /// Loop guard for the /login rescue: at most one bootstrap attempt per
        /// navigation intent. Re-armed when any non-login page finishes (proof
        /// the session is good) and by every new externally-initiated
        /// navigation.
        private var loginRescueAttempted = false

        init(onNavigationError: ((Error) -> Void)?) {
            self.onNavigationError = onNavigationError
        }

        func newNavigationIntent() {
            loginRescueAttempted = false
        }

        // MARK: - Cookies

        /// WKWebView does not guarantee cookies reach disk; `getAllCookies`
        /// forces the sync, so a session survives a quit.
        func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
            cookieStore.getAllCookies { _ in }
        }

        // MARK: - Loading cover

        func showLoadingCover(over webView: WKWebView) {
            guard loadingCover == nil else { return }

            // NSVisualEffectView rather than a resolved background colour: it
            // tracks light/dark and the window's active state on its own.
            let cover = NSVisualEffectView()
            cover.material = .windowBackground
            cover.blendingMode = .withinWindow
            cover.state = .active
            cover.translatesAutoresizingMaskIntoConstraints = false

            let spinner = NSProgressIndicator()
            spinner.style = .spinning
            spinner.controlSize = .regular
            spinner.translatesAutoresizingMaskIntoConstraints = false
            spinner.startAnimation(nil)
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

        /// Two jobs, in order:
        ///
        /// 1. Anything that is not the configured server opens in the user's
        ///    real browser. A Mac window with no address bar and no tabs is a
        ///    dead end for an external link, and Safari is where the user's
        ///    other logins live.
        ///
        ///    Known edge: a server fronted by a proxy that redirects login to
        ///    an identity provider on a DIFFERENT host would be bounced out to
        ///    the browser here, where the iPhone app follows it in place. No
        ///    such deployment exists today (login is NextAuth on the same
        ///    origin); if one appears, allow the IdP host explicitly rather
        ///    than dropping the rule, which is what makes doc links work.
        /// 2. A redirect to /login with a Bearer token in hand is rescued
        ///    before the page renders, so the only thing on screen is the
        ///    loading cover rather than a login form that reads as "logged out
        ///    again".
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.allow)
                return
            }

            let serverHost = URL(string: AppConfig.shared.serverURL)?.host
            let isMainFrame = navigationAction.targetFrame?.isMainFrame != false

            if isMainFrame, url.host != nil, url.host != serverHost {
                decisionHandler(.cancel)
                NSWorkspace.shared.open(url)
                return
            }

            guard isMainFrame,
                  url.host == serverHost,
                  isLoginPage(url),
                  SessionBootstrapper.hasCredentials,
                  !loginRescueAttempted
            else {
                decisionHandler(.allow)
                return
            }

            loginRescueAttempted = true
            decisionHandler(.cancel)
            showLoadingCover(over: webView)
            let resume = Self.resumePath(fromLoginURL: url)
            Task { @MainActor in
                if await SessionBootstrapper.bootstrap() {
                    print("[OpenTask] /login intercepted — session re-minted, resuming \(resume)")
                    // rearmRescue: false — replaying the destination must not
                    // reset the guard, or a server that keeps bouncing would
                    // loop bootstrap attempts forever.
                    WebViewManager.shared.navigate(path: resume, rearmRescue: false)
                } else {
                    print("[OpenTask] /login intercept: bootstrap failed — showing login page")
                    hideLoadingCover()
                    webView.load(URLRequest(url: url))
                }
            }
        }

        /// `target="_blank"` has nowhere to go in a single-window app: WebKit
        /// asks for a new web view and silently drops the navigation if it
        /// gets nil. Hand those to the browser instead.
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if let url = navigationAction.request.url {
                NSWorkspace.shared.open(url)
            }
            return nil
        }

        /// Destination to resume after a rescued /login bounce: the login URL's
        /// own callbackUrl when present, falling back to the last path the app
        /// asked for. Same-origin relative paths only.
        static func resumePath(fromLoginURL url: URL) -> String {
            if let cb = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "callbackUrl" })?.value,
                cb.hasPrefix("/"), !cb.hasPrefix("//") {
                return cb
            }
            return WebViewManager.shared.lastRequestedPath
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            print("[OpenTask] Loaded \(webView.url?.absoluteString ?? "(no URL)")")
            hideLoadingCover()
            injectDeviceInfo(into: webView)
            injectTokenFlags(into: webView)
            webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { _ in }

            if isLoginPage(webView.url) {
                rescueFromLogin(webView)
            } else {
                loginRescueAttempted = false
            }
        }

        /// Landing on /login with a Bearer token in hand is recoverable, not a
        /// dead end: mint a new session and replay the path the user asked for.
        /// Exactly one attempt per landing, so a server that keeps bouncing
        /// cannot loop.
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
                WebViewManager.shared.navigate(path: path, rearmRescue: false)
            }
        }

        /// NextAuth's login route, with or without a `callbackUrl` query or a
        /// trailing slash.
        private func isLoginPage(_ url: URL?) -> Bool {
            guard var path = url?.path else { return false }
            if path.count > 1 && path.hasSuffix("/") { path.removeLast() }
            return path == "/login"
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            handleNavigationFailure(error)
        }

        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            handleNavigationFailure(error)
        }

        private func handleNavigationFailure(_ error: Error) {
            // A cancelled navigation is a load being replaced by a newer one
            // (menu command, notification tap), not a connectivity problem.
            if (error as NSError).code == NSURLErrorCancelled { return }
            print("[OpenTask] Navigation failed: \(error.localizedDescription)")
            hideLoadingCover()
            onNavigationError?(error)
        }

        // MARK: - JavaScript injection

        static func deviceInfoJS(token: String) -> String {
            let bundleId = Bundle.main.bundleIdentifier ?? "io.mcnitt.opentask.mac"
            // Follows the signing entitlement, not the build configuration:
            // `com.apple.developer.aps-environment` is `development` in
            // project.yml for every build, and the app is installed as a
            // Release build. `#if DEBUG` registered it as "production", so
            // every push to the Mac was rejected and its token deleted.
            let environment = "development"
            return "window.__OPENTASK_DEVICE_INFO = { token: '\(token)', "
                + "bundleId: '\(bundleId)', environment: '\(environment)' };"
        }

        /// Re-inject after every navigation: the document-start user script is
        /// a snapshot from web-view creation, and APNs usually answers after
        /// that.
        private func injectDeviceInfo(into webView: WKWebView) {
            guard let token = AppConfig.shared.deviceToken else { return }
            webView.evaluateJavaScript(Self.deviceInfoJS(token: token))
        }

        private func injectTokenFlags(into webView: WKWebView) {
            webView.evaluateJavaScript(Self.tokenFlagsJS())
        }

        /// `window.__OPENTASK_HAS_TOKEN` / `window.__OPENTASK_TOKEN_PREVIEW`.
        ///
        /// The preview is the last 8 characters of the stored Bearer token —
        /// the same suffix the server keeps in `api_tokens.token_preview` — so
        /// the web app can tell that the native token belongs to a different
        /// user than the one whose session is loaded. Never the token itself.
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

        // MARK: - JavaScript bridge

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard let body = message.body as? [String: Any],
                  let action = body["action"] as? String else { return }

            switch action {
            case "disconnect":
                Task { await AppConfig.shared.disconnect() }
            case "provisionToken":
                if let token = body["token"] as? String, !token.isEmpty {
                    KeychainHelper.save(key: "bearerToken", value: token)
                    print("[OpenTask] Bearer token provisioned via JS bridge")
                }
            default:
                print("[OpenTask] Unknown JS bridge action: \(action)")
            }
        }
    }
}
