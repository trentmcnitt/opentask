import XCTest

/// A checklist left open comes back as it was (`ChecklistMemory` and
/// `ChecklistState.restore`, 2026-11-25), and the pager's words (NCL-2).
final class ChecklistMemoryTests: XCTestCase {

    private struct Plain: ChecklistItem {
        let n: Int
        var checklistKey: String { "k\(n)" }
    }

    private let today = LocalDate(year: 2026, month: 11, day: 25)
    private let yesterday = LocalDate(year: 2026, month: 11, day: 24)
    private var suite: UserDefaults!

    override func setUp() {
        suite = UserDefaults(suiteName: "ChecklistMemoryTests")
        suite.removePersistentDomain(forName: "ChecklistMemoryTests")
        ChecklistMemory.suiteOverride = suite
    }

    override func tearDown() {
        ChecklistMemory.suiteOverride = nil
        suite.removePersistentDomain(forName: "ChecklistMemoryTests")
    }

    private func rows(_ count: Int) -> [Plain] { (1 ... count).map { Plain(n: $0) } }

    // MARK: - The memory

    func testItKeepsMarksAndPageForTheNotificationToday() {
        ChecklistMemory.remember("n1", marks: ["k2": .check, "k9": .did], page: 1, today: today)
        XCTAssertEqual(
            ChecklistMemory.recall("n1", today: today),
            ChecklistMemory.Entry(day: "2026-11-25", marks: ["k2": .check, "k9": .did], page: 1)
        )
        XCTAssertNil(ChecklistMemory.recall("n2", today: today), "another notification has its own")
    }

    func testYesterdaysSetNeverComesBack() {
        ChecklistMemory.remember("n1", marks: ["k2": .check], page: 1, today: yesterday)
        XCTAssertNil(ChecklistMemory.recall("n1", today: today))
        // A save today prunes every other day's entry.
        ChecklistMemory.remember("n2", marks: ["k1": .check], page: 0, today: today)
        XCTAssertNil(ChecklistMemory.recall("n1", today: yesterday), "pruned, not just hidden")
    }

    func testForgetAndAnEmptySetLeaveNothing() {
        ChecklistMemory.remember("n1", marks: ["k2": .check], page: 1, today: today)
        ChecklistMemory.forget("n1")
        XCTAssertNil(ChecklistMemory.recall("n1", today: today))
        ChecklistMemory.remember("n1", marks: ["k2": .check], page: 0, today: today)
        ChecklistMemory.remember("n1", marks: [:], page: 0, today: today)
        XCTAssertNil(ChecklistMemory.recall("n1", today: today), "nothing marked on page 1 is the default")
    }

    // MARK: - The restore

    func testRestoredMarksShowAtOnceAndThePageOnceTheListLands() {
        var state = ChecklistState<Plain>(rows: [Plain(n: 1)], marks: ["k1": .check], load: .loading, heldKey: "k1")
        state.restore(marks: ["k2": .check, "k8": .check], page: 1)
        XCTAssertEqual(state.page, 0, "only the payload's row before the fetch: the page waits")
        state.apply(fetched: rows(9))
        XCTAssertEqual(state.page, 1)
        XCTAssertEqual(state.pageRows.map(\.n), [7, 8, 9])
        XCTAssertEqual(Set(state.marked.map(\.item.n)), [2, 8], "the restored set replaces the default held mark")
    }

    func testARestoredMarkOnAGoneRowFallsAwayAndThePageIsClamped() {
        var state = ChecklistState<Plain>(rows: [], load: .loading)
        state.restore(marks: ["k2": .check, "k12": .check], page: 3)
        state.apply(fetched: rows(7))
        XCTAssertEqual(state.page, 1, "two pages now: the last")
        XCTAssertEqual(state.marked.map(\.item.n), [2])
    }

    // MARK: - The pager's words (NCL-2, 2026-11-25)

    func testThePagerSaysPreviousNextAndWhichPage() {
        var state = ChecklistState<Plain>(rows: [], load: .loading)
        state.apply(fetched: rows(14))
        XCTAssertEqual(state.pageLabel, "1 of 3")
        XCTAssertFalse(state.showsLess)
        XCTAssertTrue(state.showsMore)
        state.showMore()
        XCTAssertEqual(state.pageLabel, "2 of 3")
        XCTAssertTrue(state.showsLess && state.showsMore, "a middle page has both")
        state.showMore()
        XCTAssertEqual(state.pageLabel, "3 of 3")
        XCTAssertTrue(state.showsLess)
        XCTAssertFalse(state.showsMore)
        var single = ChecklistState<Plain>(rows: [], load: .loading)
        single.apply(fetched: rows(4))
        XCTAssertNil(single.pageLabel, "one page: no pager at all")
        XCTAssertEqual([NotificationWords.previous, NotificationWords.next], ["Previous", "Next"])
    }
}
