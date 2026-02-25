import WebKit

/// Manages the WKWebView reference for deep linking from notifications and quick actions.
///
/// Handles two launch scenarios:
/// - **App running**: WebView exists → navigate immediately
/// - **Cold launch**: WebView not yet created → store the path for the initial load
class WebViewManager {
    static let shared = WebViewManager()
    weak var webView: WKWebView?
    private var pendingPath: String?

    private init() {}

    /// Navigate the WebView to a path on the server (e.g., "/?task=123" or "/?action=create").
    /// If the WebView doesn't exist yet (cold launch), stores the path for initial load.
    func navigate(path: String) {
        let serverURL = AppConfig.shared.serverURL
        print("[OpenTask] navigate(path: \(path)) — webView: \(webView != nil), serverURL: \(serverURL)")

        if let webView = webView {
            let fullURL = serverURL + path
            if let url = URL(string: fullURL) {
                print("[OpenTask] Loading URL: \(fullURL)")
                DispatchQueue.main.async {
                    webView.load(URLRequest(url: url))
                }
            } else {
                print("[OpenTask] ERROR: Invalid URL: \(fullURL)")
            }
        } else {
            print("[OpenTask] WebView nil — storing pendingPath: \(path)")
            pendingPath = path
        }
    }

    /// Navigate to the dashboard with the task modal open.
    func navigateToTask(_ taskId: Int) {
        navigate(path: "/?task=\(taskId)")
    }

    /// Returns and clears any pending path from a cold-launch deep link.
    func consumePendingPath() -> String? {
        let path = pendingPath
        pendingPath = nil
        return path
    }
}
