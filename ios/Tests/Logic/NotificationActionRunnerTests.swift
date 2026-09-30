import XCTest

/// Which server call each notification action makes (`NotificationActionRunner`,
/// shared by the phone, Mac and Watch delegates and the content extension).
/// The key assertions: a summary's sweeps never send `include_task_ids`, a
/// task's always include its own task, a custom snooze with no picked time
/// sends nothing, and the post-sweep dismissal runs only after a sweep that
/// succeeded.
final class NotificationActionRunnerTests: XCTestCase {

    // MARK: - Stub

    private enum Call: Equatable {
        case markDone(Int)
        case deleteTask(Int)
        case snoozeNextHour(Int)
        case snoozeTo(Int, String)
        case snoozeDelta(Int, Int?)
        case snoozeUntil(String, Int?)
        case snoozeSlot(String, Int?)
        case completeSlot(Int, Set<String>)
    }

    private struct StubError: Error {}

    private final class StubAPI: NotificationActionAPI {
        var calls: [Call] = []
        var shouldThrow = false
        var sweepResult = APIClient.BulkSnoozeResult(
            tasksAffected: 3, skippedOnPriority: 1, skippedHigh: 1, snoozedHigh: 0
        )
        var slotAffected = 2

        private func record(_ call: Call) throws {
            calls.append(call)
            if shouldThrow { throw StubError() }
        }

        func markDone(taskId: Int) async throws { try record(.markDone(taskId)) }
        func deleteTask(taskId: Int) async throws { try record(.deleteTask(taskId)) }
        func snoozeNextHour(taskId: Int) async throws { try record(.snoozeNextHour(taskId)) }
        func snoozeTo(taskId: Int, dueAt: String) async throws { try record(.snoozeTo(taskId, dueAt)) }

        func snoozeOverdue(deltaMinutes: Int, includeTaskId: Int?) async throws -> APIClient.BulkSnoozeResult {
            try record(.snoozeDelta(deltaMinutes, includeTaskId))
            return sweepResult
        }

        func snoozeOverdue(until: String, includeTaskId: Int?) async throws -> APIClient.BulkSnoozeResult {
            try record(.snoozeUntil(until, includeTaskId))
            return sweepResult
        }

        func snoozeOverdue(slot: String, includeTaskId: Int?) async throws -> APIClient.BulkSnoozeResult {
            try record(.snoozeSlot(slot, includeTaskId))
            return sweepResult
        }

        func completeSlotReminders(slotId: Int, didKeys: Set<String>) async throws -> Int {
            try record(.completeSlot(slotId, didKeys))
            return slotAffected
        }
    }

    private var api: StubAPI!
    private var dismissed: [APIClient.BulkSnoozeResult] = []

    override func setUp() {
        super.setUp()
        api = StubAPI()
        dismissed = []
    }

    private func run(
        _ category: String,
        _ action: NotificationActionRunner.Action,
        userInfo: [AnyHashable: Any] = [:],
        customDueAt: String? = nil
    ) async throws -> NotificationActionRunner.Outcome {
        try await NotificationActionRunner.perform(
            category: category,
            action: action,
            userInfo: userInfo,
            customDueAt: customDueAt,
            api: api,
            dismissAfterSweep: { self.dismissed.append($0) }
        )
    }

    private let summary = NotificationCategory.taskSummary
    private let slot = NotificationCategory.slotReminder
    private let task = NotificationCategory.taskReminder
    private let taskInfo: [AnyHashable: Any] = ["taskId": 42, "priority": 1]
    private let customTime = "2026-09-29T20:00:00Z"

    // MARK: - Summary (bulk only, never include_task_ids)

    func testSummaryAllPlusHourSweepsWithoutIncludingATask() async throws {
        let outcome = try await run(summary, .button(NotificationAction.snoozeAll1hr))
        XCTAssertEqual(api.calls, [.snoozeDelta(60, nil)])
        XCTAssertEqual(outcome, .swept(api.sweepResult))
        XCTAssertEqual(dismissed, [api.sweepResult])
    }

    func testSummarySlotActionSweepsToThatSlot() async throws {
        let next = try await run(summary, .button(NotificationAction.snoozeAllSlotNext))
        let morning = try await run(
            summary, .button(NotificationAction.snoozeAllSlotIdentifier(startTime: "07:00"))
        )
        XCTAssertEqual(api.calls, [.snoozeSlot("next", nil), .snoozeSlot("07:00", nil)])
        XCTAssertEqual(next, .swept(api.sweepResult))
        XCTAssertEqual(morning, .swept(api.sweepResult))
        XCTAssertEqual(dismissed.count, 2)
    }

