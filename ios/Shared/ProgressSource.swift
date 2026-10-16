import Foundation

/// Where a quota's progress was logged from — the `source` field the server
/// records on `progress_events` (2026-10-16; `src/lib/progress-source.ts`,
/// `ProgressSource` in docs/openapi.yaml). Sent on `POST /api/tasks/{id}/
/// progress`, `POST /api/quota-prompts/did` and `/restore`, and on
/// `POST /api/tasks/bulk/complete` when the batch carries quota prompts.
///
/// Only the native values: the server's enum is `web | widget | watch | mac |
/// api`, and a call that sends nothing is recorded as `api` (every
/// `APIClient` method defaults to nil, so an older caller keeps working).
/// `undo`/`redo` are the server's own — Undo and Redo send nothing.
///
/// - `widget`: the iOS and Mac widget intents (their outbox included — it
///   only ever drains in the widget extension).
/// - `watch`: the watch app and its Smart Stack widget.
/// - `mac`: the Mac app itself. Nothing there logs progress today (its menu
///   bar completes tasks only); its notification "Complete all" carries
///   prompts, so it says `mac` (`forNotificationActions`).
///
/// The iPhone app's notification actions and the content extension's
/// checklist send nothing: the server has no value for them yet, so they
/// read `api` there.
enum ProgressSource: String, CaseIterable {
    case widget
    case watch
    case mac

    /// The `source` for `NotificationActionRunner`, which the iPhone app, the
    /// Mac app and the watch app share: decided by the platform it was
    /// compiled for.
    static var forNotificationActions: ProgressSource? {
        #if os(watchOS)
        return .watch
        #elseif os(macOS)
        return .mac
        #else
        return nil
        #endif
    }

    /// `body` with `"source"` added when there is one. Pure, so the request
    /// shapes are tested without the network (`ProgressSourceTests`).
    static func adding(_ source: ProgressSource?, to body: [String: Any]) -> [String: Any] {
        guard let source else { return body }
        var body = body
        body["source"] = source.rawValue
        return body
    }
}
