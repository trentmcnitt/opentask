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

    /// The task queue ("Day starts at" PR 3): tasks the sweep sent to the
    /// queue at the day start lead the lines, and when every moved task went
    /// there, "Moved to <period>" is not said — it would be false.
    func testQueuedLineAndMovedTo() {
        let chicago = TimeZone(identifier: "America/Chicago")!
        let at = DateHelpers.parseISO("2026-10-20T08:00:00Z")! // 3:00 AM CDT
        var live = result(affected: 3, skippedUrgent: 1)
        live.queued = 2
        live.queuedUntil = at
        XCTAssertEqual(live.summaryLines, [.queued(2, at: at), .urgentStillOverdue(1)])
        XCTAssertEqual(SweepLine.timeWords(at, timeZone: chicago), "3:00 AM")
        XCTAssertEqual(SweepLine.queued(2, at: nil).text, "2 to the queue")

        var stored = WatchWidgetState.SnoozeResult(
            at: Date(), tasksAffected: 2, snoozedHigh: 0, skippedHigh: 0, skippedUrgent: 0, targetLabel: "Evening"
        )
        XCTAssertEqual(stored.movedToLabel, "Moved to Evening")
        stored.queued = 1
        XCTAssertEqual(stored.movedToLabel, "Moved to Evening", "one still went to the period")
        stored.queued = 2
        XCTAssertNil(stored.movedToLabel, "every one went to the queue")
        XCTAssertEqual(stored.summaryLines, [.queued(2, at: nil)])
    }

    /// A result stored by an older build (no queue fields) still decodes.
    func testStoredResultWithoutQueueFieldsDecodes() throws {
        let json = #"{"at":0,"tasksAffected":1,"snoozedHigh":0,"skippedHigh":0,"skippedUrgent":0,"targetLabel":"Midday"}"#
        let stored = try JSONDecoder().decode(WatchWidgetState.SnoozeResult.self, from: Data(json.utf8))
        XCTAssertNil(stored.queued)
        XCTAssertEqual(stored.movedToLabel, "Moved to Midday")
    }
}
