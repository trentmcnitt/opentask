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

    /// EVERY segment is a page (native PR E, `?fill=1`: "always show every
    /// queue segment, every day, in fixed positions") — an all-deferred one
    /// and an empty one too, which used to drop out of the ring.
    func testSegmentsComeAfterTheSlotsAndEverySegmentIsAPage() throws {
        let groups = try Fixtures.reminders()
        let listed = TaskSegmentDTO.listed(segments() + [TaskSegmentDTO(horizon: "eventually", tasks: [])])
        XCTAssertEqual(listed.map(\.horizon), ["days", "weeks", "months", "eventually"])
        // Under the slots (Trent, 10-11), so after them in the ring.
        XCTAssertEqual(
            RemindersTimeline.pageKeys(groups: groups, segments: listed),
            groups.map(\.slotKey) + [-10, -11, -12, -13]
        )
        XCTAssertTrue(listed[3].isEmpty)
        XCTAssertFalse(listed[3].hasWaiting, "an empty segment waits for nothing")
    }

    /// The queue's panels and the deadlines page (native PR E): their own
    /// page keys, so an override never lands on another page.
    func testTheNewKindsHaveTheirOwnPageKeys() {
        let kinds: [String: Int] = ["deadlines": -16, "queue_today": -17, "queue_previous": -18]
        for (raw, key) in kinds {
            let segment = TaskSegmentDTO(horizon: raw, tasks: [])
            XCTAssertEqual(segment.pageKey, key, raw)
            XCTAssertEqual(segment.kind?.raw, raw)
            XCTAssertFalse(segment.offersDeferAll, "no Defer all on \(raw)")
        }
        XCTAssertEqual(TaskSegmentDTO(horizon: "someday", tasks: []).pageKey, -15, "an unknown kind")
        XCTAssertTrue(TaskSegmentDTO(horizon: "days", tasks: []).offersDeferAll)
        XCTAssertTrue(TaskSegmentDTO(horizon: "upcoming", tasks: []).offersDeferAll)
        // An empty deadlines page waits for nothing: the clock's slot stays
        // natural, and with no slots the first waiting segment wins over it.
        let ring = [TaskSegmentDTO(horizon: "deadlines", tasks: [])] + segments()
        XCTAssertEqual(RemindersTimeline.naturalPageKey(groups: [], segments: ring, now: noon), -10)
    }

    /// The fixture at 12:30 has prompts waiting in 07:00 and 09:00, so an
    /// earlier slot is unfinished: the default page is the EARLIEST of them
    /// (the default-page ruling of 2026-10-27, `ReminderDefaultPageTests`;
    /// it was the clock's slot before), and a waiting segment waits behind it.
    func testTheEarliestUnfinishedSlotIsNaturalEvenWhileASegmentWaits() throws {
        let groups = try Fixtures.reminders()
        let listed = TaskSegmentDTO.listed(segments())
        XCTAssertFalse(groups[0].hasNothingWaiting)
        XCTAssertEqual(RemindersTimeline.naturalPageKey(groups: groups, segments: listed, now: noon), groups[0].slotKey)
        let page = RemindersTimeline.displayedPage(groups: groups, segments: listed, now: noon)
        XCTAssertNil(page.segmentIndex)
        XCTAssertEqual(page.slotIndex, 0)

        // No slots at all: the first waiting segment is the page.
        let daysDone = TaskSegmentDTO.listed(segments(daysWaiting: false))
        XCTAssertEqual(RemindersTimeline.naturalPageKey(groups: [], segments: daysDone, now: noon), -11)
    }

    func testWithNoSegmentWaitingTheEarliestUnfinishedSlotIsNatural() throws {
        let groups = try Fixtures.reminders()
        let considered = [TaskSegmentDTO(horizon: "days", tasks: [row(1, .considered)])]
        XCTAssertEqual(RemindersTimeline.naturalPageKey(groups: groups, segments: considered, now: noon), groups[0].slotKey)
        let page = RemindersTimeline.displayedPage(groups: groups, segments: considered, now: noon)
        XCTAssertNil(page.segmentIndex)
        XCTAssertEqual(page.slotIndex, 0)
    }

    func testAnOverrideOntoASegmentPageResolvesToIt() throws {
        let groups = try Fixtures.reminders()
        let considered = TaskSegmentDTO.listed([TaskSegmentDTO(horizon: "days", tasks: [row(1, .considered)])])
        let naturalKey = try XCTUnwrap(RemindersTimeline.naturalPageKey(groups: groups, segments: considered, now: noon))
        WidgetStore.setSlotOverride(slotKey: -10, naturalSlotKey: naturalKey)
        XCTAssertEqual(RemindersTimeline.displayedPage(groups: groups, segments: considered, now: noon).segmentIndex, 0)
    }

    /// Auto-advance off a finished slot the user flipped to drops the flip,
    /// so the display follows the default page (2026-10-27; it used to
    /// write an override of its own, anchored to the natural page).
    func testAutoAdvanceOffAFinishedFlippedSlotDropsTheFlip() throws {
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
        XCTAssertNil(WidgetStore.slotOverride())
        XCTAssertEqual(
            RemindersTimeline.displayedPageKey(groups: groups, segments: TaskSegmentDTO.listed(segs), now: noon), naturalKey
        )
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

    /// An earlier unfinished slot wins over the segments — and over the
    /// clock's finished slot (2026-10-27: it is the default page itself, not
    /// only where auto-advance lands; this read 2, the clock's, before).
    func testAnEarlierUnfinishedSlotStillWins() {
        let groups = [slot(1, "07:00", waiting: [101]), slot(2, "12:00", considered: 1)]
        let listed = TaskSegmentDTO.listed(segments())
        XCTAssertEqual(RemindersTimeline.naturalPageKey(groups: groups, segments: listed, now: noon), 1)
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

    /// A done row LEAVES handled (native PR E, `?handled=1`): drawn as the
    /// server sends it back — considered, `segment_left: done` — so "N of M"
    /// stays fixed for the day.
    func testConsiderDrawsTheRowConsideredAndDoneLeavesItHandled() {
        WidgetStore.stagePendingSegmentConsider(3, now: t0)
        WidgetStore.stagePendingCompletion(1, now: t0)
        let drawn = WidgetStore.filterPendingSegments(segments(), now: t0)
        XCTAssertEqual(drawn[0].tasks.map(\.id), [1, 2], "the done row stays, nothing moves")
        XCTAssertEqual(drawn[0].tasks.map(\.state), [.considered, .considered])
        XCTAssertEqual(drawn[0].tasks.map(\.left), [.done, nil])
        XCTAssertEqual(ReminderDayProgress.PeriodCount(drawn[0]).text, "2 of 2", "M never shrinks")
        XCTAssertEqual(drawn[1].tasks.map(\.state), [.considered, .deferred])
        XCTAssertFalse(drawn[1].hasWaiting)
        XCTAssertTrue(WidgetStore.hasRecentInteraction(now: t0), "a consider repaints from cache")
    }

    /// The deadlines page's SAFETY NET (native PR E): a consider marks the
    /// row seen and it keeps waiting; a seen row is no longer considerable.
    func testAConsiderInTheSafetyNetSeesTheRowAndKeepsItWaiting() throws {
        let net = SegmentTaskDTO(task: TaskDTO(id: 7, title: "Task 7"), state: .waiting, safetyNet: true)
        let plain = row(8)
        let deadlines = [TaskSegmentDTO(horizon: "deadlines", tasks: [net, plain])]
        WidgetStore.stagePendingSegmentConsider(7, now: t0)
        WidgetStore.stagePendingSegmentConsider(8, now: t0)
        let drawn = WidgetStore.filterPendingSegments(deadlines, now: t0)
        XCTAssertEqual(drawn[0].tasks.map(\.state), [.waiting, .considered])
        XCTAssertEqual(drawn[0].tasks.map(\.seen), [true, false])
        XCTAssertFalse(drawn[0].tasks[0].isConsiderable, "its circle is inert now")
        XCTAssertTrue(drawn[0].hasWaiting, "the deadline is close, so it stays")
        // The server's answer, written in: seen, still waiting.
        WidgetStore.saveReminders([], taskSegments: deadlines, fetchStartedAt: t0)
        WidgetStore.confirmSegmentConsider(7)
        let cached = try XCTUnwrap(WidgetStore.loadReminders()?.value.taskSegments.first?.tasks.first)
        XCTAssertEqual(cached.state, .waiting)
        XCTAssertTrue(cached.seen)
    }

    func testCacheWritesKeepSegmentsAndConfirmCompletionLeavesTheRowHandled() throws {
        WidgetStore.saveReminders(try Fixtures.reminders(), taskSegments: segments(), fetchStartedAt: t0)
        WidgetStore.confirmCompletion(1)
        WidgetStore.confirmSegmentConsider(3)
        WidgetStore.confirmSegmentDefer([2])
        let cached = try XCTUnwrap(WidgetStore.loadReminders()?.value)
        XCTAssertEqual(cached.groups.count, 6)
        XCTAssertEqual(cached.taskSegments[0].tasks.map(\.id), [1, 2])
        XCTAssertEqual(cached.taskSegments[0].tasks.map(\.state), [.considered, .deferred])
        XCTAssertEqual(cached.taskSegments[0].tasks.first?.left, .done)
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

    func testTargetTodayLeavesTheRowHandled() {
        tapTargetToday(3)
        let drawn = WidgetStore.filterPendingSegments(segments(), now: t0.addingTimeInterval(600))
        XCTAssertEqual(drawn[1].tasks.map(\.id), [3, 4], "queued = still drawn as it left")
        XCTAssertEqual(drawn[1].tasks.first?.left, .target)
        XCTAssertEqual(drawn[1].tasks.first?.state, .considered)
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
        XCTAssertEqual(WidgetStore.loadReminders()?.value.taskSegments[1].tasks.map(\.id), [3, 4])
        XCTAssertEqual(WidgetStore.loadReminders()?.value.taskSegments[1].tasks.first?.left, .target)
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
        XCTAssertEqual(set.segmentMeta(segmentHorizon: "days", now: now, calendar: cal), "Weeks\u{00A0}· Nov\u{00A0}1")
        XCTAssertEqual(
            set.segmentLabelText(segmentHorizon: "days", now: now, calendar: cal),
            "Fix the gate\u{00A0}· Weeks\u{00A0}· Nov\u{00A0}1"
        )
        // Words that don't fit on the title's last line start their own,
        // with no separator; words that wrap even alone go one part per
        // line, with no dot (2026-10-12: never a "·" at either end of a line).
        XCTAssertEqual(
            set.segmentLabelText(segmentHorizon: "days", now: now, calendar: cal, placement: .ownLine),
            "Fix the gate\nWeeks\u{00A0}· Nov\u{00A0}1"
        )
        XCTAssertEqual(
            set.segmentLabelText(segmentHorizon: "days", now: now, calendar: cal, placement: .partsOnOwnLines),
            "Fix the gate\nWeeks\nNov\u{00A0}1"
        )
        XCTAssertEqual(SegmentMetaPlacement.partsOnOwnLines.joined(meta: "One"), "\nOne")
        // Every break opportunity around a dot is AFTER it.
        XCTAssertFalse(TaskDTO.metaJoiner.hasPrefix(" "))
        XCTAssertTrue(TaskDTO.metaJoiner.hasSuffix(" "))
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

    /// Upcoming's words (one line since 2026-10-12, Trent's review of #251):
    /// the target's day with no "Target" word, the schedule of a repeating
    /// one, the deadline — no "(+Nd)", no "(same day)" — and never the task's
    /// horizon. Each `UpcomingMetaForm` drops a little more.
    func testUpcomingRowWords() {
        let now = DateHelpers.parseISO("2026-10-12T15:00:00.000Z")!
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "America/Chicago")!
        let nb = "\u{00A0}"
        let dot = "\(nb)· "
        func words(_ s: String) -> String { s.replacingOccurrences(of: " ", with: nb) }

        let plain = TaskDTO(id: 1, title: "Renew", dueAt: "2026-10-13T14:00:00.000Z", horizon: "weeks")
        XCTAssertEqual(plain.segmentMeta(segmentHorizon: "upcoming", now: now, calendar: cal), words("Tue Oct 13"))
        XCTAssertEqual(
            plain.segmentMeta(segmentHorizon: "upcoming", now: now, calendar: cal, upcomingForm: .short), words("Oct 13")
        )

        let gap = TaskDTO(
            id: 2, title: "Passport", dueAt: "2026-10-13T14:00:00.000Z", deadlineAt: "2026-10-17T22:00:00.000Z"
        )
        XCTAssertEqual(
            gap.segmentMeta(segmentHorizon: "upcoming", now: now, calendar: cal),
            words("Tue Oct 13") + dot + words("deadline Sat Oct 17")
        )
        XCTAssertEqual(
            gap.segmentLabelText(segmentHorizon: "upcoming", now: now, calendar: cal),
            "Passport" + dot + words("Tue Oct 13") + dot + words("deadline Sat Oct 17")
        )
        XCTAssertEqual(gap.upcomingMeta(calendar: cal, form: .short), words("Oct 13") + dot + words("deadline Oct 17"))

        let sameDay = TaskDTO(
            id: 3, title: "Same", dueAt: "2026-10-13T14:00:00.000Z", deadlineAt: "2026-10-13T22:00:00.000Z"
        )
        XCTAssertEqual(sameDay.upcomingMeta(calendar: cal), words("Tue Oct 13") + dot + words("deadline Tue Oct 13"))

        let before = TaskDTO(
            id: 4, title: "Late", dueAt: "2026-10-26T14:00:00.000Z", deadlineAt: "2026-10-23T22:00:00.000Z"
        )
        XCTAssertEqual(
            before.upcomingMeta(calendar: cal),
            words("Mon Oct 26") + dot + words("deadline Fri Oct 23 (deadline before target)")
        )
        XCTAssertEqual(
            before.upcomingMeta(calendar: cal, form: .noScheduleOn),
            words("Mon Oct 26") + dot + words("deadline Fri Oct 23 (deadline first)")
        )
        XCTAssertEqual(
            before.upcomingMeta(calendar: cal, form: .short),
            words("Oct 26") + dot + words("deadline Oct 23 (deadline first)")
        )
        XCTAssertEqual(before.upcomingMeta(calendar: cal, form: .shortest), words("Oct 26") + dot + words("deadline Oct 23"))
        XCTAssertEqual(gap.upcomingMeta(calendar: cal, form: .shortest), gap.upcomingMeta(calendar: cal, form: .short))

        let repeating = TaskDTO(id: 5, title: "Plants", dueAt: "2026-10-14T14:00:00.000Z", rrule: "FREQ=DAILY;INTERVAL=3")
        XCTAssertEqual(repeating.upcomingMeta(calendar: cal), words("Wed Oct 14") + dot + words("every 3 days"))
        let weekly = TaskDTO(
            id: 6, title: "Bins", dueAt: "2026-10-14T14:00:00.000Z", rrule: "FREQ=WEEKLY;BYDAY=WE", anchorTime: "09:00"
        )
        XCTAssertEqual(weekly.upcomingMeta(calendar: cal), words("Wed Oct 14") + dot + words("every Wed at 9 AM"))
        XCTAssertEqual(
            weekly.upcomingMeta(calendar: cal, form: .noScheduleTime), words("Wed Oct 14") + dot + words("every Wed")
        )
        let biweekly = TaskDTO(
            id: 8, title: "Recycling", dueAt: "2026-10-14T14:00:00.000Z", rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE",
            anchorTime: "07:00"
        )
        XCTAssertEqual(
            biweekly.upcomingMeta(calendar: cal), words("Wed Oct 14") + dot + words("every 2 weeks on Wed at 7 AM")
        )
        XCTAssertEqual(
            biweekly.upcomingMeta(calendar: cal, form: .noScheduleTime),
            words("Wed Oct 14") + dot + words("every 2 weeks on Wed")
        )
        XCTAssertEqual(
            biweekly.upcomingMeta(calendar: cal, form: .noScheduleOn), words("Wed Oct 14") + dot + words("every 2 weeks")
        )
        XCTAssertEqual(biweekly.upcomingMeta(calendar: cal, form: .short), words("Oct 14") + dot + words("every 2 weeks"))
        let unreadable = TaskDTO(id: 7, title: "Odd", dueAt: "2026-10-14T14:00:00.000Z", rrule: "FREQ=HOURLY")
        XCTAssertEqual(unreadable.upcomingMeta(calendar: cal), words("Wed Oct 14") + dot + "repeats")
    }

    /// The two badges ride at the end of a segment row's words (the web's
    /// `BadgeChips`): the server's attempts label on a row with a target, the
    /// age label on an undated one — the server's strings, never recounted.
    func testSegmentRowsCarryTheBadges() {
        let now = DateHelpers.parseISO("2026-10-12T15:00:00.000Z")!
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "America/Chicago")!
        let nb = "\u{00A0}"
        let dot = "\(nb)· "
        let undated = TaskDTO(id: 1, title: "Garage", horizon: "weeks", ageLabel: ">1 mo")
        XCTAssertEqual(undated.segmentMeta(segmentHorizon: "weeks", now: now, calendar: cal), ">1\(nb)mo")
        let moved = TaskDTO(
            id: 2, title: "Hinges", dueAt: "2026-10-14T14:00:00.000Z", deadlineAt: "2026-10-17T22:00:00.000Z",
            attempts: 3, attemptsLabel: "3×"
        )
        XCTAssertEqual(
            moved.segmentMeta(segmentHorizon: "upcoming", now: now, calendar: cal),
            "Wed\(nb)Oct\(nb)14" + dot + "deadline\(nb)Sat\(nb)Oct\(nb)17" + dot + "3×"
        )
        // No target, no attempts badge, whatever the label says.
        let noTarget = TaskDTO(id: 3, title: "X", horizon: "days", attemptsLabel: "2×")
        XCTAssertNil(noTarget.segmentMeta(segmentHorizon: "days", now: now, calendar: cal))
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

        // The titles (2026-10-26, the web's `segmentTitle`): "Task queue ·"
        // and the cadence word — the row word ("Days") keeps its name.
        XCTAssertEqual(
            ["days", "weeks", "months", "eventually", "upcoming"].map { TaskSegmentDTO(horizon: $0, tasks: []).title },
            [
                "Task queue · Daily", "Task queue · Weekly", "Task queue · Monthly", "Task queue · Quarterly",
                "Task queue · Upcoming",
            ]
        )
        XCTAssertEqual(TaskSegmentDTO(horizon: "weeks", tasks: []).label, "Weeks")
        XCTAssertEqual(TaskSegmentDTO(horizon: "someday", tasks: []).title, "Task queue · Someday")
        // A wrapping header breaks after the dot, never before it.
        XCTAssertEqual(TaskSegmentDTO(horizon: "eventually", tasks: []).wrappingTitle, "Task queue\u{00A0}· Quarterly")
        // The Smart Stack card's short header: the word alone; a period keeps its name.
        XCTAssertEqual(TaskWording.withoutTaskQueuePrefix("Task queue · Upcoming"), "Upcoming")
        XCTAssertNil(TaskWording.withoutTaskQueuePrefix("Early morning"))

        let bars = ReminderDayProgress.stripBars(
            groups: [], segments: [TaskSegmentDTO(horizon: "days", tasks: [row(1)]), upcoming], now: t0,
            day: .midnight(timeZone: .current)
        )
        XCTAssertEqual(bars.map(\.segment), [.horizon(.days), .upcoming])
        XCTAssertEqual(bars.map(\.label), ["Task queue · Daily", "Task queue · Upcoming"])
    }

    /// Every row offers Today, repeating ones included (batch 2, 2026-10-12:
    /// the server keeps the occurrence apart from the target), and
    /// `recurring` still decodes — from the wire, else the rrule.
    func testEveryRowOffersTargetToday() throws {
        let oneOff = SegmentTaskDTO(task: TaskDTO(id: 1, title: "A"), state: .waiting)
        XCTAssertTrue(oneOff.offersTargetToday)
        let repeating = SegmentTaskDTO(task: TaskDTO(id: 2, title: "B", rrule: "FREQ=DAILY"), state: .waiting)
        XCTAssertTrue(repeating.recurring)
        XCTAssertTrue(repeating.offersTargetToday)
        XCTAssertTrue(repeating.with(state: .considered).offersTargetToday)
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
