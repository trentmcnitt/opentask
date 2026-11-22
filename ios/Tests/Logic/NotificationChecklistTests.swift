import XCTest

/// The shared notification checklist (`NotificationChecklist`, NCL-1…7) and
/// the period checklist on it (`PeriodChecklist`). Every title is invented.
final class NotificationChecklistTests: XCTestCase {

    // MARK: - Fixtures

    private struct Plain: ChecklistItem {
        let n: Int
        var checklistKey: String { "k\(n)" }
    }

    private func list(_ count: Int, held: Int? = nil) -> ChecklistState<Plain> {
        var state = ChecklistState<Plain>(
            rows: [], marks: held.map { ["k\($0)": .check] } ?? [:], load: .loading, heldKey: held.map { "k\($0)" }
        )
        state.apply(fetched: (0 ..< count).map { Plain(n: $0 + 1) })
        return state
    }

    private func reminder(_ id: Int) -> TaskDTO {
        TaskDTO(id: id, title: "Invented reminder \(id)", priority: 0, isReminder: true)
    }

    private func prompt(_ key: String, taskId: Int = 50) -> QuotaPromptDTO {
        QuotaPromptDTO(
            promptKey: key, taskId: taskId, number: nil, numbers: nil, slotId: nil,
            title: "Invented quota", current: 0, target: 3, period: "WEEKLY", stripeColor: nil,
            considered: false, done: false, hasNotes: false
        )
    }

    private func group(reminders: [Int], prompts: [String]) -> ReminderGroupDTO {
        ReminderGroupDTO(slot: nil, reminders: reminders.map(reminder), prompts: prompts.map { prompt($0) })
    }

    private func titles(_ rows: [TaskNotificationList.Row]) -> [String] { rows.map(\.title) }
    private func ids(_ rows: [TaskNotificationList.Row]) -> [String] { rows.map(\.identifier) }

    // MARK: - NCL-2 pages

    func testNCL2_pagesOfSixWithLinksByPage() {
        var state = list(14)  // 6, 6, 2
        XCTAssertEqual(state.pageCount, 3)
        XCTAssertEqual([state.showsLess, state.showsMore], [false, true])
        XCTAssertEqual(state.pageSpacers, 0)
        state.showMore()
        XCTAssertEqual(state.pageRows.map(\.n), [7, 8, 9, 10, 11, 12])
        XCTAssertEqual([state.showsLess, state.showsMore], [true, true])
        state.showMore()
        XCTAssertEqual(state.pageRows.map(\.n), [13, 14])
        XCTAssertEqual(state.pageSpacers, 4, "the last page is padded to six rows")
        XCTAssertEqual([state.showsLess, state.showsMore], [true, false])
        state.showLess()
        XCTAssertEqual(state.pageRows.map(\.n), [7, 8, 9, 10, 11, 12], "back one page, not to the start")
    }

    func testNCL2_aSinglePageHasNoLinksAndNoSpacers() {
        let state = list(4)
        XCTAssertEqual(state.pageCount, 1)
        XCTAssertFalse(state.showsLess)
        XCTAssertFalse(state.showsMore)
        XCTAssertEqual(state.pageSpacers, 0)
    }

    func testNCL2_marksSurvivePagingAndTheHeaderCountsEveryPage() {
        var state = list(20)
        state.toggle("k2")
        state.showMore()
        state.choose("k9", .did)
        state.showLess()
        XCTAssertEqual(state.mark(of: "k2"), .check)
        XCTAssertEqual(state.mark(of: "k9"), .did)
        XCTAssertEqual(state.headerCount(noun: "waiting"), "2 of 20 checked")
        XCTAssertEqual(state.marked.map(\.item.n), [2, 9], "list order, every page")
    }

    // MARK: - NCL-1 marks

    func testNCL1_oneChoicePerRow() {
        var state = list(3)
        state.choose("k1", .check)
        state.choose("k1", .did)
        XCTAssertEqual(state.mark(of: "k1"), .did, "the other control switches it")
        state.choose("k1", .did)
        XCTAssertNil(state.mark(of: "k1"), "the same control again clears it")
        state.toggle("k5")
        XCTAssertNil(state.mark(of: "k5"), "a row that isn't listed can't be marked")
    }

