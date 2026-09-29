import XCTest

/// The watch's Quotas page grouping (`WatchQuotaLogic`), its prompt "move
/// to period" config (`WatchPromptMove`), and the slot logic shared by the
/// watch app and its Smart Stack widget (`WatchSlotLogic`).
final class WatchQuotaLogicTests: XCTestCase {

    private func quota(
        _ id: Int, _ title: String, rrule: String? = "FREQ=WEEKLY", current: Int = 0, target: Int = 1,
        labels: [String] = []
    ) -> TaskDTO {
        TaskDTO(
            id: id, title: title, rrule: rrule, progressTarget: target, progressCurrent: current,
            trackedFlag: true, labels: labels
        )
    }

    func testSectionsFromTheScenario() throws {
        let quotas = try Fixtures.decode(TasksPage.self, "tasks").tasks.filter(\.isTracked)
        let config = [LabelConfigDTO(name: "Personal", color: "purple")]
        let sections = WatchQuotaLogic.sections(quotas: quotas, labelConfig: config, showMet: false)
        XCTAssertEqual(sections.map(\.period), [.daily, .weekly, .monthly])
        XCTAssertEqual(sections.map(\.summary), [
            "Today · 0 of 1 met", "This week · 0 of 1 met", "This month · 0 of 1 met",
        ])
        XCTAssertEqual(sections.flatMap(\.rows).map(\.id), [Fixtures.daily, Fixtures.weekly, Fixtures.monthly])
        // Case-insensitive label match → the stripe.
        XCTAssertEqual(sections[0].rows.first?.color, "purple")
        XCTAssertNil(sections[1].rows.first?.color)
    }

    /// The summary counts EVERY quota in the period; only the rows hide met.
    func testSummaryCountsMetQuotasTheRowsHide() {
        let quotas = (1...7).map { i in quota(i, "Q\(i)", current: i <= 2 ? 1 : 0) }
        let hidden = WatchQuotaLogic.sections(quotas: quotas, labelConfig: [], showMet: false)
        XCTAssertEqual(hidden.map(\.summary), ["This week · 2 of 7 met"])
        XCTAssertEqual(hidden[0].rows.map(\.id), [3, 4, 5, 6, 7])
        let shown = WatchQuotaLogic.sections(quotas: quotas, labelConfig: [], showMet: true)
        XCTAssertEqual(shown[0].rows.count, 7)
        XCTAssertEqual(shown[0].summary, "This week · 2 of 7 met")
    }

    /// "This week · 5 of 5 met" is the good news the page exists to show: an
    /// all-met period keeps its section, with no rows.
    func testAllMetPeriodKeepsItsSection() {
        let quotas = [quota(1, "A", current: 1), quota(2, "B", current: 3, target: 2)]
        let sections = WatchQuotaLogic.sections(quotas: quotas, labelConfig: [], showMet: false)
        XCTAssertEqual(sections.map(\.summary), ["This week · 2 of 2 met"])
        XCTAssertEqual(sections[0].rows.count, 0)
    }

    /// Sections run day → year, then the period-less bucket last. (The
    /// rrule → period rule itself is `QuotaRulesTests`.)
    func testSectionOrder() {
        let quotas = [quota(1, "N", rrule: nil), quota(2, "Y", rrule: "FREQ=YEARLY"), quota(3, "D", rrule: "FREQ=DAILY")]
        XCTAssertEqual(
            WatchQuotaLogic.sections(quotas: quotas, labelConfig: [], showMet: true).map(\.summary),
            ["Today · 0 of 1 met", "This year · 0 of 1 met", "No period · 0 of 1 met"]
        )
    }

    /// Label first (unlabeled last), then the FULL title, then id.
    func testRowOrder() {
        let quotas = [
            quota(1, "zebra"), quota(2, "Walk", labels: ["home"]), quota(3, "apple", labels: ["Home"]),
            quota(4, "Run", labels: ["fitness"]), quota(6, "same"), quota(5, "same"),
        ]
        let rows = WatchQuotaLogic.sections(quotas: quotas, labelConfig: [], showMet: true)[0].rows
        XCTAssertEqual(rows.map(\.id), [4, 3, 2, 5, 6, 1])
    }

    func testPromptMoveConfig() throws {
        // A daily row moves only its own numbers, merged over the stored config.
        let stored: [String: Any] = ["enabled": true, "numbers": ["1": 11]]
        let daily = WatchPromptMove.movedConfig(stored: stored, numbers: [2, 3], toSlotId: 14)
        XCTAssertEqual(daily["enabled"] as? Bool, true)
        XCTAssertEqual(daily["numbers"] as? [String: Int], ["1": 11, "2": 14, "3": 14])
        XCTAssertNil(daily["slot_id"])
        // Any other quota moves as a whole.
        let weekly = WatchPromptMove.movedConfig(stored: nil, numbers: nil, toSlotId: 12)
        XCTAssertEqual(weekly["slot_id"] as? Int, 12)
        XCTAssertNil(weekly["numbers"])
        // The scenario's daily row #2 carries exactly the numbers it moves.
        let row = try Fixtures.prompt(Fixtures.promptKey(Fixtures.daily, 2))
        let moved = WatchPromptMove.movedConfig(stored: nil, numbers: row.numbers, toSlotId: 15)
        XCTAssertEqual(moved["numbers"] as? [String: Int], ["2": 15])
    }
}

