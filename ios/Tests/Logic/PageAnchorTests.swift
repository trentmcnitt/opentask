import XCTest

/// The page anchor (2026-10-14, `ios/Shared/PageAnchor.swift`): while the
/// user is tapping, the page on screen keeps its first row, so a handled
/// row's neighbours never slide back onto an earlier page.
///
/// The sample list is Trent's Morning period on 2026-10-14, by shape (sample
/// titles): budget 100, no gaps. Page 1 is A (60) + B (20); page 2 is C (60)
/// + D (20) = 80, and the two-line Clean (40) doesn't fit under them, so it
/// starts page 3 with Walks, MDX and Recruiter (20 each) — exactly 100.
/// Without Clean, Walks fits at the foot of page 2 (80 + 20), which is the
/// slide the anchor stops; without C, D fits at the foot of page 1.
final class PageAnchorTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let budget: CGFloat = 100

    private struct Row {
        let key: String
        let height: CGFloat
        var identity: String?
        var divider = false
    }

    private func morning() -> [Row] {
        [
            Row(key: "A", height: 60, identity: "task:1"),
            Row(key: "B", height: 20, identity: "task:2"),
            Row(key: "C", height: 60, identity: "task:3"),
            Row(key: "D", height: 20, identity: "task:4"),
            Row(key: "Clean", height: 40, identity: "task:5"),
            Row(key: "Walks", height: 20, identity: "task:6"),
            Row(key: "MDX", height: 20, identity: "task:7"),
            Row(key: "Recruiter", height: 20, identity: "task:8"),
        ]
    }

    private func paged(_ rows: [Row]) -> [PagedRow] {
        rows.map {
            PagedRow(keys: $0.divider ? [] : [$0.key], identities: $0.identity.map { [$0] } ?? [], staysWithNext: $0.divider)
        }
    }

    private func plain(_ rows: [Row]) -> (Range<Int>) -> [Range<Int>] {
        let heights = rows.map(\.height)
        return { range in
            ListPaging.pages(heights: heights, spacing: 0, budget: self.budget, in: range) { rows[$0].divider }
        }
    }

    private func layout(
        _ rows: [Row], storedPage: Int, anchor: PageAnchor?, pageKey: String = "reminders:3",
        lastTap: Date? = nil
    ) -> AnchoredPaging.Result {
        AnchoredPaging.layout(
            rows: paged(rows), pageKey: pageKey, storedPage: storedPage, anchor: anchor,
            lastTap: lastTap, now: now, plain: plain(rows)
        )
    }

    /// The keys on each page.
    private func pageKeys(_ result: AnchoredPaging.Result, _ rows: [Row]) -> [[String]] {
        result.pages.map { range in range.map { rows[$0].key } }
    }

    private func without(_ keys: String..., in rows: [Row]) -> [Row] {
        rows.filter { !keys.contains($0.key) }
    }

    /// Page 3 drawn at rest — the anchor every tap below starts from.
    private func restingAnchorOnPage3() throws -> PageAnchor {
        let rest = layout(morning(), storedPage: 2, anchor: nil)
        XCTAssertEqual(rest.page, 2)
        let anchor = try XCTUnwrap(rest.anchor)
        XCTAssertEqual(anchor.firstKey, "Clean")
        XCTAssertEqual(anchor.page, 2)
        XCTAssertEqual(anchor.pageStarts, ["A", "C", "Clean"])
        return anchor
    }

    // MARK: - Plain paging is unchanged

    func testPlainPartitionWithNoAnchor() {
        let rows = morning()
        let result = layout(rows, storedPage: 1, anchor: nil)
        XCTAssertEqual(pageKeys(result, rows), [["A", "B"], ["C", "D"], ["Clean", "Walks", "MDX", "Recruiter"]])
        XCTAssertEqual(result.page, 1)
        XCTAssertEqual(result.anchor?.firstKey, "C", "a resting draw anchors the page it shows")
        XCTAssertEqual(result.anchor?.pageStarts, ["A", "C"])
        XCTAssertEqual(result.anchor?.keys, rows.map(\.key))
        // The stored page is clamped to the list.
        XCTAssertEqual(layout(rows, storedPage: 9, anchor: nil).page, 2)
        // An empty list is one empty page and no anchor.
        let empty = layout([], storedPage: 2, anchor: nil)
        XCTAssertEqual(empty.pages, [0..<0])
        XCTAssertEqual(empty.page, 0)
        XCTAssertNil(empty.anchor)
    }

    func testListPagingMatchesTheGreedyRuleAndTheDividerRule() {
        // Greedy: the next row starts a new page only when it doesn't fit.
        XCTAssertEqual(
            ListPaging.pages(heights: [40, 40, 40, 40], spacing: 10, budget: 100) { _ in false },
            [0..<2, 2..<4]
        )
        // A page that would end on the divider, with rows still to come,
        // hands it to the next page.
        XCTAssertEqual(
            ListPaging.pages(heights: [45, 45, 10, 40], spacing: 0, budget: 100) { $0 == 2 },
            [0..<2, 2..<4]
        )
        // A row taller than the budget gets a page of its own.
        XCTAssertEqual(ListPaging.pages(heights: [150, 20], spacing: 0, budget: 100) { _ in false }, [0..<1, 1..<2])
        XCTAssertEqual(ListPaging.pages(heights: [], spacing: 0, budget: 100) { _ in false }, [0..<0])
        // A sub-range is paged on its own.
        XCTAssertEqual(
            ListPaging.pages(heights: [60, 30, 60, 20, 40], spacing: 0, budget: 100, in: 2..<5) { _ in false },
            [2..<4, 4..<5]
        )
    }

    // MARK: - The Trent scenario

    func testHandlingTheTwoLineRowAtTheTopOfTheLastPageKeepsItsNeighbourOnThatPage() throws {
        let anchor = try restingAnchorOnPage3()
        let after = without("Clean", in: morning())

        // What plain paging did: Walks slid back to page 2.
        XCTAssertEqual(pageKeys(layout(after, storedPage: 2, anchor: nil), after)[1], ["C", "D", "Walks"])

        let result = layout(after, storedPage: 2, anchor: anchor, lastTap: now.addingTimeInterval(-1))
        XCTAssertEqual(pageKeys(result, after), [["A", "B"], ["C", "D"], ["Walks", "MDX", "Recruiter"]])
        XCTAssertEqual(result.page, 2, "still page 3 of 3")
        XCTAssertEqual(result.anchor, anchor, "the anchor keeps the list as it was when the user started")
    }

    func testRowsKeepResolvingAgainstTheAnchoredOrderAcrossARunOfTaps() throws {
        let anchor = try restingAnchorOnPage3()
        let tap = now.addingTimeInterval(-1)
        let afterTwo = without("Clean", "Walks", in: morning())
        let result = layout(afterTwo, storedPage: 2, anchor: anchor, lastTap: tap)
        XCTAssertEqual(pageKeys(result, afterTwo), [["A", "B"], ["C", "D"], ["MDX", "Recruiter"]])
        XCTAssertEqual(result.page, 2)
    }

    func testALaterRowHandledLeavesTheAnchorRowFirst() throws {
        let anchor = try restingAnchorOnPage3()
        let after = without("MDX", in: morning())
        let result = layout(after, storedPage: 2, anchor: anchor, lastTap: now.addingTimeInterval(-1))
        XCTAssertEqual(pageKeys(result, after), [["A", "B"], ["C", "D"], ["Clean", "Walks", "Recruiter"]])
        XCTAssertEqual(result.page, 2)
    }

    func testRowsFromTheNextPageMoveUpIntoTheAnchoredPage() throws {
        // A fourth page under the last one: X (20) didn't fit page 3 (100).
        var rows = morning()
        rows.append(Row(key: "X", height: 20, identity: "task:9"))
        let anchor = try XCTUnwrap(layout(rows, storedPage: 2, anchor: nil).anchor)
        XCTAssertEqual(anchor.firstKey, "Clean")
        let after = without("Clean", in: rows)
        let result = layout(after, storedPage: 2, anchor: anchor, lastTap: now.addingTimeInterval(-1))
        XCTAssertEqual(pageKeys(result, after), [["A", "B"], ["C", "D"], ["Walks", "MDX", "Recruiter", "X"]])
        XCTAssertEqual(result.page, 2)
    }

    func testEverythingFromTheAnchorOnHandledShowsTheLastPage() throws {
        let anchor = try restingAnchorOnPage3()
        let after = without("Clean", "Walks", "MDX", "Recruiter", in: morning())
        let result = layout(after, storedPage: 2, anchor: anchor, lastTap: now.addingTimeInterval(-1))
        XCTAssertEqual(pageKeys(result, after), [["A", "B"], ["C", "D"]])
        XCTAssertEqual(result.page, 1)
    }

    func testHandledRowMovingToDoneIsNotANewItem() throws {
        // "Show completed" on: handling Clean moves it under a DONE divider —
        // a new ROW, the same ITEM. The anchor holds.
        let anchor = try restingAnchorOnPage3()
        var after = without("Clean", in: morning())
        after.append(Row(key: "divider", height: 10, identity: nil, divider: true))
        after.append(Row(key: "done-Clean", height: 20, identity: "task:5"))
        let result = layout(after, storedPage: 2, anchor: anchor, lastTap: now.addingTimeInterval(-1))
        XCTAssertEqual(result.pages[1].map { after[$0].key }, ["C", "D"])
        XCTAssertEqual(result.pages[2].first.map { after[$0].key }, "Walks")
        XCTAssertEqual(result.page, 2)
    }

    func testAnAnchorOnTheFirstDoneRowTakesTheDividerAlong() {
        let rows = [
            Row(key: "A", height: 60, identity: "task:1"),
            Row(key: "divider", height: 10, identity: nil, divider: true),
            Row(key: "done-B", height: 60, identity: "task:2"),
        ]
        let anchor = PageAnchor(
            pageKey: "reminders:3", firstKey: "done-B", pageStarts: ["A", "done-B"], keys: ["A", "done-B"],
            identities: ["task:1", "task:2"], page: 1
        )
        let result = layout(rows, storedPage: 1, anchor: anchor, lastTap: now)
        XCTAssertEqual(pageKeys(result, rows), [["A"], ["divider", "done-B"]])
        XCTAssertEqual(result.page, 1)
    }

    // MARK: - Paging with an anchor

    func testPagingLeftAfterTheTapShowsTheOldPageAndBackShowsTheAnchoredPage() throws {
        let anchor = try restingAnchorOnPage3()
        let after = without("Clean", in: morning())
        let tap = now.addingTimeInterval(-1)
        let held = layout(after, storedPage: 2, anchor: anchor, lastTap: tap)
        XCTAssertEqual(held.page, 2)

        // ‹ : page 2 exactly as it was, ending just above where Clean was.
        let left = layout(after, storedPage: 1, anchor: held.anchor, lastTap: tap)
        XCTAssertEqual(left.page, 1)
        XCTAssertEqual(left.pages[1].map { after[$0].key }, ["C", "D"])
        XCTAssertEqual(left.anchor, held.anchor, "paging never re-anchors")

        // › again: page 3 still starts at Daily Walks.
        let back = layout(after, storedPage: 2, anchor: left.anchor, lastTap: tap)
        XCTAssertEqual(back.page, 2)
        XCTAssertEqual(back.pages[2].map { after[$0].key }, ["Walks", "MDX", "Recruiter"])
        XCTAssertEqual(back.anchor, held.anchor)
    }

    func testHandlingARowOnAnEarlierPageKeepsEveryBoundary() throws {
        let anchor = try restingAnchorOnPage3()
        let tap = now.addingTimeInterval(-1)
        // Clean handled on page 3, then ‹ to page 2 and C (its first row)
        // handled there.
        let afterC = without("Clean", "C", in: morning())

        // What plain paging would do: D slides onto page 1, Walks onto page 2.
        XCTAssertEqual(pageKeys(layout(afterC, storedPage: 1, anchor: nil), afterC)[0], ["A", "B", "D"])

        let result = layout(afterC, storedPage: 1, anchor: anchor.withPage(2), lastTap: tap)
        XCTAssertEqual(pageKeys(result, afterC), [["A", "B"], ["D"], ["Walks", "MDX", "Recruiter"]])
        XCTAssertEqual(result.page, 1, "still on page 2, its rows moved up within it")
        XCTAssertEqual(result.anchor?.firstKey, "Clean", "page 3 still starts at its anchor")

        // A later row on page 2 handled instead: page 2 keeps C first.
        let afterD = without("Clean", "D", in: morning())
        let other = layout(afterD, storedPage: 1, anchor: anchor, lastTap: tap)
        XCTAssertEqual(pageKeys(other, afterD), [["A", "B"], ["C"], ["Walks", "MDX", "Recruiter"]])
    }

    func testAnEmptiedEarlierPageDisappears() throws {
        let anchor = try restingAnchorOnPage3()
        let after = without("C", "D", in: morning())
        let result = layout(after, storedPage: 2, anchor: anchor, lastTap: now)
        XCTAssertEqual(pageKeys(result, after), [["A", "B"], ["Clean", "Walks", "MDX", "Recruiter"]])
        XCTAssertEqual(result.page, 1, "the anchored page, now 2 of 2")
    }

    func testPagingRightKeepsTheAnchor() throws {
        let rows = morning()
        let rest = layout(rows, storedPage: 1, anchor: nil)
        XCTAssertEqual(rest.anchor?.firstKey, "C")
        let right = layout(rows, storedPage: 2, anchor: rest.anchor, lastTap: now.addingTimeInterval(-1))
        XCTAssertEqual(right.page, 2)
        XCTAssertEqual(right.anchor, rest.anchor, "paging never re-anchors")
        XCTAssertEqual(pageKeys(right, rows), [["A", "B"], ["C", "D"], ["Clean", "Walks", "MDX", "Recruiter"]])
        // Paging past the end clamps to the last page.
        let past = layout(rows, storedPage: 5, anchor: right.anchor, lastTap: now)
        XCTAssertEqual(past.page, 2)
        XCTAssertEqual(past.anchor?.firstKey, "C")
    }

    func testFewerPagesBeforeTheAnchorMoveTheIndexNotThePage() throws {
        // A and B handled elsewhere (say, on the web) while page 3 is held:
        // the anchored page is still the anchored page, now page 2 of 2.
        let anchor = try restingAnchorOnPage3()
        let after = without("A", "B", "Clean", in: morning())
        let result = layout(after, storedPage: 2, anchor: anchor, lastTap: now.addingTimeInterval(-1))
        XCTAssertEqual(pageKeys(result, after), [["C", "D"], ["Walks", "MDX", "Recruiter"]])
        XCTAssertEqual(result.page, 1)
        XCTAssertEqual(result.anchor?.page, 1, "so the stored page (written back as 1) still means 'not paged'")
        let next = layout(after, storedPage: 1, anchor: result.anchor, lastTap: now)
        XCTAssertEqual(next.page, 1)
        XCTAssertEqual(next.anchor?.firstKey, "Clean")
    }

    // MARK: - Lapse rules

    func testLapsesOnAPageKeyChange() throws {
        let anchor = try restingAnchorOnPage3()
        let after = without("Clean", in: morning())
        let result = layout(after, storedPage: 0, anchor: anchor, pageKey: "reminders:4", lastTap: now)
        XCTAssertEqual(pageKeys(result, after)[1], ["C", "D", "Walks"], "plain paging")
        XCTAssertEqual(result.anchor?.pageKey, "reminders:4")
        XCTAssertEqual(result.anchor?.firstKey, "A")
    }

    func testLapsesWhenANewItemAppears() throws {
        let anchor = try restingAnchorOnPage3()
        var after = without("Clean", in: morning())
        after.append(Row(key: "New", height: 20, identity: "task:99"))
        let result = layout(after, storedPage: 2, anchor: anchor, lastTap: now)
        XCTAssertEqual(pageKeys(result, after), [["A", "B"], ["C", "D", "Walks"], ["MDX", "Recruiter", "New"]])
        XCTAssertEqual(result.anchor?.identities.contains("task:99"), true, "re-anchored on the new list")
        XCTAssertEqual(result.anchor?.firstKey, "MDX")
        // A new quota prompt is a new item too.
        var withPrompt = without("Clean", in: morning())
        withPrompt.append(Row(key: "prompt-q:5:1", height: 20, identity: "prompt:q:5:1"))
        XCTAssertFalse(
            AnchoredPaging.isLive(anchor, pageKey: "reminders:3", rows: paged(withPrompt), lastTap: now, now: now)
        )
    }

    func testLapsesAfterSixtySecondsWithoutATap() throws {
        let anchor = try restingAnchorOnPage3()
        let after = without("Clean", in: morning())
        let rows = paged(after)
        XCTAssertEqual(PageAnchor.idleLapse, 60)
        XCTAssertTrue(
            AnchoredPaging.isLive(anchor, pageKey: "reminders:3", rows: rows, lastTap: now.addingTimeInterval(-59), now: now)
        )
        XCTAssertFalse(
            AnchoredPaging.isLive(anchor, pageKey: "reminders:3", rows: rows, lastTap: now.addingTimeInterval(-60), now: now)
        )
        XCTAssertFalse(AnchoredPaging.isLive(anchor, pageKey: "reminders:3", rows: rows, lastTap: nil, now: now))

        let idle = layout(after, storedPage: 2, anchor: anchor, lastTap: now.addingTimeInterval(-61))
        XCTAssertEqual(pageKeys(idle, after), [["A", "B"], ["C", "D", "Walks"], ["MDX", "Recruiter"]])
        XCTAssertEqual(idle.page, 2)
        XCTAssertEqual(idle.anchor?.firstKey, "MDX", "re-anchored on the page now drawn")
    }

    // MARK: - Quotas lines: anchored by chip

    func testAChipRowIsAnchoredByItsChipsAcrossAReWrap() {
        // Page 2 began with the line holding chips 7 and 8. Chip 7 is met and
        // hidden; chip 8 now heads a re-wrapped line with chip 9 pulled up.
        let anchor = PageAnchor(
            pageKey: "quotas", firstKey: "q:7", pageStarts: ["h:week", "q:7"], keys: ["h:week", "t:week:", "q:5", "q:6", "q:7", "q:8", "q:9"],
            identities: ["q:5", "q:6", "q:7", "q:8", "q:9"], page: 1
        )
        let rows = [
            PagedRow(keys: ["h:week"], identities: []),
            PagedRow(keys: ["t:week:"], identities: [], staysWithNext: true),
            PagedRow(keys: ["q:5", "q:6"], identities: ["q:5", "q:6"]),
            PagedRow(keys: ["q:8", "q:9"], identities: ["q:8", "q:9"]),
        ]
        XCTAssertEqual(AnchoredPaging.anchoredStart(anchor, rows: rows), 3)
        // A cluster title right before the anchor goes with it.
        let titled = [
            PagedRow(keys: ["h:week"], identities: []),
            PagedRow(keys: ["t:week:a"], identities: [], staysWithNext: true),
            PagedRow(keys: ["q:8", "q:9"], identities: ["q:8", "q:9"]),
        ]
        XCTAssertEqual(AnchoredPaging.anchoredStart(anchor, rows: titled), 1)
    }
}

