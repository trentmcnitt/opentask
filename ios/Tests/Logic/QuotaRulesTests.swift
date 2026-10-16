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

    // MARK: Interval quotas (2026-10-16)

    func testPeriodGroupKeysOnUnitAndInterval() {
        let week = TaskDTO(id: 1, title: "Run", rrule: "FREQ=WEEKLY", progressTarget: 3)
        let fortnight = TaskDTO(
            id: 2, title: "Oven", rrule: "FREQ=WEEKLY;INTERVAL=2", trackedFlag: true, periodInterval: 2
        )
        // An older server: no `period_interval`, the rrule's INTERVAL is read.
        let oldServer = TaskDTO(id: 3, title: "Filters", rrule: "FREQ=MONTHLY;INTERVAL=3", trackedFlag: true)
        XCTAssertEqual(QuotaPeriodGroup.of(week), QuotaPeriodGroup(key: .weekly, interval: 1))
        XCTAssertEqual(QuotaPeriodGroup.of(fortnight), QuotaPeriodGroup(key: .weekly, interval: 2))
        XCTAssertEqual(QuotaPeriodGroup.of(oldServer), QuotaPeriodGroup(key: .monthly, interval: 3))
        XCTAssertEqual(QuotaPeriodGroup.of(fortnight).id, "weekly/2")
        XCTAssertEqual(QuotaPeriodGroup.of(fortnight).heading, "Every 2 weeks")
        XCTAssertEqual(QuotaPeriodGroup.of(week).heading, "This week")
        XCTAssertTrue(QuotaPeriodGroup.of(week).hasClock)
        XCTAssertFalse(QuotaPeriodGroup.of(fortnight).hasClock)
    }

    func testPeriodGroupOrder() {
        let groups = [
            QuotaPeriodGroup(key: .monthly, interval: 1),
            QuotaPeriodGroup(key: .weekly, interval: 3),
            QuotaPeriodGroup(key: .none, interval: 1),
            QuotaPeriodGroup(key: .weekly, interval: 1),
            QuotaPeriodGroup(key: .weekly, interval: 2),
            QuotaPeriodGroup(key: .daily, interval: 2),
        ]
        XCTAssertEqual(
            QuotaPeriodGroup.ordered(groups).map(\.id),
            ["daily/2", "weekly", "weekly/2", "weekly/3", "monthly", "none"]
        )
    }

    func testCompactDay() {
        XCTAssertEqual(QuotaCount.compactDay("2026-10-24"), "10/24")
        XCTAssertEqual(QuotaCount.compactDay("2026-01-05"), "1/5")
        XCTAssertNil(QuotaCount.compactDay(nil))
        XCTAssertNil(QuotaCount.compactDay("Oct 24"))
    }
}
