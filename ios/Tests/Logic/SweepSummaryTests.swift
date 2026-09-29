import XCTest

/// The High/Urgent lines under a sweep's result (`SweepLine`), shared by the
/// watch sheet, the watch Smart Stack card and the Mac menu bar and alert.
final class SweepSummaryTests: XCTestCase {

    private func result(affected: Int, snoozedHigh: Int = 0, skippedHigh: Int = 0, skippedUrgent: Int = 0)
        -> APIClient.BulkSnoozeResult
    {
        APIClient.BulkSnoozeResult(
            tasksAffected: affected,
            skippedOnPriority: skippedHigh + skippedUrgent,
            skippedHigh: skippedHigh,
            snoozedHigh: snoozedHigh
        )
    }

    /// Nothing but P0-P2 moved: no lines at all, not a list of zeros.
    func testCleanSweepHasNoLines() {
        XCTAssertEqual(result(affected: 4).summaryLines, [])
    }

    /// High left behind gets its own line — the watch sheet used to drop it.
    func testHighLeftBehindIsALine() {
        let lines = result(affected: 3, skippedHigh: 2, skippedUrgent: 1).summaryLines
        XCTAssertEqual(lines, [.highStillOverdue(2), .urgentStillOverdue(1)])
        XCTAssertEqual(lines.map(\.text), ["2 High still overdue", "1 Urgent still overdue"])
        XCTAssertEqual(lines.map(\.isUrgent), [false, true])
    }

    /// Every line at once, in the fixed order: included, High left, Urgent left.
    func testOrder() {
        XCTAssertEqual(
            result(affected: 2, snoozedHigh: 1, skippedHigh: 3, skippedUrgent: 2).summaryLines,
            [.includedHigh(1), .highStillOverdue(3), .urgentStillOverdue(2)]
        )
        XCTAssertEqual(SweepLine.includedHigh(1).text, "Included 1 High")
    }

    /// The Smart Stack card's stored result gives the same lines as the live one.
    func testStoredResultMatchesLiveResult() {
        let stored = WatchWidgetState.SnoozeResult(
            at: Date(), tasksAffected: 2, snoozedHigh: 1, skippedHigh: 0, skippedUrgent: 2, targetLabel: nil
        )
        XCTAssertEqual(stored.summaryLines, result(affected: 2, snoozedHigh: 1, skippedUrgent: 2).summaryLines)
    }
}
