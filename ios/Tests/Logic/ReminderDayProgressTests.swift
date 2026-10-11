import XCTest

/// The Reminders widget's "day complete" rules (`ReminderDayProgress`,
/// 2026-09-29): the day-complete predicate, the per-period "N of M", the
/// which empty state a period shows (Congratulations on every period of a
/// complete day; "Complete" with no count line for a finished period).
final class ReminderDayProgressTests: XCTestCase {

    // MARK: Fixtures (synthetic)

    private func reminder(_ id: Int) -> TaskDTO {
        TaskDTO(id: id, title: "Reminder \(id)", priority: 0, isReminder: true)
    }

    private func prompt(_ taskId: Int, handled: Bool) -> QuotaPromptDTO {
        let waiting = QuotaPromptDTO(
            promptKey: "q:\(taskId):0:2026-01-15", taskId: taskId, number: nil, numbers: nil, slotId: nil,
            title: "Quota \(taskId)", current: 0, target: 3, period: "WEEKLY", stripeColor: nil,
            considered: false, done: false, hasNotes: false
        )
        return handled ? waiting.handled(did: false) : waiting
    }

    /// A period with `waiting` open reminders, `done` considered ones, and
    /// the given prompts.
    private func period(
        _ id: Int, start: String?, waiting: Int = 0, done: Int = 0, prompts: [QuotaPromptDTO] = []
    ) -> ReminderGroupDTO {
        let open = (0..<waiting).map { reminder(id * 100 + $0) }
        let considered = (0..<done).map { reminder(id * 100 + 50 + $0) }
        return ReminderGroupDTO(
            slot: start.map { TimeSlotDTO(id: id, label: "Period \(id)", startTime: $0) },
            reminders: open, considered: considered.count, consideredItems: considered, prompts: prompts
        )
    }

    // MARK: Day complete

    func testDayCompleteWhenEveryPeriodIsClearAndSomethingWasHandled() {
        let groups = [
            period(1, start: "07:00", done: 3),
            period(2, start: "12:00", done: 2, prompts: [prompt(9, handled: true)]),
            period(3, start: "21:00", done: 1),
        ]
        XCTAssertTrue(ReminderDayProgress.isDayComplete(groups, segments: []))
        XCTAssertEqual(ReminderDayProgress.handledTotal(groups), 7)
    }

    func testAFinishedCurrentPeriodWithALaterPeriodStillWaitingIsNotDayComplete() {
        // The clock is in period 2 (finished); period 3 hasn't started but has
        // two reminders waiting. "All caught up" used to fire here.
        let groups = [
            period(1, start: "07:00", done: 3),
            period(2, start: "12:00", done: 2),
            period(3, start: "21:00", waiting: 2),
        ]
        XCTAssertFalse(ReminderDayProgress.isDayComplete(groups, segments: []))
        XCTAssertEqual(
            ReminderDayProgress.emptyBody(groups: groups, segments: [], displayedIndex: 1), .periodDone
        )
    }

    func testAWaitingPromptKeepsTheDayOpen() {
        let groups = [
            period(1, start: "07:00", done: 3),
            period(2, start: "12:00", done: 1, prompts: [prompt(9, handled: false)]),
        ]
        XCTAssertFalse(ReminderDayProgress.isDayComplete(groups, segments: []))
    }

    func testAnEmptyDayIsNeverComplete() {
        XCTAssertFalse(ReminderDayProgress.isDayComplete([], segments: []))
        // Periods exist but nothing was ever in them.
        let groups = [period(1, start: "07:00"), period(2, start: "12:00")]
        XCTAssertFalse(ReminderDayProgress.isDayComplete(groups, segments: []))
        XCTAssertEqual(
            ReminderDayProgress.emptyBody(groups: groups, segments: [], displayedIndex: 0), .nothingHere,
            "no Congratulations for work that was never there"
        )
        XCTAssertEqual(ReminderDayProgress.emptyBody(groups: [], segments: [], displayedIndex: 0), .noReminders)
    }

    func testAnUnslottedGroupCountsAsAPeriod() {
        let groups = [period(1, start: "07:00", done: 2), period(-1, start: nil, waiting: 1)]
        XCTAssertFalse(ReminderDayProgress.isDayComplete(groups, segments: []))
    }

