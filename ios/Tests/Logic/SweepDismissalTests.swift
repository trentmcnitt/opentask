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
        // Two named quota-prompt banners of one daily quota (QUOTA_NAG):
        // one task id, two prompt keys, no priority.
        DeliveredBanner(identifier: "prompt-morning", userInfo: ["taskId": 6, "prompt_key": "q:6:1:2026-01-15"]),
        DeliveredBanner(identifier: "prompt-evening", userInfo: ["taskId": 6, "prompt_key": "q:6:2:2026-01-15"]),
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

    /// A sweep leaves the quota-prompt banners: it moves only overdue tasks,
    /// a quota has no target, so its id is never in `moved_ids` — here every
    /// overdue task's banner goes and both prompt banners stay.
    func testSweepLeavesQuotaPromptBanners() {
        let cleared = bannerIdentifiers(banners, forTaskIds: [1, 2, 4])
        XCTAssertEqual(cleared, ["task-1", "task-2", "task-4"])
        XCTAssertFalse(cleared.contains("prompt-morning"))
        XCTAssertFalse(cleared.contains("prompt-evening"))
    }

    // MARK: - The dismiss push's `promptKeys` (Push PR 4b)

    /// Morning's prompt considered elsewhere: the push lists the quota's id
    /// AND Morning's key. Only Morning's banner goes; Evening's, which shares
    /// the task id, stays.
    func testDismissByPromptKeyClosesOnlyThatPrompt() {
        let cleared = bannerIdentifiers(banners, forTaskIds: [6], promptKeys: ["q:6:1:2026-01-15"])
        XCTAssertEqual(cleared, ["prompt-morning"])
    }

    /// With `promptKeys`, every banner without a key still closes by `taskIds`.
    func testDismissWithPromptKeysStillClosesTaskBannersById() {
        let cleared = bannerIdentifiers(banners, forTaskIds: [1, 6], promptKeys: ["q:6:2:2026-01-15"])
        XCTAssertEqual(cleared, ["task-1", "prompt-evening"])
    }

    /// A key not up, or another day's: nothing of the quota goes.
    func testDismissByAnUnlistedKeyClosesNoPromptBanner() {
        XCTAssertEqual(bannerIdentifiers(banners, forTaskIds: [6], promptKeys: ["q:6:1:2026-01-14"]), [])
    }

    /// No `promptKeys` (a quota done, deleted or edited — the ordinary task
    /// path), or an empty list: every banner of the task goes, prompt
    /// banners included.
    func testDismissWithoutPromptKeysFallsBackToTaskIds() {
        XCTAssertEqual(bannerIdentifiers(banners, forTaskIds: [6]), ["prompt-morning", "prompt-evening"])
        XCTAssertEqual(
            bannerIdentifiers(banners, forTaskIds: [6], promptKeys: []), ["prompt-morning", "prompt-evening"]
        )
    }

    func testBannerPromptKeyFromThePayload() {
        XCTAssertEqual(DeliveredBanner(identifier: "a", userInfo: ["taskId": 6, "prompt_key": "q:6:1:2026-01-15"]).promptKey, "q:6:1:2026-01-15")
        XCTAssertNil(DeliveredBanner(identifier: "b", userInfo: ["taskId": 6]).promptKey)
    }

    /// The payload's `taskId` is read as the server sends it, an integer; a
    /// payload without one is never matched.
    func testBannerTaskIdFromThePayload() {
        XCTAssertEqual(DeliveredBanner(identifier: "a", userInfo: ["taskId": 7]).taskId, 7)
        XCTAssertNil(DeliveredBanner(identifier: "b", userInfo: ["slot_id": 7]).taskId)
        XCTAssertNil(DeliveredBanner(identifier: "c", userInfo: ["taskId": "7"]).taskId)
    }
}
