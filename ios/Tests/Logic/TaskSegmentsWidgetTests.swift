import XCTest

/// Task segments on the Reminders widget (2026-10-10): the page ring
/// (`RemindersTimeline` — segments after the slots (10-11), the natural page, the
/// override anchored to it), the optimistic consider/done render
/// (`WidgetStore.filterPendingSegments`), the cache write-throughs, and the
/// outbox's `.considerSegment`.
final class TaskSegmentsWidgetTests: WidgetStoreTestCase {

    private let t0 = Date(timeIntervalSince1970: 1_768_492_800) // 2026-01-15T16:00:00Z

    /// 12:30 local today — any time works; the slot is whatever the clock says.
    private var noon: Date { Calendar.current.date(bySettingHour: 12, minute: 30, second: 0, of: Date())! }

    private func row(_ id: Int, _ state: SegmentTaskDTO.State = .waiting, horizon: String? = nil) -> SegmentTaskDTO {
        SegmentTaskDTO(task: TaskDTO(id: id, title: "Task \(id)", horizon: horizon), state: state)
    }

    private func segments(daysWaiting: Bool = true) -> [TaskSegmentDTO] {
        [
            TaskSegmentDTO(horizon: "days", tasks: [row(1, daysWaiting ? .waiting : .considered), row(2, .considered)]),
            TaskSegmentDTO(horizon: "weeks", tasks: [row(3), row(4, .deferred)]),
            TaskSegmentDTO(horizon: "months", tasks: [row(5, .deferred)]),
        ]
    }

    // MARK: Ring

    func testSegmentsComeAfterTheSlotsAndAllDeferredOnesDropOut() throws {
        let groups = try Fixtures.reminders()
        let listed = TaskSegmentDTO.listed(segments())
        XCTAssertEqual(listed.map(\.horizon), ["days", "weeks"], "months has only a deferred row")
        // Under the slots (Trent, 10-11), so after them in the ring.
        XCTAssertEqual(
            RemindersTimeline.pageKeys(groups: groups, segments: listed),
            groups.map(\.slotKey) + [-10, -11]
        )
    }

    func testTheClocksSlotIsNaturalEvenWhileASegmentWaits() throws {
        let groups = try Fixtures.reminders()
        let listed = TaskSegmentDTO.listed(segments())
        let natural = RemindersTimeline.naturalSlotIndex(in: groups, now: noon)
        XCTAssertEqual(
            RemindersTimeline.naturalPageKey(groups: groups, segments: listed, now: noon), groups[natural].slotKey
        )
        let page = RemindersTimeline.displayedPage(groups: groups, segments: listed, now: noon)
        XCTAssertNil(page.segmentIndex)
        XCTAssertEqual(page.slotIndex, natural)

        // No slots at all: the first waiting segment is the page.
        let daysDone = TaskSegmentDTO.listed(segments(daysWaiting: false))
        XCTAssertEqual(RemindersTimeline.naturalPageKey(groups: [], segments: daysDone, now: noon), -11)
    }

    func testWithNothingWaitingTheClocksSlotIsNatural() throws {
        let groups = try Fixtures.reminders()
        let considered = [TaskSegmentDTO(horizon: "days", tasks: [row(1, .considered)])]
        let natural = RemindersTimeline.naturalSlotIndex(in: groups, now: noon)
        XCTAssertEqual(
            RemindersTimeline.naturalPageKey(groups: groups, segments: considered, now: noon), groups[natural].slotKey
        )
        let page = RemindersTimeline.displayedPage(groups: groups, segments: considered, now: noon)
        XCTAssertNil(page.segmentIndex)
        XCTAssertEqual(page.slotIndex, natural)
    }

    func testAnOverrideOntoASegmentPageResolvesToIt() throws {
        let groups = try Fixtures.reminders()
        let considered = TaskSegmentDTO.listed([TaskSegmentDTO(horizon: "days", tasks: [row(1, .considered)])])
        let naturalKey = try XCTUnwrap(RemindersTimeline.naturalPageKey(groups: groups, segments: considered, now: noon))
        WidgetStore.setSlotOverride(slotKey: -10, naturalSlotKey: naturalKey)
        XCTAssertEqual(RemindersTimeline.displayedPage(groups: groups, segments: considered, now: noon).segmentIndex, 0)
    }

    /// Auto-advance anchors its override to the natural page — the clock's
    /// slot now that segments sit after the slots.
    func testAutoAdvanceAnchorsToTheNaturalPage() throws {
        let groups = try Fixtures.reminders()
        let segs = segments()
        // Stand on a finished slot after the clock's (Anytime, always started).
        let anytime = try XCTUnwrap(groups.last)
        XCTAssertTrue(anytime.hasNothingWaiting)
        let naturalKey = try XCTUnwrap(
            RemindersTimeline.naturalPageKey(groups: groups, segments: TaskSegmentDTO.listed(segs), now: noon)
        )
        WidgetStore.setSlotOverride(slotKey: anytime.slotKey, naturalSlotKey: naturalKey)
        RemindersTimeline.autoAdvanceSlot(in: groups, segments: segs, now: noon)
        if let override = WidgetStore.slotOverride() {
            XCTAssertEqual(override.naturalSlotKey, naturalKey)
        }
    }

