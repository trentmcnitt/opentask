import Foundation

/// The pure halves of the native ↔ web-view bridge, shared by the iOS app
/// (`ios/OpenTask/WebView.swift`) and the macOS app
/// (`macos/OpenTaskMac/WebViewHost.swift`): the JavaScript each injects into
/// the page, and the /login-rescue URL rules. The web-view coordinators stay
/// per platform (UIKit vs AppKit); only what was copied verbatim between them
/// lives here.
///
/// Foundation only, in Shared/, so `OpenTaskLogicTests` (`WebBridgeTests`)
/// covers the escaping and the callbackUrl validation.
enum WebBridge {
    // MARK: - /login rescue

    /// NextAuth's login route, whether or not it carries a `callbackUrl`
    /// query or a trailing slash.
    static func isLoginPath(_ url: URL?) -> Bool {
        guard var path = url?.path else { return false }
        if path.count > 1 && path.hasSuffix("/") { path.removeLast() }
        return path == "/login"
    }

    /// Destination to resume after a rescued /login bounce: the login URL's
    /// own callbackUrl when present (the server records exactly where the
    /// user was headed), falling back to `fallback` — the last path the app
    /// requested (`WebViewManager.lastRequestedPath`). Same-origin relative
    /// paths only: a callbackUrl that isn't `/…`, or is protocol-relative
    /// `//host`, is ignored.
    ///
    /// `wasPreempted` skips the callbackUrl entirely. Only iOS ever passes
    /// true — see `WebView.swift`'s "foreground-resume race" doc on its
    /// `decidePolicyFor`: a page's own client-side redirect cancelled our
    /// widget navigation, so its callbackUrl names the OLD page, not the
    /// destination. The Mac passes false (it doesn't track cancellations).
    static func resumePath(fromLoginURL url: URL, wasPreempted: Bool, fallback: String) -> String {
        if !wasPreempted,
           let cb = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "callbackUrl" })?.value,
           cb.hasPrefix("/"), !cb.hasPrefix("//") {
            return cb
        }
        return fallback
    }

    // MARK: - Injected JavaScript

    /// `window.__OPENTASK_DEVICE_INFO`: the APNs device token, bundle id and
    /// APNs environment, so the web app registers the token with the server
    /// under the session cookie — push follows whoever is logged in in the
    /// web view, not whoever owns the Bearer token.
    ///
    /// The environment follows the signing entitlement, not the build
    /// configuration (see `ApsEnvironment`): Release builds installed
    /// straight onto devices are signed for development, and `#if DEBUG`
    /// registered them as "production", so every push was rejected.
    ///
    /// The token is hex from APNs, and the bundle id and environment are ours,
    /// so they're interpolated as-is (unchanged from the per-app copies).
    static func deviceInfoJS(token: String) -> String {
        let bundleId = Bundle.main.bundleIdentifier ?? "io.mcnitt.opentask"
        let environment = ApsEnvironment.current
        return "window.__OPENTASK_DEVICE_INFO = { token: '\(token)', "
            + "bundleId: '\(bundleId)', environment: '\(environment)' };"
    }

    /// `window.__OPENTASK_HAS_TOKEN` / `window.__OPENTASK_TOKEN_PREVIEW` for
    /// the Bearer token in the Keychain.
    ///
    /// The preview is the last 8 characters of the stored Bearer token —
    /// the same suffix the server keeps in `api_tokens.token_preview` — so
    /// the web app can tell that the native token belongs to a different
    /// user than the one whose session is loaded. `null` when there is no
    /// token; never the token itself.
    static func tokenFlagsJS() -> String {
        tokenFlagsJS(token: KeychainHelper.read(key: "bearerToken"))
    }

    /// The same, for a given token — the pure half, so tests never touch the
    /// Keychain (which has no test seam).
    static func tokenFlagsJS(token: String?) -> String {
        let preview = token.map { String($0.suffix(8)) }
        return """
            window.__OPENTASK_HAS_TOKEN = \(token != nil);
            window.__OPENTASK_TOKEN_PREVIEW = \(jsStringLiteral(preview));
            """
    }

    /// Render a Swift string as a JS single-quoted literal (or `null`).
    /// Token previews are opaque server-generated strings — escape rather
    /// than assume they are alphanumeric. The result goes to
    /// `evaluateJavaScript` / a `WKUserScript` source, never into HTML, so
    /// `</script>` needs no escaping; the line terminators JS forbids inside
    /// a string literal (`\n`, `\r`, U+2028, U+2029) do.
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
}
