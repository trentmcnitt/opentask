import XCTest

/// The checklist on a named reminder or quota-prompt push (`NagChecklist`,
/// 2026-11-21). Invented titles. Periods: Morning 09:00, Midday 12:00,
/// Bedtime 21:00; the day starts at 03:00.
final class NagChecklistTests: XCTestCase {

    private let day = OpenTaskDay(dayStart: "03:00", timeZone: .current)
    private let morning = TimeSlotDTO(id: 1, label: "Morning", startTime: "09:00")
    private let midday = TimeSlotDTO(id: 2, label: "Midday", startTime: "12:00")
    private let bedtime = TimeSlotDTO(id: 3, label: "Bedtime", startTime: "21:00")
    private var slots: [TimeSlotDTO] { [morning, midday, bedtime] }

    private func today(_ hour: Int, _ minute: Int = 0) -> Date {
        Calendar.current.date(bySettingHour: hour, minute: minute, second: 0, of: Date())!
    }

    private func reminder(_ id: Int) -> TaskDTO {
        TaskDTO(id: id, title: "Invented reminder \(id)", priority: 2, isReminder: true)
    }

    private func prompt(_ key: String) -> QuotaPromptDTO {
        QuotaPromptDTO(
            promptKey: key, taskId: 50, number: nil, numbers: nil, slotId: nil,
            title: "Invented quota", current: 0, target: 3, period: "WEEKLY", stripeColor: nil,
            considered: false, done: false, hasNotes: false
        )
    }

    private func groups() -> [ReminderGroupDTO] {
        [
            ReminderGroupDTO(slot: midday, reminders: [reminder(20)], prompts: [prompt("qm")]),
            ReminderGroupDTO(slot: morning, reminders: [reminder(10), reminder(11)], prompts: []),
            ReminderGroupDTO(slot: bedtime, reminders: [reminder(30)], prompts: []),
            ReminderGroupDTO(slot: nil, reminders: [reminder(99)], prompts: []),
        ]
    }

    private func loaded(held: String, at now: Date) -> NagChecklist.State {
        var state = NagChecklist.opening(heldKey: held)
        state.apply(fetched: NagChecklist.items(groups(), now: now, day: day))
        return state
    }

    private func titles(_ rows: [TaskNotificationList.Row]) -> [String] { rows.map(\.title) }

    // MARK: - Rows

    func testRowsAreTheOpenedPeriodsInDayOrderHeldFirstNeverAnytime() {
        let state = loaded(held: "r:20", at: today(13))
        XCTAssertEqual(state.rows.map(\.checklistKey), ["r:20", "r:10", "r:11", "qm"])
        XCTAssertEqual(state.mark(of: "r:20"), .check)
        XCTAssertTrue(NagChecklist.showsPeriodLabels(state), "Morning and Midday: each row names its period")
    }

    func testOnePeriodNeedsNoLabels() {
        let state = loaded(held: "r:10", at: today(10))
        XCTAssertEqual(state.rows.map(\.checklistKey), ["r:10", "r:11"])
        XCTAssertFalse(NagChecklist.showsPeriodLabels(state))
    }

    func testAPromptPushHoldsItsKey() {
        let state = loaded(held: "qm", at: today(13))
        XCTAssertEqual(state.rows.first?.checklistKey, "qm")
        XCTAssertEqual(state.mark(of: "qm"), .check)
    }

    // MARK: - The move's period

    func testTheMoveGoesAfterNowAndAfterEveryCheckedRowsPeriod() {
        var state = loaded(held: "r:10", at: today(13))
        XCTAssertEqual(titles(NagChecklist.actions(for: state, slots: slots, now: today(13), day: day)), [
            "Consider", "\u{2192} Bedtime \u{00B7} \(NagChecklist.clock(bedtime))", "Cancel",
        ])
        state.toggle("r:20")
        state.choose("qm", .did)
        XCTAssertEqual(titles(NagChecklist.actions(for: state, slots: slots, now: today(13), day: day)), [
            "Log (3)", "\u{2192} Bedtime \u{00B7} \(NagChecklist.clock(bedtime)) (3)", "Cancel",
        ])
        let early = loaded(held: "r:10", at: today(10))
        XCTAssertEqual(
            NagChecklist.moveTarget(marked: early.marked.map(\.item), slots: slots, now: today(10), day: day)?.label,
            "Midday"
        )
    }

