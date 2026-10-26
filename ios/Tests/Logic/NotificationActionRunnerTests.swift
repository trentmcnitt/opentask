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
        case markDoneOnDay(Int, String?)
        case deleteTask(Int)
        case snoozeNextHour(Int)
        case snoozeTo(Int, String)
        case snoozeDelta(Int, Int?)
        case snoozeUntil(String, Int?)
        case snoozeSlot(String, Int?)
        case completeSlot(Int, Set<String>, ProgressSource?)
        case considerPrompts([String])
        case didPrompts([String], ProgressSource?)
    }

    private struct StubError: Error {}

    private final class StubAPI: NotificationActionAPI {
        var calls: [Call] = []
        var shouldThrow = false
        var sweepResult = APIClient.BulkSnoozeResult(
            tasksAffected: 3, skippedOnPriority: 1, skippedHigh: 1, snoozedHigh: 0
        )
        var slotAffected = 2
        /// The server's `considered` for a `done` with `day`.
        var considered = true
        /// What the prompt routes throw, when set (e.g. the 400 for another
        /// day's key, `APIError.serverError(statusCode: 400)`).
        var promptError: Error?

        private func record(_ call: Call) throws {
            calls.append(call)
            if shouldThrow { throw StubError() }
        }

        func considerPrompts(keys: [String]) async throws -> APIClient.PromptActionResult {
            try record(.considerPrompts(keys))
            if let promptError { throw promptError }
            return APIClient.PromptActionResult(considered: keys.count, did: 0, tasks: [])
        }

        func didPrompts(keys: [String], source: ProgressSource?) async throws -> APIClient.PromptActionResult {
            try record(.didPrompts(keys, source))
            if let promptError { throw promptError }
            return APIClient.PromptActionResult(considered: keys.count, did: keys.count, tasks: [])
        }

        func markDone(taskId: Int) async throws { try record(.markDone(taskId)) }
        func markDone(taskId: Int, day: String?) async throws -> Bool {
            try record(.markDoneOnDay(taskId, day))
            return considered
        }
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

        func completeSlotReminders(slotId: Int, didKeys: Set<String>, source: ProgressSource?) async throws -> Int {
            try record(.completeSlot(slotId, didKeys, source))
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
        // `.mac`: this bundle is a macOS one, and a Mac notification says so.
        XCTAssertEqual(api.calls, [.completeSlot(7, [], .mac)])
        XCTAssertEqual(outcome, .slotCompleted(affected: 2))
        XCTAssertEqual(dismissed, [])
    }

    /// The un-slotted ("Anytime") group, and a payload missing the key.
    func testSlotCompleteAllWithoutASlotIdUsesAnytime() async throws {
        _ = try await run(slot, .button(NotificationAction.completeAll))
        XCTAssertEqual(api.calls, [.completeSlot(-1, [], .mac)])
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

    // MARK: - The deadlines-page nag (2026-10-22)

    /// No category (an empty identifier on the device), `kind: "deadlines"`,
    /// no `taskId`: the body tap opens the deadlines page and calls nothing.
    func testDeadlinesNagBodyTapOpensTheDeadlinesPage() async throws {
        let outcome = try await run("", .bodyTap, userInfo: ["kind": "deadlines"])
        XCTAssertEqual(outcome, .openDeadlines)
        XCTAssertEqual(api.calls, [])
        XCTAssertEqual(NotificationActionRunner.deadlinesKind, "deadlines")
    }

    /// It has no buttons; one that somehow arrives does nothing.
    func testDeadlinesNagIgnoresButtons() async throws {
        let outcome = try await run("", .button(NotificationAction.done), userInfo: ["kind": "deadlines"])
        XCTAssertEqual(outcome, .ignored)
        XCTAssertEqual(api.calls, [])
    }

    /// The other kinds without a task (the deadline cap) are unchanged.
    func testOtherTasklessKindsStillSendNothing() async throws {
        let outcome = try await run("", .bodyTap, userInfo: ["kind": "deadline-cap"])
        XCTAssertEqual(outcome, .missingTaskId)
    }

    // MARK: - The named reminder push (REMINDER_NAG, 2026-10-26)

    private let reminder = NotificationCategory.reminderNag
    /// As `buildReminderNagNotification` sends it: no `priority`.
    private let reminderInfo: [AnyHashable: Any] = ["taskId": 42, "reminder_day": "2026-01-15"]

    func testReminderNagIdentifiers() {
        XCTAssertEqual(NotificationCategory.reminderNag, "REMINDER_NAG")
        XCTAssertEqual(ReminderNagKey.day, "reminder_day")
    }

    /// Considered is the DONE identifier, and sends the payload's day.
    func testReminderConsideredSendsTheDay() async throws {
        let outcome = try await run(reminder, .button(NotificationAction.done), userInfo: reminderInfo)
        XCTAssertEqual(api.calls, [.markDoneOnDay(42, "2026-01-15")])
        XCTAssertEqual(outcome, .reminderConsidered(taskId: 42, considered: true))
        XCTAssertEqual(dismissed, [])
    }

    /// Another day's banner, or a reminder considered elsewhere: the server
    /// changed nothing, and that is a success — no throw, nothing else sent.
    func testReminderNotWaitingIsASuccess() async throws {
        api.considered = false
        let outcome = try await run(reminder, .button(NotificationAction.done), userInfo: reminderInfo)
        XCTAssertEqual(api.calls, [.markDoneOnDay(42, "2026-01-15")])
        XCTAssertEqual(outcome, .reminderConsidered(taskId: 42, considered: false))
    }

    /// A real failure still throws, as every other action's does.
    func testReminderConsideredFailurePropagates() async {
        api.shouldThrow = true
        do {
            _ = try await run(reminder, .button(NotificationAction.done), userInfo: reminderInfo)
            XCTFail("expected the API error to propagate")
        } catch {
            XCTAssertTrue(error is StubError)
        }
        XCTAssertEqual(api.calls, [.markDoneOnDay(42, "2026-01-15")])
    }

    /// Without a day there is nothing safe to send: a plain done would
    /// advance whatever occurrence is current.
    func testReminderWithoutADaySendsNothing() async throws {
        let outcome = try await run(reminder, .button(NotificationAction.done), userInfo: ["taskId": 42])
        XCTAssertEqual(outcome, .ignored)
        XCTAssertEqual(api.calls, [])
    }

    func testReminderBodyTapOpensTheTask() async throws {
        let outcome = try await run(reminder, .bodyTap, userInfo: reminderInfo)
        XCTAssertEqual(outcome, .openTask(taskId: 42))
        XCTAssertEqual(api.calls, [])
    }

    /// No snooze, no sweep, no delete on a reminder banner, whatever arrives.
    func testReminderIgnoresEveryOtherButton() async throws {
        for id in [
            NotificationAction.snooze1hr, NotificationAction.snoozeAll1hr, NotificationAction.snoozeAllSlotNext,
            NotificationAction.delete, NotificationAction.completeAll,
        ] {
            let outcome = try await run(reminder, .button(id), userInfo: reminderInfo)
            XCTAssertEqual(outcome, .ignored, id)
        }
        XCTAssertEqual(api.calls, [])
        XCTAssertEqual(dismissed, [])
    }

    func testReminderWithoutATaskIdSendsNothing() async throws {
        let outcome = try await run(reminder, .button(NotificationAction.done), userInfo: ["reminder_day": "2026-01-15"])
        XCTAssertEqual(outcome, .missingTaskId)
        XCTAssertEqual(api.calls, [])
    }

    // MARK: - The named quota-prompt push (QUOTA_NAG, Push PR 4b, 2026-10-26)

    private let quota = NotificationCategory.quotaNag
    private let promptKey = "q:42:1:2026-01-15"
    /// As `buildPromptNagNotification` sends it: the quota's id and the
    /// prompt's key, no priority.
    private var quotaInfo: [AnyHashable: Any] { ["taskId": 42, "prompt_key": promptKey] }
    private let staleKey = APIError.serverError(statusCode: 400)

    func testQuotaNagIdentifiers() {
        XCTAssertEqual(NotificationCategory.quotaNag, "QUOTA_NAG")
        XCTAssertEqual(QuotaNagKey.promptKey, "prompt_key")
        XCTAssertEqual(QuotaNagKey.dismissPromptKeys, "promptKeys")
        XCTAssertNotEqual(NotificationAction.considered, NotificationAction.didIt)
        XCTAssertEqual(NotificationActionRunner.staleDidMessage, "That was yesterday's — open OpenTask to log it")
    }

    /// Considered sends the key to /consider — no source, no task id.
    func testPromptConsideredSendsTheKey() async throws {
        let outcome = try await run(quota, .button(NotificationAction.considered), userInfo: quotaInfo)
        XCTAssertEqual(api.calls, [.considerPrompts([promptKey])])
        XCTAssertEqual(outcome, .promptConsidered(promptKey: promptKey))
        XCTAssertEqual(dismissed, [])
    }

    /// Did it sends the key to /did with the device's source. This bundle runs
    /// on macOS, so that is `mac`; the watch build sends `watch` and the
    /// iPhone none (`ProgressSource.forNotificationActions`,
    /// `ProgressSourceTests`).
    func testPromptDidSendsTheKeyAndTheSource() async throws {
        let outcome = try await run(quota, .button(NotificationAction.didIt), userInfo: quotaInfo)
        XCTAssertEqual(ProgressSource.forNotificationActions, .mac)
        XCTAssertEqual(api.calls, [.didPrompts([promptKey], ProgressSource.forNotificationActions)])
        XCTAssertEqual(outcome, .promptDid(promptKey: promptKey))
    }

    /// Considered on another day's key: the server's 400 is nothing to do —
    /// the same quiet outcome as a success, no throw.
    func testPromptConsideredOnAnotherDaysKeyIsQuiet() async throws {
        api.promptError = staleKey
        let outcome = try await run(quota, .button(NotificationAction.considered), userInfo: quotaInfo)
        XCTAssertEqual(api.calls, [.considerPrompts([promptKey])])
        XCTAssertEqual(outcome, .promptConsidered(promptKey: promptKey))
    }

    /// Did it on another day's key: nothing was logged, so its own outcome
    /// (the device says "That was yesterday's"), not a success and not a throw.
    func testPromptDidOnAnotherDaysKeyIsStale() async throws {
        api.promptError = staleKey
        let outcome = try await run(quota, .button(NotificationAction.didIt), userInfo: quotaInfo)
        XCTAssertEqual(api.calls, [.didPrompts([promptKey], ProgressSource.forNotificationActions)])
        XCTAssertEqual(outcome, .promptDidStale(promptKey: promptKey))
    }

    /// Any other failure (a 500, the network, not configured) propagates for
    /// both buttons, as every other action's does.
    func testPromptOtherFailuresPropagate() async {
        for (button, error) in [
            (NotificationAction.considered, APIError.serverError(statusCode: 500)),
            (NotificationAction.didIt, APIError.serverError(statusCode: 500)),
            (NotificationAction.didIt, APIError.serverError(statusCode: 403)),
            (NotificationAction.considered, APIError.notConfigured),
        ] {
            api.promptError = error
            do {
                _ = try await run(quota, .button(button), userInfo: quotaInfo)
                XCTFail("expected \(error) to propagate from \(button)")
            } catch {
                XCTAssertTrue(error is APIError, button)
            }
        }
    }

    /// No key, no call: the routes take keys only.
    func testPromptWithoutAKeySendsNothing() async throws {
        for button in [NotificationAction.considered, NotificationAction.didIt] {
            let none = try await run(quota, .button(button), userInfo: ["taskId": 42])
            let empty = try await run(quota, .button(button), userInfo: ["taskId": 42, "prompt_key": ""])
            XCTAssertEqual(none, .ignored, button)
            XCTAssertEqual(empty, .ignored, button)
        }
        XCTAssertEqual(api.calls, [])
    }

    /// A body tap opens the prompt's row: `/reminders?prompt=<key>`.
    func testPromptBodyTapOpensItsRow() async throws {
        let outcome = try await run(quota, .bodyTap, userInfo: quotaInfo)
        XCTAssertEqual(outcome, .openPrompt(promptKey: promptKey))
        XCTAssertEqual(api.calls, [])
        guard case .openPrompt(let key) = outcome else { return XCTFail("not openPrompt") }
        XCTAssertEqual(PromptDeepLink.webPath(promptKey: key), "/reminders?prompt=q:42:1:2026-01-15")
    }

    /// Without a key, a body tap opens the quota by its id, as an older build would.
    func testPromptBodyTapWithoutAKeyOpensTheQuota() async throws {
        let byId = try await run(quota, .bodyTap, userInfo: ["taskId": 42])
        let neither = try await run(quota, .bodyTap, userInfo: [:])
        XCTAssertEqual(byId, .openTask(taskId: 42))
        XCTAssertEqual(neither, .missingTaskId)
    }

    /// No Done, snooze, sweep or delete on a quota-prompt banner.
    func testPromptIgnoresEveryOtherButton() async throws {
        for id in [
            NotificationAction.done, NotificationAction.snooze1hr, NotificationAction.snoozeAll1hr,
            NotificationAction.snoozeAllSlotNext, NotificationAction.delete, NotificationAction.completeAll,
        ] {
            let outcome = try await run(quota, .button(id), userInfo: quotaInfo)
            XCTAssertEqual(outcome, .ignored, id)
        }
        XCTAssertEqual(api.calls, [])
        XCTAssertEqual(dismissed, [])
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
