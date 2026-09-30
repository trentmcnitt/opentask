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
        XCTAssertTrue(ReminderDayProgress.isDayComplete(groups))
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
        XCTAssertFalse(ReminderDayProgress.isDayComplete(groups))
        XCTAssertEqual(
            ReminderDayProgress.emptyBody(groups: groups, displayedIndex: 1), .periodDone
        )
    }

    func testAWaitingPromptKeepsTheDayOpen() {
        let groups = [
            period(1, start: "07:00", done: 3),
            period(2, start: "12:00", done: 1, prompts: [prompt(9, handled: false)]),
        ]
        XCTAssertFalse(ReminderDayProgress.isDayComplete(groups))
    }

    func testAnEmptyDayIsNeverComplete() {
        XCTAssertFalse(ReminderDayProgress.isDayComplete([]))
        // Periods exist but nothing was ever in them.
        let groups = [period(1, start: "07:00"), period(2, start: "12:00")]
        XCTAssertFalse(ReminderDayProgress.isDayComplete(groups))
        XCTAssertEqual(
            ReminderDayProgress.emptyBody(groups: groups, displayedIndex: 0), .nothingHere,
            "no Congratulations for work that was never there"
        )
        XCTAssertEqual(ReminderDayProgress.emptyBody(groups: [], displayedIndex: 0), .noReminders)
    }

    func testAnUnslottedGroupCountsAsAPeriod() {
        let groups = [period(1, start: "07:00", done: 2), period(-1, start: nil, waiting: 1)]
        XCTAssertFalse(ReminderDayProgress.isDayComplete(groups))
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
                ReminderDayProgress.emptyBody(groups: groups, displayedIndex: index), .dayComplete,
                "period \(index)"
            )
        }
    }

    func testAPeriodThatNeverHadAnythingAlsoCongratulatesOnACompleteDay() {
        let groups = [period(1, start: "07:00", done: 2), period(2, start: "12:00")]
        XCTAssertTrue(ReminderDayProgress.isDayComplete(groups))
        XCTAssertEqual(ReminderDayProgress.emptyBody(groups: groups, displayedIndex: 1), .dayComplete)
    }

    func testAFinishedPeriodEarlierInAnOpenDayReadsComplete() {
        // Morning finished, Evening still waiting: Morning is "Complete"
        // (`.periodDone` carries no count — the body has no count line; the
        // bottom-left "N of M" does), Evening's own list isn't empty.
        let groups = [period(1, start: "07:00", done: 4), period(2, start: "21:00", waiting: 2)]
        XCTAssertEqual(ReminderDayProgress.emptyBody(groups: groups, displayedIndex: 0), .periodDone)
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
        XCTAssertEqual(ReminderDayProgress.emptyBody(groups: groups, displayedIndex: 0), .periodDone)
    }
}
