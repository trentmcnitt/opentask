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
struct WebView: UIViewRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()

        // Allow inline media playback (avoids fullscreen for any embedded media)
        config.allowsInlineMediaPlayback = true

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

    class Coordinator: NSObject, WKNavigationDelegate {
        var refreshControl: UIRefreshControl?

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
        }
    }
}