    // MARK: - NCL-3 held row

    func testNCL3_theHeldRowGoesFirstWhileListedAndDropsOffWhenNot() {
        var state = ChecklistState<Plain>(rows: [Plain(n: 7)], marks: ["k7": .check], load: .loading, heldKey: "k7")
        state.apply(fetched: [Plain(n: 1), Plain(n: 7), Plain(n: 2)])
        XCTAssertEqual(state.rows.map(\.n), [7, 1, 2])
        XCTAssertEqual(state.mark(of: "k7"), .check)
        state.apply(fetched: [Plain(n: 1), Plain(n: 2)])
        XCTAssertEqual(state.rows.map(\.n), [1, 2])
        XCTAssertEqual(state.markedCount, 0)
    }

    // MARK: - Words (Trent, 2026-11-21: imperative)

    func testWords_theCommitVerbIsNamedForTheMarks() {
        XCTAssertNil(NotificationWords.commitVerb([]))
        XCTAssertEqual(NotificationWords.commitVerb([.check, .check]), "Consider")
        XCTAssertEqual(NotificationWords.commitVerb([.did]), "Did")
        XCTAssertEqual(NotificationWords.commitVerb([.check, .did]), "Log")
        XCTAssertEqual(NotificationWords.counted("Consider", 1), "Consider")
        XCTAssertEqual(NotificationWords.counted("Consider", 3), "Consider (3)")
    }

    // MARK: - The period checklist (NCL-4 counts, NCL-6 Cancel last)

    func testPeriod_rowsAreItsRemindersThenItsWaitingPrompts() {
        let items = PeriodChecklist.items(group(reminders: [1, 2], prompts: ["q:50:0:2026-01-15"]))
        XCTAssertEqual(items.map(\.checklistKey), ["r:1", "r:2", "q:50:0:2026-01-15"])
    }

    func testPeriod_actionsByWhatIsMarked() {
        var state = PeriodChecklist.opening()
        state.apply(fetched: PeriodChecklist.items(group(reminders: [1, 2], prompts: ["qa", "qb"])))
        XCTAssertEqual(titles(PeriodChecklist.actions(for: state)), ["Consider all", "Cancel"])
        state.toggle("r:1")
        XCTAssertEqual(titles(PeriodChecklist.actions(for: state)), ["Consider", "Consider all", "Cancel"])
        state.toggle("r:2")
        state.choose("qa", .check)
        XCTAssertEqual(titles(PeriodChecklist.actions(for: state)).first, "Consider (3)")
        state.choose("qb", .did)
        XCTAssertEqual(titles(PeriodChecklist.actions(for: state)).first, "Log (4)")
        XCTAssertEqual(ids(PeriodChecklist.actions(for: state)), [
            NotificationAction.completeChecked, NotificationAction.completeAll, NotificationAction.cancel,
        ])
        var dids = PeriodChecklist.opening()
        dids.apply(fetched: PeriodChecklist.items(group(reminders: [], prompts: ["qa", "qb"])))
        dids.choose("qa", .did)
        dids.choose("qb", .did)
        XCTAssertEqual(titles(PeriodChecklist.actions(for: dids)).first, "Did (2)")
    }

    func testPeriod_nothingWaitingLeavesOnlyCancel() {
        var state = PeriodChecklist.opening()
        state.apply(fetched: [])
        XCTAssertEqual(titles(PeriodChecklist.actions(for: state)), ["Cancel"])
    }

    // MARK: - The period checklist's commit (NCL-4, NCL-5, NCL-7)

    private final class StubAPI: PeriodChecklistAPI {
        var group: ReminderGroupDTO?
        var sent: [(ids: [Int], prompts: [APIClient.PromptCommit])] = []
        var affected: Int?
        var sendError: Error?
        var fetches = 0

