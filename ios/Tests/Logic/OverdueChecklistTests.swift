import XCTest

/// The overdue checklist — a task notification's long-press (2026-11-21).
/// Each test is named for the rule it pins (`OverdueChecklist`'s TNC-1…9)
/// or the state-table case it plays. Every title is invented.
final class OverdueChecklistTests: XCTestCase {

    private let periods = [
        TimeSlotDTO(id: 1, label: "Morning", startTime: "09:00"),
        TimeSlotDTO(id: 2, label: "Midday", startTime: "12:00"),
        TimeSlotDTO(id: 3, label: "Afternoon", startTime: "15:00"),
        TimeSlotDTO(id: 4, label: "Evening", startTime: "20:30"),
    ]

    /// Local wall-clock time on 2026-01-15 (+ `day` days).
    private func local(_ hour: Int, _ minute: Int = 0, day: Int = 0) -> Date {
        var c = DateComponents()
        c.year = 2026
        c.month = 1
        c.day = 15 + day
        c.hour = hour
        c.minute = minute
        return Calendar.current.date(from: c)!
    }

    private func iso(_ date: Date) -> String { DateHelpers.formatISO(date) }
    private func clock(_ date: Date) -> String { DateHelpers.formatShortTime(date) }

    private func task(_ id: Int, _ title: String, priority: Int = 0, due: Date?) -> TaskDTO {
        TaskDTO(id: id, title: title, priority: priority, dueAt: due.map(iso))
    }

    /// The pressed task, as its payload draws it.
    private func held(_ id: Int = 1, due: Date? = nil) -> OverdueChecklist.State {
        .held(OverdueChecklist.Row(
            id: id, title: "Return the borrowed ladder", priority: 0, dueAt: iso(due ?? local(8)), fromPayload: true
        ))
    }

    /// `count` overdue tasks with ids 1…count, the held one (id 1) first in time.
    private func overdue(_ count: Int) -> [TaskDTO] {
        (1...count).map { task($0, "Invented chore \($0)", due: local(8, $0)) }
    }

    private func ids(_ rows: [OverdueChecklist.Row]) -> [Int] { rows.map(\.id) }
    private func titles(_ rows: [TaskNotificationList.Row]) -> [String] { rows.map(\.title) }
    private func actionIds(_ rows: [TaskNotificationList.Row]) -> [String] { rows.map(\.identifier) }

    private func actions(_ state: OverdueChecklist.State, picked: Date? = nil, slots: [TimeSlotDTO]? = nil)
        -> [TaskNotificationList.Row]
    {
        OverdueChecklist.actions(for: state, picked: picked, now: local(10, 20), slots: slots ?? periods)
    }

    // MARK: - TNC-1 rows and order

    func testTNC1_heldFirstThenPriorityThenMostOverdue() {
        var state = held(5, due: local(9))
        state.apply(fetched: [
            task(2, "Sort the seed packets", due: local(7)),
            task(3, "Oil the gate hinge", priority: 3, due: local(9, 30)),
            task(4, "Label the spice jars", priority: 3, due: local(6)),
            task(5, "Return the borrowed ladder", due: local(9)),
            task(6, "Undated errand", due: nil),
            task(7, "Phone the tile shop", priority: 4, due: local(10)),
        ])
        // Held, then Urgent, then the two Highs most overdue first, then the
        // rest most overdue first, undated last.
        XCTAssertEqual(ids(state.rows), [5, 7, 4, 3, 2, 6])
    }

    func testTNC1_theFetchedRowReplacesThePayloadsAndStaysChecked() {
        var state = held(1, due: local(8))
        state.apply(fetched: [task(1, "Return the borrowed ladder", due: local(8, 5)), task(2, "Other", due: local(7))])
        XCTAssertEqual(state.rows.first?.dueDate, local(8, 5))
        XCTAssertEqual(state.rows.first?.fromPayload, false)
        XCTAssertTrue(state.isChecked(1))
    }

