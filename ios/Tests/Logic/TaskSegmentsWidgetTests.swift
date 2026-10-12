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

    /// The fixture at 12:30 has prompts waiting in 07:00 and 09:00, so an
    /// earlier slot is unfinished and the clock's slot stays natural.
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

    // MARK: Segments as slots (2026-10-11): the natural page and auto-advance

    private func slot(_ id: Int, _ start: String, waiting: [Int] = [], considered: Int = 0) -> ReminderGroupDTO {
        let done = (0..<considered).map { TaskDTO(id: id * 100 + 50 + $0, title: "Done \($0)", isReminder: true) }
        return ReminderGroupDTO(
            slot: TimeSlotDTO(id: id, label: "Slot \(id)", startTime: start),
            reminders: waiting.map { TaskDTO(id: $0, title: "Reminder \($0)", isReminder: true) },
            considered: done.count, consideredItems: done, prompts: []
        )
    }

    /// 07:00 and 12:00 finished, 20:00 still to come (with something in it).
    private var finishedSoFar: [ReminderGroupDTO] {
        [slot(1, "07:00", considered: 2), slot(2, "12:00", considered: 1), slot(3, "20:00", waiting: [301])]
    }

    func testOnceTheDaySoFarIsFinishedTheFirstWaitingSegmentIsNatural() {
        // Days has nothing waiting (considered only), Weeks does.
        let listed = TaskSegmentDTO.listed(segments(daysWaiting: false))
        XCTAssertEqual(RemindersTimeline.naturalPageKey(groups: finishedSoFar, segments: listed, now: noon), -11)
        let page = RemindersTimeline.displayedPage(groups: finishedSoFar, segments: listed, now: noon)
        XCTAssertEqual(page.segmentIndex, 1)
        XCTAssertEqual(page.slotIndex, 1, "the slot-only families keep the clock's slot")
    }

    func testAnEarlierUnfinishedSlotStillWins() {
        let groups = [slot(1, "07:00", waiting: [101]), slot(2, "12:00", considered: 1)]
        let listed = TaskSegmentDTO.listed(segments())
        XCTAssertEqual(RemindersTimeline.naturalPageKey(groups: groups, segments: listed, now: noon), 2)
    }

    func testTheClocksSlotWaitingIsNatural() {
        let groups = [slot(1, "07:00", considered: 1), slot(2, "12:00", waiting: [201])]
        let listed = TaskSegmentDTO.listed(segments())
        XCTAssertEqual(RemindersTimeline.naturalPageKey(groups: groups, segments: listed, now: noon), 2)
    }

    func testWithNoSegmentWaitingTheFinishedClocksSlotIsNatural() {
        let considered = [TaskSegmentDTO(horizon: "days", tasks: [row(1, .considered)])]
        XCTAssertEqual(RemindersTimeline.naturalPageKey(groups: finishedSoFar, segments: considered, now: noon), 2)
    }

    func testFinishingTheClocksSlotLandsOnTheWaitingSegment() {
        // The clock's slot has one reminder left; Days waits.
        let groups = [slot(1, "07:00", considered: 2), slot(2, "12:00", waiting: [201]), slot(3, "20:00", waiting: [301])]
        let segs = segments()
        XCTAssertNil(RemindersTimeline.displayedPage(groups: groups, segments: TaskSegmentDTO.listed(segs), now: noon).segmentIndex)

        WidgetStore.stagePendingCompletion(201, now: noon)
        RemindersTimeline.autoAdvanceSlot(in: groups, segments: segs, now: noon)
        let filtered = WidgetStore.filterPending(groups, now: noon)
        XCTAssertEqual(
            RemindersTimeline.displayedPageKey(groups: filtered, segments: TaskSegmentDTO.listed(segs), now: noon), -10
        )
    }

    func testFinishingALaterSlotOnceTheDayIsDoneSoFarLandsOnTheSegment() {
        // The day so far is finished, so Days is natural; the user chevrons
        // ahead to 20:00 and checks off its one reminder there.
        let segs = segments()
        let listed = TaskSegmentDTO.listed(segs)
        WidgetStore.setSlotOverride(slotKey: 3, naturalSlotKey: -10)
        XCTAssertEqual(RemindersTimeline.displayedPageKey(groups: finishedSoFar, segments: listed, now: noon), 3)

        WidgetStore.stagePendingCompletion(301, now: noon)
        RemindersTimeline.autoAdvanceSlot(in: finishedSoFar, segments: segs, now: noon)
        let filtered = WidgetStore.filterPending(finishedSoFar, now: noon)
        XCTAssertEqual(RemindersTimeline.displayedPageKey(groups: filtered, segments: listed, now: noon), -10)
    }

    func testAJumpToATaskBarResolvesToItsPage() {
        // `JumpToReminderSlotIntent` writes exactly this for a task bar.
        let groups = [slot(1, "07:00", waiting: [101]), slot(2, "12:00", waiting: [201])]
        let listed = TaskSegmentDTO.listed(segments())
        let naturalKey = RemindersTimeline.naturalPageKey(groups: groups, segments: listed, now: noon)!
        XCTAssertTrue(RemindersTimeline.pageKeys(groups: groups, segments: listed).contains(-11))
        WidgetStore.setSlotOverride(slotKey: -11, naturalSlotKey: naturalKey)
        XCTAssertEqual(RemindersTimeline.displayedPage(groups: groups, segments: listed, now: noon).segmentIndex, 1)
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

    // MARK: Upcoming (2026-10-12)

    /// Upcoming's words: the target date always (it is the whole point of the
    /// segment), the deadline's gap, "repeats" — never the task's horizon.
    func testUpcomingRowWords() {
        let now = DateHelpers.parseISO("2026-10-12T15:00:00.000Z")!
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "America/Chicago")!
        let nb = "\u{00A0}"
        let dot = "\(nb)·\(nb)"
        func words(_ s: String) -> String { s.replacingOccurrences(of: " ", with: nb) }

        let plain = TaskDTO(id: 1, title: "Renew", dueAt: "2026-10-13T14:00:00.000Z", horizon: "weeks")
        XCTAssertEqual(plain.segmentMeta(segmentHorizon: "upcoming", now: now, calendar: cal), words("Target Tue Oct 13"))

        let gap = TaskDTO(
            id: 2, title: "Passport", dueAt: "2026-10-13T14:00:00.000Z", deadlineAt: "2026-10-17T22:00:00.000Z"
        )
        XCTAssertEqual(
            gap.segmentMeta(segmentHorizon: "upcoming", now: now, calendar: cal),
            words("Target Tue Oct 13") + dot + words("deadline Sat Oct 17 (+4d)")
        )
        XCTAssertEqual(
            gap.segmentLabelText(segmentHorizon: "upcoming", now: now, calendar: cal),
            "Passport ·\(nb)" + words("Target Tue Oct 13") + dot + words("deadline Sat Oct 17 (+4d)")
        )

        let sameDay = TaskDTO(
            id: 3, title: "Same", dueAt: "2026-10-13T14:00:00.000Z", deadlineAt: "2026-10-13T22:00:00.000Z"
        )
        XCTAssertEqual(
            sameDay.upcomingMeta(calendar: cal),
            words("Target Tue Oct 13") + dot + words("deadline Tue Oct 13 (same day)")
        )

        let before = TaskDTO(
            id: 4, title: "Late", dueAt: "2026-10-26T14:00:00.000Z", deadlineAt: "2026-10-23T22:00:00.000Z"
        )
        XCTAssertEqual(
            before.upcomingMeta(calendar: cal),
            words("Target Mon Oct 26") + dot + words("deadline Fri Oct 23 (deadline before target)")
        )

        let repeating = TaskDTO(id: 5, title: "Plants", dueAt: "2026-10-14T14:00:00.000Z", rrule: "FREQ=DAILY;INTERVAL=3")
        XCTAssertEqual(repeating.upcomingMeta(calendar: cal), words("Target Wed Oct 14") + dot + "repeats")
    }

    /// Upcoming is its own kind: its own page key, label and colour — never a
    /// horizon's, so the `.weeks` fallback can't catch it.
    func testUpcomingIsItsOwnSegmentKind() {
        let upcoming = TaskSegmentDTO(horizon: "upcoming", tasks: [row(7)])
        XCTAssertEqual(upcoming.kind, .upcoming)
        XCTAssertTrue(upcoming.isUpcoming)
        XCTAssertNil(upcoming.horizonValue, "Upcoming is not a task horizon")
        XCTAssertEqual(upcoming.label, "Upcoming")
        XCTAssertEqual(upcoming.pageKey, -14)
        XCTAssertEqual(SegmentKind.upcoming.colorHex.light, 0x1A8FB0)
        XCTAssertEqual(SegmentKind.upcoming.colorHex.dark, 0x4CB8D9)
        XCTAssertEqual(SegmentKind.upcoming.titleHex.light, 0x136F8A)
        XCTAssertEqual(SegmentKind.upcoming.titleHex.dark, 0x4CB8D9)
        // The horizons keep their keys (a stored override still lands).
        XCTAssertEqual(
            ["days", "weeks", "months", "eventually"].map { TaskSegmentDTO(horizon: $0, tasks: []).pageKey },
            [-10, -11, -12, -13]
        )
        XCTAssertNil(TaskSegmentDTO(horizon: "someday", tasks: []).kind)
        XCTAssertEqual(TaskSegmentDTO(horizon: "someday", tasks: []).pageKey, -15)

        let bars = ReminderDayProgress.stripBars(
            groups: [], segments: [TaskSegmentDTO(horizon: "days", tasks: [row(1)]), upcoming], now: t0
        )
        XCTAssertEqual(bars.map(\.segment), [.horizon(.days), .upcoming])
        XCTAssertEqual(bars.map(\.label), ["Tasks · Days", "Tasks · Upcoming"])
    }

    /// A repeating row has no Today: `recurring` from the wire, else its rrule.
    func testARepeatingRowOffersNoTargetToday() throws {
        let oneOff = SegmentTaskDTO(task: TaskDTO(id: 1, title: "A"), state: .waiting)
        XCTAssertTrue(oneOff.offersTargetToday)
        let repeating = SegmentTaskDTO(task: TaskDTO(id: 2, title: "B", rrule: "FREQ=DAILY"), state: .waiting)
        XCTAssertFalse(repeating.offersTargetToday)
        XCTAssertFalse(repeating.with(state: .considered).offersTargetToday, "with(state:) keeps it")
        // An older cache with no `recurring` key falls back to the rrule.
        let json = #"{"id": 3, "title": "C", "rrule": "FREQ=WEEKLY", "segment_state": "waiting"}"#
        XCTAssertTrue(try JSONDecoder().decode(SegmentTaskDTO.self, from: Data(json.utf8)).recurring)
        // The wire's own flag wins.
        let flagged = #"{"id": 4, "title": "D", "recurring": true, "segment_state": "waiting"}"#
        XCTAssertTrue(try JSONDecoder().decode(SegmentTaskDTO.self, from: Data(flagged.utf8)).recurring)
    }

    /// `skipped_recurring` (2026-10-12): the server left the task alone, so the
    /// row comes back rather than being dropped from the cache.
    func testASkippedRecurringTargetTodayPutsTheRowBack() async throws {
        WidgetStore.saveReminders(try Fixtures.reminders(), taskSegments: segments(), fetchStartedAt: t0)
        tapTargetToday(3)
        let transport = StubOutboxTransport()
        transport.targetResults = [.success(APIClient.SegmentTargetResult(affected: 0, skippedRecurring: [3]))]
        await WidgetOutboxDrainer(transport: transport, clock: { [t0] in t0 }) { _ in }.drain()
        XCTAssertEqual(transport.calls, [.targetToday([3])])
        XCTAssertTrue(WidgetStore.outboxEntries().isEmpty, "sent, not retried")
        XCTAssertTrue(WidgetStore.pendingSegmentTargets(now: t0).isEmpty)
        XCTAssertEqual(WidgetStore.loadReminders()?.value.taskSegments[1].tasks.map(\.id), [3, 4], "still in the cache")
    }
}