/// The anchor's storage and the tap stamp its idle lapse reads.
final class PageAnchorStoreTests: WidgetStoreTestCase {
    func testEveryKindOfTapStampsTheLastTapAndNothingClearsIt() {
        XCTAssertNil(WidgetStore.lastWidgetTap())
        let t1 = Date(timeIntervalSince1970: 1_800_000_000)
        WidgetStore.markInteraction(now: t1)
        XCTAssertEqual(WidgetStore.lastWidgetTap(), t1)
        let t2 = t1.addingTimeInterval(5)
        WidgetStore.stagePendingCompletion(42, now: t2)
        XCTAssertEqual(WidgetStore.lastWidgetTap(), t2)
        let t3 = t2.addingTimeInterval(5)
        WidgetStore.stagePendingPromptAction("q:1:0:2026-10-14", did: false, now: t3)
        XCTAssertEqual(WidgetStore.lastWidgetTap(), t3)
        let t4 = t3.addingTimeInterval(5)
        WidgetStore.stagePendingSegmentConsider(7, now: t4)
        XCTAssertEqual(WidgetStore.lastWidgetTap(), t4)
        // Undo/snooze declare the cache stale; they are still taps.
        WidgetStore.clearInteraction(now: t4.addingTimeInterval(1))
        XCTAssertEqual(WidgetStore.lastWidgetTap(), t4)
        WidgetStore.clearPendingCompletion(42)
        XCTAssertEqual(WidgetStore.lastWidgetTap(), t4)
    }