    // MARK: - TNC-2 held row

    func testTNC2_heldOpensCheckedAndWorksBeforeTheFetch() {
        let state = held()
        XCTAssertEqual(ids(state.rows), [1])
        XCTAssertTrue(state.isChecked(1))
        XCTAssertEqual(state.load, .loading)
        XCTAssertEqual(actionIds(actions(state)).first, NotificationAction.done)
    }

    func testTNC2_aHeldTaskHandledElsewhereDropsOffUnchecked() {
        var state = held(1)
        state.apply(fetched: [task(2, "Sort the seed packets", due: local(7))])
        XCTAssertEqual(ids(state.rows), [2])
        XCTAssertTrue(state.checked.isEmpty)
        XCTAssertEqual(actionIds(actions(state)), [NotificationAction.cancel])
    }

    func testTNC2_aFailedFetchLeavesTheHeldRowWorking() {
        var state = held()
        state.fetchFailed()
        XCTAssertEqual(state.load, .failed)
        XCTAssertEqual(ids(state.rows), [1])
        XCTAssertEqual(actionIds(actions(state)).first, NotificationAction.done)
    }

    // MARK: - TNC-3 pages of six

    func testTNC3_oneRowIsOnePageWithNoLinks() {
        var state = held()
        state.apply(fetched: overdue(1))
        XCTAssertEqual(state.pageCount, 1)
        XCTAssertFalse(state.showsLess)
        XCTAssertFalse(state.showsMore)
    }

    func testTNC3_sixRowsFitOnePageSevenMakeTwo() {
        var six = held()
        six.apply(fetched: overdue(6))
        XCTAssertEqual(six.pageCount, 1)
        var seven = held()
        seven.apply(fetched: overdue(7))
        XCTAssertEqual(seven.pageCount, 2)
        XCTAssertEqual(ids(seven.pageRows), [1, 2, 3, 4, 5, 6], "page 1 = the held task and 5 more")
    }

    func testTNC3_linksByPageAndShowLessGoesBackOnePage() {
        var state = held()
        state.apply(fetched: overdue(14))  // pages of 6, 6, 2
        XCTAssertEqual(state.pageCount, 3)
        XCTAssertEqual([state.showsLess, state.showsMore], [false, true])
        state.showMore()
        XCTAssertEqual([state.showsLess, state.showsMore], [true, true])
        XCTAssertEqual(ids(state.pageRows), [7, 8, 9, 10, 11, 12])
        state.showMore()
        XCTAssertEqual([state.showsLess, state.showsMore], [true, false])
        XCTAssertEqual(ids(state.pageRows), [13, 14])
        state.showMore()
        XCTAssertEqual(ids(state.pageRows), [13, 14], "no page past the last")
        state.showLess()
        XCTAssertEqual(ids(state.pageRows), [7, 8, 9, 10, 11, 12], "one page back, not to the start")
    }

    func testTNC3_checksSurvivePagingAndTheHeaderCountsEveryPage() {
        var state = held()
        state.apply(fetched: overdue(20))
        state.showMore()
        state.toggle(8)
        state.showLess()
        XCTAssertTrue(state.isChecked(1))
        XCTAssertTrue(state.isChecked(8))
        XCTAssertEqual(state.headerCount, "2 of 20 checked")
        XCTAssertEqual(titles(actions(state)).first, "Done (2)")
    }

    func testTNC3_aShorterReloadKeepsTheViewOnAPageThatExists() {
        var state = held()
        state.apply(fetched: overdue(14))
        state.showMore()
        state.showMore()
        state.apply(fetched: overdue(4))
        XCTAssertEqual(state.page, 0)
        XCTAssertEqual(ids(state.pageRows), [1, 2, 3, 4])
    }

    // MARK: - TNC-4 one request, "(N)"