    /// The designer's check: a held Bedtime reminder (the last period) shows
    /// the commit and Cancel only.
    func testABedtimeReminderHasNoMoveRow() {
        let state = loaded(held: "r:30", at: today(21, 30))
        XCTAssertEqual(titles(NagChecklist.actions(for: state, slots: slots, now: today(21, 30), day: day)), [
            "Consider", "Cancel",
        ])
    }

    func testNothingCheckedLeavesOnlyCancel() {
        var state = loaded(held: "r:10", at: today(10))
        state.toggle("r:10")
        XCTAssertEqual(titles(NagChecklist.actions(for: state, slots: slots, now: today(10), day: day)), ["Cancel"])
    }

    func testAllSquaresSayDid() {
        var state = loaded(held: "qm", at: today(13))
        state.choose("qm", .did)
        XCTAssertEqual(titles(NagChecklist.actions(for: state, slots: slots, now: today(13), day: day)).first, "Did")
    }

    // MARK: - The commit, with a stub

    private final class StubAPI: NagChecklistAPI {
        enum Call: Equatable {
            case fetch
            case complete([Int], [APIClient.PromptCommit])
            case move([Int], [String], Int)
        }
        var calls: [Call] = []
        var groups: [ReminderGroupDTO] = []
        var error: Error?

        func fetchReminderGroups() async throws -> [ReminderGroupDTO] {
            calls.append(.fetch)
            return groups
        }
        func completeChecklist(ids: [Int], prompts: [APIClient.PromptCommit]) async throws -> Int {
            calls.append(.complete(ids, prompts))
            if let error { throw error }
            return ids.count + prompts.count
        }
        func moveForToday(ids: [Int], promptKeys: [String], slotId: Int) async throws -> APIClient.MoveResult {
            calls.append(.move(ids, promptKeys, slotId))
            if let error { throw error }
            return APIClient.MoveResult(moved: ids, movedPrompts: promptKeys, slotId: slotId, slotLabel: "")
        }
    }

    func testTheCommitIsOneBulkRequestWithEachRowsMark() async throws {
        let api = StubAPI()
        api.groups = groups()
        var state = loaded(held: "r:20", at: today(13))
        state.toggle("r:11")
        state.choose("qm", .did)
        let outcome = try await NagChecklist.commit(
            .commit, state: state, slots: slots, now: today(13), day: day, api: api
        )
        XCTAssertEqual(api.calls, [.fetch, .complete([20, 11], [APIClient.PromptCommit(key: "qm", did: true)])])
        guard case let .sent(ids, keys, own) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertEqual(ids, [20, 11])
        XCTAssertEqual(keys, ["qm"])
        XCTAssertTrue(own)
    }

    func testTheMoveSendsEveryCheckedRowToOnePeriod() async throws {
        let api = StubAPI()
        api.groups = groups()
        var state = loaded(held: "r:10", at: today(10))
        state.toggle("r:11")
        _ = try await NagChecklist.commit(.move, state: state, slots: slots, now: today(10), day: day, api: api)
        XCTAssertEqual(api.calls, [.fetch, .move([10, 11], [], midday.id)])
    }

    func testTheRecheckDropsRowsHandledElsewhere() async throws {
        let api = StubAPI()
        api.groups = [ReminderGroupDTO(slot: morning, reminders: [reminder(11)], prompts: [])]
        var state = loaded(held: "r:10", at: today(10))
        state.toggle("r:11")
        _ = try await NagChecklist.commit(.commit, state: state, slots: slots, now: today(10), day: day, api: api)
        XCTAssertEqual(api.calls, [.fetch, .complete([11], [])])
    }

    func testARefusedBatchIsRefused() async throws {
        let api = StubAPI()
        api.groups = groups()
        api.error = APIError.serverError(statusCode: 400)
        let outcome = try await NagChecklist.commit(
            .move, state: loaded(held: "r:10", at: today(10)), slots: slots, now: today(10), day: day, api: api
        )
        guard case .refused = outcome else { return XCTFail("\(outcome)") }
    }
}
