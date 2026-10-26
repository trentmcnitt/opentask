import XCTest

/// The quota count as segments (2026-10-13): the words, the accessibility
/// label, the fills and the fit rule shared by every native surface — kept
/// in step with the web's `src/lib/quota-segments.ts`.
final class QuotaCountTests: XCTestCase {

    // MARK: Words

    func testPeriodWordIsTheShortForm() {
        XCTAssertEqual(
            ["DAILY", "WEEKLY", "MONTHLY", "YEARLY", nil, "HOURLY"].map { QuotaCount.word(period: $0) },
            ["today", "week", "month", "year", nil, nil]
        )
    }

    func testSpokenLabelUsesNaturalWords() {
        XCTAssertEqual(QuotaCount.spokenLabel(current: 1, target: 2, period: "DAILY"), "1 of 2 today")
        XCTAssertEqual(QuotaCount.spokenLabel(current: 1, target: 2, period: "WEEKLY"), "1 of 2 this week")
        XCTAssertEqual(QuotaCount.spokenLabel(current: 1, target: 2, period: "MONTHLY"), "1 of 2 this month")
        XCTAssertEqual(QuotaCount.spokenLabel(current: 0, target: 1, period: "YEARLY"), "0 of 1 this year")
        XCTAssertEqual(QuotaCount.spokenLabel(current: 1, target: 2, period: nil), "1 of 2")
        XCTAssertEqual(
            QuotaCount.spokenLabel(current: 1, target: 2, period: "WEEKLY", withPeriod: false), "1 of 2",
            "a chip under a period heading leaves the period out"
        )
    }

    func testTextForm() {
        XCTAssertEqual(QuotaCount.text(current: 3, target: 7, word: "today"), "3/7 today")
        XCTAssertEqual(QuotaCount.text(current: 3, target: 7, word: nil), "3/7")
    }

    func testPromptWordsFollowTheSegments() {
        let nbsp = "\u{00A0}"
        let weekly = prompt(current: 1, target: 2, period: "WEEKLY")
        XCTAssertEqual(weekly.countText, "1/2\(nbsp)week")
        XCTAssertEqual(weekly.spokenCount, "1 of 2 this week")
        XCTAssertEqual(prompt(current: 0, target: 1, period: "MONTHLY").spokenCount, "0 of 1 this month")
    }

    // MARK: Fills

    func testFillsPerCompletion() {
        XCTAssertEqual(QuotaCount.fills(current: 0, target: 2), [.empty, .empty])
        XCTAssertEqual(QuotaCount.fills(current: 1, target: 3), [.filled, .empty, .empty])
        XCTAssertEqual(QuotaCount.fills(current: 2, target: 2), [.met, .met], "met is all green")
        XCTAssertEqual(QuotaCount.fills(current: 3, target: 2), [.met, .met], "past the cap: still N, all green")
        XCTAssertEqual(QuotaCount.fills(current: 0, target: 1), [.empty], "a 1× quota is one segment")
        XCTAssertEqual(QuotaCount.fills(current: 0, target: 0), [.empty], "never fewer than one")
    }

    func testMet() {
        XCTAssertFalse(QuotaCount.isMet(current: 1, target: 2))
        XCTAssertTrue(QuotaCount.isMet(current: 2, target: 2))
        XCTAssertTrue(QuotaCount.isMet(current: 5, target: 2))
    }

    // MARK: The fit rule

    func testMoreThanSixIsAlwaysText() {
        XCTAssertEqual(QuotaCount.maxSegments, 6)
        XCTAssertEqual(QuotaCount.chooseForm(target: 6), .segments)
        XCTAssertEqual(QuotaCount.chooseForm(target: 7), .text)
        XCTAssertEqual(
            QuotaCount.chooseForm(target: 7, available: 1000, segmentsWidth: 10, textWidth: 10), .text,
            "room doesn't matter above six"
        )
        XCTAssertEqual(QuotaCount.chooseForm(target: 1), .segments)
    }

