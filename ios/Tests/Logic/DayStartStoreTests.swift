import XCTest

/// `DayStartStore` ("Day starts at" PR 3): the rule (the day start with the
/// task queue on, midnight off — `browserDayStart`'s), remembering the last
/// known boundary, and midnight only when nothing is known. Every test runs
/// on a throwaway suite (`suiteOverride`), never the real App Group.
final class DayStartStoreTests: XCTestCase {
    private var suiteName = ""

    override func setUp() {
        super.setUp()
        suiteName = "test.\(UUID().uuidString)"
        DayStartStore.suiteOverride = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName)
        DayStartStore.suiteOverride = nil
        super.tearDown()
    }

    private func page(_ json: String) throws -> UserPreferencesLabelConfigPage {
        try JSONDecoder().decode(UserPreferencesLabelConfigPage.self, from: Data(json.utf8))
    }

    func testTheRule() {
        XCTAssertEqual(DayStartStore.resolvedDayStart(taskQueue: true, rolloverTime: "03:00"), "03:00")
        XCTAssertEqual(DayStartStore.resolvedDayStart(taskQueue: true, rolloverTime: "23:00"), "23:00")
        XCTAssertEqual(DayStartStore.resolvedDayStart(taskQueue: false, rolloverTime: "03:00"), "00:00")
        // No switch (a server that predates it) is midnight, as that server runs.
        XCTAssertEqual(DayStartStore.resolvedDayStart(taskQueue: nil, rolloverTime: "03:00"), "00:00")
        XCTAssertEqual(DayStartStore.resolvedDayStart(taskQueue: true, rolloverTime: nil), "00:00")
        XCTAssertEqual(DayStartStore.resolvedDayStart(taskQueue: true, rolloverTime: "3am"), "00:00")
    }

    func testNothingKnownIsMidnight() {
        XCTAssertNil(DayStartStore.cachedDayStart)
        XCTAssertEqual(DayStartStore.current.dayStart, "00:00")
        XCTAssertNil(DayStartStore.cachedFirstWeekday)
    }

    func testRemembersTheLastKnownBoundary() throws {
        DayStartStore.save(from: try page(#"{"task_queue":true,"rollover_time":"06:30","week_start":"monday"}"#))
        XCTAssertEqual(DayStartStore.cachedDayStart, "06:30")
        XCTAssertEqual(DayStartStore.current.dayStartMinutes, 390)
        XCTAssertEqual(DayStartStore.cachedFirstWeekday, 2)
        // The switch going off is midnight — remembered as such, not forgotten.
        DayStartStore.save(from: try page(#"{"task_queue":false,"rollover_time":"06:30"}"#))
        XCTAssertEqual(DayStartStore.cachedDayStart, "00:00")
        // A page without week_start keeps the last known week.
        XCTAssertEqual(DayStartStore.cachedFirstWeekday, 2)
    }

    /// The switch itself is remembered (2026-10-26, the sweep estimate's one
    /// High per press) — apart from the boundary, since the switch on with a
    /// 00:00 day start resolves to the same boundary as off. Off when nothing
    /// is known, or the field is missing or not a boolean.
    func testRemembersTheTaskQueueSwitch() throws {
        XCTAssertFalse(DayStartStore.cachedTaskQueue)
        DayStartStore.save(from: try page(#"{"task_queue":true,"rollover_time":"00:00"}"#))
        XCTAssertTrue(DayStartStore.cachedTaskQueue)
        XCTAssertEqual(DayStartStore.cachedDayStart, "00:00")
        DayStartStore.save(from: try page(#"{"rollover_time":"03:00"}"#))
        XCTAssertFalse(DayStartStore.cachedTaskQueue, "a server without the field has no switch")
        DayStartStore.save(from: try page(#"{"task_queue":true}"#))
        DayStartStore.save(from: try page(#"{"task_queue":"yes"}"#))
        XCTAssertFalse(DayStartStore.cachedTaskQueue)
    }

    func testDecodesTheFieldsLeniently() throws {
        let p = try page(#"{"task_queue":"yes","rollover_time":3,"week_start":"sunday"}"#)
        XCTAssertNil(p.taskQueue)
        XCTAssertNil(p.rolloverTime)
        XCTAssertEqual(DayStartStore.firstWeekday(for: p.weekStart), 1)
        XCTAssertNil(DayStartStore.firstWeekday(for: "tuesday"))
    }
}