    func testSummaryCustomTimeSweepsUntilIt() async throws {
        let outcome = try await run(summary, .button(NotificationAction.snoozeAllCustom), customDueAt: customTime)
        XCTAssertEqual(api.calls, [.snoozeUntil(customTime, nil)])
        XCTAssertEqual(outcome, .swept(api.sweepResult))
    }

    /// The app delegates pass no time: the custom snoozes are the content
    /// extension's, which makes the call itself.
    func testSummaryCustomWithoutATimeSendsNothing() async throws {
        let outcome = try await run(summary, .button(NotificationAction.snoozeAllCustom))
        XCTAssertEqual(api.calls, [])
        XCTAssertEqual(outcome, .ignored)
        XCTAssertEqual(dismissed, [])
    }

    func testSummaryBodyTapOpensTheDashboard() async throws {
        let outcome = try await run(summary, .bodyTap)
        XCTAssertEqual(outcome, .openDashboard)
        XCTAssertEqual(api.calls, [])
    }

    /// A summary has no single task, so a task-only button is not its to run.
    func testSummaryIgnoresTaskActions() async throws {
        let done = try await run(summary, .button(NotificationAction.done), userInfo: taskInfo)
        let plusHour = try await run(summary, .button(NotificationAction.snooze1hr), userInfo: taskInfo)
        XCTAssertEqual(done, .ignored)
        XCTAssertEqual(plusHour, .ignored)
        XCTAssertEqual(api.calls, [])
    }

    // MARK: - Slot reminders

    func testSlotCompleteAllCompletesThePayloadsSlot() async throws {
        let outcome = try await run(
            slot, .button(NotificationAction.completeAll), userInfo: [SlotReminderKey.slotId: 7]
        )
        XCTAssertEqual(api.calls, [.completeSlot(7, [])])
        XCTAssertEqual(outcome, .slotCompleted(affected: 2))
        XCTAssertEqual(dismissed, [])
    }

    /// The un-slotted ("Anytime") group, and a payload missing the key.
    func testSlotCompleteAllWithoutASlotIdUsesAnytime() async throws {
        _ = try await run(slot, .button(NotificationAction.completeAll))
        XCTAssertEqual(api.calls, [.completeSlot(-1, [])])
    }

    func testSlotCompleteAllReportsZeroSoTheBannerCanStay() async throws {
        api.slotAffected = 0
        let outcome = try await run(slot, .button(NotificationAction.completeAll), userInfo: [SlotReminderKey.slotId: 7])
        XCTAssertEqual(outcome, .slotCompleted(affected: 0))
    }

    func testSlotBodyTapOpensTheDashboardAndOtherButtonsDoNothing() async throws {
        let body = try await run(slot, .bodyTap, userInfo: [SlotReminderKey.slotId: 7])
        let checked = try await run(slot, .button(NotificationAction.completeChecked))
        let sweep = try await run(slot, .button(NotificationAction.snoozeAll1hr))
        XCTAssertEqual(body, .openDashboard)
        XCTAssertEqual(checked, .ignored)
        XCTAssertEqual(sweep, .ignored)
        XCTAssertEqual(api.calls, [])
    }

    // MARK: - Task notifications (sweeps include the task)

    func testTaskDoneAndPlusHourActOnTheTask() async throws {
        let done = try await run(task, .button(NotificationAction.done), userInfo: taskInfo)
        let plusHour = try await run(task, .button(NotificationAction.snooze1hr), userInfo: taskInfo)
        XCTAssertEqual(api.calls, [.markDone(42), .snoozeNextHour(42)])
        XCTAssertEqual(done, .taskUpdated(taskId: 42))
        XCTAssertEqual(plusHour, .taskUpdated(taskId: 42))
        XCTAssertEqual(dismissed, [])
    }

    // MARK: - TASK_ADDED (the "AI finished" notification)

    func testTaskAddedDoneAndDeleteActOnTheTask() async throws {
        let added = NotificationCategory.taskAdded
        let done = try await run(added, .button(NotificationAction.done), userInfo: taskInfo)
        let delete = try await run(added, .button(NotificationAction.delete), userInfo: taskInfo)
        XCTAssertEqual(api.calls, [.markDone(42), .deleteTask(42)])
        XCTAssertEqual(done, .taskUpdated(taskId: 42))
        XCTAssertEqual(delete, .taskUpdated(taskId: 42))
        XCTAssertEqual(dismissed, [])
    }

