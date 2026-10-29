import XCTest

/// The native row corner (2026-10-16, `ios/Shared/RowCorner.swift`): the web
/// row corner's rules (`src/lib/row-corner.ts`, tests/behavioral/
/// tm-row-corner.test.ts). The dot and the corner strip went on 2026-10-28
/// (`LeanRowTests` has the lean row's rules).
final class RowCornerTests: XCTestCase {

    private let target = "2026-10-16T14:00:00.000Z"

    private func task(
        priority: Int = 0, due: String? = nil, rrule: String? = nil, horizon: String? = nil,
        targetAuto: Bool = false, reminder: Bool = false, tracked: Bool = false, progressTarget: Int = 1
    ) -> TaskDTO {
        TaskDTO(
            id: 1, title: "t", priority: priority, dueAt: due, rrule: rrule, progressTarget: progressTarget,
            trackedFlag: tracked, isReminder: reminder, horizon: horizon, targetAuto: targetAuto
        )
    }

    // MARK: Priority tab — Trent's rule: High and Urgent only

    func testOnlyHighAndUrgentGetATab() {
        XCTAssertNil(RowCorner.priorityTab(0), "None")
        XCTAssertNil(RowCorner.priorityTab(1), "Low")
        XCTAssertNil(RowCorner.priorityTab(2), "Medium")
        XCTAssertEqual(RowCorner.priorityTab(3), .high)
        XCTAssertEqual(RowCorner.priorityTab(4), .urgent)
        XCTAssertNil(RowCorner.priorityTab(5), "an unknown value draws nothing")
    }

    func testTabWordsAreTheWebsCompactSymbols() {
        XCTAssertEqual(RowCorner.PriorityTab.high.text, "!")
        XCTAssertEqual(RowCorner.PriorityTab.urgent.text, "!!")
        XCTAssertEqual(RowCorner.PriorityTab.high.name, "High priority")
        XCTAssertEqual(RowCorner.PriorityTab.urgent.name, "Urgent priority")
    }

    /// Medium and Low get no priority colour on the row's other marks either
    /// (checkbox outline, Up next dot, a segment row's circle).
    func testOnlyHighAndUrgentColourTheRowsMarks() {
        XCTAssertEqual((0...4).map(RowCorner.markIsColored), [false, false, false, true, true])
    }

    // MARK: Where the horizon decides something

    /// `showsHorizonDot`: a plain one-off with no target the user picked.
    func testShowsHorizonDotOnlyWhereTheHorizonDecides() {
        XCTAssertTrue(RowCorner.showsHorizonDot(task()), "undated one-off")
        XCTAssertTrue(RowCorner.showsHorizonDot(task(due: target, targetAuto: true)), "a deadline's automatic target")
        XCTAssertFalse(RowCorner.showsHorizonDot(task(due: target)), "a picked target makes it quiet")
        XCTAssertFalse(RowCorner.showsHorizonDot(task(rrule: "FREQ=DAILY")), "repeating")
        XCTAssertFalse(RowCorner.showsHorizonDot(task(reminder: true)), "reminder")
        XCTAssertFalse(RowCorner.showsHorizonDot(task(tracked: true)), "quota")
        XCTAssertFalse(RowCorner.showsHorizonDot(task(progressTarget: 3)), "a quota by its target")
        XCTAssertTrue(RowCorner.showsHorizonDot(task(rrule: "")), "an empty rrule is not a schedule")
    }

    func testReadsTheTasksHorizonAndUnset() {
        XCTAssertEqual(RowCorner.horizon(of: task(horizon: "months")), .months)
        XCTAssertNil(RowCorner.horizon(of: task()), "unset")
        XCTAssertNil(RowCorner.horizon(of: task(horizon: "someday")), "unknown reads as unset")
    }
}
