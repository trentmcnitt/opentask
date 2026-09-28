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

    /// Called at the start of every externally-initiated `navigate(path:)`.
    /// The Coordinator hooks this to RE-ARM its /login rescue: each fresh user
    /// intent (widget tap, notification, quick action) deserves a fresh rescue
    /// attempt. Without it, one failed rescue left the guard spent and every
    /// later tap dead-ended on the login page until a page happened to load.
    var onNewNavigationIntent: (() -> Void)?

    /// The path the app last asked the web view to show, regardless of whether
    /// the load succeeded, was deferred, or was bounced to `/login` by an
    /// expired session. The `/login` rescue in `WebView.Coordinator` replays
    /// this after re-minting the session, so a widget tap that lands on the
    /// login page still ends up where the user was actually going.
    ///
    /// Defaults to the dashboard — a plain icon launch never calls `navigate`.
    private(set) var lastRequestedPath: String = "/"

    private init() {}

    /// Navigate the WebView to a path on the server (e.g., "/?task=123" or "/?action=create").
    /// If the WebView doesn't exist yet (cold launch), stores the path for initial load.
    ///
    /// Note that `webView` is deliberately left nil during the cold-launch
    /// session bootstrap (see `WebView.makeUIView`), so a deep link that
    /// arrives mid-bootstrap parks itself here instead of firing a request
    /// that would beat the session cookie into the store.
    ///
    /// `rearmRescue: false` is used by the /login rescue itself when replaying
    /// the intended path — the replay must NOT re-arm the rescue, or a server
    /// that keeps bouncing to /login would loop bootstrap attempts forever.
    func navigate(path: String, rearmRescue: Bool = true) {
        if rearmRescue {
            onNewNavigationIntent?()
        }
        lastRequestedPath = path
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

    // MARK: - Quick-action snooze result

    /// A Home Screen quick action's snooze result waiting for a page to show
    /// it (`useNativeSnoozeToast` on the web side renders the usual "Snoozed
    /// N tasks · Undo" toast). Held because on a cold launch the result can
    /// arrive before the page has loaded; delivered by `flushSnoozeResult()`
    /// from `WebView.Coordinator`'s `didFinish` (a real page, not /login),
    /// or at once when a page is already up.
    private var pendingSnoozeResultJSON: String?

    func deliverSnoozeResult(json: String) {
        pendingSnoozeResultJSON = json
        flushSnoozeResult()
    }

    /// Sets `window.__opentaskNativeSnooze` (read by the web hook when it
    /// mounts — the cold-launch case) and fires `opentask-native-snoozed`
    /// (the page-already-mounted case). Cleared only once the page has run
    /// it, so a delivery into a still-loading page is retried at `didFinish`.
    func flushSnoozeResult() {
        guard let json = pendingSnoozeResultJSON, let webView, !webView.isLoading else { return }
        let js = "window.__opentaskNativeSnooze = \(json); window.dispatchEvent(new CustomEvent('opentask-native-snoozed'))"
        webView.evaluateJavaScript(js) { [weak self] _, error in
            if error == nil { self?.pendingSnoozeResultJSON = nil }
        }
    }

    /// Returns and clears any pending path from a cold-launch deep link.
    func consumePendingPath() -> String? {
        let path = pendingPath
        pendingPath = nil
        return path
    }
}
