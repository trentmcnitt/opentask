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

/// A delivered banner, as much of it as the rule reads.
struct DeliveredBanner: Equatable {
    /// The request identifier, what `removeDeliveredNotifications` takes.
    let identifier: String
    /// The payload's `taskId`; nil for a banner about no single task (a
    /// period push, an overflow summary, the deadlines nag).
    let taskId: Int?

    init(identifier: String, taskId: Int?) {
        self.identifier = identifier
        self.taskId = taskId
    }

    init(identifier: String, userInfo: [AnyHashable: Any]) {
        self.init(identifier: identifier, taskId: userInfo["taskId"] as? Int)
    }
}

/// The identifiers of the banners that belong to `taskIds`, in delivered
/// order. The one matching rule for a sweep's `moved_ids` and for the
/// server's silent `dismiss` push.
func bannerIdentifiers(_ banners: [DeliveredBanner], forTaskIds taskIds: [Int]) -> [String] {
    guard !taskIds.isEmpty else { return [] }
    let ids = Set(taskIds)
    return banners.compactMap { banner in
        guard let taskId = banner.taskId, ids.contains(taskId) else { return nil }
        return banner.identifier
    }
}