    func testTNC4_oneCheckedHasNoCountTwoOrMoreDo() {
        var state = held()
        state.apply(fetched: overdue(4))
        XCTAssertEqual(titles(actions(state)), [
            "Done",
            "Midday \u{00B7} \(clock(local(12)))",
            "+1 hour \u{00B7} \(clock(local(11)))",
            "Afternoon \u{00B7} \(clock(local(15)))",
            "Evening \u{00B7} \(clock(local(20, 30)))",
            "Cancel",
        ])
        state.toggle(2)
        state.toggle(3)
        XCTAssertEqual(titles(actions(state)), [
            "Done (3)",
            "Midday \u{00B7} \(clock(local(12))) (3)",
            "+1 hour \u{00B7} \(clock(local(11))) (3)",
            "Afternoon \u{00B7} \(clock(local(15))) (3)",
            "Evening \u{00B7} \(clock(local(20, 30))) (3)",
            "Cancel",
        ])
    }

    func testTNC4_aPickedTimeIsDoneThatTimeAndCancel() {
        var state = held()
        state.apply(fetched: overdue(3))
        state.toggle(2)
        let rows = actions(state, picked: local(16))
        XCTAssertEqual(titles(rows), ["Done (2)", "\(clock(local(16))) (2)", "Cancel"])
        XCTAssertEqual(actionIds(rows), [NotificationAction.done, NotificationAction.snoozeCustom, NotificationAction.cancel])
    }

    func testTNC4_namesTwoPeriodsAfterTheNextAtMost() {
        let many = (6...12).map { TimeSlotDTO(id: $0, label: "P\($0)", startTime: String(format: "%02d:00", $0)) }
        let rows = OverdueChecklist.actions(for: held(), picked: nil, now: local(5), slots: many)
        XCTAssertEqual(rows.map(\.title).map { $0.components(separatedBy: " ").first }, [
            "Done", "P6", "+1", "P7", "P8", "Cancel",
        ])
    }

    // MARK: - TNC-5 nothing checked

    func testTNC5_nothingCheckedLeavesOnlyCancel() {
        var state = held()
        state.apply(fetched: overdue(3))
        state.toggle(1)
        XCTAssertEqual(actionIds(actions(state)), [NotificationAction.cancel])
        XCTAssertEqual(state.headerCount, "3 \(TaskWording.overdueLower)")
    }

    func testTNC5_aSummaryKeepsTheSweepWhileNothingIsChecked() {
        var state = OverdueChecklist.State.summary()
        state.apply(fetched: overdue(9))
        XCTAssertNil(state.heldId)
        XCTAssertTrue(state.checked.isEmpty)
        XCTAssertEqual(actionIds(actions(state)), [NotificationAction.snoozeAllSlotNext, NotificationAction.cancel])
        // No cached period: no sweep row.
        XCTAssertEqual(actionIds(actions(state, slots: [])), [NotificationAction.cancel])
        // Once something is checked, the checked set's rows.
        state.toggle(4)
        XCTAssertEqual(actionIds(actions(state)).first, NotificationAction.done)
        XCTAssertFalse(actionIds(actions(state)).contains(NotificationAction.snoozeAllSlotNext))
    }

    // MARK: - TNC-6 the re-check

    func testTNC6_sendsOnlyRowsStillOverdueAtTheSameTime() {
        var state = held()
        state.apply(fetched: [
            task(1, "Held", due: local(8)),
            task(2, "Done elsewhere", due: local(7)),
            task(3, "Repeating, done elsewhere", due: local(6)),
            task(4, "Untouched", due: local(5)),
        ])
        [2, 3, 4].forEach { state.toggle($0) }
        let current = [
            task(1, "Held", due: local(8)),
            // 2 is gone; 3 advanced to its next occurrence (still overdue).
            task(3, "Repeating, done elsewhere", due: local(9)),
            task(4, "Untouched", due: local(5)),
        ]
        XCTAssertEqual(OverdueChecklist.toSend(checked: state.checkedRows, current: current), [1, 4])
    }