    // MARK: Empty body

    func testCongratulationsOnEveryPeriodOfACompleteDay() {
        let groups = [
            period(1, start: "07:00", done: 7),
            period(2, start: "12:00", done: 3),
            period(3, start: "21:00", done: 7),
        ]
        // Every period reads "Congratulations / Day complete" — the clock's
        // period and any other one paged to (2026-09-29 follow-up; it was the
        // clock's period alone in #191).
        for index in groups.indices {
            XCTAssertEqual(
                ReminderDayProgress.emptyBody(groups: groups, segments: [], displayedIndex: index), .dayComplete,
                "period \(index)"
            )
        }
    }

    func testAPeriodThatNeverHadAnythingAlsoCongratulatesOnACompleteDay() {
        let groups = [period(1, start: "07:00", done: 2), period(2, start: "12:00")]
        XCTAssertTrue(ReminderDayProgress.isDayComplete(groups, segments: []))
        XCTAssertEqual(ReminderDayProgress.emptyBody(groups: groups, segments: [], displayedIndex: 1), .dayComplete)
    }

    func testAFinishedPeriodEarlierInAnOpenDayReadsComplete() {
        // Morning finished, Evening still waiting: Morning is "Complete"
        // (`.periodDone` carries no count — the body has no count line; the
        // bottom-left "N of M" does), Evening's own list isn't empty.
        let groups = [period(1, start: "07:00", done: 4), period(2, start: "21:00", waiting: 2)]
        XCTAssertEqual(ReminderDayProgress.emptyBody(groups: groups, segments: [], displayedIndex: 0), .periodDone)
    }

    // MARK: Counts

    func testPeriodCountIncludesPrompts() {
        let group = period(
            1, start: "07:00", waiting: 3, done: 2,
            prompts: [prompt(8, handled: true), prompt(9, handled: false)]
        )
        let count = ReminderDayProgress.PeriodCount(group)
        XCTAssertEqual(count, .init(handled: 3, total: 7))
        XCTAssertEqual(count.text, "3 of 7")
    }

    func testPeriodCountOfAFinishedPeriod() {
        let count = ReminderDayProgress.PeriodCount(period(1, start: "07:00", done: 7))
        XCTAssertEqual(count.text, "7 of 7")
    }

    func testAPeriodWhosePromptsAreTheOnlyHandledItemsIsComplete() {
        let groups = [
            period(1, start: "07:00", prompts: [prompt(8, handled: true)]),
            period(2, start: "12:00", waiting: 1),
        ]
        XCTAssertEqual(ReminderDayProgress.emptyBody(groups: groups, segments: [], displayedIndex: 0), .periodDone)
    }

    // MARK: Task segments (2026-10-11, "segments as slots")

    private func row(_ id: Int, _ state: SegmentTaskDTO.State) -> SegmentTaskDTO {
        SegmentTaskDTO(task: TaskDTO(id: id, title: "Task \(id)"), state: state)
    }

    private var noon: Date { Calendar.current.date(bySettingHour: 12, minute: 30, second: 0, of: Date())! }

    func testAWaitingTaskSegmentKeepsTheDayOpen() {
        let groups = [period(1, start: "07:00", done: 3), period(2, start: "12:00", done: 2)]
        let waiting = [TaskSegmentDTO(horizon: "days", tasks: [row(1, .considered), row(2, .waiting)])]
        XCTAssertFalse(ReminderDayProgress.isDayComplete(groups, segments: waiting))
        XCTAssertEqual(
            ReminderDayProgress.emptyBody(groups: groups, segments: waiting, displayedIndex: 1), .periodDone,
            "a finished period reads Complete, not Congratulations, while a segment waits"
        )
        let finished = [TaskSegmentDTO(horizon: "days", tasks: [row(1, .considered), row(2, .deferred)])]
        XCTAssertTrue(ReminderDayProgress.isDayComplete(groups, segments: finished))
        XCTAssertEqual(ReminderDayProgress.emptyBody(groups: groups, segments: finished, displayedIndex: 1), .dayComplete)
    }

