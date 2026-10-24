import XCTest

/// `OpenTaskDay` ("Day starts at" PR 3) against the server's own helper: the
/// shared table `opentask-day-cases.json` (written from
/// `src/lib/opentask-day.ts` by `tests/behavioral/tq-day-native-cases.test.ts`)
/// for the expected values, then TQ-DD's named cases and its properties over
/// every quarter hour of both America/Chicago DST nights — the Swift twin of
/// `tests/behavioral/tq-day-directions.test.ts`.
final class OpenTaskDayTests: XCTestCase {

    private let chicago = TimeZone(identifier: "America/Chicago")!
    private let starts = ["00:00", "03:00", "06:30", "12:00", "12:01", "23:00"]

    private func day(_ start: String) -> OpenTaskDay {
        OpenTaskDay(dayStart: start, timeZone: chicago)
    }

    private func date(_ s: String) -> LocalDate { LocalDate(s)! }

    private func instant(_ iso: String) -> Date { DateHelpers.parseISO(iso)! }

    /// A Chicago wall-clock "yyyy-MM-ddTHH:mm" as an instant.
    private func local(_ wall: String, seconds: Double = 0) -> Date {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = chicago
        f.dateFormat = "yyyy-MM-dd'T'HH:mm"
        return f.date(from: wall)!.addingTimeInterval(seconds)
    }

    /// An instant as Chicago wall-clock "yyyy-MM-ddTHH:mm".
    private func wall(_ d: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = chicago
        f.dateFormat = "yyyy-MM-dd'T'HH:mm"
        return f.string(from: d)
    }

    // MARK: The shared table (TQ-DN)

    private struct Cases: Decodable {
        let timezone: String
        let dayStartMoments: [[String]]
        let openTaskDays: [[String]]
        let periodOpensAt: [[String]]
    }

    private func cases() throws -> Cases {
        try JSONDecoder().decode(Cases.self, from: Fixtures.data("opentask-day-cases"))
    }

    func testTableDayStartMoments() throws {
        let table = try cases()
        XCTAssertEqual(table.timezone, "America/Chicago")
        XCTAssertGreaterThan(table.dayStartMoments.count, 50)
        for row in table.dayStartMoments {
            let d = OpenTaskDay(dayStart: row[1], timeZone: TimeZone(identifier: table.timezone)!)
            XCTAssertEqual(d.dayStart(of: date(row[0])), instant(row[2]), "\(row)")
        }
    }

    func testTableOpenTaskDays() throws {
        let table = try cases()
        XCTAssertGreaterThan(table.openTaskDays.count, 1000)
        for row in table.openTaskDays {
            let d = OpenTaskDay(dayStart: row[1], timeZone: TimeZone(identifier: table.timezone)!)
            XCTAssertEqual(d.openTaskDay(of: instant(row[0])).description, row[2], "\(row)")
        }
    }

    func testTablePeriodOpensAt() throws {
        let table = try cases()
        XCTAssertGreaterThan(table.periodOpensAt.count, 100)
        for row in table.periodOpensAt {
            let d = OpenTaskDay(dayStart: row[1], timeZone: TimeZone(identifier: table.timezone)!)
            let opens = d.periodOpensAt(date(row[0]), startMinutes: OpenTaskDay.parseHHMM(row[2])!)
            XCTAssertEqual(opens, instant(row[3]), "\(row)")
        }
    }

    // MARK: TQ-DD's named cases

    func testNamingConvention() {
        XCTAssertEqual(starts.map { day($0).namesNextDate }, [false, false, false, false, true, true])
        let expected = [
            "00:00": "2026-10-20T00:00", "03:00": "2026-10-20T03:00", "06:30": "2026-10-20T06:30",
            "12:00": "2026-10-20T12:00", "12:01": "2026-10-19T12:01", "23:00": "2026-10-19T23:00",
        ]
        for start in starts {
            XCTAssertEqual(wall(day(start).dayStart(of: date("2026-10-20"))), expected[start], start)
        }
    }

    func testElevenPMSundayNightIsMonday() {
        let d = day("23:00")
        XCTAssertEqual(d.openTaskDay(of: local("2026-10-18T23:30")), date("2026-10-19"))
        XCTAssertEqual(d.openTaskDay(of: local("2026-10-18T23:00")), date("2026-10-19"))
        XCTAssertEqual(d.openTaskDay(of: local("2026-10-18T22:59", seconds: 59.999)), date("2026-10-18"))
        XCTAssertEqual(d.openTaskDay(of: local("2026-10-19T12:00")), date("2026-10-19"))
    }

    func testNoonEdge() {
        XCTAssertEqual(day("12:00").openTaskDay(of: local("2026-10-20T11:59")), date("2026-10-19"))
        XCTAssertEqual(day("12:00").openTaskDay(of: local("2026-10-20T12:00")), date("2026-10-20"))
        XCTAssertEqual(day("12:01").openTaskDay(of: local("2026-10-20T12:00")), date("2026-10-20"))
        XCTAssertEqual(day("12:01").openTaskDay(of: local("2026-10-20T12:01")), date("2026-10-21"))
    }