    func testTNC6_nothingLeftToSendThenReloadsAndKeepsWhatIsStillChecked() {
        var state = held()
        state.apply(fetched: overdue(3))
        state.toggle(2)
        let current = [task(2, "Invented chore 2", due: local(9)), task(3, "Invented chore 3", due: local(8, 3))]
        XCTAssertEqual(OverdueChecklist.toSend(checked: state.checkedRows, current: current), [])
        state.apply(fetched: current)
        XCTAssertEqual(ids(state.rows), [3, 2])
        XCTAssertEqual(state.checked, [2], "the held task left; 2 is still listed, so still checked")
    }

    // MARK: - TNC-7 banners

    func testTNC7_theBannersOfTheTasksActedOn() {
        XCTAssertEqual(OverdueChecklist.bannersToClear(completed: [4, 9]), [4, 9])
        let moved = APIClient.BulkSnoozeResult(
            tasksAffected: 1, skippedOnPriority: 0, skippedHigh: 0, snoozedHigh: 0, movedIds: [9]
        )
        XCTAssertEqual(OverdueChecklist.bannersToClear(snoozed: moved), [9])
        let older = APIClient.BulkSnoozeResult(tasksAffected: 2, skippedOnPriority: 0, skippedHigh: 0, snoozedHigh: 0)
        XCTAssertEqual(OverdueChecklist.bannersToClear(snoozed: older), [], "an older server: clear nothing here")
    }

    func testTNC7_thePressedBannerGoesOnlyWhenItsTaskWasActedOn() {
        XCTAssertTrue(OverdueChecklist.removesOwnBanner(intent: .complete, heldId: 1, acted: [1, 4]))
        XCTAssertFalse(OverdueChecklist.removesOwnBanner(intent: .complete, heldId: 1, acted: [4]))
        XCTAssertTrue(OverdueChecklist.removesOwnBanner(intent: .complete, heldId: nil, acted: [4]), "a summary")
    }

    // MARK: - TNC-8 Cancel

    func testTNC8_cancelIsAlwaysLastAndRemovesTheBanner() {
        var state = held()
        state.apply(fetched: overdue(8))
        for list in [actions(state), actions(state, picked: local(16)), actions(state, slots: [])] {
            XCTAssertEqual(list.last, OverdueChecklist.cancel)
        }
        XCTAssertEqual(
            OverdueChecklist.intent(for: NotificationAction.cancel, picked: nil, now: local(10), slots: periods),
            .cancel
        )
        XCTAssertTrue(OverdueChecklist.removesOwnBanner(intent: .cancel, heldId: 1, acted: []))
    }

    // MARK: - TNC-9 times

    func testTNC9_everyTimeIsOneInstantFromNow() {
        let now = local(10, 20)
        func intent(_ id: String, picked: Date? = nil, slots: [TimeSlotDTO]? = nil) -> OverdueChecklist.Intent {
            OverdueChecklist.intent(for: id, picked: picked, now: now, slots: slots ?? periods)
        }
        XCTAssertEqual(intent(NotificationAction.done), .complete)
        XCTAssertEqual(intent(NotificationAction.snooze1hr), .snooze(until: local(11)))
        XCTAssertEqual(intent(NotificationAction.snoozeNextPeriod), .snooze(until: local(12)))
        XCTAssertEqual(intent(NotificationAction.snoozeSlotIdentifier(startTime: "09:00")), .snooze(until: local(9, day: 1)))
        XCTAssertEqual(intent(NotificationAction.snoozeCustom, picked: local(16)), .snooze(until: local(16)))
        XCTAssertEqual(intent(NotificationAction.snoozeCustom), .none, "nothing picked")
        XCTAssertEqual(intent(NotificationAction.snoozeSlotIdentifier(startTime: "05:00")), .none, "a period that is gone")
        XCTAssertEqual(intent(NotificationAction.snoozeNextPeriod, slots: []), .none, "no cached period")
        XCTAssertEqual(intent(NotificationAction.snoozeAllSlotNext), .sweep)
    }

