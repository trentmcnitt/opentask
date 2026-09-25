import XCTest

/// `QuotaPromptDTO`'s own rules: the count text every prompt surface shows,
/// the optimistic `handled(did:)`, and prompt identity.
final class QuotaPromptDTOTests: XCTestCase {

    private func prompt(
        period: String?, current: Int = 1, target: Int = 2, number: Int? = nil,
        considered: Bool = false, done: Bool = false
    ) -> QuotaPromptDTO {
        QuotaPromptDTO(
            promptKey: "q:7:\(number ?? 0):2026-01-15", taskId: 7, number: number,
            numbers: number.map { [$0] }, slotId: 3, title: "Read", current: current, target: target,
            period: period, stripeColor: "blue", considered: considered, done: done, hasNotes: true
        )
    }

    private let nbsp = "\u{00A0}"

    func testCountTextNamesThePeriod() {
        XCTAssertEqual(prompt(period: "DAILY").countText, "1/2\(nbsp)today")
        XCTAssertEqual(prompt(period: "WEEKLY").countText, "1/2\(nbsp)this\(nbsp)week")
        XCTAssertEqual(prompt(period: "MONTHLY").countText, "1/2\(nbsp)this\(nbsp)month")
        XCTAssertEqual(prompt(period: "YEARLY").countText, "1/2\(nbsp)this\(nbsp)year")
        XCTAssertEqual(prompt(period: nil).countText, "1/2")
        XCTAssertEqual(prompt(period: "HOURLY").countText, "1/2", "an unknown period shows the count alone")
        // The count and its words are ONE unbreakable run.
        XCTAssertFalse(prompt(period: "WEEKLY").countText.contains(" "))
    }

    func testPeriodWords() {
        XCTAssertEqual(
            ["DAILY", "WEEKLY", "MONTHLY", "YEARLY", nil].map { prompt(period: $0).periodWords },
            ["today", "this week", "this month", "this year", nil]
        )
        XCTAssertEqual(
            ["DAILY", "WEEKLY", "MONTHLY", "YEARLY", nil].map { prompt(period: $0).compactPeriodWord },
            ["today", "wk", "mo", "yr", nil]
        )
        XCTAssertEqual(prompt(period: "WEEKLY", current: 0, target: 5).countOnlyText, "0/5")
    }

    /// A plain space before the dot, a non-breaking one after it: "· 1/2
    /// today" wraps whole, but is not glued to the title's last word.
    func testCountSeparatorPlacement() {
        XCTAssertEqual(QuotaPromptDTO.countSeparator, " ·\(nbsp)")
        let label = prompt(period: "WEEKLY").labelText
        XCTAssertEqual(label, "Read ·\(nbsp)1/2\(nbsp)this\(nbsp)week")
        // Exactly one breakable space: between the title and the dot.
        XCTAssertEqual(label.filter { $0 == " " }.count, 1)
        XCTAssertTrue(label.hasPrefix("Read ·"))
    }

    func testHandledDidOnADailyRowRaisesTheCountToItsNumber() {
        // Row #2 at 0/3: a did-it means "the 2nd one is done" → 2, not 1.
        let row = prompt(period: "DAILY", current: 0, target: 3, number: 2).handled(did: true)
        XCTAssertEqual(row.current, 2)
        XCTAssertTrue(row.done)
        XCTAssertTrue(row.considered)
        // Already past it (logged elsewhere): max(current, k), never lower.
        XCTAssertEqual(prompt(period: "DAILY", current: 3, target: 3, number: 2).handled(did: true).current, 3)
    }

    func testHandledDidOnAnyOtherQuotaAddsOne() {
        let row = prompt(period: "WEEKLY", current: 1, target: 3).handled(did: true)
        XCTAssertEqual(row.current, 2)
        XCTAssertTrue(row.done)
        XCTAssertTrue(row.considered)
    }

    func testHandledConsiderChangesNoCount() {
        let row = prompt(period: "DAILY", current: 0, target: 2, number: 1).handled(did: false)
        XCTAssertEqual(row.current, 0)
        XCTAssertFalse(row.done)
        XCTAssertTrue(row.considered)
        XCTAssertFalse(row.isWaiting)
        // An already-done prompt stays done when considered.
        XCTAssertTrue(prompt(period: "WEEKLY", done: true).handled(did: false).done)
    }

    func testHandledKeepsEveryOtherField() {
        let before = prompt(period: "DAILY", current: 0, target: 2, number: 1)
        let after = before.handled(did: true)
        XCTAssertEqual(after.promptKey, before.promptKey)
        XCTAssertEqual(after.taskId, before.taskId)
        XCTAssertEqual(after.number, before.number)
        XCTAssertEqual(after.numbers, before.numbers)
        XCTAssertEqual(after.slotId, before.slotId)
        XCTAssertEqual(after.title, before.title)
        XCTAssertEqual(after.target, before.target)
        XCTAssertEqual(after.period, before.period)
        XCTAssertEqual(after.stripeColor, before.stripeColor)
        XCTAssertEqual(after.hasNotes, before.hasNotes, "a tapped prompt must not lose its notes glyph")
    }

    /// A daily quota's rows share ONE task id and differ in key — which is
    /// why rows are keyed by `promptKey`, never `taskId`.
    func testPromptIdentity() throws {
        let rows = try Fixtures.prompts().filter { $0.taskId == Fixtures.daily }
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(Set(rows.map(\.taskId)), [Fixtures.daily])
        XCTAssertEqual(rows.map(\.id), [Fixtures.promptKey(Fixtures.daily, 1), Fixtures.promptKey(Fixtures.daily, 2)])
        XCTAssertEqual(rows.map(\.id), rows.map(\.promptKey))
        XCTAssertEqual(Set(rows.map(\.id)).count, 2)
    }

    func testDecodeDefaultsAndTheRequiredKey() throws {
        let minimal = try JSONDecoder().decode(QuotaPromptDTO.self, from: Data(#"{"prompt_key":"q:1:0:2026-01-15"}"#.utf8))
        XCTAssertEqual(minimal.taskId, 0)
        XCTAssertEqual(minimal.target, 1)
        XCTAssertEqual(minimal.current, 0)
        XCTAssertFalse(minimal.considered)
        XCTAssertFalse(minimal.done)
        XCTAssertFalse(minimal.hasNotes)
        XCTAssertTrue(minimal.isWaiting)
        // No key, no prompt: it can't be acted on.
        XCTAssertThrowsError(try JSONDecoder().decode(QuotaPromptDTO.self, from: Data(#"{"task_id":1}"#.utf8)))
    }

    /// The widget re-encodes prompts into its App Group cache; the round
    /// trip must be lossless.
    func testCacheRoundTrip() throws {
        for p in try Fixtures.prompts() {
            let back = try JSONDecoder().decode(QuotaPromptDTO.self, from: JSONEncoder().encode(p))
            XCTAssertEqual(back, p)
        }
    }
}
