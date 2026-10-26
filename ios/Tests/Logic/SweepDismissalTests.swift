import XCTest

/// Which delivered notifications a bulk snooze clears (`bannerIdentifiers`,
/// used by `dismissNotificationsAfterSweep` on every sweep path and by the
/// silent `dismiss` push): exactly the banners of the tasks in the server's
/// `moved_ids`, matched by the payload's `taskId`, and nothing else.
final class SweepDismissalTests: XCTestCase {

    /// One of each kind of banner that can be up when a sweep runs, as the
    /// server builds their payloads (`src/core/notifications/apns.ts`).
    private let banners = [
        DeliveredBanner(identifier: "task-1", userInfo: ["taskId": 1, "priority": 1]),
        DeliveredBanner(identifier: "task-2", userInfo: ["taskId": 2, "priority": 3]),
        // A named reminder banner: a task id, no priority.
        DeliveredBanner(identifier: "reminder-3", userInfo: ["taskId": 3, "reminder_day": "2026-01-15"]),
        // A period push: no task id.
        DeliveredBanner(identifier: "slot-12", userInfo: ["slot_id": 12, "reminder_count": 4]),
        // Another overdue task, which this sweep did not move.
        DeliveredBanner(identifier: "task-4", userInfo: ["taskId": 4, "priority": 0]),
        // The "AI finished" push for a just-added task, and the deadlines nag.
        DeliveredBanner(identifier: "added-5", userInfo: ["taskId": 5]),
        DeliveredBanner(identifier: "deadlines", userInfo: ["kind": "deadlines"]),
    ]

    /// The coordinator's case: a sweep that moved [1, 2] clears banners 1
    /// and 2 only. The reminder, the period push, the other overdue task, the
    /// "AI finished" push and the deadlines nag all stay — whatever their
    /// priority, or lack of one.
    func testClearsOnlyTheMovedTasksBanners() {
        XCTAssertEqual(bannerIdentifiers(banners, forTaskIds: [1, 2]), ["task-1", "task-2"])
    }

    /// A sweep that moved nothing, or a server that sends no `moved_ids`,
    /// clears nothing.
    func testNothingMovedClearsNothing() {
        XCTAssertEqual(bannerIdentifiers(banners, forTaskIds: []), [])
    }

    /// A moved id with no banner up is fine; the order is the delivered order.
    func testMovedIdsWithoutABannerAndOrder() {
        XCTAssertEqual(bannerIdentifiers(banners, forTaskIds: [99, 4, 1]), ["task-1", "task-4"])
    }

    /// Two banners for one task (an overdue push and its re-send under
    /// another identifier) both go.
    func testEveryBannerOfAMovedTaskGoes() {
        let twice = banners + [DeliveredBanner(identifier: "task-1-again", taskId: 1)]
        XCTAssertEqual(bannerIdentifiers(twice, forTaskIds: [1]), ["task-1", "task-1-again"])
    }

    /// The payload's `taskId` is read as the server sends it, an integer; a
    /// payload without one is never matched.
    func testBannerTaskIdFromThePayload() {
        XCTAssertEqual(DeliveredBanner(identifier: "a", userInfo: ["taskId": 7]).taskId, 7)
        XCTAssertNil(DeliveredBanner(identifier: "b", userInfo: ["slot_id": 7]).taskId)
        XCTAssertNil(DeliveredBanner(identifier: "c", userInfo: ["taskId": "7"]).taskId)
    }
}