    func testTNC9_noCachedPeriodLeavesDonePlusHourAndCancel() {
        XCTAssertEqual(actionIds(actions(held(), slots: [])), [
            NotificationAction.done, NotificationAction.snooze1hr, NotificationAction.cancel,
        ])
    }

    // MARK: - State table: the empty case

    func testNothingOverdueShowsTheEmptyStateAndCancel() {
        var state = held()
        state.apply(fetched: [])
        XCTAssertTrue(state.isEmpty)
        XCTAssertNil(state.headerCount)
        XCTAssertEqual(state.pageCount, 0)
        XCTAssertEqual(actionIds(actions(state)), [NotificationAction.cancel])
        var summary = OverdueChecklist.State.summary()
        summary.apply(fetched: [])
        XCTAssertEqual(actionIds(actions(summary)), [NotificationAction.cancel])
    }

    // MARK: - "tomorrow" in a period's title (2026-11-21)

    func testAPeriodStartingTomorrowSaysSo() {
        let rows = OverdueChecklist.actions(for: held(), picked: nil, now: local(21), slots: periods)
        XCTAssertEqual(titles(rows), [
            "Done",
            "Morning \u{00B7} tomorrow \(clock(local(9, day: 1)))",
            "+1 hour \u{00B7} \(clock(local(22)))",
            "Midday \u{00B7} tomorrow \(clock(local(12, day: 1)))",
            "Afternoon \u{00B7} tomorrow \(clock(local(15, day: 1)))",
            "Cancel",
        ])
        XCTAssertEqual(
            TaskNotificationList.timeWords(local(0, day: 1), now: local(23, 30)), "tomorrow \(clock(local(0, day: 1)))"
        )
    }

    // MARK: - The commit (TNC-4, TNC-6, TNC-7), with a stub API

    private final class StubAPI: OverdueChecklistAPI {
        enum Call: Equatable {
            case fetch
            case complete([Int])
            case snooze([Int], Date)
        }
        var calls: [Call] = []
        var overdue: [TaskDTO] = []
        var fetchError: Error?
        var sendError: Error?
        var moved: [Int]?

        func fetchOverdueTasks() async throws -> [TaskDTO] {
            calls.append(.fetch)
            if let fetchError { throw fetchError }
            return overdue
        }
        func completeTasks(ids: [Int]) async throws -> Int {
            calls.append(.complete(ids))
            if let sendError { throw sendError }
            return ids.count
        }
        func bulkSnooze(ids: [Int], until: Date) async throws -> APIClient.BulkSnoozeResult {
            calls.append(.snooze(ids, until))
            if let sendError { throw sendError }
            return APIClient.BulkSnoozeResult(
                tasksAffected: ids.count, skippedOnPriority: 0, skippedHigh: 0, snoozedHigh: 0, movedIds: moved
            )
        }
    }

    private func loaded(_ count: Int, checking extra: [Int] = []) -> OverdueChecklist.State {
        var state = held()
        state.apply(fetched: overdue(count))
        extra.forEach { state.toggle($0) }
        return state
    }

    func testCommit_doneRechecksThenSendsOneRequestAndClearsThoseBanners() async throws {
        let api = StubAPI()
        api.overdue = overdue(4)
        let outcome = try await OverdueChecklist.commit(.complete, state: loaded(4, checking: [3]), api: api)
        XCTAssertEqual(api.calls, [.fetch, .complete([1, 3])])
        guard case let .sent(acted, clear, own) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertEqual(acted, [1, 3])
        XCTAssertEqual(clear, [1, 3])
        XCTAssertTrue(own)
    }