    func testAnchoredPagesRecordsOnlyWhenAllowed() {
        let rows = [
            PagedRow(keys: ["A"], identities: ["task:1"]),
            PagedRow(keys: ["B"], identities: ["task:2"]),
        ]
        let plain: (Range<Int>) -> [Range<Int>] = { range in
            ListPaging.pages(heights: [60, 60], spacing: 0, budget: 100, in: range) { _ in false }
        }
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let skipped = WidgetStore.anchoredPages(
            list: .reminders, pageKey: "reminders:3", rows: rows, storedPage: 1, records: false, now: now, plain: plain
        )
        XCTAssertEqual(skipped.page, 1)
        XCTAssertNil(WidgetStore.pageAnchor(for: .reminders), "a future entry or a medium card writes nothing")

        let recorded = WidgetStore.anchoredPages(
            list: .reminders, pageKey: "reminders:3", rows: rows, storedPage: 1, records: true, now: now, plain: plain
        )
        XCTAssertEqual(WidgetStore.pageAnchor(for: .reminders), recorded.anchor)
        XCTAssertEqual(WidgetStore.pageAnchor(for: .reminders)?.firstKey, "B")
        XCTAssertNil(WidgetStore.pageAnchor(for: .tasks), "one anchor per list")

        // A tap, then B handled: the anchored page stays page 2 (B's
        // successor is gone too, so it shows the last page).
        WidgetStore.markInteraction(now: now)
        let after = WidgetStore.anchoredPages(
            list: .reminders, pageKey: "reminders:3", rows: [rows[0]], storedPage: 1, records: true,
            now: now.addingTimeInterval(2), plain: { range in
                ListPaging.pages(heights: [60], spacing: 0, budget: 100, in: range) { _ in false }
            }
        )
        XCTAssertEqual(after.page, 0)
        XCTAssertEqual(WidgetStore.pageAnchor(for: .reminders)?.page, 0)

        WidgetStore.setPageAnchor(nil, for: .reminders)
        XCTAssertNil(WidgetStore.pageAnchor(for: .reminders))
    }
}

extension PageAnchor {
    /// The same anchor as last drawn on another page index.
    fileprivate func withPage(_ page: Int) -> PageAnchor {
        PageAnchor(
            pageKey: pageKey, firstKey: firstKey, pageStarts: pageStarts, keys: keys,
            identities: identities, page: page
        )
    }
}
