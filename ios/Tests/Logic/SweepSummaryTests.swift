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

    // MARK: - The cached list after a sweep (`tasksLeft(after:)`)

    private let now = DateHelpers.parseISO("2026-01-15T16:00:00.000Z")!

    private func task(_ id: Int, priority: Int = 1, overdue: Bool = true) -> TaskDTO {
        let due = now.addingTimeInterval(overdue ? -2 * 3600 : 2 * 3600)
        return TaskDTO(id: id, projectId: 1, title: "Task \(id)", priority: priority, dueAt: DateHelpers.formatISO(due))
    }

    /// Overdue P1 (1, 2), a P1 the sweep held back for its passed deadline
    /// (3), High (4), Urgent (5), an upcoming task (6), and an overdue reminder
    /// (7) and quota (8).
    private var cached: [TaskDTO] {
        [
            task(1), task(2), task(3), task(4, priority: 3), task(5, priority: 4), task(6, overdue: false),
            TaskDTO(id: 7, projectId: 1, title: "A reminder", dueAt: DateHelpers.formatISO(now.addingTimeInterval(-3600)), isReminder: true),
            TaskDTO(id: 8, projectId: 1, title: "A quota", dueAt: DateHelpers.formatISO(now.addingTimeInterval(-3600)), progressTarget: 3),
        ]
    }

    /// With `moved_ids`, exactly those leave: the deadline-held task (3) and
    /// the High one the press didn't take (4) stay, which the count guess
    /// would have dropped.
    func testMovedIdsDecideWhatLeavesTheCache() {
        var swept = result(affected: 2)
        swept.movedIds = [1, 2]
        XCTAssertEqual(swept.tasksLeft(after: cached, now: now).map(\.id), [3, 4, 5, 6, 7, 8])
    }

    /// The press that took the High tier says so by id too.
    func testMovedIdsIncludingHigh() {
        var swept = result(affected: 1, snoozedHigh: 1)
        swept.movedIds = [4]
        XCTAssertEqual(swept.tasksLeft(after: cached, now: now).map(\.id), [1, 2, 3, 5, 6, 7, 8])
    }

    /// A sweep that moved nothing (`moved_ids: []`) leaves the cache alone.
    func testEmptyMovedIdsLeavesEverything() {
        var swept = result(affected: 0)
        swept.movedIds = []
        XCTAssertEqual(swept.tasksLeft(after: cached, now: now).map(\.id), [1, 2, 3, 4, 5, 6, 7, 8])
    }

    /// An older server sends no `moved_ids`: the guess from the counts, as
    /// before — every overdue task but Urgent, reminders and quotas, and
    /// High only when none was skipped.
    func testWithoutMovedIdsTheGuessStays() {
        let highSkipped = result(affected: 3, skippedHigh: 1, skippedUrgent: 1)
        XCTAssertNil(highSkipped.movedIds)
        XCTAssertEqual(highSkipped.tasksLeft(after: cached, now: now).map(\.id), [4, 5, 6, 7, 8])
        let highTaken = result(affected: 4, snoozedHigh: 1, skippedUrgent: 1)
        XCTAssertEqual(highTaken.tasksLeft(after: cached, now: now).map(\.id), [5, 6, 7, 8])
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

    // MARK: - What the sweep says before it runs (2026-10-26)

    /// One source for the iPhone/Mac Tasks widget bar, the Mac menu bar and
    /// the watch button: "Defer 2 of 3", "Defer all 3 overdue" when they're
    /// the same; the bars' form ends with a colon.
    func testSweepWords() {
        XCTAssertEqual(OverdueSweepWords.label(count: 2, total: 3), "Defer 2 of 3")
        XCTAssertEqual(OverdueSweepWords.label(count: 3, total: 3), "Defer all 3 overdue")
        XCTAssertEqual(OverdueSweepWords.barLabel(count: 2, total: 3), "Defer 2 of 3:")
        XCTAssertEqual(OverdueSweepWords.barLabel(count: 1, total: 1), "Defer all 1 overdue:")
    }

    private func overdue(_ id: Int, priority: Int, deadlinePassed: Bool = false) -> TaskDTO {
        TaskDTO(
            id: id, projectId: 1, title: "Task \(id)", priority: priority,
            dueAt: DateHelpers.formatISO(now.addingTimeInterval(-Double(id) * 3600)),
            deadlineAt: deadlinePassed ? DateHelpers.formatISO(now.addingTimeInterval(-600)) : nil
        )
    }

    /// The estimate: below High first; the High tier only once nothing lower
    /// is left — all of it with the queue off, one per press with it on; never
    /// Urgent; reminders, quotas and upcoming tasks never count.
    func testSweepEstimateFollowsTheServerTiers() {
        let lowAndHigh = [overdue(1, priority: 0), overdue(2, priority: 2), overdue(3, priority: 3), overdue(4, priority: 4)]
        XCTAssertEqual(TaskLists.overdueSweepEligibleCount(lowAndHigh, now: now, taskQueue: false), 2)
        XCTAssertEqual(TaskLists.overdueSweepEligibleCount(lowAndHigh, now: now, taskQueue: true), 2)

        let highOnly = [overdue(1, priority: 3), overdue(2, priority: 3), overdue(3, priority: 3), overdue(4, priority: 4)]
        XCTAssertEqual(TaskLists.overdueSweepEligibleCount(highOnly, now: now, taskQueue: false), 3)
        XCTAssertEqual(
            TaskLists.overdueSweepEligibleCount(highOnly, now: now, taskQueue: true), 1, "one High per press"
        )

        let urgentOnly = [overdue(1, priority: 4)]
        XCTAssertEqual(TaskLists.overdueSweepEligibleCount(urgentOnly, now: now, taskQueue: true), 0)
        XCTAssertEqual(TaskLists.overdueSweepEligibleCount(cached, now: now, taskQueue: false), 3, "not the reminder, quota or upcoming task")
    }

    /// A passed deadline holds a task to the High tier (`bulkSnoozeTier`): it
    /// waits while anything lower is left, and is the High press's one task
    /// once nothing is.
    func testSweepEstimateHoldsAPassedDeadlineToTheHighTier() {
        let tasks = [overdue(1, priority: 1), overdue(2, priority: 1, deadlinePassed: true)]
        XCTAssertEqual(TaskLists.overdueSweepEligibleCount(tasks, now: now, taskQueue: false), 1)
        let held = [overdue(2, priority: 1, deadlinePassed: true), overdue(3, priority: 3)]
        XCTAssertEqual(TaskLists.overdueSweepEligibleCount(held, now: now, taskQueue: false), 2)
        XCTAssertEqual(TaskLists.overdueSweepEligibleCount(held, now: now, taskQueue: true), 1)
    }

    /// A result stored by an older build (no queue fields) still decodes.
    func testStoredResultWithoutQueueFieldsDecodes() throws {
        let json = #"{"at":0,"tasksAffected":1,"snoozedHigh":0,"skippedHigh":0,"skippedUrgent":0,"targetLabel":"Midday"}"#
        let stored = try JSONDecoder().decode(WatchWidgetState.SnoozeResult.self, from: Data(json.utf8))
        XCTAssertNil(stored.queued)
        XCTAssertEqual(stored.movedToLabel, "Moved to Midday")
    }
}