    func testFitFallsBackToTextOnlyWhenTextFits() {
        XCTAssertEqual(QuotaCount.chooseForm(target: 4, available: 50, segmentsWidth: 50, textWidth: 30), .segments)
        XCTAssertEqual(QuotaCount.chooseForm(target: 4, available: 49, segmentsWidth: 50, textWidth: 30), .text)
        XCTAssertEqual(
            QuotaCount.chooseForm(target: 4, available: 20, segmentsWidth: 50, textWidth: 30), .segments,
            "neither fits: segments, wrapped whole"
        )
    }

    // MARK: Geometry (S4)

    func testS4Geometry() {
        let g = QuotaCount.Geometry(em: 20)
        XCTAssertEqual(g.segmentWidth, 13, accuracy: 0.0001)
        XCTAssertEqual(g.segmentHeight, 9, accuracy: 0.0001)
        XCTAssertEqual(g.gap, 2.2, accuracy: 0.0001)
        XCTAssertEqual(g.border, 1)
        XCTAssertEqual(g.runWidth(0), 0)
        XCTAssertEqual(g.runWidth(2), 2 * 13 + 2.2 + g.skewOffset, accuracy: 0.0001)
    }

    /// The width the pager measures is the width of the images drawn: whole
    /// pixels, the same however the run is split into filled and empty.
    func testBoxesWidthIsTheDrawnImagesWidth() {
        let scale: CGFloat = 3
        for current in 0...3 {
            let width = QuotaSegmentsDrawing.boxesWidth(
                current: current, target: 3, hasWord: true, em: 15, lead: 5, scale: scale
            )
            XCTAssertEqual((width * scale).rounded(), width * scale, accuracy: 0.0001)
            let g = QuotaCount.Geometry(em: 15)
            let exact = g.leadingPad + 5 + g.runWidth(3) + g.wordGap
            XCTAssertGreaterThanOrEqual(width, exact - 0.0001)
            XCTAssertLessThan(width, exact + 2 / scale, "at most a pixel per image over the exact width")
        }
    }

    /// The pager's measuring box counts its whole width (2026-10-26, the
    /// docs' "Deep work block, no meetings ▰▰▱▱▱ wee…"): an image-less
    /// attachment measured as 1pt on macOS, so a prompt row's boxes counted
    /// as nothing and the row was sized one line short. Runs on macOS — where
    /// it broke.
    func testMeasuringBoxCountsItsWidth() {
        #if canImport(AppKit)
        let font = NSFont.systemFont(ofSize: 15)
        #else
        let font = UIFont.systemFont(ofSize: 15)
        #endif
        let options: NSString.DrawingOptions = [.usesLineFragmentOrigin, .usesFontLeading]
        let text = NSMutableAttributedString(string: "Deep work block ", attributes: [.font: font])
        let plain = text.boundingRect(with: CGSize(width: 10_000, height: 1_000), options: options, context: nil)
        text.append(NSAttributedString(attachment: MeasuringBox.attachment(width: 60)))
        text.addAttribute(.font, value: font, range: NSRange(location: text.length - 1, length: 1))
        let boxed = text.boundingRect(with: CGSize(width: 10_000, height: 1_000), options: options, context: nil)
        XCTAssertEqual(boxed.width - plain.width, 60, accuracy: 1)
        XCTAssertEqual(boxed.height, plain.height, accuracy: 0.5, "1pt tall: no taller line")
        // Too wide for one line once the box counts: two lines.
        let narrow = text.boundingRect(
            with: CGSize(width: plain.width + 30, height: 1_000), options: options, context: nil
        )
        XCTAssertEqual(narrow.height / plain.height, 2, accuracy: 0.1)
    }

    private func prompt(current: Int, target: Int, period: String?) -> QuotaPromptDTO {
        QuotaPromptDTO(
            promptKey: "k", taskId: 1, title: "Read", current: current, target: target, period: period,
            hasNotes: false
        )
    }
}
