import Foundation

/// Which delivered notifications a bulk snooze ("sweep") clears: the
/// Foundation-only rule behind `dismissNotificationsAfterSweep(_:)` and
/// `removeDeliveredNotifications(forTaskIds:)` in `NotificationConstants.swift`,
/// kept separate so `OpenTaskLogicTests` (which leaves
/// `NotificationConstants.swift` out to stay off UserNotifications) can test it.
///
/// **The rule (2026-10-26): exactly the banners of the tasks the sweep moved**,
/// matched by the payload's `taskId` against the server's `moved_ids`
/// (`APIClient.BulkSnoozeResult.movedIds`; queued tasks are in it — a task sent
/// to the Tasks queue was moved, and its banner is stale). Nothing else goes: a
/// period push, the "AI finished" push, the deadlines nag, a named reminder
/// banner (`REMINDER_NAG`), and the banner of an overdue task the sweep left
/// where it was all stay.
///
/// It replaced a priority ceiling (P0–P2 always, High when the sweep took the
/// High tier), which cleared every banner at or below the ceiling — reading a
/// missing priority as P0, so every sweep also cleared the period push, the
/// "AI finished" push, the deadlines nag and the reminder banners, and any
/// overdue banner the server held back for its deadline or never reached.
///
/// The server sends the same set to every device as the silent `dismiss` push
/// (`bulkSnooze` → `dismissNotificationsForTasks(userId, snoozedIds)`); this is
/// the local half, so the device that ran the sweep is clean the moment the
/// response lands, whether or not that push wakes it. A server from before
/// `moved_ids` sends none: nothing is cleared locally, and the silent push
/// still clears the moved ones.
///
/// A named quota-prompt banner (`QUOTA_NAG`, 2026-10-26) stays through every
/// sweep for the same reason a reminder banner does: its `taskId` is the
/// quota's, and a quota has no target, so no sweep ever moves it — it is never
/// in `moved_ids`.
///
/// **The silent `dismiss` push's prompt keys (Push PR 4b, 2026-10-26).** A
/// daily quota's prompts in two periods are two banners with ONE `taskId`, so
/// matching by task id alone closed Evening's banner when Morning's prompt was
/// considered. Since Push PR 4 the server adds `promptKeys` to a dismiss that
/// is about prompts (`dismissPromptNotifications`,
/// `src/core/notifications/dismiss.ts`); with them, a banner that carries a
/// `prompt_key` closes only when its key is listed, and every other banner
/// still closes by `taskIds`. A dismiss without `promptKeys` (a quota done,
/// deleted or edited — the ordinary task path) closes every banner of its
/// tasks, prompt banners included. A sweep passes no keys.

/// A delivered banner, as much of it as the rule reads.
struct DeliveredBanner: Equatable {
    /// The request identifier, what `removeDeliveredNotifications` takes.
    let identifier: String
    /// The payload's `taskId`; nil for a banner about no single task (a
    /// period push, an overflow summary, the deadlines nag).
    let taskId: Int?
    /// The payload's `prompt_key` (`QuotaNagKey.promptKey`): set only on a
    /// named quota-prompt banner.
    let promptKey: String?

    init(identifier: String, taskId: Int?, promptKey: String? = nil) {
        self.identifier = identifier
        self.taskId = taskId
        self.promptKey = promptKey
    }

    init(identifier: String, userInfo: [AnyHashable: Any]) {
        self.init(
            identifier: identifier,
            taskId: userInfo["taskId"] as? Int,
            promptKey: userInfo[QuotaNagKey.promptKey] as? String
        )
    }
}

/// The identifiers of the banners that belong to `taskIds`, in delivered
/// order. The one matching rule for a sweep's `moved_ids` (no `promptKeys`)
/// and for the server's silent `dismiss` push.
///
/// - `promptKeys` nil or empty: every banner whose `taskId` is listed.
/// - `promptKeys` given: a banner with a `prompt_key` goes only when that key
///   is listed (its `taskId` doesn't matter); any other banner by `taskId`.
func bannerIdentifiers(
    _ banners: [DeliveredBanner], forTaskIds taskIds: [Int], promptKeys: [String]? = nil
) -> [String] {
    let ids = Set(taskIds)
    let keys = Set(promptKeys ?? [])
    guard !ids.isEmpty || !keys.isEmpty else { return [] }
    return banners.compactMap { banner in
        if !keys.isEmpty, let promptKey = banner.promptKey {
            return keys.contains(promptKey) ? banner.identifier : nil
        }
        guard let taskId = banner.taskId, ids.contains(taskId) else { return nil }
        return banner.identifier
    }
}
