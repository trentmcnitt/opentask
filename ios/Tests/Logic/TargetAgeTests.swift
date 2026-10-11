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
        nagOff: Bool = false, rrule: String? = nil, created: String? = nil
    ) -> TaskDTO {
        TaskDTO(
            id: 1, title: "t", dueAt: due, rrule: rrule, deadlineAt: deadline, originalDueAt: original,
            deadlineNagOff: nagOff, createdAt: created
        )
    }

    /// The age never counts from before the task existed (2026-10-11): a task
    /// created today with a deadline 3 days out is over target at once (its
    /// implied target is yesterday's morning), but its badge is blank today.
    func testAgeNeverCountsFromBeforeTheTaskWasCreated() {
        let t = task(deadline: "2026-10-13T23:00:00.000Z", created: "2026-10-10T15:00:00.000Z")
        XCTAssertTrue(t.isOverdue(now: now))
        XCTAssertNil(TargetAge.days(t, now: now, calendar: calendar, morningTime: "09:00"))
        let later = DateHelpers.parseISO("2026-10-12T15:00:00.000Z")!
        XCTAssertEqual(TargetAge.days(t, now: later, calendar: calendar, morningTime: "09:00"), 2)
    }

    // Every test pins the morning time (`TargetContextStore.override`) — on
    // macOS the App Group is the installed Mac app's.
    override func setUp() {
        super.setUp()
        TargetContextStore.override = .some("09:00")
    }

    override func tearDown() {
        TargetContextStore.override = nil
        super.tearDown()
    }

    // MARK: Implied target (rulings A2/B2, 2026-10-11)

    /// The user's morning on the local day 4 days before the deadline — not
    /// deadline − 96h: an end-of-day deadline must not first nag at 23:59.
    func testImpliedTargetIsTheMorningFourLocalDaysBeforeTheDeadline() {
        // Deadline Tue 10-13 18:00 Chicago → Fri 10-09 09:00 Chicago (14:00Z).
        let t = task(deadline: "2026-10-13T23:00:00.000Z")
        XCTAssertEqual(
            TargetAge.impliedTargetDate(t, morningTime: "09:00", calendar: calendar),
            DateHelpers.parseISO("2026-10-09T14:00:00.000Z")
        )
        XCTAssertEqual(
            TargetAge.impliedTargetDate(t, morningTime: "07:30", calendar: calendar),
            DateHelpers.parseISO("2026-10-09T12:30:00.000Z")
        )
        XCTAssertTrue(t.isOverdue(now: now), "over target although due_at is null")
    }

    func testWithNoMorningTimeItFallsBackToDeadlineMinusFourDays() {
        let t = task(deadline: "2026-10-13T23:00:00.000Z")
        XCTAssertEqual(
            TargetAge.impliedTargetDate(t, morningTime: nil, calendar: calendar),
            DateHelpers.parseISO("2026-10-09T23:00:00.000Z")
        )
        XCTAssertEqual(
            TargetAge.impliedTargetDate(t, morningTime: "garbage", calendar: calendar),
            DateHelpers.parseISO("2026-10-09T23:00:00.000Z")
        )
    }

    /// A target AFTER the deadline doesn't hide it: the implied one applies
    /// and, being earlier, is the effective target.
    func testATargetAfterTheDeadlineStillGetsTheImpliedOne() {
        let late = task(due: "2026-10-20T15:00:00.000Z", deadline: "2026-10-13T23:00:00.000Z")
        let implied = DateHelpers.parseISO("2026-10-09T14:00:00.000Z")
        XCTAssertEqual(TargetAge.impliedTargetDate(late, morningTime: "09:00", calendar: calendar), implied)
        XCTAssertEqual(TargetAge.effectiveTargetDate(late, morningTime: "09:00", calendar: calendar), implied)
    }

    /// A target on or before the deadline is the target — no implied one.
    func testATargetBeforeTheDeadlineWins() {
        let early = task(due: "2026-10-11T15:00:00.000Z", deadline: "2026-10-13T23:00:00.000Z")
        XCTAssertNil(TargetAge.impliedTargetDate(early, morningTime: "09:00", calendar: calendar))
        XCTAssertEqual(
            TargetAge.effectiveTargetDate(early, morningTime: "09:00", calendar: calendar),
            DateHelpers.parseISO("2026-10-11T15:00:00.000Z")
        )
        let atDeadline = task(due: "2026-10-13T23:00:00.000Z", deadline: "2026-10-13T23:00:00.000Z")
        XCTAssertNil(TargetAge.impliedTargetDate(atDeadline, morningTime: "09:00", calendar: calendar))
    }

    func testImpliedTargetIsOffWithRemoveTargetOrRecurrence() {
        XCTAssertNil(TargetAge.impliedTargetDate(task(deadline: "2026-10-13T23:00:00.000Z", nagOff: true)))
        XCTAssertNil(TargetAge.impliedTargetDate(task(deadline: "2026-10-13T23:00:00.000Z", rrule: "FREQ=WEEKLY")))
        XCTAssertNil(TargetAge.impliedTargetDate(
            task(due: "2026-10-20T15:00:00.000Z", deadline: "2026-10-13T23:00:00.000Z", nagOff: true)
        ))
        XCTAssertFalse(task(deadline: "2026-10-13T23:00:00.000Z", nagOff: true).isOverdue(now: now))
    }

    func testTaskListsSeeTheImpliedTarget() {
        let implied = task(deadline: "2026-10-13T23:00:00.000Z")
        XCTAssertEqual(TaskLists.overdue([implied], now: now).map(\.id), [1])
        let lateTarget = task(due: "2026-10-20T15:00:00.000Z", deadline: "2026-10-13T23:00:00.000Z")
        XCTAssertEqual(TaskLists.overdue([lateTarget], now: now).map(\.id), [1], "the earlier, implied target has passed")
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
        // Deadline Tue 10-13 → implied target Fri 10-09 09:00: 1 day.
        let t = task(deadline: "2026-10-13T23:00:00.000Z")
        XCTAssertEqual(TargetAge.days(t, now: now, calendar: calendar, morningTime: "09:00"), 1)
        // A target after the deadline with an old first target: the implied
        // target is the effective one, so the age counts from IT, not from
        // original_due_at.
        let late = task(
            due: "2026-10-20T15:00:00.000Z", original: "2026-09-01T15:00:00.000Z", deadline: "2026-10-13T23:00:00.000Z"
        )
        XCTAssertEqual(TargetAge.days(late, now: now, calendar: calendar, morningTime: "09:00"), 1)
    }

    func testOwnTargetAgesFromTheFirstTarget() {
        // Own target before the deadline is effective: original_due_at counts.
        let own = task(
            due: "2026-10-10T14:00:00.000Z", original: "2026-10-05T14:00:00.000Z", deadline: "2026-10-30T23:00:00.000Z"
        )
        XCTAssertEqual(TargetAge.days(own, now: now, calendar: calendar, morningTime: "09:00"), 5)
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

    /// `GET /api/user/preferences` carries the morning time the rule reads.
    func testPreferencesCarryTheMorningTime() throws {
        let page = try Fixtures.decode(UserPreferencesLabelConfigPage.self, "user-preferences")
        XCTAssertEqual(page.morningTime, "09:00")
        XCTAssertNotNil(TargetAge.parseHHMM(page.morningTime ?? ""))
    }

    func testWordingIsOneConstant() {
        XCTAssertEqual(TaskWording.overTarget, "Over target")
        XCTAssertEqual(TaskWording.overTargetLower, "over target")
    }
}
