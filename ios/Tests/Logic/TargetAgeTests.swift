import XCTest

/// `TargetAge` — the Swift port of `src/lib/task-segments.ts`'s target rules
/// (2026-10-10): the deadline's implied target, the target-age badge's days
/// and tone, the past-deadline marker and the future-target chip. Mirrors the
/// server's TM-0xx cases (`tests/behavioral/tm-task-model.test.ts`).
final class TargetAgeTests: XCTestCase {

    /// Chicago, the fixtures' and the TS tests' zone.
    private var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/Chicago")!
        return c
    }

    /// Saturday 2026-10-10 14:00 Chicago (the TS tests' `SAT`).
    private let now = DateHelpers.parseISO("2026-10-10T19:00:00.000Z")!

    private func task(
        due: String? = nil, original: String? = nil, deadline: String? = nil,
        nagOff: Bool = false, rrule: String? = nil
    ) -> TaskDTO {
        TaskDTO(
            id: 1, title: "t", dueAt: due, rrule: rrule, deadlineAt: deadline, originalDueAt: original,
            deadlineNagOff: nagOff
        )
    }

    // MARK: Implied target

    func testDeadlineWithoutTargetImpliesOneFourDaysEarly() {
        let t = task(deadline: "2026-10-13T23:00:00.000Z")
        XCTAssertEqual(TargetAge.impliedTargetDate(t), DateHelpers.parseISO("2026-10-09T23:00:00.000Z"))
        XCTAssertEqual(t.effectiveTargetDate, TargetAge.impliedTargetDate(t))
        XCTAssertTrue(t.isOverdue(now: now), "over target although due_at is null")
    }

    func testImpliedTargetIsOffWithAnOwnTargetRemoveTargetOrRecurrence() {
        XCTAssertNil(TargetAge.impliedTargetDate(task(due: "2026-10-20T15:00:00.000Z", deadline: "2026-10-13T23:00:00.000Z")))
        XCTAssertNil(TargetAge.impliedTargetDate(task(deadline: "2026-10-13T23:00:00.000Z", nagOff: true)))
        XCTAssertNil(TargetAge.impliedTargetDate(task(deadline: "2026-10-13T23:00:00.000Z", rrule: "FREQ=WEEKLY")))
        XCTAssertFalse(task(deadline: "2026-10-13T23:00:00.000Z", nagOff: true).isOverdue(now: now))
    }

    func testTaskListsSeeTheImpliedTarget() {
        let implied = task(deadline: "2026-10-13T23:00:00.000Z")
        XCTAssertEqual(TaskLists.overdue([implied], now: now).map(\.id), [1])
        XCTAssertEqual(TaskLists.overdue([task(deadline: "2026-10-13T23:00:00.000Z", nagOff: true)], now: now), [])
    }

    // MARK: Target age

    func testAgeCountsFromTheFirstTargetNotTheSnoozedOne() {
        // First target Wed 10-07, snoozed to this morning: 3 days.
        let snoozed = task(due: "2026-10-10T14:00:00.000Z", original: "2026-10-07T14:00:00.000Z")
        XCTAssertEqual(TargetAge.days(snoozed, now: now, calendar: calendar), 3)
    }

    func testAgeIsBlankOnTheTargetDayAndBeforeTheTarget() {
        let today = task(due: "2026-10-10T14:00:00.000Z", original: "2026-10-10T14:00:00.000Z")
        XCTAssertNil(TargetAge.days(today, now: now, calendar: calendar), "no badge on the target day")
        let later = task(due: "2026-10-10T23:00:00.000Z", original: "2026-10-01T14:00:00.000Z")
        XCTAssertNil(TargetAge.days(later, now: now, calendar: calendar), "target not arrived yet")
        XCTAssertNil(TargetAge.days(task(), now: now, calendar: calendar), "no target")
    }

    func testAgeUsesLocalDaysNotTwentyFourHourSpans() {
        // 23:30 Chicago yesterday → 14:00 today is under 24h but one local day.
        let t = task(due: "2026-10-10T04:30:00.000Z", original: "2026-10-10T04:30:00.000Z")
        XCTAssertEqual(TargetAge.days(t, now: now, calendar: calendar), 1)
    }

    func testImpliedTargetAgesFromItself() {
        // Deadline Tue 10-13 18:00 Chicago → implied target Fri 10-09: 1 day.
        let t = task(deadline: "2026-10-13T23:00:00.000Z")
        XCTAssertEqual(TargetAge.days(t, now: now, calendar: calendar), 1)
    }

    func testToneSteps() {
        XCTAssertEqual(TargetAge.tone(days: 1), .gray)
        XCTAssertEqual(TargetAge.tone(days: 2), .gray)
        XCTAssertEqual(TargetAge.tone(days: 3), .amber)
        XCTAssertEqual(TargetAge.tone(days: 6), .amber)
        XCTAssertEqual(TargetAge.tone(days: 7), .red)
        XCTAssertEqual(TargetAge.tone(days: 40), .red)
        XCTAssertEqual(TargetAge.badgeText(days: 2), "2d")
    }

    // MARK: Deadline and chip

    func testPastDeadline() {
        XCTAssertTrue(TargetAge.isPastDeadline(task(deadline: "2026-10-09T23:00:00.000Z"), now: now))
        XCTAssertFalse(TargetAge.isPastDeadline(task(deadline: "2026-10-13T23:00:00.000Z"), now: now))
        XCTAssertFalse(TargetAge.isPastDeadline(task(), now: now))
    }

    func testFutureTargetChip() {
        let t = task(due: "2026-11-01T14:00:00.000Z")
        XCTAssertEqual(TargetAge.futureTargetChip(t, now: now, calendar: calendar), "Nov 1")
        XCTAssertNil(TargetAge.futureTargetChip(task(due: "2026-10-09T14:00:00.000Z"), now: now, calendar: calendar))
        XCTAssertNil(TargetAge.futureTargetChip(task(), now: now, calendar: calendar))
    }

    func testWordingIsOneConstant() {
        XCTAssertEqual(TaskWording.overTarget, "Over target")
        XCTAssertEqual(TaskWording.overTargetLower, "over target")
    }
}
