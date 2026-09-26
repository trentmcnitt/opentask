import XCTest

/// `TaskSnoozePlan` — per-task "+1h" / "Next period" targets and how they
/// group into `POST /api/tasks/bulk/snooze` requests. Times are LOCAL
/// (`Calendar.current`, as the plan itself computes them), on a fixed day,
/// against the scenario's real slots (time-slots.json: 07:00, 09:00, 12:00,
/// 16:00, 20:30).
final class TaskSnoozePlanTests: XCTestCase {

    private var slots: [TimeSlotDTO] = []

    override func setUpWithError() throws {
        slots = try Fixtures.decode(TimeSlotsPage.self, "time-slots").timeSlots
    }

    /// Local wall-clock time on 2026-01-15 (+ `day` days).
    private func at(_ hour: Int, _ minute: Int = 0, day: Int = 0) -> Date {
        var c = DateComponents()
        c.year = 2026
        c.month = 1
        c.day = 15 + day
        c.hour = hour
        c.minute = minute
        return Calendar.current.date(from: c)!
    }

    private var now: Date { at(10, 20) }

    // MARK: +1h

    func testUpcomingPlusOneHourIsADeltaFromItsOwnTime() {
        let due = at(17)
        XCTAssertEqual(TaskSnoozePlan.target(.plusOneHour, dueAt: due, now: now, slots: slots), at(18))
        XCTAssertEqual(
            TaskSnoozePlan.requests(.plusOneHour, tasks: [(id: 1, dueAt: due)], now: now, slots: slots),
            [.init(kind: .deltaMinutes(60), ids: [1])]
        )
    }

    func testOverdueAndUndatedPlusOneHourIsFromNowSnapped() {
        // 10:20 + 1h = 11:20 → snapped down to 11:00 (under :35).
        let snapped = at(11)
        XCTAssertEqual(DateHelpers.snapToNextHour(now: now), snapped)
        XCTAssertEqual(TaskSnoozePlan.target(.plusOneHour, dueAt: at(8), now: now, slots: slots), snapped)
        XCTAssertEqual(TaskSnoozePlan.target(.plusOneHour, dueAt: nil, now: now, slots: slots), snapped)
        XCTAssertEqual(
            TaskSnoozePlan.requests(.plusOneHour, tasks: [(id: 1, dueAt: at(8)), (id: 2, dueAt: nil)], now: now, slots: slots),
            [.init(kind: .until(snapped), ids: [1, 2])]
        )
        // At or past :35 it rounds up: 10:40 + 1h = 11:40 → 12:00.
        XCTAssertEqual(DateHelpers.snapToNextHour(now: at(10, 40)), at(12))
    }

    /// A mixed selection is at most two requests: from-now first, then the
    /// delta; ids keep their input order inside each.
    func testMixedPlusOneHourGroupsIntoTwoRequests() {
        let tasks: [(id: Int, dueAt: Date?)] = [
            (id: 5, dueAt: at(15)), (id: 3, dueAt: nil), (id: 9, dueAt: at(9)), (id: 4, dueAt: at(19)),
        ]
        XCTAssertEqual(
            TaskSnoozePlan.requests(.plusOneHour, tasks: tasks, now: now, slots: slots),
            [.init(kind: .until(at(11)), ids: [3, 9]), .init(kind: .deltaMinutes(60), ids: [5, 4])]
        )
    }

    // MARK: Next period

    func testNextPeriodCountsFromTheTasksOwnTimeWhileUpcoming() {
        // Upcoming at 13:00 → the first slot after 13:00 is 16:00.
        XCTAssertEqual(TaskSnoozePlan.target(.nextPeriod, dueAt: at(13), now: now, slots: slots), at(16))
        // Overdue (08:00) and undated count from now (10:20) → 12:00.
        XCTAssertEqual(TaskSnoozePlan.target(.nextPeriod, dueAt: at(8), now: now, slots: slots), at(12))
        XCTAssertEqual(TaskSnoozePlan.target(.nextPeriod, dueAt: nil, now: now, slots: slots), at(12))
        // STRICTLY after: a task due exactly at a slot's start goes to the next.
        XCTAssertEqual(TaskSnoozePlan.target(.nextPeriod, dueAt: at(12), now: now, slots: slots), at(16))
    }

    func testNextPeriodAfterTheLastSlotIsTomorrowsFirst() {
        XCTAssertEqual(TaskSnoozePlan.target(.nextPeriod, dueAt: at(20, 45), now: now, slots: slots), at(7, day: 1))
        XCTAssertEqual(
            TimeSlotStore.nextPeriodStart(slots: slots, after: at(23, 59)), at(7, day: 1)
        )
    }

    /// One request per distinct target, in first-seen order.
    func testNextPeriodGroupsByTarget() {
        let tasks: [(id: Int, dueAt: Date?)] = [
            (id: 1, dueAt: nil),          // → 12:00
            (id: 2, dueAt: at(13)),       // → 16:00
            (id: 3, dueAt: at(9)),        // overdue → 12:00
            (id: 4, dueAt: at(21)),       // → tomorrow 07:00
            (id: 5, dueAt: at(14)),       // → 16:00
        ]
        XCTAssertEqual(
            TaskSnoozePlan.requests(.nextPeriod, tasks: tasks, now: now, slots: slots),
            [
                .init(kind: .until(at(12)), ids: [1, 3]),
                .init(kind: .until(at(16)), ids: [2, 5]),
                .init(kind: .until(at(7, day: 1)), ids: [4]),
            ]
        )
    }

    func testNoSlotsMeansNoNextPeriod() {
        XCTAssertNil(TaskSnoozePlan.target(.nextPeriod, dueAt: nil, now: now, slots: []))
        XCTAssertEqual(TaskSnoozePlan.requests(.nextPeriod, tasks: [(id: 1, dueAt: nil)], now: now, slots: []), [])
        // Malformed start times are skipped, not crashed on.
        let broken = [TimeSlotDTO(id: 1, label: "Bad", startTime: "noon")]
        XCTAssertNil(TaskSnoozePlan.target(.nextPeriod, dueAt: nil, now: now, slots: broken))
        // +1h never depends on slots.
        XCTAssertEqual(
            TaskSnoozePlan.requests(.plusOneHour, tasks: [(id: 1, dueAt: nil)], now: now, slots: []).count, 1
        )
    }

    func testNothingSelectedIsNoRequests() {
        XCTAssertEqual(TaskSnoozePlan.requests(.plusOneHour, tasks: [], now: now, slots: slots), [])
        XCTAssertEqual(TaskSnoozePlan.requests(.nextPeriod, tasks: [], now: now, slots: slots), [])
    }
}