    func testMidnightIsTheCalendarDay() {
        let d = OpenTaskDay.midnight(timeZone: chicago)
        XCTAssertEqual(d.openTaskDay(of: local("2026-10-20T00:00")), date("2026-10-20"))
        XCTAssertEqual(d.openTaskDay(of: local("2026-10-19T23:59", seconds: 59.999)), date("2026-10-19"))
        // An unparseable day start reads as midnight.
        XCTAssertEqual(OpenTaskDay(dayStart: "25:00", timeZone: chicago), d)
    }

    func testSpringForwardGapIsTheNextValidMinute() {
        let d = day("02:30")
        XCTAssertEqual(wall(d.dayStart(of: date("2027-03-14"))), "2027-03-14T03:00")
        XCTAssertEqual(d.openTaskDay(of: local("2027-03-14T01:59")), date("2027-03-13"))
        XCTAssertEqual(d.openTaskDay(of: local("2027-03-14T03:00")), date("2027-03-14"))
    }

    func testElevenPMAroundBothNightsMakesTwentyThreeAndTwentyFiveHourDays() {
        let spring = day("23:00").daySpan(containing: local("2027-03-14T12:00"))
        XCTAssertEqual(spring.date, date("2027-03-14"))
        XCTAssertEqual([wall(spring.start), wall(spring.end)], ["2027-03-13T23:00", "2027-03-14T23:00"])
        XCTAssertEqual(spring.end.timeIntervalSince(spring.start) / 3600, 23)
        let fall = day("23:00").daySpan(containing: local("2026-11-01T12:00"))
        XCTAssertEqual(fall.date, date("2026-11-01"))
        XCTAssertEqual([wall(fall.start), wall(fall.end)], ["2026-10-31T23:00", "2026-11-01T23:00"])
        XCTAssertEqual(fall.end.timeIntervalSince(fall.start) / 3600, 25)
    }

    func testFallBackRepeatedTimeIsItsFirstInstant() {
        let d = day("01:30")
        XCTAssertEqual(DateHelpers.formatISO(d.dayStart(of: date("2026-11-01"))), "2026-11-01T06:30:00Z")
        // The second 01:30 (CST) is the same day.
        XCTAssertEqual(d.openTaskDay(of: instant("2026-11-01T07:30:00Z")), date("2026-11-01"))
    }

    /// A far-east zone (Auckland, +13 in summer): its fall-back night's
    /// repeated 02:30 is still the FIRST instant (NZDT), and the second (NZST)
    /// is the same day; its spring-forward gap still takes the next valid minute.
    func testFarEastZoneTransitions() {
        let auckland = OpenTaskDay(dayStart: "02:30", timeZone: TimeZone(identifier: "Pacific/Auckland")!)
        XCTAssertEqual(DateHelpers.formatISO(auckland.dayStart(of: date("2027-04-04"))), "2027-04-03T13:30:00Z")
        XCTAssertEqual(auckland.openTaskDay(of: instant("2027-04-03T14:30:00Z")), date("2027-04-04"))
        // Spring forward 2026-09-27, 02:00 NZST → 03:00 NZDT: 02:30 is 03:00 NZDT.
        XCTAssertEqual(DateHelpers.formatISO(auckland.dayStart(of: date("2026-09-27"))), "2026-09-26T14:00:00Z")
        // Chatham (+13:45 in summer) falls back 03:45 → 02:45: a 03:00 start
        // is the first 03:00 (CHADT), so the day is 25 hours.
        let chatham = OpenTaskDay(dayStart: "03:00", timeZone: TimeZone(identifier: "Pacific/Chatham")!)
        let span = chatham.dateSpan(date("2027-04-04"))
        XCTAssertEqual(DateHelpers.formatISO(span.start), "2027-04-03T13:15:00Z")
        XCTAssertEqual(chatham.openTaskDay(of: span.start), date("2027-04-04"))
        XCTAssertEqual(span.end.timeIntervalSince(span.start), 25 * 3600)
    }

    func testEveryBoundaryJustBeforeAtAndAfter() {
        for start in starts {
            let d = day(start)
            for name in ["2026-10-20", "2027-03-14", "2026-11-01"] {
                let D = date(name)
                let b = d.dayStart(of: D)
                XCTAssertEqual(d.openTaskDay(of: b.addingTimeInterval(-0.001)), D.adding(days: -1), "\(start) \(name)")
                XCTAssertEqual(d.openTaskDay(of: b), D, "\(start) \(name)")
                XCTAssertEqual(d.openTaskDay(of: b.addingTimeInterval(0.001)), D, "\(start) \(name)")
                let span = d.daySpan(containing: b)
                XCTAssertEqual(span, OpenTaskDay.Span(date: D, start: b, end: d.dayStart(of: D.adding(days: 1))))
                XCTAssertEqual(d.latestRollover(atOrBefore: b), b)
                XCTAssertEqual(d.nextRollover(after: b.addingTimeInterval(-0.001)), b)
                XCTAssertEqual(d.nextRollover(after: b), span.end)
            }
        }
    }