    func testCommit_aTimeSendsOneUntilAndClearsTheMovedBanners() async throws {
        let api = StubAPI()
        api.overdue = overdue(4)
        api.moved = [3]
        var state = loaded(4, checking: [3])
        state.toggle(1)  // the pressed task unchecked
        let outcome = try await OverdueChecklist.commit(.snooze(until: local(12)), state: state, api: api)
        XCTAssertEqual(api.calls, [.fetch, .snooze([3], local(12))])
        guard case let .sent(_, clear, own) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertEqual(clear, [3])
        XCTAssertFalse(own, "the pressed task was not acted on: its banner stays")
    }

    func testCommit_theRecheckDropsRowsHandledElsewhere() async throws {
        let api = StubAPI()
        let state = loaded(4, checking: [2, 3])
        // 2 was done elsewhere; 3 is a repeat that advanced (a new time).
        api.overdue = [overdue(4)[0], task(3, "Invented chore 3", due: local(9, 30)), overdue(4)[3]]
        _ = try await OverdueChecklist.commit(.complete, state: state, api: api)
        XCTAssertEqual(api.calls, [.fetch, .complete([1])])
    }

    func testCommit_nothingLeftSendsNothingAndHandsBackTheList() async throws {
        let api = StubAPI()
        api.overdue = [task(9, "Something new", due: local(7))]
        let outcome = try await OverdueChecklist.commit(.complete, state: loaded(3, checking: [2]), api: api)
        XCTAssertEqual(api.calls, [.fetch])
        guard case let .nothingLeft(current) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertEqual(current.map(\.id), [9])
    }

    func testCommit_aRefusedBatchIsRefusedNotThrown() async throws {
        let api = StubAPI()
        api.overdue = overdue(3)
        api.sendError = APIError.serverError(statusCode: 400)
        let outcome = try await OverdueChecklist.commit(.complete, state: loaded(3), api: api)
        guard case .refused = outcome else { return XCTFail("\(outcome)") }
    }

    func testCommit_otherErrorsPropagate() async {
        let api = StubAPI()
        api.fetchError = URLError(.notConnectedToInternet)
        do {
            _ = try await OverdueChecklist.commit(.complete, state: loaded(3, checking: [2]), api: api)
            XCTFail("expected a throw")
        } catch {
            XCTAssertEqual(api.calls, [.fetch])
        }
    }

    func testCommit_nothingCheckedSendsNothing() async throws {
        let api = StubAPI()
        var state = loaded(3)
        state.toggle(1)
        let outcome = try await OverdueChecklist.commit(.complete, state: state, api: api)
        XCTAssertEqual(api.calls, [])
        guard case .nothingChecked = outcome else { return XCTFail("\(outcome)") }
    }

    /// TNC-2: the list never loaded and only the pressed task is checked —
    /// it is sent as it is, without the list.
    func testCommit_thePressedTaskAloneWorksWithoutTheList() async throws {
        let api = StubAPI()
        var failed = held()
        failed.fetchFailed()
        _ = try await OverdueChecklist.commit(.complete, state: failed, api: api)
        _ = try await OverdueChecklist.commit(.snooze(until: local(11)), state: held(), api: api)
        XCTAssertEqual(api.calls, [.complete([1]), .snooze([1], local(11))])
    }

    /// A payload row's time is the notifier's, not the stored target: the
    /// re-check takes it while it is still overdue at all.
    func testRecheck_aPayloadRowIsSentWhileStillOverdue() {
        let payload = OverdueChecklist.Row(id: 1, title: "Held", priority: 0, dueAt: iso(local(8)), fromPayload: true)
        let current = [task(1, "Held", due: local(7, 45))]
        XCTAssertEqual(OverdueChecklist.toSend(checked: [payload], current: current), [1])
        XCTAssertEqual(OverdueChecklist.toSend(checked: [payload], current: []), [])
    }
}
