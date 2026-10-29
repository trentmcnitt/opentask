import XCTest

/// The lean row's rules on native (`ios/Shared/LeanRow.swift`), with the
/// web's own cases: tests/behavioral/lean-row-state.test.ts,
/// lean-chip-words.test.ts and horizon-square.test.ts (PR #410). Chicago, a
/// 3:00 AM day start, Wed 2026-10-28.
final class LeanRowTests: XCTestCase {

    private let zone = TimeZone(identifier: "America/Chicago")!
    private var day: OpenTaskDay { OpenTaskDay(dayStart: "03:00", timeZone: zone) }

    /// A Chicago wall-clock moment, "2026-10-28T18:00".
    private func at(_ local: String) -> Date {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = zone
        f.dateFormat = "yyyy-MM-dd'T'HH:mm"
        return f.date(from: local)!
    }

    private func iso(_ local: String?) -> String? {
        local.map { DateHelpers.formatISO(at($0)) }
    }

    private func task(
        due: String? = nil, deadline: String? = nil, rrule: String? = nil, horizon: String? = nil,
        targetAuto: Bool = false, reminder: Bool = false, tracked: Bool = false
    ) -> TaskDTO {
        TaskDTO(
            id: 1, title: "t", dueAt: iso(due), rrule: rrule, trackedFlag: tracked, isReminder: reminder,
            deadlineAt: iso(deadline), horizon: horizon, targetAuto: targetAuto
        )
    }

    // MARK: - The tint (lean-row-state.test.ts, now 15:20)

    private func state(_ due: String?, _ deadline: String?, overdue: Bool = false) -> LeanRow.State? {
        LeanRow.state(task(due: due, deadline: deadline), isOverdue: overdue, now: at("2026-10-28T15:20"), day: day)
    }

    func testAPassedDeadlineIsRedAndWinsOverOverTarget() {
        XCTAssertEqual(state(nil, "2026-10-28T09:00"), .passed)
        // The target still ahead (the rental car): the normal red.
        XCTAssertEqual(state("2026-10-29T08:00", "2026-10-28T09:00"), .passed)
        // Both passed: the stronger red (2026-10-29), never the blue.
        XCTAssertEqual(state("2026-10-28T08:00", "2026-10-28T09:00", overdue: true), .bothPassed)
    }

    /// M1 (2026-10-29): every over-target time is plum, whatever its day
    /// word — a target that passed EARLIER TODAY (a time-only label) too,
    /// not only one from another day; a target later today stays blue.
    func testAPassedTargetsTimeIsPlumWhateverItsDay() {
        let now = at("2026-10-28T10:00")
        let plum = LeanRow.overTargetHex, blue = LeanRow.targetHex
        func timeHex(_ due: String) -> UInt32 {
            let t = task(due: due)
            return LeanRow.targetTimeHex(isOverdue: t.isOverdue(now: now)).light
        }
        XCTAssertEqual(timeHex("2026-10-28T08:00"), plum.light, "earlier today")
        XCTAssertEqual(timeHex("2026-10-28T09:30"), plum.light, "earlier today")
        XCTAssertEqual(timeHex("2026-10-25T08:00"), plum.light, "another day")
        XCTAssertEqual(timeHex("2026-10-28T13:00"), blue.light, "later today")
        XCTAssertEqual(timeHex("2026-10-29T09:00"), blue.light, "tomorrow")
    }

    func testOverTargetIsBlue() {
        XCTAssertEqual(state("2026-10-28T13:00", nil, overdue: true), .over)
        XCTAssertEqual(state("2026-10-28T13:00", "2026-10-28T21:00", overdue: true), .over, "over outranks a deadline later today")
    }

    func testATargetOrDeadlineLaterTodayIsSoon() {
        XCTAssertEqual(state("2026-10-28T18:00", nil), .soon)
        XCTAssertEqual(state(nil, "2026-10-28T21:00"), .soon)
        XCTAssertEqual(state("2026-10-29T01:30", nil), .soon, "1:30 AM is still today's OpenTask day")
    }

    func testTomorrowOrNothingDatedIsPlain() {
        XCTAssertNil(state("2026-10-29T09:00", nil))
        XCTAssertNil(state(nil, "2026-10-29T04:00"))
        XCTAssertNil(state(nil, nil))
    }

    // MARK: - The countdown (lean-chip-words.test.ts)

    private func countdown(_ deadline: String, at now: String) -> String {
        LeanRow.countdownWords(deadline: at(deadline), now: at(now), day: day)
    }

    func testCountdownIsWholeHoursFromTheNextTopOfTheHour() {
        XCTAssertEqual(countdown("2026-10-28T18:00", at: "2026-10-28T08:30"), "in 9 hrs")
        XCTAssertEqual(countdown("2026-10-28T20:00", at: "2026-10-28T19:05"), "in <1 hr")
        XCTAssertEqual(countdown("2026-10-28T20:00", at: "2026-10-28T19:00"), "in <1 hr", "Trent's example: at 7 PM, an 8 PM deadline")
    }