    func testSegmentRowsHandledCountAsHandledForDayComplete() {
        // Periods that never had anything, and a segment considered: there
        // WAS work today, and it is all done.
        let groups = [period(1, start: "07:00"), period(2, start: "12:00")]
        let finished = [TaskSegmentDTO(horizon: "weeks", tasks: [row(1, .considered)])]
        XCTAssertTrue(ReminderDayProgress.isDayComplete(groups, segments: finished))
        XCTAssertEqual(ReminderDayProgress.handledTotal(groups), 0, "a period's own number never counts segment rows")
    }

    func testSegmentCountIsConsideredPlusDeferredOfTodaysRows() {
        let segment = TaskSegmentDTO(
            horizon: "days", tasks: [row(1, .considered), row(2, .deferred), row(3, .waiting), row(4, .waiting)]
        )
        let count = ReminderDayProgress.PeriodCount(segment)
        XCTAssertEqual(count, .init(handled: 2, total: 4))
        XCTAssertEqual(count.text, "2 of 4")
    }

    func testEmptyBodyOnASegmentPage() {
        let groups = [period(1, start: "07:00", done: 1), period(2, start: "21:00", waiting: 2)]
        let days = TaskSegmentDTO(horizon: "days", tasks: [row(1, .considered)])
        XCTAssertEqual(ReminderDayProgress.emptyBody(segment: days, groups: groups, segments: [days]), .periodDone)
        let doneGroups = [period(1, start: "07:00", done: 1)]
        XCTAssertEqual(ReminderDayProgress.emptyBody(segment: days, groups: doneGroups, segments: [days]), .dayComplete)
    }

    // MARK: Strip

    func testStripIsPeriodsThenTaskSegments() {
        let groups = [
            period(1, start: "07:00", waiting: 1, done: 3),  // started, waiting
            period(2, start: "09:00"),                       // never had anything: no bar
            period(3, start: "12:00", done: 2),              // done
            period(4, start: "21:00", waiting: 5),           // not started yet
        ]
        let segments = [
            TaskSegmentDTO(horizon: "days", tasks: [row(1, .considered), row(2, .deferred), row(3, .waiting)]),
            TaskSegmentDTO(horizon: "weeks", tasks: [row(4, .considered)]),
            TaskSegmentDTO(horizon: "months", tasks: [row(5, .deferred)]),  // not listed: no page, no bar
        ]
        let bars = ReminderDayProgress.stripBars(groups: groups, segments: segments, now: noon)
        XCTAssertEqual(bars.map(\.key), [1, 3, 4, -10, -11])
        XCTAssertEqual(bars.map(\.kind), [.period, .period, .period, .taskSegment, .taskSegment])
        XCTAssertEqual(bars.map(\.state), [.behind, .done, .upcoming, .behind, .done])
        XCTAssertEqual(bars.map(\.total), [4, 2, 5, 3, 1], "a segment weighs its rows today, deferred included")
        XCTAssertEqual(bars.map(\.handled), [3, 2, 0, 2, 1])
        XCTAssertEqual(bars[3].fraction, 2.0 / 3.0, accuracy: 1e-9)
        XCTAssertEqual(bars[3].label, "Tasks · Days")
    }

    func testATaskSegmentBarIsNeverUpcoming() {
        // 5 am: no period has started, but a segment shown today has.
        let early = Calendar.current.date(bySettingHour: 5, minute: 0, second: 0, of: Date())!
        let bars = ReminderDayProgress.stripBars(
            groups: [period(1, start: "07:00", waiting: 2)],
            segments: [TaskSegmentDTO(horizon: "days", tasks: [row(1, .waiting)])],
            now: early
        )
        XCTAssertEqual(bars.map(\.state), [.upcoming, .behind])
    }

    func testAnytimeCountsAsStarted() {
        let early = Calendar.current.date(bySettingHour: 5, minute: 0, second: 0, of: Date())!
        XCTAssertTrue(ReminderDayProgress.hasStarted(period(-1, start: nil, waiting: 1), now: early))
        XCTAssertFalse(ReminderDayProgress.hasStarted(period(1, start: "07:00", waiting: 1), now: early))
    }
}