final class WatchSlotLogicTests: XCTestCase {

    private func at(_ hour: Int, _ minute: Int = 0) -> Date {
        Calendar.current.date(from: DateComponents(year: 2026, month: 1, day: 15, hour: hour, minute: minute))!
    }

    func testNaturalSlotIsTheLatestStarted() throws {
        let groups = try Fixtures.reminders()
        XCTAssertEqual(WatchSlotLogic.naturalSlotIndex(in: groups, now: at(10, 15)), 1) // Morning, 09:00
        XCTAssertEqual(WatchSlotLogic.naturalSlotIndex(in: groups, now: at(16)), 3)     // Afternoon, at its start
        XCTAssertEqual(WatchSlotLogic.naturalSlotIndex(in: groups, now: at(23)), 4)     // Evening
        XCTAssertEqual(WatchSlotLogic.naturalSlotIndex(in: groups, now: at(3)), 0, "before the first slot: the first")
        XCTAssertEqual(WatchSlotLogic.naturalSlotIndex(in: [], now: at(10)), 0)
    }

    /// Waiting quota prompts count like reminders on the progress strip.
    func testSlotStates() throws {
        let groups = try Fixtures.reminders()
        let noon = at(12, 30)
        XCTAssertEqual(WatchSlotLogic.state(for: groups[0], now: noon), .waiting)   // monthly prompt waiting
        XCTAssertEqual(WatchSlotLogic.state(for: groups[1], now: noon), .waiting)   // daily #2 waiting
        XCTAssertEqual(WatchSlotLogic.state(for: groups[2], now: noon), .finished)  // nothing in it
        XCTAssertEqual(WatchSlotLogic.state(for: groups[3], now: noon), .notStarted) // 16:00
        XCTAssertEqual(WatchSlotLogic.state(for: groups[5], now: at(3)), .finished, "Anytime has always started")

        // Handle the last waiting prompt of Morning → finished.
        let morning = groups[1]
        let handled = morning.replacingPrompts(morning.prompts.map { $0.handled(did: false) })
        XCTAssertEqual(WatchSlotLogic.state(for: handled, now: noon), .finished)
    }

    /// A period finished before its start time reads as finished, not "not
    /// started" (2026-09-28); an empty one that hasn't started stays a
    /// placeholder, and one with something still waiting stays not started.
    func testFinishedEarlyIsFinished() {
        let later = TimeSlotDTO(id: 90, label: "Evening", startTime: "20:30")
        let noon = at(12, 30)
        let doneEarly = ReminderGroupDTO(slot: later, reminders: [], considered: 2, consideredItems: [], prompts: [])
        XCTAssertEqual(WatchSlotLogic.state(for: doneEarly, now: noon), .finished)
        let empty = ReminderGroupDTO(slot: later, reminders: [], considered: 0, consideredItems: [], prompts: [])
        XCTAssertEqual(WatchSlotLogic.state(for: empty, now: noon), .notStarted)
        let partly = ReminderGroupDTO(
            slot: later, reminders: [TaskDTO(id: 1, title: "Wind down", priority: 0, isReminder: true)],
            considered: 1, consideredItems: [], prompts: []
        )
        XCTAssertEqual(WatchSlotLogic.state(for: partly, now: noon), .notStarted)
    }

    /// The watch's Up next and Overdue lists are the phone widget's
    /// (`TaskLists`): soonest first, and on an equal due time the higher
    /// priority first. The watch used to sort by due time alone, so two tasks
    /// due at the same minute could come out in either order.
    func testTasksWithTheSameDueTimeSortByPriority() {
        let now = at(12)
        let earlier = DateHelpers.formatISO(now.addingTimeInterval(-3600))
        let later = DateHelpers.formatISO(now.addingTimeInterval(3600))
        let tasks = [
            TaskDTO(id: 1, title: "Low, late", priority: 0, dueAt: earlier),
            TaskDTO(id: 2, title: "High, late", priority: 3, dueAt: earlier),
            TaskDTO(id: 3, title: "Normal, upcoming", priority: 1, dueAt: later),
            TaskDTO(id: 4, title: "Urgent, upcoming", priority: 4, dueAt: later),
            TaskDTO(id: 5, title: "Undated", priority: 4),
        ]
        XCTAssertEqual(WatchSlotLogic.upNextTasks(from: tasks).map(\.id), [2, 1, 4, 3])
        XCTAssertEqual(WatchSlotLogic.overdueTasks(from: tasks, now: now).map(\.id), [2, 1])
        XCTAssertEqual(WatchSlotLogic.upNextTasks(from: tasks.reversed()).map(\.id), [2, 1, 4, 3])
    }
}
