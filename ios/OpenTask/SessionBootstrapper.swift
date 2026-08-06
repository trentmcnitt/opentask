import Foundation
import WebKit

/// Mints a fresh PWA web session from the Keychain Bearer token.
///
/// **The problem.** Two credentials with two different lifetimes live side by
/// side: the NextAuth session cookie the WKWebView logs in with expires after
/// 7 days, while the Bearer token the app provisions at setup never expires.
/// A user who ignores the app for a week and then taps a widget or a
/// notification lands on `/login` — even though the app is still fully
/// credentialed and every native surface (widgets, watch, notification
/// actions) is happily talking to the server with that same token.
///
/// **The fix.** Trade the long-lived token for a fresh session cookie and hand
/// that cookie to the web view's cookie store before it makes a request. The
/// server contract is exactly:
///
///     POST {serverURL}/api/auth/session-from-token
///     Authorization: Bearer <keychain token>
///     → 200 { "data": { "ok": true } } + Set-Cookie: <NextAuth session cookie>
///     → 401 when the token is invalid or absent
///
/// The cookie's name is deliberately **not** hardcoded here: NextAuth uses
/// `authjs.session-token` over http and `__Secure-authjs.session-token` over
/// https, and may add others (CSRF, callback). Every cookie the response sets
/// is parsed and injected.
///
/// **Failure is never loud.** Any non-200, any network error, any missing
/// cookie returns `false` and the caller falls back to today's behavior — the
/// user sees the login page and types a password. Nothing throws into the UI.
enum SessionBootstrapper {
    private static let endpointPath = "/api/auth/session-from-token"

    /// Whether there is anything to bootstrap *from*. Callers gate on this
    /// first so an unconfigured app never pays for a doomed round-trip.
    static var hasCredentials: Bool {
        guard let url = KeychainHelper.read(key: "serverURL"), !url.isEmpty,
              let token = KeychainHelper.read(key: "bearerToken"), !token.isEmpty
        else { return false }
        return true
    }

    /// Exchange the Keychain Bearer token for a web session cookie and install
    /// it in `WKWebsiteDataStore.default()`.
    ///
    /// Returns `true` only once every returned cookie has been committed to the
    /// store — the caller may load a URL the instant this returns and be sure
    /// the request carries the new session.
    ///
    /// `@MainActor` because `WKHTTPCookieStore` is main-thread-only.
    @MainActor
    @discardableResult
    static func bootstrap() async -> Bool {
        guard let serverURL = KeychainHelper.read(key: "serverURL"), !serverURL.isEmpty,
              let token = KeychainHelper.read(key: "bearerToken"), !token.isEmpty,
              let url = URL(string: serverURL + endpointPath)
        else {
            return false
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // Cold launch is gated on this call. A server that has gone away must
        // not hold a blank web view for longer than a user will wait.
        request.timeoutInterval = 10
        request.cachePolicy = .reloadIgnoringLocalCacheData

        // Ephemeral configuration with cookie handling disabled: `URLSession.shared`
        // would quietly absorb the Set-Cookie into the shared `HTTPCookieStorage`,
        // which the WKWebView never reads. We want the raw headers so we can put
        // the cookies where they actually matter — the web view's own store.
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        let session = URLSession(configuration: configuration)
        defer { session.finishTasksAndInvalidate() }

        do {
            let (_, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                print("[OpenTask] Session bootstrap: non-HTTP response")
                return false
            }
            guard http.statusCode == 200 else {
                // 401 is the expected "this token is no good" answer; anything
                // else is a server problem. Both mean: leave the user on /login.
                print("[OpenTask] Session bootstrap failed: HTTP \(http.statusCode)")
                return false
            }

            let cookies = HTTPCookie.cookies(
                withResponseHeaderFields: stringHeaders(from: http),
                for: url
            )
            guard !cookies.isEmpty else {
                print("[OpenTask] Session bootstrap: 200 but no Set-Cookie")
                return false
            }

            await install(cookies)
            print("[OpenTask] Session bootstrapped from Bearer token (\(cookies.count) cookie(s))")
            return true
        } catch {
            print("[OpenTask] Session bootstrap error: \(error)")
            return false
        }
    }

    /// `allHeaderFields` is `[AnyHashable: Any]`; a blanket cast to
    /// `[String: String]` fails outright if any single value isn't a String,
    /// which would silently drop the cookies. Filter instead of cast.
    private static func stringHeaders(from response: HTTPURLResponse) -> [String: String] {
        var headers: [String: String] = [:]
        for (key, value) in response.allHeaderFields {
            if let key = key as? String, let value = value as? String {
                headers[key] = value
            }
        }
        return headers
    }

    /// Commit each cookie to the web view's store, awaiting every completion.
    ///
    /// `setCookie` is asynchronous — returning before the callbacks fire would
    /// reintroduce exactly the race this exists to close (a page load beating
    /// its own session cookie into the store).
    @MainActor
    private static func install(_ cookies: [HTTPCookie]) async {
        let store = WKWebsiteDataStore.default().httpCookieStore
        for cookie in cookies {
            await withCheckedContinuation { continuation in
                store.setCookie(cookie) { continuation.resume() }
            }
        }
    }
}
