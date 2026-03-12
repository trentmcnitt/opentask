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

        // Tell the web app whether native has a Bearer token in Keychain.
        // Used by the auto-provisioning flow to decide whether to create a new token.
        let hasToken = KeychainHelper.read(key: "bearerToken") != nil
        let hasTokenScript = WKUserScript(
            source: "window.__OPENTASK_HAS_TOKEN = \(hasToken);",
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

        // Store references for live Dynamic Type updates and deep linking
        context.coordinator.webView = webView
        WebViewManager.shared.webView = webView
        context.coordinator.startObservingContentSize()

        // Check for pending deep link (cold launch from notification tap or quick action)
        var loadURL = url
        if let path = WebViewManager.shared.consumePendingPath() {
            loadURL = URL(string: AppConfig.shared.serverURL + path) ?? url
        }
        webView.load(URLRequest(url: loadURL))

        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // No updates needed — URL doesn't change during the view's lifecycle
    }

    class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler, WKHTTPCookieStoreObserver {
        var refreshControl: UIRefreshControl?
        var onNavigationError: ((Error) -> Void)?
        weak var webView: WKWebView?
        private var contentSizeObserver: NSObjectProtocol?

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
            injectDeviceInfo(into: webView)

            // Force WKWebView to flush cookies to disk so session survives force-quit.
            // WKWebView doesn't guarantee immediate persistence — getAllCookies triggers a sync.
            webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { _ in }
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
            let hasToken = KeychainHelper.read(key: "bearerToken") != nil
            let js = """
                window.__OPENTASK_DEVICE_INFO = { token: '\(token)', bundleId: '\(bundleId)', environment: '\(env)' };
                window.__OPENTASK_HAS_TOKEN = \(hasToken);
                """
            webView.evaluateJavaScript(js)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            refreshControl?.endRefreshing()
            // Ignore cancelled navigations — happens when a quick action or deep link
            // navigation replaces an in-flight load. Not a real connectivity error.
            if (error as NSError).code == NSURLErrorCancelled { return }
            onNavigationError?(error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            refreshControl?.endRefreshing()
            if (error as NSError).code == NSURLErrorCancelled { return }
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
