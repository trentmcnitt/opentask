import XCTest

/// Which page the Reminders widget and the watch's Reminders page open to by
/// default (`ReminderDefaultPage`, ios/Shared) — Trent's ruling of
/// 2026-10-27: the leftmost unfinished page in the strip, except Deadlines
/// goes first while it has unseen rows. One test per step, then the widget's
/// manual override and auto-advance on top of it (`RemindersTimeline`).
///
/// Synthetic data only. The day starts at 3:00 (remembered in the test
/// suite's throwaway App Group, so `RemindersTimeline`'s own default day is
/// the same one); every instant is local on 2026-10-27.
final class ReminderDefaultPageTests: WidgetStoreTestCase {

    /// After `WidgetStoreTestCase.setUp` has pointed the stores at the
    /// throwaway suite — never the real App Group.
    override func setUp() {
        super.setUp()
        XCTAssertNoThrow(try rememberDayStart("03:00"))
    }

    private var day: OpenTaskDay { DayStartStore.current }

    private func at(_ hour: Int, _ minute: Int = 0, day: Int = 27) -> Date {
        Calendar.current.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour, minute: minute))!
    }

    // MARK: Builders

    private func period(_ id: Int, _ start: String?, waiting: Int = 0, handled: Int = 0) -> ReminderGroupDTO {
        let done = (0..<handled).map { TaskDTO(id: id * 100 + 50 + $0, title: "Done \(id).\($0)", isReminder: true) }
        return ReminderGroupDTO(
            slot: start.map { TimeSlotDTO(id: id, label: "Period \(id)", startTime: $0) },
            reminders: (0..<waiting).map { TaskDTO(id: id * 100 + $0, title: "Reminder \(id).\($0)", isReminder: true) },
            considered: done.count, consideredItems: done, prompts: []
        )
    }

    private func row(
        _ id: Int, _ state: SegmentTaskDTO.State = .waiting, safetyNet: Bool = false, seen: Bool = false
    ) -> SegmentTaskDTO {
        SegmentTaskDTO(task: TaskDTO(id: id, title: "Task \(id)"), state: state, safetyNet: safetyNet, seen: seen)
    }

    /// Every kind, in the server's (and the strip's) order, each empty unless
    /// given rows: Deadlines, Today's pulls, Previous pulls, Daily, Upcoming,
    /// Weekly, Monthly, Quarterly.
    private func strip(_ rows: [String: [SegmentTaskDTO]] = [:]) -> [TaskSegmentDTO] {
        ["deadlines", "queue_today", "queue_previous", "days", "upcoming", "weeks", "months", "eventually"]
            .map { TaskSegmentDTO(horizon: $0, tasks: rows[$0] ?? []) }
    }

    /// Morning 07:00, Midday 12:00, Evening 18:00.
    private func periods(morning: Int = 0, midday: Int = 0, evening: Int = 0) -> [ReminderGroupDTO] {
        [
            period(1, "07:00", waiting: morning, handled: morning == 0 ? 2 : 0),
            period(2, "12:00", waiting: midday, handled: midday == 0 ? 1 : 0),
            period(3, "18:00", waiting: evening, handled: evening == 0 ? 1 : 0),
        ]
    }

    private func key(_ groups: [ReminderGroupDTO], _ segments: [TaskSegmentDTO], _ now: Date) -> Int? {
        ReminderDefaultPage.key(groups: groups, segments: segments, now: now, day: day)
    }

    private let deadlinesKey = -16, queueTodayKey = -17, queuePreviousKey = -18, dailyKey = -10
    private let upcomingKey = -14, weeklyKey = -11

    // MARK: Step 1 — Deadlines while it has an unseen row

    func testDeadlinesWithAnUnseenRowGoesFirst() {
        // Morning waits too; Deadlines still wins.
        let segments = strip(["deadlines": [row(1)], "days": [row(2)]])
        XCTAssertEqual(key(periods(morning: 2), segments, at(9)), deadlinesKey)
        // An unseen SAFETY-NET row counts: it waits until seen.
        let net = strip(["deadlines": [row(1, safetyNet: true)]])
        XCTAssertEqual(key(periods(morning: 2), net, at(9)), deadlinesKey)
    }

    func testASeenSafetyNetRowDoesNotHoldDeadlinesFirst() {
        // Seen: still waiting (the web's rule), but it no longer counts here.
        let seenRow = row(1, safetyNet: true, seen: true)
        XCTAssertEqual(seenRow.state, .waiting)
        let segments = strip(["deadlines": [seenRow]])
        XCTAssertTrue(segments[0].hasWaiting)
        XCTAssertEqual(key(periods(morning: 2), segments, at(9)), 1, "the waiting Morning, not Deadlines")
        // One unseen row beside it is enough.
        let mixed = strip(["deadlines": [seenRow, row(2)]])
        XCTAssertEqual(key(periods(morning: 2), mixed, at(9)), deadlinesKey)
    }

    func testAnEmptyOrConsideredDeadlinesPageDoesNotCount() {
        // Empty (`?fill=1`): done from the start.
        XCTAssertTrue(strip()[0].isEmpty)
        XCTAssertEqual(key(periods(morning: 2), strip(), at(9)), 1)
        // Every row considered.
        let considered = strip(["deadlines": [row(1, .considered)]])
        XCTAssertEqual(key(periods(morning: 2), considered, at(9)), 1)
    }

    /// The ruling's step 3 lists the queue's kinds without Deadlines: once
    /// its rows are all seen, it is never the default — even with every
    /// period done and nothing else waiting (its bar stays purple; the
    /// default is the latest opened period, completed — step 5).
    func testDeadlinesWithOnlySeenRowsIsNotAQueueStep() {
        let segments = strip(["deadlines": [row(1, safetyNet: true, seen: true)]])
        XCTAssertEqual(key(periods(), segments, at(13)), 2, "Midday, the latest opened, Complete — not Deadlines")
        XCTAssertEqual(key(periods(), segments, at(20)), 3, "Evening, the latest opened — not Deadlines")
        XCTAssertEqual(key(periods(), segments, at(4)), 1, "before Morning opens: Morning — not Deadlines")
        // A later queue segment waiting is the default instead.
        let withDaily = strip(["deadlines": [row(1, safetyNet: true, seen: true)], "days": [row(2)]])
        XCTAssertEqual(key(periods(), withDaily, at(13)), dailyKey)
    }

    // MARK: Step 2 — the earliest unfinished period that has opened

    func testTheEarliestOpenedUnfinishedPeriod() {
        let segments = strip(["days": [row(2)]])
        // 13:00: Morning still waits, Midday too — Morning, the earliest.
        XCTAssertEqual(key(periods(morning: 1, midday: 1), segments, at(13)), 1)
        // Morning done: Midday.
        XCTAssertEqual(key(periods(midday: 1), segments, at(13)), 2)
    }

    func testAPeriodThatHasNotOpenedIsSkipped() {
        // Evening waits but opens at 18:00; at 13:00 it doesn't count, so
        // with Morning and Midday done the queue comes first.
        let segments = strip(["days": [row(2)]])
        XCTAssertEqual(key(periods(evening: 3), segments, at(13)), dailyKey)
        // Nothing waiting in the queue either: the clock's Midday (Complete),
        // never forward into the unopened Evening.
        XCTAssertEqual(key(periods(evening: 3), strip(), at(13)), 2)
    }

    /// "Anytime" (no start time) has always opened (the web's
    /// `slotHasStarted`) and sits left of the queue in the strip: with
    /// something waiting it comes before the queue.
    func testAnytimeWithSomethingWaitingComesBeforeTheQueue() {
        let groups = periods() + [period(9, nil, waiting: 1)]
        let segments = strip(["days": [row(2)]])
        XCTAssertEqual(key(groups, segments, at(13)), -1)
        // Anytime finished: the queue.
        XCTAssertEqual(key(periods() + [period(9, nil, handled: 1)], segments, at(13)), dailyKey)
    }

    // MARK: Step 3 — the first unfinished queue segment, in strip order

    func testTheFirstUnfinishedQueueSegmentInStripOrder() {
        let all = strip([
            "queue_today": [row(1)], "queue_previous": [row(2)], "days": [row(3)],
            "upcoming": [row(4)], "weeks": [row(5)], "months": [row(6)], "eventually": [row(7)],
        ])
        XCTAssertEqual(key(periods(), all, at(13)), queueTodayKey)

        // Finish them one at a time, left to right: the default walks the
        // strip exactly as it is drawn.
        let order: [(String, Int)] = [
            ("queue_today", queuePreviousKey), ("queue_previous", dailyKey), ("days", upcomingKey),
            ("upcoming", weeklyKey), ("weeks", -12), ("months", -13),
        ]
        var segments = all
        for (finished, next) in order {
            segments = segments.map { $0.horizon == finished ? $0.replacingTasks($0.tasks.map { $0.with(state: .considered) }) : $0 }
            XCTAssertEqual(key(periods(), segments, at(13)), next, "after \(finished)")
        }
    }

    func testDeferredAndEmptySegmentsAreFinished() {
        let segments = strip(["queue_today": [row(1, .deferred)], "days": [row(2, .considered)], "weeks": [row(3)]])
        XCTAssertEqual(key(periods(), segments, at(13)), weeklyKey)
    }

    func testBeforeTheFirstPeriodOpensTheQueueIsTheDefault() {
        // 04:00, after the 3:00 day start: nothing has opened yet.
        let segments = strip(["days": [row(2)]])
        XCTAssertEqual(key(periods(morning: 2), segments, at(4)), dailyKey)
        // With no queue waiting: the first period (the clock's fallback).
        XCTAssertEqual(key(periods(morning: 2), strip(), at(4)), 1)
    }

    // MARK: Step 4 — the next period opens: back to it

    func testWhenTheNextPeriodOpensTheDefaultGoesBackToIt() {
        let groups = periods(evening: 2)
        let segments = strip(["days": [row(2)]])
        XCTAssertEqual(key(groups, segments, at(17, 59)), dailyKey, "Evening hasn't opened")
        XCTAssertEqual(key(groups, segments, at(18)), 3, "Evening opens with something waiting")
        // Re-evaluated, never latched: Evening finished, back to the queue.
        XCTAssertEqual(key(periods(), segments, at(18, 30)), dailyKey)
    }

    /// The widget's pre-scheduled boundary entries re-run the rule at each
    /// period's opening (`scheduledPage`).
    func testTheBoundaryEntryShowsTheOpenedPeriod() {
        let groups = periods(evening: 2)
        let segments = strip(["days": [row(2)]])
        XCTAssertEqual(RemindersTimeline.naturalPage(groups: groups, segments: segments, now: at(17)).segmentIndex, 3)
        let boundary = RemindersTimeline.scheduledPage(groups: groups, segments: segments, now: at(18), override: nil)
        XCTAssertNil(boundary.segmentIndex)
        XCTAssertEqual(boundary.slotIndex, 2)
    }

    // MARK: Step 5 — everything done: the latest opened period, completed

    /// Trent (2026-10-27): "When everything's complete, the widget should,
    /// unless the user overrides it, automatically jump to the latest
    /// reminder period."
    func testEverythingDoneIsTheLatestOpenedPeriod() {
        XCTAssertEqual(key(periods(), strip(), at(7, 30)), 1, "only Morning has opened")
        XCTAssertEqual(key(periods(), strip(), at(13)), 2)
        XCTAssertEqual(key(periods(), strip(), at(17, 59)), 2)
        XCTAssertEqual(key(periods(), strip(), at(18)), 3)
        XCTAssertEqual(key(periods(), strip(), at(20)), 3)
        // 00:30 on the 28th is still the 27th's OpenTask day (3:00 start).
        XCTAssertEqual(key(periods(), strip(), at(0, 30, day: 28)), 3)
        // A 1:00 AM period ends the day: the latest once it has opened.
        let late = periods() + [period(4, "01:00", handled: 1)]
        XCTAssertEqual(key(late, strip(), at(0, 30, day: 28)), 3, "the 1:00 AM period hasn't opened")
        XCTAssertEqual(key(late, strip(), at(1, 30, day: 28)), 4)
        // Every segment finished or empty too: the period draws "Day complete".
        XCTAssertEqual(ReminderDayProgress.emptyBody(groups: periods(), segments: strip(), displayedIndex: 2), .dayComplete)
    }

    /// Later periods still to come (not opened, something waiting): the
    /// latest OPENED one, drawn "Complete" — never forward into one that
    /// hasn't opened.
    func testWithLaterPeriodsToComeTheLatestOpenedReadsComplete() {
        let groups = periods(evening: 1)
        let segments = strip(["days": [row(2, .considered)]])
        XCTAssertEqual(key(groups, segments, at(13)), 2)
        XCTAssertEqual(ReminderDayProgress.emptyBody(groups: groups, segments: segments, displayedIndex: 1), .periodDone)
    }

    /// The server sends every slot; one with nothing in it today has no strip
    /// bar and nothing to show completed, so it is never step 5's period.
    func testAnEmptyPeriodIsNotTheFinishedDefault() {
        let groups = [period(1, "07:00", handled: 2), period(2, "12:00", handled: 1), period(3, "18:00")]
        XCTAssertEqual(key(groups, strip(), at(20)), 2, "Midday, not the empty Evening")
        XCTAssertEqual(ReminderDayProgress.emptyBody(groups: groups, segments: strip(), displayedIndex: 1), .dayComplete)
        // Nor "Anytime", which has no place in the day.
        XCTAssertEqual(key(groups + [period(9, nil, handled: 1)], strip(), at(20)), 2)
        // No period has anything today: the clock's.
        let empty = [period(1, "07:00"), period(2, "12:00"), period(3, "18:00")]
        XCTAssertEqual(key(empty, strip(), at(13)), 2)
    }

    /// Between the day start and the first period nothing has opened, and the
    /// payload is TODAY's groups: yesterday's last period isn't there, and
    /// today's would draw not started. So: the next period to open that has
    /// anything in it.
    func testBeforeTheFirstPeriodTheNextToOpen() {
        XCTAssertEqual(key(periods(morning: 2, midday: 1, evening: 1), strip(), at(4)), 1)
        // Morning has nothing today: Midday, the next with anything in it.
        let groups = [period(1, "07:00"), period(2, "12:00", waiting: 1), period(3, "18:00", waiting: 2)]
        XCTAssertEqual(key(groups, strip(), at(4)), 2)
    }

    func testNoPeriodsAtAllIsTheFirstSegment() {
        XCTAssertEqual(key([], strip(), at(13)), deadlinesKey)
        XCTAssertNil(key([], [], at(13)))
    }

    /// A flip made with everything done holds while the default does — an
    /// EMPTY period opening doesn't move it — and lapses when a period with
    /// something waiting opens.
    func testAFlipInTheFinishedStateHoldsThenLapses() throws {
        let groups = [
            period(1, "07:00", handled: 2), period(2, "12:00", handled: 1), period(5, "15:00"),
            period(3, "18:00", waiting: 1),
        ]
        let segments = TaskSegmentDTO.listed(strip())
        let natural = try XCTUnwrap(RemindersTimeline.naturalPageKey(groups: groups, segments: segments, now: at(13)))
        XCTAssertEqual(natural, 2, "Midday, the latest opened")
        WidgetStore.setSlotOverride(slotKey: 1, naturalSlotKey: natural) // back to Morning
        XCTAssertEqual(RemindersTimeline.displayedPageKey(groups: groups, segments: segments, now: at(14)), 1)
        // The empty 15:00 period opens: the default stays Midday, the flip holds.
        let quiet = RemindersTimeline.scheduledPage(
            groups: groups, segments: segments, now: at(15), override: WidgetStore.slotOverride()
        )
        XCTAssertEqual(quiet.slotIndex, 0)
        XCTAssertNil(quiet.segmentIndex)
        XCTAssertEqual(RemindersTimeline.displayedPageKey(groups: groups, segments: segments, now: at(16)), 1)
        // Evening opens with something waiting: the flip lapses to it.
        XCTAssertEqual(RemindersTimeline.displayedPageKey(groups: groups, segments: segments, now: at(18)), 3)
        XCTAssertNil(WidgetStore.slotOverride())
        // Evening finished: the default stays on it, the latest opened.
        let done = groups.map { $0.slot?.id == 3 ? period(3, "18:00", handled: 1) : $0 }
        XCTAssertEqual(RemindersTimeline.displayedPageKey(groups: done, segments: segments, now: at(18, 30)), 3)
    }

    // MARK: The widget's manual override and auto-advance

    func testAManualFlipSticksWhileTheDefaultHolds() throws {
        let groups = periods(morning: 1)
        let segments = TaskSegmentDTO.listed(strip(["deadlines": [row(1)], "days": [row(2)]]))
        let natural = try XCTUnwrap(RemindersTimeline.naturalPageKey(groups: groups, segments: segments, now: at(9)))
        XCTAssertEqual(natural, deadlinesKey)
        // The user flips to Daily (what `ShiftReminderSlotIntent` writes).
        WidgetStore.setSlotOverride(slotKey: dailyKey, naturalSlotKey: natural)
        XCTAssertEqual(RemindersTimeline.displayedPageKey(groups: groups, segments: segments, now: at(9)), dailyKey)
        XCTAssertEqual(RemindersTimeline.displayedPageKey(groups: groups, segments: segments, now: at(11)), dailyKey)
        // Midday opens with nothing waiting and Deadlines is still unseen:
        // the default hasn't moved, so the boundary entry keeps the flip.
        let boundary = RemindersTimeline.scheduledPage(
            groups: groups, segments: segments, now: at(12), override: WidgetStore.slotOverride()
        )
        XCTAssertEqual(boundary.segmentIndex, 3)
        XCTAssertNotNil(WidgetStore.slotOverride(), "a pre-computed entry never clears it")

        // The last unseen deadline row seen (elsewhere): the default moves
        // to Morning, and the flip lapses to it.
        let seen = TaskSegmentDTO.listed(strip(["deadlines": [row(1, .considered)], "days": [row(2)]]))
        XCTAssertEqual(RemindersTimeline.displayedPageKey(groups: groups, segments: seen, now: at(12)), 1)
        XCTAssertNil(WidgetStore.slotOverride())
    }

    func testAFlipLapsesWhenAPeriodOpensWithSomethingWaiting() throws {
        let groups = periods(evening: 1)
        let segments = TaskSegmentDTO.listed(strip(["days": [row(2)], "weeks": [row(3)]]))
        let natural = try XCTUnwrap(RemindersTimeline.naturalPageKey(groups: groups, segments: segments, now: at(17)))
        XCTAssertEqual(natural, dailyKey)
        WidgetStore.setSlotOverride(slotKey: weeklyKey, naturalSlotKey: natural)
        let boundary = RemindersTimeline.scheduledPage(
            groups: groups, segments: segments, now: at(18), override: WidgetStore.slotOverride()
        )
        XCTAssertNil(boundary.segmentIndex, "Evening opened: back to it")
        XCTAssertEqual(boundary.slotIndex, 2)
        XCTAssertEqual(RemindersTimeline.displayedPageKey(groups: groups, segments: segments, now: at(18)), 3)
    }

    /// Finishing a slot the user flipped to drops the flip, so the widget
    /// lands on the default page — here Deadlines, which has an unseen row.
    func testAutoAdvanceAfterFinishingAFlippedSlotLandsOnTheDefault() throws {
        let groups = periods(morning: 1, evening: 1)
        let segments = strip(["deadlines": [row(9)], "days": [row(2)]])
        let listed = TaskSegmentDTO.listed(segments)
        let natural = try XCTUnwrap(RemindersTimeline.naturalPageKey(groups: groups, segments: listed, now: at(13)))
        XCTAssertEqual(natural, deadlinesKey)
        WidgetStore.setSlotOverride(slotKey: 3, naturalSlotKey: natural) // ahead to Evening
        XCTAssertEqual(RemindersTimeline.displayedPageKey(groups: groups, segments: listed, now: at(13)), 3)

        WidgetStore.snapshotSlotOverrideBeforeAutoAdvance(at: at(13))
        WidgetStore.stagePendingCompletion(300, now: at(13)) // Evening's one reminder
        RemindersTimeline.autoAdvanceSlot(in: groups, segments: segments, now: at(13))
        XCTAssertNil(WidgetStore.slotOverride())
        let filtered = WidgetStore.filterPending(groups, now: at(13))
        XCTAssertEqual(RemindersTimeline.displayedPageKey(groups: filtered, segments: listed, now: at(13)), deadlinesKey)

        // A failed completion (or Undo) puts the flip back.
        WidgetStore.restoreSlotOverrideBeforeAutoAdvance(ifMatches: at(13))
        XCTAssertEqual(WidgetStore.slotOverride()?.slotKey, 3)
    }

    func testAutoAdvanceWithoutAFlipChangesNothing() {
        let groups = periods(morning: 1)
        let segments = strip(["days": [row(2)]])
        WidgetStore.stagePendingCompletion(100, now: at(9))
        RemindersTimeline.autoAdvanceSlot(in: groups, segments: segments, now: at(9))
        XCTAssertNil(WidgetStore.slotOverride())
        // The default itself moved on with the tap: Morning finished → Daily.
        let filtered = WidgetStore.filterPending(groups, now: at(9))
        XCTAssertEqual(
            RemindersTimeline.displayedPageKey(groups: filtered, segments: TaskSegmentDTO.listed(segments), now: at(9)),
            dailyKey
        )
    }

    func testAutoAdvanceKeepsAFlipWhileItsSlotStillWaits() throws {
        let groups = periods(morning: 1, evening: 2)
        let listed = TaskSegmentDTO.listed(strip())
        let natural = try XCTUnwrap(RemindersTimeline.naturalPageKey(groups: groups, segments: listed, now: at(9)))
        WidgetStore.setSlotOverride(slotKey: 3, naturalSlotKey: natural)
        WidgetStore.stagePendingCompletion(300, now: at(9)) // one of Evening's two
        RemindersTimeline.autoAdvanceSlot(in: groups, segments: strip(), now: at(9))
        XCTAssertEqual(WidgetStore.slotOverride()?.slotKey, 3)
    }

    // MARK: The watch

    /// The watch pages through periods only; the shared rule picks its
    /// period, and a segment answer keeps the clock's period on screen (the
    /// segments are listed under it).
    func testTheWatchShowsTheRulesPeriodElseTheClocks() {
        let groups = periods(morning: 1, midday: 1)
        // Rule 2: Morning, not the clock's Midday.
        let key2 = key(groups, strip(), at(13))
        XCTAssertEqual(groups.firstIndex { $0.slotKey == key2 }, 0)
        // Rule 1: Deadlines — not a watch page, so the clock's period.
        let key1 = key(groups, strip(["deadlines": [row(1)]]), at(13))
        XCTAssertNil(groups.firstIndex { $0.slotKey == key1 })
        XCTAssertEqual(WatchSlotLogic.naturalSlotIndex(in: groups, now: at(13), day: day), 1)
        // Rule 5: everything done — the latest opened period with anything
        // in it (the watch maps the key the same way), skipping an empty Evening.
        let finished = [period(1, "07:00", handled: 2), period(2, "12:00", handled: 1), period(3, "18:00")]
        let key5 = key(finished, strip(), at(20))
        XCTAssertEqual(finished.firstIndex { $0.slotKey == key5 }, 1)
    }
}

