import Foundation

/// The widget deep link for one quota PROMPT row, and its web path.
///
/// A prompt tapped on the Reminders widget opens the app ON the Reminders
/// surface with that row highlighted — the same thing a reminder row's tap
/// does (`opentask://reminder/<id>` → `/reminders?reminder=<id>`). It used to
/// link to the quota on the Quotas surface (`opentask://quota/<id>`), which
/// took the user to a different tab from the one they tapped on.
///
/// Keyed by `prompt_key` (`q:<taskId>:<k>:<date>`), never task id: a daily
/// quota can have several prompt rows sharing one task id, and the link has to
/// land on the exact row that was tapped.
///
/// Shape: `opentask://reminders/prompt/<key>` — under the `reminders` host,
/// mirroring `reminders/slot/<id>`, so an app build that predates this link
/// still lands on the Reminders surface (unscoped) rather than the dashboard,
/// and the watch's `WatchPage(url:)` reads it as Reminders unchanged. The app
/// resolves it to `/reminders?prompt=<key>` (`RemindersView.tsx`'s deep-link
/// effect brings the row into view and flashes it).
///
/// Foundation only, in Shared/: the widget builds the URL, the iOS and macOS
/// apps resolve it, and `OpenTaskLogicTests` pins both directions.
enum PromptDeepLink {
    static let scheme = "opentask"

    /// Characters left bare in the key: RFC 3986 unreserved. A real key only
    /// has digits, `q`, `:` and `-`; everything else is encoded, so a key can
    /// never smuggle a `/`, `?` or `&` into the path or the query.
    private static let unreserved = CharacterSet(
        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~:"
    )

    /// `opentask://reminders/prompt/<key>` for one prompt row.
    static func url(promptKey: String) -> URL? {
        guard !promptKey.isEmpty,
              let encoded = promptKey.addingPercentEncoding(withAllowedCharacters: unreserved)
        else { return nil }
        return URL(string: "\(scheme)://reminders/prompt/\(encoded)")
    }

    /// The prompt key a `url(promptKey:)` link carries, or nil for any other
    /// link (a bare `opentask://reminders`, a slot link, another host).
    static func promptKey(from url: URL) -> String? {
        guard url.scheme == scheme, url.host == "reminders" else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }
        guard parts.count == 2, parts[0] == "prompt", !parts[1].isEmpty else { return nil }
        return parts[1]
    }

    /// The web path the app loads for a prompt key: `/reminders?prompt=<key>`,
    /// the key encoded as in `url(promptKey:)` (`:` is legal in a query).
    static func webPath(promptKey: String) -> String {
        let query = promptKey.addingPercentEncoding(withAllowedCharacters: unreserved) ?? ""
        return "/reminders?prompt=\(query)"
    }
}
