import XCTest

/// The per-quota rules the phone/Mac Quotas widget and the watch's Quotas
/// page share (`QuotaPeriodKey`, `QuotaRules` in ios/Shared/QuotaRules.swift).
final class QuotaRulesTests: XCTestCase {

    private func quota(_ id: Int, labels: [String] = []) -> TaskDTO {
        TaskDTO(
            id: id, title: "Q", rrule: "FREQ=WEEKLY", progressTarget: 1, progressCurrent: 0,
            trackedFlag: true, labels: labels
        )
    }

    func testPeriodFromRRule() {
        XCTAssertEqual(QuotaPeriodKey.from(rrule: "FREQ=DAILY"), .daily)
        XCTAssertEqual(QuotaPeriodKey.from(rrule: "FREQ=WEEKLY;INTERVAL=2"), .weekly, "INTERVAL is ignored")
        XCTAssertEqual(QuotaPeriodKey.from(rrule: "interval=1;freq=monthly"), .monthly)
        XCTAssertEqual(QuotaPeriodKey.from(rrule: "FREQ=YEARLY;BYMONTH=3"), .yearly)
        XCTAssertEqual(QuotaPeriodKey.from(rrule: "FREQ=HOURLY"), QuotaPeriodKey.none)
        XCTAssertEqual(QuotaPeriodKey.from(rrule: ""), QuotaPeriodKey.none)
        XCTAssertEqual(QuotaPeriodKey.from(rrule: nil), QuotaPeriodKey.none)
    }

    /// Day → year, then the period-less bucket last.
    func testPeriodOrderAndHeadings() {
        XCTAssertEqual(QuotaPeriodKey.order, [.daily, .weekly, .monthly, .yearly, .none])
        XCTAssertEqual(
            QuotaPeriodKey.order.map(\.heading),
            ["Today", "This week", "This month", "This year", "No period"]
        )
    }

    func testLabelAndStripeColorRules() {
        let config = [
            LabelConfigDTO(name: "health", color: "green"),
            LabelConfigDTO(name: "home", color: "orange"),
        ]
        // `ai-` machinery labels are skipped.
        let q = quota(1, labels: ["ai-added", "home"])
        XCTAssertEqual(QuotaRules.label(of: q), "home")
        XCTAssertEqual(QuotaRules.stripeColor(of: q, labelConfig: config), "orange")
        // The label match is case-insensitive.
        XCTAssertEqual(QuotaRules.stripeColor(forLabel: "HOME", labelConfig: config), "orange")
        // Green means "met" on quota chips, so a green label draws neutral.
        XCTAssertNil(QuotaRules.stripeColor(of: quota(2, labels: ["Health"]), labelConfig: config))
        XCTAssertNil(QuotaRules.stripeColor(of: quota(3), labelConfig: config))
        XCTAssertNil(QuotaRules.stripeColor(forLabel: "unconfigured", labelConfig: config))
    }
}
