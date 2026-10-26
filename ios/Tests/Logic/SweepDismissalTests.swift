import XCTest

/// Which delivered notifications a bulk snooze may clear
/// (`sweepDismissCeiling`, used by `dismissNotificationsAfterSweep` on every
/// sweep path). Mirrors the server's High-tier rule in `filterForBulkSnooze`
/// (`src/core/tasks/bulk.ts`).
final class SweepDismissalTests: XCTestCase {

    private func result(affected: Int, snoozedHigh: Int = 0, skippedHigh: Int = 0, skippedUrgent: Int = 0)
        -> APIClient.BulkSnoozeResult
    {
        APIClient.BulkSnoozeResult(
            tasksAffected: affected,
            skippedOnPriority: skippedHigh + skippedUrgent,
            skippedHigh: skippedHigh,
            snoozedHigh: snoozedHigh
        )
    }

    /// The usual round: P0-P2 moved, High and Urgent left overdue, so their
    /// banners must stay.
    func testLowerTiersOnlyClearsUpToNormal() {
        XCTAssertEqual(sweepDismissCeiling(result(affected: 3, skippedHigh: 2, skippedUrgent: 1)), 2)
        XCTAssertEqual(sweepDismissCeiling(result(affected: 3)), 2)
    }

    /// Nothing lower was left, so the server swept the High tier too: the
    /// High banners are now stale and go with the rest. Urgent stays.
    func testHighTierSweptClearsHighToo() {
        XCTAssertEqual(sweepDismissCeiling(result(affected: 2, snoozedHigh: 2, skippedUrgent: 1)), 3)
    }

    /// A sweep started from one High task's own notification rescues that
    /// task (`include_task_ids`) while P0-P2 are still overdue: one High moved,
    /// the other Highs were skipped and are still overdue, so High banners
    /// must NOT be cleared by tier.
    func testRescuedHighWithOthersSkippedKeepsHighBanners() {
        XCTAssertEqual(sweepDismissCeiling(result(affected: 4, snoozedHigh: 1, skippedHigh: 2)), 2)
    }

    // MARK: - Which banner goes (`sweepClearsBanner`)

    /// A named reminder banner (`REMINDER_NAG`) carries no priority. Read as
    /// P0 it would go with every sweep, but a reminder isn't overdue and no
    /// sweep moves it: it stays at any ceiling, even with a priority present.
    func testReminderNagBannerIsNeverClearedBySweep() {
        let reminder = NotificationCategory.reminderNag
        for ceiling in [2, 3, 4] {
            XCTAssertFalse(sweepClearsBanner(category: reminder, priority: nil, ceiling: ceiling))
        }
        XCTAssertFalse(sweepClearsBanner(category: reminder, priority: 0, ceiling: 3))
    }

    /// Overdue task banners: by priority against the ceiling, as before.
    func testTaskBannersGoByPriority() {
        let task = NotificationCategory.taskReminder
        XCTAssertTrue(sweepClearsBanner(category: task, priority: 2, ceiling: 2))
        XCTAssertFalse(sweepClearsBanner(category: task, priority: 3, ceiling: 2))
        XCTAssertTrue(sweepClearsBanner(category: task, priority: 3, ceiling: 3))
        XCTAssertFalse(sweepClearsBanner(category: task, priority: 4, ceiling: 3))
    }

    /// Any other banner without a priority still reads as P0 (unchanged).
    func testOtherBannersWithoutAPriorityStillGo() {
        XCTAssertTrue(sweepClearsBanner(category: NotificationCategory.taskReminder, priority: nil, ceiling: 2))
        XCTAssertTrue(sweepClearsBanner(category: NotificationCategory.slotReminder, priority: nil, ceiling: 2))
        XCTAssertTrue(sweepClearsBanner(category: "", priority: nil, ceiling: 2))
    }
}
