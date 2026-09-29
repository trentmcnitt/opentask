import Foundation

/// Which delivered notifications a bulk snooze ("sweep") may clear — the
/// Foundation-only half of `dismissNotificationsAfterSweep(_:)` in
/// `NotificationConstants.swift`, kept separate so `OpenTaskLogicTests` (which
/// leaves `NotificationConstants.swift` out to stay off UserNotifications) can
/// test the rule.

/// Highest priority a sweep ALWAYS includes.
///
/// Mirrors `HIGH_PRIORITY_THRESHOLD - 1` in `src/core/tasks/bulk.ts`
/// (`filterForBulkSnooze`): P0-P2 are always swept; P3 (High) only once no
/// P0-P2 task is left in the batch; P4 (Urgent) never. Dismissing above the
/// tier that actually moved would clear the banner for a task that was never
/// snoozed — it would stay overdue while looking handled, which is the failure
/// this app exists to prevent.
///
/// Keep in sync with the server constant; there is no shared source of truth
/// across the Swift/TypeScript boundary.
let bulkSnoozeMaxPriority = 2

/// The priority ceiling to dismiss at after a sweep returned `result`.
///
/// 3 when the sweep moved High tasks (`snoozed_high > 0`) and left none
/// behind (`skipped_high == 0`) — the round where nothing lower was left and
/// the server swept the High tier too, so their banners are now stale.
/// Otherwise 2.
///
/// The `skippedHigh == 0` half matters for a sweep started from one High
/// task's own notification: `include_task_ids` rescues that one task while
/// P0-P2 are still overdue, so `snoozed_high` is 1 but every other High task
/// was skipped and is still overdue. That task's own banner is removed by
/// identifier by the action handler, not by this ceiling.
func sweepDismissCeiling(_ result: APIClient.BulkSnoozeResult) -> Int {
    result.snoozedHigh > 0 && result.skippedHigh == 0 ? bulkSnoozeMaxPriority + 1 : bulkSnoozeMaxPriority
}
