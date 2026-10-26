import XCTest

/// `TargetAge` — what the native rows still take from `src/lib/task-segments.ts`
/// (2026-10-12): the attempts badge's text and depth, the past-deadline
/// marker and the future-target chip. The target is `due_at` (stored since
/// spec §8); the old implied-target and target-age cases left with the rule.
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
        due: String? = nil, deadline: String? = nil, attempts: Int = 0, label: String? = nil, tracked: Bool = false
    ) -> TaskDTO {
        TaskDTO(
            id: 1, title: "t", dueAt: due, trackedFlag: tracked, deadlineAt: deadline, attempts: attempts,
            attemptsLabel: label
        )
    }

    /// Over target is `due_at < now`: a deadline with no `due_at` (an older
    /// server's data) is not over target — the server stores the target now.
    func testOverTargetReadsTheStoredTarget() {
        XCTAssertTrue(task(due: "2026-10-10T14:00:00.000Z").isOverdue(now: now))
        XCTAssertFalse(task(due: "2026-10-10T23:00:00.000Z").isOverdue(now: now))
        XCTAssertFalse(task(deadline: "2026-10-11T23:00:00.000Z").isOverdue(now: now))
        XCTAssertEqual(TaskLists.overdue([task(deadline: "2026-10-11T23:00:00.000Z")], now: now).count, 0)
    }

    /// The badge is the server's label, shown only with a target and never
    /// on a quota.
    func testAttemptsBadgeIsTheServersLabel() {
        XCTAssertEqual(TargetAge.attemptsBadge(task(due: "2026-10-12T14:00:00.000Z", attempts: 3, label: "3×")), "3×")
        XCTAssertNil(TargetAge.attemptsBadge(task(due: "2026-10-12T14:00:00.000Z")))
        XCTAssertNil(TargetAge.attemptsBadge(task(attempts: 3, label: "3×")), "no target, no badge")
        XCTAssertNil(TargetAge.attemptsBadge(task(due: "2026-10-12T14:00:00.000Z", attempts: 3, label: "3×", tracked: true)))
    }

    /// The web's `attemptsTone`: 1–2 light, 3–6 medium, 7+ strong.
    func testToneSteps() {
        XCTAssertEqual(TargetAge.tone(attempts: 1), .light)
        XCTAssertEqual(TargetAge.tone(attempts: 2), .light)
        XCTAssertEqual(TargetAge.tone(attempts: 3), .medium)
        XCTAssertEqual(TargetAge.tone(attempts: 6), .medium)
        XCTAssertEqual(TargetAge.tone(attempts: 7), .strong)
        XCTAssertEqual(TargetAge.tone(attempts: 40), .strong)
    }

    // MARK: Deadline and chip

    func testPastDeadline() {
        XCTAssertTrue(TargetAge.isPastDeadline(task(deadline: "2026-10-09T23:00:00.000Z"), now: now))
        XCTAssertFalse(TargetAge.isPastDeadline(task(deadline: "2026-10-13T23:00:00.000Z"), now: now))
        XCTAssertFalse(TargetAge.isPastDeadline(task(), now: now))
    }

    func testFutureTargetChip() {
        let t = task(due: "2026-11-01T14:00:00.000Z")
        XCTAssertEqual(TargetAge.futureTargetChip(t, now: now, calendar: calendar, dayStart: OpenTaskDay.calendarDayStart), "Nov 1")
        XCTAssertNil(TargetAge.futureTargetChip(task(due: "2026-10-09T14:00:00.000Z"), now: now, calendar: calendar, dayStart: OpenTaskDay.calendarDayStart))
        XCTAssertNil(TargetAge.futureTargetChip(task(), now: now, calendar: calendar, dayStart: OpenTaskDay.calendarDayStart))
    }

    func testWordingIsOneConstant() {
        XCTAssertEqual(TaskWording.overdue, "Overdue")
        XCTAssertEqual(TaskWording.overdueLower, "overdue")
    }
}