    // MARK: Optimistic render and cache

    func testConsiderDrawsTheRowConsideredAndDoneHidesIt() {
        WidgetStore.stagePendingSegmentConsider(3, now: t0)
        WidgetStore.stagePendingCompletion(1, now: t0)
        let drawn = WidgetStore.filterPendingSegments(segments(), now: t0)
        XCTAssertEqual(drawn[0].tasks.map(\.id), [2], "the done row is gone, the rest keep their order")
        XCTAssertEqual(drawn[1].tasks.map(\.state), [.considered, .deferred])
        XCTAssertFalse(drawn[1].hasWaiting)
        XCTAssertTrue(WidgetStore.hasRecentInteraction(now: t0), "a consider repaints from cache")
    }

    func testCacheWritesKeepSegmentsAndConfirmCompletionDropsTheRow() throws {
        WidgetStore.saveReminders(try Fixtures.reminders(), taskSegments: segments(), fetchStartedAt: t0)
        WidgetStore.confirmCompletion(1)
        WidgetStore.confirmSegmentConsider(3)
        WidgetStore.confirmSegmentDefer([2])
        let cached = try XCTUnwrap(WidgetStore.loadReminders()?.value)
        XCTAssertEqual(cached.groups.count, 6)
        XCTAssertEqual(cached.taskSegments[0].tasks.map(\.id), [2])
        XCTAssertEqual(cached.taskSegments[0].tasks.map(\.state), [.deferred])
        XCTAssertEqual(cached.taskSegments[1].tasks.first?.state, .considered)
        XCTAssertTrue(WidgetStore.pendingSegmentConsiders(now: t0).isEmpty)
    }

    func testAnOlderCacheWithoutSegmentsStillDecodes() throws {
        let groups = try Fixtures.reminders()
        struct Old: Codable { let groups: [ReminderGroupDTO] }
        WidgetStore.save(Old(groups: groups), forKey: "widget.cache.reminders", at: t0)
        let cached = try XCTUnwrap(WidgetStore.loadReminders()?.value)
        XCTAssertEqual(cached.groups.count, groups.count)
        XCTAssertEqual(cached.taskSegments, [])
    }

    func testUndoClearsConsiderTombstones() {
        WidgetStore.stagePendingSegmentConsider(3, now: t0)
        WidgetStore.clearAllPendingState()
        XCTAssertTrue(WidgetStore.pendingSegmentConsiders(now: t0).isEmpty)
    }

    // MARK: Outbox

    private func tapConsider(_ id: Int) {
        WidgetStore.stagePendingSegmentConsider(id, now: t0)
        WidgetStore.enqueueOutbox(WidgetStore.OutboxEntry(
            mutation: .considerSegment(taskId: id), widgetKind: RemindersWidget.kind, createdAt: t0, title: nil
        ))
    }

    func testAQueuedConsiderIsSentAndWrittenIntoTheCache() async throws {
        WidgetStore.saveReminders(try Fixtures.reminders(), taskSegments: segments(), fetchStartedAt: t0)
        tapConsider(3)
        XCTAssertEqual(WidgetStore.pendingSegmentConsiders(now: t0.addingTimeInterval(600)), [3], "queued = still drawn")
        let transport = StubOutboxTransport()
        await WidgetOutboxDrainer(transport: transport, clock: { [t0] in t0 }) { _ in }.drain()
        XCTAssertEqual(transport.calls, [.considerSegment([3])])
        XCTAssertTrue(WidgetStore.outboxEntries().isEmpty)
        XCTAssertEqual(WidgetStore.loadReminders()?.value.taskSegments[1].tasks.first?.state, .considered)
    }

    func testARefusedConsiderPutsTheRowBack() async throws {
        WidgetStore.saveReminders(try Fixtures.reminders(), taskSegments: segments(), fetchStartedAt: t0)
        tapConsider(3)
        let transport = StubOutboxTransport()
        transport.segmentResults = [.failure(APIError.serverError(statusCode: 404))]
        await WidgetOutboxDrainer(transport: transport, clock: { [t0] in t0 }) { _ in }.drain()
        XCTAssertTrue(WidgetStore.outboxEntries().isEmpty)
        XCTAssertTrue(WidgetStore.pendingSegmentConsiders(now: t0).isEmpty)
        XCTAssertEqual(WidgetStore.loadReminders()?.value.taskSegments[1].tasks.first?.state, .waiting)
    }

