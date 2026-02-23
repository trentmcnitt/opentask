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

        // Register JS bridge for native actions (disconnect, etc.)
        config.userContentController.add(context.coordinator, name: "opentask")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = true
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

        // Load the server URL
        webView.load(URLRequest(url: url))

        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        // No updates needed — URL doesn't change during the view's lifecycle
    }

    class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var refreshControl: UIRefreshControl?
        var onNavigationError: ((Error) -> Void)?

        init(onNavigationError: ((Error) -> Void)?) {
            self.onNavigationError = onNavigationError
        }

        @objc func handleRefresh(_ sender: UIRefreshControl) {
            guard let webView = sender.superview?.superview as? WKWebView else {
                sender.endRefreshing()
                return
            }
            webView.reload()
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            refreshControl?.endRefreshing()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            refreshControl?.endRefreshing()
            onNavigationError?(error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            refreshControl?.endRefreshing()
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
            default:
                print("[OpenTask] Unknown JS bridge action: \(action)")
            }
        }
    }
}
