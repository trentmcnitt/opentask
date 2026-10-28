import XCTest

/// The native row corner (2026-10-16, `ios/Shared/RowCorner.swift`): the web
/// row corner's rules (`src/lib/row-corner.ts`, tests/behavioral/
/// tm-row-corner.test.ts) on the Tasks widget and the watch Tasks page.
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

    // MARK: Horizon dot

    /// `HORIZON_DOT` / `HORIZON_DOT_UNSET`, exact values shared with the web.
    func testDotSizesAndOpacitiesMatchTheWeb() {
        typealias S = RowCorner.DotStyle
        XCTAssertEqual(RowCorner.dotStyle(.days), S(radius: 4, opacity: 1, ring: false))
        XCTAssertEqual(RowCorner.dotStyle(.weeks), S(radius: 3, opacity: 0.7, ring: false))
        XCTAssertEqual(RowCorner.dotStyle(.months), S(radius: 2.5, opacity: 0.55, ring: false))
        XCTAssertEqual(RowCorner.dotStyle(.eventually), S(radius: 2.25, opacity: 0.42, ring: false))
        // Unset: a closed hollow ring, the Weeks dot's 6pt across (r 2.5 + a
        // 1pt stroke) — no dashes since 2026-10-28.
        XCTAssertEqual(RowCorner.dotStyle(nil), S(radius: 2.5, opacity: 0.36, ring: true), "unset: a ring, Weeks size")
        XCTAssertLessThan(RowCorner.dotStyle(nil).opacity, RowCorner.dotStyle(.eventually).opacity, "unset is quieter than any set dot")
        XCTAssertEqual(RowCorner.dotStyle(nil).radius * 2 + RowCorner.unsetStroke, RowCorner.dotStyle(.weeks).radius * 2)
        // Each step smaller and fainter than the one before.
        let filled = TaskHorizon.allCases.map(RowCorner.dotStyle)
        XCTAssertEqual(filled.map(\.radius), filled.map(\.radius).sorted(by: >))
        XCTAssertEqual(filled.map(\.opacity), filled.map(\.opacity).sorted(by: >))
    }

    /// `showsHorizonDot`: a plain one-off with no target the user picked.
    func testDotShowsOnlyWhereTheHorizonDecides() {
        XCTAssertTrue(RowCorner.showsHorizonDot(task()), "undated one-off")
        XCTAssertTrue(RowCorner.showsHorizonDot(task(due: target, targetAuto: true)), "a deadline's automatic target")
        XCTAssertFalse(RowCorner.showsHorizonDot(task(due: target)), "a picked target makes it quiet")
        XCTAssertFalse(RowCorner.showsHorizonDot(task(rrule: "FREQ=DAILY")), "repeating")
        XCTAssertFalse(RowCorner.showsHorizonDot(task(reminder: true)), "reminder")
        XCTAssertFalse(RowCorner.showsHorizonDot(task(tracked: true)), "quota")
        XCTAssertFalse(RowCorner.showsHorizonDot(task(progressTarget: 3)), "a quota by its target")
        XCTAssertTrue(RowCorner.showsHorizonDot(task(rrule: "")), "an empty rrule is not a schedule")
    }

    func testDotReadsTheTasksHorizonAndUnset() {
        XCTAssertEqual(RowCorner.horizon(of: task(horizon: "months")), .months)
        XCTAssertNil(RowCorner.horizon(of: task()), "unset")
        XCTAssertNil(RowCorner.horizon(of: task(horizon: "someday")), "unknown reads as unset")
        XCTAssertEqual(RowCorner.dotAccessibilityLabel(.days), "Horizon Days")
        XCTAssertEqual(RowCorner.dotAccessibilityLabel(nil), "Horizon unset")
    }
}
