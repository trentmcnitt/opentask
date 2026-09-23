import AppKit
import WebKit

/// The one handle the rest of the app has on the web view.
///
/// Menu commands and notification actions both need to say "show me this page"
/// without knowing whether the web view exists yet, so every such request goes
/// through here. The macOS counterpart of `ios/OpenTask/WebViewManager.swift`;
/// same two launch cases, plus one the phone does not have — the window can be
/// closed while the app keeps running, so a navigation may need to reopen it.
@MainActor
final class WebViewManager {
    static let shared = WebViewManager()

    weak var webView: WKWebView?
    private var pendingPath: String?

    /// Called at the start of every externally-initiated `navigate(path:)` so
    /// the coordinator can re-arm its /login rescue: each fresh user intent
    /// (menu command, notification tap) deserves a fresh rescue attempt.
    var onNewNavigationIntent: (() -> Void)?

    /// Set by the app scene. A notification tap with the window closed has to
    /// bring a window back before it has anywhere to navigate.
    var openMainWindow: (() -> Void)?

    /// The path the app last asked for, whether or not the load succeeded or
    /// was bounced to /login. The rescue in `WebViewHost.Coordinator` replays
    /// this after re-minting the session. Defaults to the dashboard — a plain
    /// launch never calls `navigate`.
    private(set) var lastRequestedPath: String = "/"

    private init() {}

    /// Navigate to a path on the configured server (e.g. `/?task=123`).
    /// With no web view yet (cold launch, or a closed window), the path is
    /// parked and consumed by the next `WebViewHost` that comes up.
    ///
    /// `rearmRescue: false` is used by the /login rescue itself when replaying
    /// the intended path — the replay must NOT re-arm the rescue, or a server
    /// that keeps bouncing to /login would loop bootstrap attempts forever.
    func navigate(path: String, rearmRescue: Bool = true) {
        if rearmRescue {
            onNewNavigationIntent?()
        }
        lastRequestedPath = path

        guard let webView else {
            print("[OpenTask] No web view — parking path: \(path)")
            pendingPath = path
            openMainWindow?()
            return
        }

        guard let url = URL(string: AppConfig.shared.serverURL + path) else {
            print("[OpenTask] ERROR: invalid URL for path \(path)")
            return
        }
        print("[OpenTask] Loading \(url.absoluteString)")
        webView.load(URLRequest(url: url))
        showWindow()
    }

    func navigateToTask(_ taskId: Int) {
        navigate(path: "/?task=\(taskId)")
    }

    /// Returns and clears any parked path.
    func consumePendingPath() -> String? {
        defer { pendingPath = nil }
        return pendingPath
    }

    /// Reload the current page. No-op before the web view exists — there is
    /// nothing to reload, and the initial load is already on its way.
    func reload() {
        webView?.reload()
    }

    /// Fire-and-forget JavaScript in the loaded page, and a no-op when there
    /// is no page. Nothing the app injects reads a result back, so this stays
    /// synchronous and callable from anywhere on the main actor.
    func evaluate(_ js: String) {
        webView?.evaluateJavaScript(js, completionHandler: nil)
    }

    /// Bring the app and its window forward. Used by notification taps and by
    /// menu actions that change what the page should be showing.
    func showWindow() {
        // `activate()`, not `activate(ignoringOtherApps:)` — the latter is
        // deprecated as of macOS 14, which is this app's floor.
        NSApp.activate()
        if webView == nil {
            openMainWindow?()
        } else {
            webView?.window?.makeKeyAndOrderFront(nil)
        }
    }
}
