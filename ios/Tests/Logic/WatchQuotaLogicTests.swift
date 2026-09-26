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

    func testPeriodFromRRule() {
        XCTAssertEqual(WatchQuotaPeriod.from(rrule: "FREQ=DAILY"), .daily)
        XCTAssertEqual(WatchQuotaPeriod.from(rrule: "FREQ=WEEKLY;INTERVAL=2"), .weekly, "INTERVAL is ignored")
        XCTAssertEqual(WatchQuotaPeriod.from(rrule: "interval=1;freq=monthly"), .monthly)
        XCTAssertEqual(WatchQuotaPeriod.from(rrule: "FREQ=YEARLY;BYMONTH=3"), .yearly)
        XCTAssertEqual(WatchQuotaPeriod.from(rrule: "FREQ=HOURLY"), WatchQuotaPeriod.none)
        XCTAssertEqual(WatchQuotaPeriod.from(rrule: ""), WatchQuotaPeriod.none)
        XCTAssertEqual(WatchQuotaPeriod.from(rrule: nil), WatchQuotaPeriod.none)
        // Sections run day → year, then the period-less bucket last.
        let quotas = [quota(1, "N", rrule: nil), quota(2, "Y", rrule: "FREQ=YEARLY"), quota(3, "D", rrule: "FREQ=DAILY")]
        XCTAssertEqual(
            WatchQuotaLogic.sections(quotas: quotas, labelConfig: [], showMet: true).map(\.summary),
            ["Today · 0 of 1 met", "This year · 0 of 1 met", "No period · 0 of 1 met"]
        )
    }

    func testLabelAndColorRules() {
        let config = [
            LabelConfigDTO(name: "health", color: "green"),
            LabelConfigDTO(name: "home", color: "orange"),
        ]
        // `ai-` machinery labels are skipped.
        let q = quota(1, "Q", labels: ["ai-added", "home"])
        XCTAssertEqual(WatchQuotaLogic.label(of: q), "home")
        XCTAssertEqual(WatchQuotaLogic.color(of: q, labelConfig: config), "orange")
        // Green means "met" on quota chips, so a green label draws neutral.
        XCTAssertNil(WatchQuotaLogic.color(of: quota(2, "Q", labels: ["Health"]), labelConfig: config))
        XCTAssertNil(WatchQuotaLogic.color(of: quota(3, "Q"), labelConfig: config))
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
}
