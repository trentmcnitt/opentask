import XCTest

/// The Reminders widget strip's proportional segment widths (`SegmentWidths`).
final class SegmentWidthsTests: XCTestCase {

    private func assertWidths(_ actual: [Double], _ expected: [Double], file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(actual.count, expected.count, file: file, line: line)
        for (a, e) in zip(actual, expected) {
            XCTAssertEqual(a, e, accuracy: 0.0001, file: file, line: line)
        }
    }

    func testProportionalWhenNothingHitsTheFloor() {
        assertWidths(SegmentWidths.widths(weights: [1, 3], available: 400, minimum: 36), [100, 300])
    }

    func testSmallSegmentsHoldTheFloorAndTheRestShareBySize() {
        // Trent's day: 2 vs 8 vs 17. 2 would get 27 of 270 — under 36 — so it
        // is frozen at 36 and 8:17 share the other 234.
        let widths = SegmentWidths.widths(weights: [2, 8, 17], available: 270, minimum: 36)
        assertWidths(widths, [36, 234 * 8 / 25, 234 * 17 / 25])
        XCTAssertEqual(widths.reduce(0, +), 270, accuracy: 0.0001)
    }

    func testFreezingOneCanPushAnotherUnderTheFloor() {
        // 1 freezes first; then 4 of the remaining 64 × 4/17 ≈ 15 is under 36 too.
        let widths = SegmentWidths.widths(weights: [1, 4, 13], available: 136, minimum: 36)
        assertWidths(widths, [36, 36, 64])
    }

    func testEqualWhenTheFloorsDoNotFit() {
        assertWidths(SegmentWidths.widths(weights: [1, 50, 2], available: 90, minimum: 36), [30, 30, 30])
    }

    func testEmptyAndZeroSpace() {
        XCTAssertEqual(SegmentWidths.widths(weights: [], available: 100, minimum: 36), [])
        XCTAssertEqual(SegmentWidths.widths(weights: [1, 2], available: 0, minimum: 36), [0, 0])
    }
}