    func testCountdownChangesOnlyOnTheHourAndOneHourIsSingular() {
        XCTAssertEqual(countdown("2026-10-28T20:00", at: "2026-10-28T18:00"), "in 1 hr")
        XCTAssertEqual(countdown("2026-10-28T20:00", at: "2026-10-28T18:59"), "in 1 hr")
        XCTAssertEqual(countdown("2026-10-28T21:30", at: "2026-10-28T08:30"), "in 12 hrs", "9:30 PM from 9:00 is 12.5 hours: 12")
    }

    func testCountdownCountsLocalHoursInAHalfHourZone() {
        let india = OpenTaskDay(dayStart: "03:00", timeZone: TimeZone(identifier: "Asia/Kolkata")!)
        // 10:40 IST → the next top of the hour is 11:00 IST; a 13:00 IST deadline is 2 hrs.
        let now = Date(timeIntervalSince1970: 1_793_164_200) // 2026-10-28T05:10:00Z = 10:40 IST
        XCTAssertEqual(LeanRow.countdownWords(deadline: now.addingTimeInterval(2 * 3600 + 20 * 60), now: now, day: india), "in 2 hrs")
    }

    func testOnlyADeadlineLaterTodayCountsDown() {
        let noon = at("2026-10-28T12:00")
        XCTAssertEqual(LeanRow.countdown(task(deadline: "2026-10-28T21:00"), now: noon, day: day), "in 8 hrs")
        XCTAssertNil(LeanRow.countdown(task(deadline: "2026-10-28T09:00"), now: noon, day: day), "earlier today")
        XCTAssertNil(LeanRow.countdown(task(deadline: "2026-10-29T09:00"), now: noon, day: day), "another day")
        XCTAssertNil(LeanRow.countdown(task(due: "2026-10-28T18:00"), now: noon, day: day), "targets never count down")
    }

    // MARK: - "Today" once per row

    func testTodayIsSaidOncePerRow() {
        XCTAssertEqual(LeanRow.todayOnce(deadline: "Today 9:00 PM", target: "Today 5:00 PM"), "5:00 PM")
        XCTAssertEqual(LeanRow.todayOnce(deadline: "Today 9:00 PM", target: "Today 9:00 AM"), "9:00 AM", "a passed target today too")
        XCTAssertEqual(LeanRow.todayOnce(deadline: "Fri 5:00 PM", target: "Today 1:00 PM"), "Today 1:00 PM")
        XCTAssertEqual(LeanRow.todayOnce(deadline: nil, target: "Today 9:00 AM"), "Today 9:00 AM")
        XCTAssertEqual(LeanRow.todayOnce(deadline: "Today 9:00 PM", target: "Tomorrow 9:00 AM"), "Tomorrow 9:00 AM")
        XCTAssertNil(LeanRow.todayOnce(deadline: "Today 9:00 PM", target: nil))
    }

    func testTonightCountsAsToday() {
        XCTAssertEqual(LeanRow.todayOnce(deadline: "Tonight 12:30 AM", target: "Today 5:00 PM"), "5:00 PM")
        XCTAssertEqual(LeanRow.todayOnce(deadline: "Tonight 2:00 AM", target: "Tonight 1:00 AM"), "1:00 AM")
        XCTAssertEqual(LeanRow.todayOnce(deadline: "Today 9:00 PM", target: "Tonight 1:00 AM"), "1:00 AM")
        XCTAssertEqual(LeanRow.todayOnce(deadline: "Fri 5:00 PM", target: "Tonight 1:00 AM"), "Tonight 1:00 AM")
        XCTAssertEqual(LeanRow.todayOnce(deadline: nil, target: "Tonight 1:00 AM"), "Tonight 1:00 AM")
    }

    // MARK: - The horizon square (horizon-square.test.ts)

    func testUnsetLooksLikeWhateverUnsetMeans() {
        XCTAssertEqual(LeanRow.squareLook(nil), LeanRow.squareLook(TaskHorizon.unsetReadsAs))
        XCTAssertEqual(TaskHorizon.unsetReadsAs, .weeks)
    }

    func testDaysIsThePlainSquareTheOthersArePatterned() {
        XCTAssertEqual(LeanRow.squareLook(.days), .solid)
        XCTAssertNil(LeanRow.sidePattern(.solid))
        for h in [TaskHorizon.weeks, .months, .eventually] {
            XCTAssertNotNil(LeanRow.sidePattern(LeanRow.squareLook(h)), h.rawValue)
        }
        XCTAssertTrue(LeanRow.cornerDots(LeanRow.squareLook(.eventually)))
        XCTAssertFalse(LeanRow.cornerDots(LeanRow.squareLook(.months)))
    }