/// A considered row's words on the widget (2026-10-27): the web's
/// `ConsideredSegmentRow` exactly — the title, then only "· on deck Sat" /
/// "· on deck today" (lower-case) or how it left, never the waiting row's
/// small words.
final class ConsideredSegmentRowWordsTests: XCTestCase {

    private let nbsp = "\u{00A0}"
    private let day = OpenTaskDay(dayStart: "03:00", timeZone: .current)
    private var now: Date {
        Calendar.current.date(from: DateComponents(year: 2026, month: 10, day: 27, hour: 13))! // a Tuesday
    }

    private func considered(onDeck: String?, left: SegmentLeft? = nil) -> SegmentTaskDTO {
        SegmentTaskDTO(
            task: TaskDTO(id: 1, title: "Fix the gate", deadlineAt: "2027-01-20T23:00:00Z", horizon: "days", onDeckDay: onDeck),
            state: .considered, left: left
        )
    }

    func testAConsideredRowOnDeckReadsTheWebsWords() {
        XCTAssertEqual(
            considered(onDeck: "2026-10-31").consideredLabelText(now: now, day: day),
            "Fix the gate\(nbsp)· on\(nbsp)deck\(nbsp)Sat"
        )
        XCTAssertEqual(
            considered(onDeck: "2026-10-27").consideredLabelText(now: now, day: day),
            "Fix the gate\(nbsp)· on\(nbsp)deck\(nbsp)today"
        )
        // The waiting row's chip keeps the web's capital ("On deck Sat").
        XCTAssertEqual(considered(onDeck: "2026-10-31").task.deckWords(now: now, day: day), "On deck Sat")
    }

    func testAConsideredRowWithoutADeckIsItsTitleAlone() {
        XCTAssertEqual(considered(onDeck: nil).consideredLabelText(now: now, day: day), "Fix the gate")
    }

    func testARowThatLeftKeepsItsWords() {
        let row = considered(onDeck: "2026-10-31", left: .deck)
        XCTAssertEqual(row.consideredLabelText(now: now, day: day), row.leftLabelText)
        XCTAssertEqual(row.leftLabelText, "Fix the gate\(nbsp)· on\(nbsp)deck")
    }
}