    // MARK: Properties over every quarter hour (both DST nights)

    func testSpanPropertiesOverBothDSTNights() {
        var instants: [Date] = []
        for (from, to) in [("2026-10-30T00:00", "2026-11-03T00:00"), ("2027-03-12T00:00", "2027-03-16T00:00")] {
            var t = local(from)
            while t < local(to) {
                instants.append(t)
                t = t.addingTimeInterval(15 * 60)
            }
        }
        for start in starts {
            let d = day(start)
            for x in instants {
                let today = d.openTaskDay(of: x)
                let span = d.daySpan(containing: x)
                XCTAssertEqual(span.date, today)
                XCTAssertTrue(span.contains(x), "\(start) \(wall(x))")
                XCTAssertEqual(d.openTaskDay(of: span.start), today)
                XCTAssertEqual(d.openTaskDay(of: span.end.addingTimeInterval(-0.001)), today)
                XCTAssertEqual(d.openTaskDay(of: span.end), today.adding(days: 1))
                XCTAssertGreaterThan(d.nextRollover(after: x), x)
                // The named date is the calendar date, or the one before (≤ 12:00) / after (> 12:00).
                let calendarDay = d.calendarDate(of: x)
                let other = d.namesNextDate ? calendarDay.adding(days: 1) : calendarDay.adding(days: -1)
                XCTAssertTrue([calendarDay, other].contains(today), "\(start) \(wall(x))")
            }
        }
    }

    // MARK: Periods within a day

    func testPeriodsOpenInsideTheirOwnDay() {
        let periods = ["00:30", "01:00", "02:30", "03:00", "06:30", "07:00", "12:00", "20:30", "23:30"]
        for start in starts {
            let d = day(start)
            for name in ["2026-10-20", "2027-03-14", "2026-11-01"] {
                for p in periods {
                    let opens = d.periodOpensAt(date(name), startMinutes: OpenTaskDay.parseHHMM(p)!)
                    XCTAssertEqual(d.openTaskDay(of: opens), date(name), "\(start) \(name) \(p)")
                }
            }
        }
        // 3:00 AM: a 1:00 AM period ends the day; 07:00 begins it.
        XCTAssertEqual(wall(day("03:00").periodOpensAt(date("2026-10-20"), startMinutes: 60)), "2026-10-21T01:00")
        XCTAssertEqual(wall(day("03:00").periodOpensAt(date("2026-10-20"), startMinutes: 420)), "2026-10-20T07:00")
        // 11 PM: Monday's 23:30 period is Sunday night.
        XCTAssertEqual(wall(day("23:00").periodOpensAt(date("2026-10-19"), startMinutes: 1410)), "2026-10-18T23:30")
    }

    func testMinutesIntoDayAndOrderByDay() {
        let d = day("03:00")
        XCTAssertEqual(d.minutesIntoDay(180), 0)
        XCTAssertEqual(d.minutesIntoDay(60), 1320)
        XCTAssertEqual(d.minutesIntoDay(1439), 1259)
        let starts: [Int?] = [60, 420, nil, 1230]
        XCTAssertEqual(d.orderedByDay(starts) { $0 }, [420, 1230, 60, nil])
        // Midnight: start order comes back unchanged.
        XCTAssertEqual(OpenTaskDay.midnight(timeZone: chicago).orderedByDay([60, 420, nil]) { $0 }, [60, 420, nil])
    }

    func testLateNightAndDaysBetween() {
        XCTAssertTrue(day("03:00").isLateNight(local("2026-10-20T01:00")))
        XCTAssertFalse(day("03:00").isLateNight(local("2026-10-20T03:00")))
        XCTAssertFalse(day("23:00").isLateNight(local("2026-10-20T23:30")))
        XCTAssertEqual(day("03:00").daysBetween(local("2026-10-20T01:00"), local("2026-10-20T04:00")), 1)
        XCTAssertEqual(day("00:00").daysBetween(local("2026-10-20T01:00"), local("2026-10-20T04:00")), 0)
    }

    func testLocalDate() {
        XCTAssertNil(LocalDate("2026-02-30"))
        XCTAssertNil(LocalDate("2026-2-3"))
        XCTAssertEqual(date("2026-12-31").adding(days: 1), date("2027-01-01"))
        XCTAssertEqual(date("2027-03-01").adding(days: -1), date("2027-02-28"))
        XCTAssertEqual(date("2026-10-20").days(to: date("2026-11-02")), 13)
        XCTAssertEqual(date("2026-10-18").weekday, 1) // a Sunday
    }
}