    func testAnUnsentConsiderIsRetried() async throws {
        tapConsider(3)
        let transport = StubOutboxTransport()
        transport.segmentResults = [.failure(URLError(.notConnectedToInternet))]
        await WidgetOutboxDrainer(transport: transport, clock: { [t0] in t0 }) { _ in }.drain()
        XCTAssertEqual(WidgetStore.outboxEntries().first?.attempts, 1)
        XCTAssertEqual(WidgetStore.pendingSegmentConsiders(now: t0), [3])
    }

    // MARK: Target today (2026-10-11)

    private func tapTargetToday(_ id: Int) {
        WidgetStore.stagePendingSegmentTarget(id, now: t0)
        WidgetStore.enqueueOutbox(WidgetStore.OutboxEntry(
            mutation: .targetSegmentToday(taskId: id), widgetKind: RemindersWidget.kind, createdAt: t0, title: nil
        ))
    }

    func testTargetTodayTakesTheRowOutOfTheSegment() {
        tapTargetToday(3)
        let drawn = WidgetStore.filterPendingSegments(segments(), now: t0.addingTimeInterval(600))
        XCTAssertEqual(drawn[1].tasks.map(\.id), [4], "queued = still gone")
        XCTAssertFalse(drawn[1].hasWaiting)
        XCTAssertEqual(drawn[0].tasks.map(\.id), [1, 2], "nothing else moves")
    }

    func testAQueuedTargetTodayIsSentAndTheRowLeavesTheCache() async throws {
        WidgetStore.saveReminders(try Fixtures.reminders(), taskSegments: segments(), fetchStartedAt: t0)
        tapTargetToday(3)
        let transport = StubOutboxTransport()
        let reports = ReportLog()
        await WidgetOutboxDrainer(transport: transport, clock: { [t0] in t0 }) { reports.append($0) }.drain()
        XCTAssertEqual(transport.calls, [.targetToday([3])])
        XCTAssertTrue(WidgetStore.outboxEntries().isEmpty)
        XCTAssertEqual(WidgetStore.loadReminders()?.value.taskSegments[1].tasks.map(\.id), [4])
        XCTAssertTrue(WidgetStore.pendingSegmentTargets(now: t0).isEmpty)
        XCTAssertEqual(reports.all.first?.dependentKinds, [TasksWidget.kind], "the task now has a target today")
    }

    func testARefusedTargetTodayPutsTheRowBack() async throws {
        WidgetStore.saveReminders(try Fixtures.reminders(), taskSegments: segments(), fetchStartedAt: t0)
        tapTargetToday(3)
        let transport = StubOutboxTransport()
        transport.targetResults = [.failure(APIError.serverError(statusCode: 404))]
        await WidgetOutboxDrainer(transport: transport, clock: { [t0] in t0 }) { _ in }.drain()
        XCTAssertTrue(WidgetStore.pendingSegmentTargets(now: t0).isEmpty)
        let drawn = WidgetStore.filterPendingSegments(WidgetStore.loadReminders()?.value.taskSegments ?? [], now: t0)
        XCTAssertEqual(drawn[1].tasks.map(\.id), [3, 4])
    }

    func testUndoClearsTargetTodayTombstones() {
        WidgetStore.stagePendingSegmentTarget(3, now: t0)
        XCTAssertTrue(WidgetStore.hasRecentInteraction(now: t0))
        WidgetStore.clearAllPendingState()
        XCTAssertTrue(WidgetStore.pendingSegmentTargets(now: t0).isEmpty)
    }

    // MARK: Row words

    func testSegmentRowWords() {
        let now = DateHelpers.parseISO("2026-10-10T19:00:00.000Z")!
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "America/Chicago")!
        let set = TaskDTO(id: 1, title: "Fix the gate", dueAt: "2026-11-01T14:00:00.000Z", horizon: "weeks")
        XCTAssertEqual(set.segmentMeta(segmentHorizon: "days", now: now, calendar: cal), "Weeks\u{00A0}·\u{00A0}Nov\u{00A0}1")
        XCTAssertEqual(
            set.segmentLabelText(segmentHorizon: "days", now: now, calendar: cal),
            "Fix the gate ·\u{00A0}Weeks\u{00A0}·\u{00A0}Nov\u{00A0}1"
        )
        // Its own segment: the horizon goes unsaid.
        XCTAssertEqual(set.segmentMeta(segmentHorizon: "weeks", now: now, calendar: cal), "Nov\u{00A0}1")
        // A deadline shows as itself, not as its implied target.
        let deadline = TaskDTO(id: 3, title: "Pay", deadlineAt: "2026-10-20T22:00:00.000Z")
        XCTAssertEqual(deadline.segmentMeta(segmentHorizon: "days", now: now, calendar: cal), "deadline\u{00A0}Oct\u{00A0}20")
        let unset = TaskDTO(id: 2, title: "Plain")
        XCTAssertNil(unset.segmentMeta(segmentHorizon: "days", now: now, calendar: cal), "unset horizon shows nothing")
        XCTAssertEqual(unset.segmentLabelText(segmentHorizon: "days", now: now, calendar: cal), "Plain")
    }
}
