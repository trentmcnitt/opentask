import XCTest

/// `DueLabel.parts` — the words beside a Tasks widget row's due time. The
/// overdue half (2026-09-25): a day word sits above the time whenever the due
/// date isn't today, so an old overdue row can't be mistaken for today's.
/// Built in the machine's own calendar/time zone, like the widget.
final class DueLabelTests: XCTestCase {

    private let calendar = Calendar.current

    /// Wednesday 2026-01-14, 3:00 PM local.
    private var now: Date {
        calendar.date(from: DateComponents(year: 2026, month: 1, day: 14, hour: 15))!
    }

    private func at(daysFromNow days: Int, hour: Int, minute: Int = 0) -> Date {
        let day = calendar.date(byAdding: .day, value: days, to: calendar.startOfDay(for: now))!
        return calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day)!
    }

    private func weekday(_ date: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = "EEE"
        return f.string(from: date)
    }

    private func monthDay(_ date: Date) -> String {
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f.string(from: date)
    }

    private func parts(_ due: Date) -> DueLabel.Parts {
        DueLabel.parts(for: due, now: now, isOverdue: due < now)
    }

    // MARK: Overdue

    func testOverdueEarlierTodayIsTheTimeAlone() {
        let p = parts(at(daysFromNow: 0, hour: 9))
        XCTAssertEqual(p, DueLabel.Parts(dayWord: nil, time: "9:00 am"))
        XCTAssertFalse(p.hasTwoParts)
    }

    func testOverdueYesterdayStacksYesterdayOverTheTime() {
        let p = parts(at(daysFromNow: -1, hour: 12))
        XCTAssertEqual(p, DueLabel.Parts(dayWord: "Yesterday", time: "12:00 pm"))
        XCTAssertTrue(p.hasTwoParts, "two parts stack — the pager measures two lines")
    }

    func testOverdueWithinAWeekNamesTheWeekday() {
        for back in 2...6 {
            let due = at(daysFromNow: -back, hour: 8, minute: 30)
            XCTAssertEqual(parts(due), DueLabel.Parts(dayWord: weekday(due), time: "8:30 am"), "\(back) days back")
        }
    }

    func testOverdueAWeekOrMoreNamesTheDate() {
        for back in [7, 30] {
            let due = at(daysFromNow: -back, hour: 17)
            XCTAssertEqual(parts(due), DueLabel.Parts(dayWord: monthDay(due), time: "5:00 pm"), "\(back) days back")
        }
    }

    func testOverdueDateOnlyIsTheDayWordAlone() {
        XCTAssertEqual(parts(at(daysFromNow: -1, hour: 0)), DueLabel.Parts(dayWord: "Yesterday", time: nil))
        XCTAssertEqual(parts(at(daysFromNow: 0, hour: 0)), DueLabel.Parts(dayWord: "Today", time: nil))
    }

    // MARK: Upcoming (unchanged)

    func testUpcomingLadder() {
        XCTAssertEqual(parts(at(daysFromNow: 0, hour: 20, minute: 30)), DueLabel.Parts(dayWord: nil, time: "8:30 pm"))
        XCTAssertEqual(parts(at(daysFromNow: 1, hour: 9)), DueLabel.Parts(dayWord: "Tomorrow", time: "9:00 am"))
        let sat = at(daysFromNow: 3, hour: 9)
        XCTAssertEqual(parts(sat), DueLabel.Parts(dayWord: weekday(sat), time: "9:00 am"))
        let later = at(daysFromNow: 10, hour: 9)
        XCTAssertEqual(parts(later), DueLabel.Parts(dayWord: monthDay(later), time: "9:00 am"))
        let dateOnly = at(daysFromNow: 2, hour: 0)
        XCTAssertEqual(parts(dateOnly), DueLabel.Parts(dayWord: weekday(dateOnly), time: nil))
    }
}