    func testTaskAddedBodyTapOpensTheTask() async throws {
        let outcome = try await run(NotificationCategory.taskAdded, .bodyTap, userInfo: taskInfo)
        XCTAssertEqual(outcome, .openTask(taskId: 42))
        XCTAssertEqual(api.calls, [])
    }

    func testTaskAddedWithoutTaskIdSendsNothing() async throws {
        let outcome = try await run(NotificationCategory.taskAdded, .button(NotificationAction.delete))
        XCTAssertEqual(outcome, .missingTaskId)
        XCTAssertEqual(api.calls, [])
    }

    func testDeleteFailurePropagates() async throws {
        api.shouldThrow = true
        do {
            _ = try await run(NotificationCategory.taskAdded, .button(NotificationAction.delete), userInfo: taskInfo)
            XCTFail("expected the delete to throw")
        } catch {}
        XCTAssertEqual(api.calls, [.deleteTask(42)])
    }

    func testTaskSweepsIncludeTheTask() async throws {
        _ = try await run(task, .button(NotificationAction.snoozeAll1hr), userInfo: taskInfo)
        _ = try await run(task, .button(NotificationAction.snoozeAllSlotNext), userInfo: taskInfo)
        _ = try await run(task, .button(NotificationAction.snoozeAllCustom), userInfo: taskInfo, customDueAt: customTime)
        XCTAssertEqual(api.calls, [
            .snoozeDelta(60, 42),
            .snoozeSlot("next", 42),
            .snoozeUntil(customTime, 42),
        ])
        XCTAssertEqual(dismissed.count, 3)
    }

    func testTaskCustomSnoozeMovesJustTheTask() async throws {
        let outcome = try await run(task, .button(NotificationAction.snoozeCustom), userInfo: taskInfo, customDueAt: customTime)
        XCTAssertEqual(api.calls, [.snoozeTo(42, customTime)])
        XCTAssertEqual(outcome, .taskUpdated(taskId: 42))
    }

    func testTaskCustomWithoutATimeSendsNothing() async throws {
        let single = try await run(task, .button(NotificationAction.snoozeCustom), userInfo: taskInfo)
        let all = try await run(task, .button(NotificationAction.snoozeAllCustom), userInfo: taskInfo)
        XCTAssertEqual(single, .ignored)
        XCTAssertEqual(all, .ignored)
        XCTAssertEqual(api.calls, [])
    }

    func testTaskBodyTapOpensTheTask() async throws {
        let outcome = try await run(task, .bodyTap, userInfo: taskInfo)
        XCTAssertEqual(outcome, .openTask(taskId: 42))
        XCTAssertEqual(api.calls, [])
    }

    func testTaskWithoutATaskIdSendsNothing() async throws {
        let done = try await run(task, .button(NotificationAction.done))
        let body = try await run(task, .bodyTap)
        XCTAssertEqual(done, .missingTaskId)
        XCTAssertEqual(body, .missingTaskId)
        XCTAssertEqual(api.calls, [])
    }

    /// A category this build doesn't know is treated as a task push, as the
    /// delegates always did.
    func testUnknownCategoryIsATaskNotification() async throws {
        let outcome = try await run("SOMETHING_NEW", .button(NotificationAction.done), userInfo: taskInfo)
        XCTAssertEqual(outcome, .taskUpdated(taskId: 42))
    }

    func testUnknownButtonOnATaskSendsNothing() async throws {
        let outcome = try await run(task, .button("NOT_AN_ACTION"), userInfo: taskInfo)
        XCTAssertEqual(outcome, .ignored)
        XCTAssertEqual(api.calls, [])
    }

    // MARK: - Failures

    /// A failed sweep throws to the caller (haptics, error banner, keep the
    /// extension's notification up) and clears no banners.
    func testAFailedSweepThrowsAndDismissesNothing() async {
        api.shouldThrow = true
        do {
            _ = try await run(task, .button(NotificationAction.snoozeAll1hr), userInfo: taskInfo)
            XCTFail("expected the API error to propagate")
        } catch {
            XCTAssertTrue(error is StubError)
        }
        XCTAssertEqual(api.calls, [.snoozeDelta(60, 42)])
        XCTAssertEqual(dismissed, [])
    }

    func testAFailedCompleteAllThrows() async {
        api.shouldThrow = true
        do {
            _ = try await run(slot, .button(NotificationAction.completeAll), userInfo: [SlotReminderKey.slotId: 7])
            XCTFail("expected the API error to propagate")
        } catch {
            XCTAssertTrue(error is StubError)
        }
    }
}
