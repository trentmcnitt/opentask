import XCTest

/// `RecurrenceSummary` — an Upcoming row's schedule words in place of a bare
/// "repeats" (2026-10-12). The web's `formatRRuleCompact` is the model; the
/// deliberate differences are in the type's doc.
final class RecurrenceSummaryTests: XCTestCase {
    private func text(_ rrule: String?, anchor: String? = nil) -> String {
        RecurrenceSummary.text(rrule: rrule, anchorTime: anchor)
    }

    func testDaily() {
        XCTAssertEqual(text("FREQ=DAILY"), "daily")
        XCTAssertEqual(text("FREQ=DAILY;BYHOUR=9;BYMINUTE=0"), "daily at 9 AM")
        XCTAssertEqual(text("FREQ=DAILY;BYHOUR=19;BYMINUTE=30"), "daily at 7:30 PM")
        XCTAssertEqual(text("FREQ=DAILY;INTERVAL=3"), "every 3 days")
        XCTAssertEqual(text("FREQ=DAILY;INTERVAL=3;BYHOUR=9;BYMINUTE=0"), "every 3 days at 9 AM")
        XCTAssertEqual(text("RRULE:freq=daily"), "daily", "prefix and case, like the web's parser")
    }

    func testTimeFallsBackToAnchorTime() {
        XCTAssertEqual(text("FREQ=DAILY", anchor: "08:15"), "daily at 8:15 AM")
        XCTAssertEqual(text("FREQ=WEEKLY;BYDAY=SU", anchor: "12:00"), "every Sun at noon")
        XCTAssertEqual(text("FREQ=DAILY", anchor: "00:00"), "daily at midnight")
        XCTAssertEqual(text("FREQ=DAILY;BYHOUR=6;BYMINUTE=0", anchor: "21:00"), "daily at 6 AM", "BYHOUR wins")
        XCTAssertEqual(text("FREQ=DAILY", anchor: "nonsense"), "daily", "an unreadable anchor adds nothing")
    }

    func testWeeklySingleDay() {
        XCTAssertEqual(text("FREQ=WEEKLY;BYDAY=WE"), "every Wed")
        XCTAssertEqual(text("FREQ=WEEKLY;BYDAY=WE", anchor: "09:00"), "every Wed at 9 AM")
        XCTAssertEqual(text("FREQ=WEEKLY"), "weekly")
    }

    func testWeeklyMultipleDays() {
        XCTAssertEqual(text("FREQ=WEEKLY;BYDAY=FR,MO,WE"), "every Mon, Wed, Fri", "Monday-first order")
        XCTAssertEqual(text("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"), "weekdays")
        XCTAssertEqual(text("FREQ=WEEKLY;BYDAY=SA,SU"), "weekends")
        XCTAssertEqual(text("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU"), "daily")
    }

    func testEveryNWeeks() {
        XCTAssertEqual(text("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO"), "every 2 weeks on Mon")
        XCTAssertEqual(text("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH"), "every 2 weeks on Tue, Thu")
        XCTAssertEqual(text("FREQ=WEEKLY;INTERVAL=3"), "every 3 weeks")
    }

    func testMonthlyByDay() {
        XCTAssertEqual(text("FREQ=MONTHLY;BYMONTHDAY=1"), "monthly on the 1st")
        XCTAssertEqual(text("FREQ=MONTHLY;BYMONTHDAY=1,15"), "monthly on the 1st, 15th")
        XCTAssertEqual(text("FREQ=MONTHLY;BYMONTHDAY=22", anchor: "12:00"), "monthly on the 22nd at noon")
        XCTAssertEqual(text("FREQ=MONTHLY;BYMONTHDAY=-1"), "monthly on the last day")
        XCTAssertEqual(text("FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=11"), "every 3 months on the 11th")
        XCTAssertEqual(text("FREQ=MONTHLY"), "monthly")
    }

    func testMonthlyByWeekdayOrdinal() {
        XCTAssertEqual(text("FREQ=MONTHLY;BYDAY=2TU"), "monthly on the 2nd Tue")
        XCTAssertEqual(text("FREQ=MONTHLY;BYDAY=-1FR"), "monthly on the last Fri")
        XCTAssertEqual(text("FREQ=MONTHLY;BYDAY=+1MO"), "monthly on the 1st Mon")
        XCTAssertEqual(text("FREQ=MONTHLY;BYDAY=TH;BYSETPOS=3"), "monthly on the 3rd Thu")
        XCTAssertEqual(text("FREQ=MONTHLY;BYDAY=SA"), "monthly on Sat")
    }

    func testYearly() {
        XCTAssertEqual(text("FREQ=YEARLY"), "yearly")
        XCTAssertEqual(text("FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15"), "yearly on Mar 15")
        XCTAssertEqual(text("FREQ=YEARLY;INTERVAL=2"), "every 2 years")
    }

    func testUnreadableFallsBackToRepeats() {
        XCTAssertEqual(text(nil), "repeats")
        XCTAssertEqual(text(""), "repeats")
        XCTAssertEqual(text("garbage"), "repeats")
        XCTAssertEqual(text("FREQ=HOURLY"), "repeats")
        XCTAssertEqual(text("FREQ=WEEKLY;BYDAY=XX"), "repeats")
        XCTAssertEqual(text("FREQ=DAILY;INTERVAL=0"), "repeats")
        XCTAssertEqual(text("FREQ=MONTHLY;BYDAY=9TU"), "repeats")
        XCTAssertEqual(text("BYDAY=MO"), "repeats", "no FREQ")
    }

    func testOrdinals() {
        XCTAssertEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(RecurrenceSummary.ordinal),
                       ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "31st"])
    }

    /// The parser is shared with the quota period rule (one splitter).
    func testPartsParser() {
        XCTAssertEqual(RRuleParts.parse("RRULE:FREQ=weekly;byday=MO;;INTERVAL="), ["FREQ": "weekly", "BYDAY": "MO"])
    }
}