        func fetchSlotGroup(slotId: Int) async throws -> ReminderGroupDTO? {
            fetches += 1
            return group
        }
        func completeChecklist(ids: [Int], prompts: [APIClient.PromptCommit]) async throws -> Int {
            sent.append((ids, prompts))
            if let sendError { throw sendError }
            return affected ?? (ids.count + prompts.count)
        }
    }

    private func marked(_ setup: (inout PeriodChecklist.State) -> Void) -> PeriodChecklist.State {
        var state = PeriodChecklist.opening()
        state.apply(fetched: PeriodChecklist.items(group(reminders: [1, 2, 3], prompts: ["qa", "qb"])))
        setup(&state)
        return state
    }

    func testCommit_oneRequestWithRemindersAndPromptsByMark() async throws {
        let api = StubAPI()
        api.group = group(reminders: [1, 2, 3], prompts: ["qa", "qb"])
        let state = marked {
            $0.toggle("r:2")
            $0.choose("qa", .check)
            $0.choose("qb", .did)
        }
        let outcome = try await PeriodChecklist.commit(state, slotId: 4, api: api)
        XCTAssertEqual(api.sent.count, 1)
        XCTAssertEqual(api.sent[0].ids, [2])
        XCTAssertEqual(api.sent[0].prompts, [
            APIClient.PromptCommit(key: "qa", did: false), APIClient.PromptCommit(key: "qb", did: true),
        ])
        guard case .sent(let empty) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertFalse(empty, "reminders 1 and 3 still wait: the banner stays")
    }

    func testCommit_thePeriodLeftEmptyTakesItsBanner() async throws {
        let api = StubAPI()
        api.group = group(reminders: [1], prompts: [])
        var state = PeriodChecklist.opening()
        state.apply(fetched: PeriodChecklist.items(api.group))
        state.toggle("r:1")
        let outcome = try await PeriodChecklist.commit(state, slotId: 4, api: api)
        guard case .sent(let empty) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertTrue(empty)
    }

    func testCommit_theRecheckDropsRowsHandledElsewhere() async throws {
        let api = StubAPI()
        // Reminder 2 was considered elsewhere; prompt qa is yesterday's.
        api.group = group(reminders: [1, 3], prompts: ["qb"])
        let state = marked {
            $0.toggle("r:2")
            $0.toggle("r:3")
            $0.choose("qa", .did)
        }
        _ = try await PeriodChecklist.commit(state, slotId: 4, api: api)
        XCTAssertEqual(api.sent.first?.ids, [3])
        XCTAssertEqual(api.sent.first?.prompts, [])
    }

    func testCommit_nothingLeftSendsNothingAndStays() async throws {
        let api = StubAPI()
        api.group = group(reminders: [1], prompts: [])
        let state = marked { $0.toggle("r:2") }
        let outcome = try await PeriodChecklist.commit(state, slotId: 4, api: api)
        XCTAssertTrue(api.sent.isEmpty)
        guard case .nothingLeft(let current) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertEqual(current?.reminders.map(\.id), [1])
    }

    func testCommit_aRefusedBatchIsRefused() async throws {
        let api = StubAPI()
        api.group = group(reminders: [1, 2, 3], prompts: ["qa", "qb"])
        api.sendError = APIError.serverError(statusCode: 400)
        let outcome = try await PeriodChecklist.commit(marked { $0.choose("qa", .did) }, slotId: 4, api: api)
        guard case .refused = outcome else { return XCTFail("\(outcome)") }
    }

    func testCommit_nothingMarkedFetchesNothing() async throws {
        let api = StubAPI()
        let outcome = try await PeriodChecklist.commit(marked { _ in }, slotId: 4, api: api)
        XCTAssertEqual(api.fetches, 0)
        guard case .nothingMarked = outcome else { return XCTFail("\(outcome)") }
    }

    func testCommit_theServerActingOnNothingIsNotASuccess() async throws {
        let api = StubAPI()
        api.group = group(reminders: [1, 2, 3], prompts: ["qa", "qb"])
        api.affected = 0
        let outcome = try await PeriodChecklist.commit(marked { $0.toggle("r:1") }, slotId: 4, api: api)
        guard case .nothingLeft = outcome else { return XCTFail("\(outcome)") }
    }
}