    /// Every side pattern sums to the side, is symmetric, and lands on whole
    /// pixels at 2x (half points).
    func testSidePatternsFillTheSideSymmetricallyOnThePixelGrid() {
        XCTAssertEqual(LeanRow.squareSide, 8)
        for look in [LeanRow.SquareLook.dashes, .midDash, .dots] {
            let side = LeanRow.sidePattern(look)!
            XCTAssertEqual(side.reduce(0, +), LeanRow.squareSide, "\(look)")
            // Symmetric about the middle once the leading "off" is read as part of the first gap.
            let runs = side.first == 0 ? Array(side.dropFirst()) : side
            XCTAssertEqual(runs, runs.reversed(), "\(look)")
            XCTAssertTrue(side.allSatisfy { ($0 * 2).rounded() == $0 * 2 }, "\(look) on half points")
        }
        XCTAssertEqual(LeanRow.sidePattern(.dots)?.filter { $0 == LeanRow.squareStroke }.count, 2, "two stroke-wide dots a side")
    }

    func testTheSquareShowsTheHorizonOnEveryOneOff() {
        XCTAssertTrue(LeanRow.horizonGoverns(task()))
        XCTAssertTrue(LeanRow.horizonGoverns(task(horizon: "months")))
        XCTAssertTrue(LeanRow.horizonGoverns(task(due: "2026-11-05T09:00")), "a picked target too (2026-10-29)")
        XCTAssertTrue(LeanRow.horizonGoverns(task(deadline: "2026-11-05T09:00")), "a deadline too: the set horizon")
        XCTAssertFalse(LeanRow.horizonGoverns(task(rrule: "FREQ=WEEKLY")), "a repeat")
        XCTAssertFalse(LeanRow.horizonGoverns(task(reminder: true)), "a reminder")
        XCTAssertFalse(LeanRow.horizonGoverns(task(tracked: true)), "a quota")
        XCTAssertTrue(LeanRow.horizonGoverns(task(due: "2026-11-05T09:00", targetAuto: true)), "an automatic target is not a pick")
    }

    func testARowsSquareIsPlainOutsideAHorizonSection() {
        // Every native list: the plain square, whatever the horizon (2026-10-29).
        XCTAssertEqual(LeanRow.squareLook(for: task(horizon: "eventually")), .solid)
        XCTAssertEqual(LeanRow.squareLook(for: task(due: "2026-11-05T09:00", horizon: "months")), .solid)
        // A Horizon section (the web's Scan) draws the set horizon; unset reads as Weeks.
        XCTAssertEqual(LeanRow.squareLook(for: task(horizon: "eventually"), inHorizonSection: true), .dots)
        XCTAssertEqual(LeanRow.squareLook(for: task(), inHorizonSection: true), .dashes, "unset reads as Weeks")
        XCTAssertEqual(LeanRow.squareLook(for: task(deadline: "2026-11-05T09:00", horizon: "eventually"), inHorizonSection: true), .dots)
        XCTAssertEqual(LeanRow.squareLook(for: task(rrule: "FREQ=WEEKLY", horizon: "eventually"), inHorizonSection: true), .solid, "a repeat: plain")
        XCTAssertEqual(LeanRow.squareAccessibilityLabel(.days), "Horizon Days")
        XCTAssertEqual(LeanRow.squareAccessibilityLabel(nil), "Horizon unset")
    }

    // MARK: - Colours

    func testTheRowsColoursAreTheWebsTokens() {
        XCTAssertEqual(LeanRow.targetHex.light, 0x155DFC)
        XCTAssertEqual(LeanRow.targetHex.dark, 0x51A2FF)
        XCTAssertEqual(LeanRow.passedHex.light, 0xC10007)
        XCTAssertEqual(LeanRow.passedHex.dark, 0xFF6467)
        XCTAssertEqual(LeanRow.tint(.over)?.light, .init(hex: 0xD6EEFF, alpha: 1))
        XCTAssertEqual(LeanRow.tint(.over)?.dark, .init(hex: 0x51A2FF, alpha: 0.125))
        XCTAssertNil(LeanRow.tint(.soon), "later today: no tint for now (Trent, 2026-10-29); the state is kept")
        XCTAssertEqual(LeanRow.tint(.passed)?.light, .init(hex: 0xC8140A, alpha: 0.098))
        XCTAssertEqual(LeanRow.tint(.passed)?.dark, .init(hex: 0xFF6467, alpha: 0.14))
        XCTAssertEqual(LeanRow.tint(.bothPassed)?.light, .init(hex: 0xC8140A, alpha: 0.1715), "1.75× the red")
        XCTAssertEqual(LeanRow.tint(.bothPassed)?.dark, .init(hex: 0xFF6467, alpha: 0.245))
        // M1: a passed target's time is the plum "over" tone; ahead, blue.
        XCTAssertEqual(LeanRow.targetTimeHex(isOverdue: true).light, 0x8E389B)
        XCTAssertEqual(LeanRow.targetTimeHex(isOverdue: true).dark, 0xC97CD5)
        XCTAssertEqual(LeanRow.targetTimeHex(isOverdue: false).light, 0x155DFC)
        XCTAssertEqual(LeanRow.priorityHex(.high), 0xF97316)
        XCTAssertEqual(LeanRow.priorityHex(.urgent), 0xEF4444)
    }
}
