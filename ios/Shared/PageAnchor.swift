import Foundation

// MARK: - Page anchor (2026-10-14, "Daily Walks disappeared")
//
// The bug (Trent's iPhone, Reminders widget, systemLarge, Morning, page 3/3):
// page 3 showed Clean phone (a two-line title), Daily Walks, MDX battery
// toggle and Recruiter block. He tapped Clean phone's circle, and page 3 then
// showed only MDX and Recruiter. Nothing was wrong on the server: the list
// is paged greedily from the top (`ListPaging.pages`), Clean phone hadn't
// fitted at the foot of page 2, so it started page 3; once it was handled,
// the one-line Daily Walks DID fit at the foot of page 2 and slid back there.
// A row jumping to an earlier page under the user's finger reads as data loss.
//
// The rule (Trent approved: "as long as switching periods, new reminder/
// quota/task being added reflows it, and ideally something light like a
// phone lock/unlock, then im okay with it"):
//
// - While the user is actively tapping, the page on screen keeps its FIRST
//   ROW as an anchor. The page starts at the anchor row; if that row left the
//   list (handled, completed), it starts at the next surviving row that came
//   after it in the list as it was when the anchor was set. Rows below move
//   UP within the page (and the next page's rows fill in under them); nothing
//   ever slides back onto an earlier page. Pages before the anchor are filled
//   greedily from the top but END just before the anchor row, so the previous
//   page looks as it did (leftover space at its foot is accepted). The "n/N"
//   follows from that partition.
// - The anchor LAPSES — plain top-down paging again — when (a) the page key
//   changes (a Reminders period or task segment, a Tasks page: chevron, slot
//   jump, auto-advance, the clock crossing into a new slot), (b) an item
//   appears that wasn't in the list when the anchor was set (a new reminder,
//   quota prompt, task, quota), or (c) the list is drawn `idleLapse` (60 s)
//   after the last widget tap. Widgets get no lock/unlock signal; the idle
//   lapse is the agreed stand-in, and it is a plain timestamp comparison
//   (`WidgetStore.lastWidgetTap()`), no timer.
// - Paging (‹ ›) with a live anchor moves the anchor to the first row of the
//   page paged to, in the partition that was on screen, and the list is then
//   partitioned from that new anchor — so the page you land on is filled
//   greedily from its own first row and stays put while you work on it.
//
// Everything here is Foundation-only and pure; `WidgetStore.anchoredPages`
// does the one read and write of the stored anchor around it, and the list
// views (`RemindersListView`, `TaskSegmentListView`, `TasksListView`, the
// Quotas `TrackLargeView`) supply their rows and their own plain partition.

/// One row of a paged list, as the anchor sees it.
struct PagedRow: Equatable {
    /// Position keys: what an anchor names and resolves. Unique within a
    /// list and different for an item's open and done rows ("open-42" vs
    /// "done-42"), because handling a row moves it to the DONE section and
    /// the anchor must not follow it there. A Quotas chip row (several chips
    /// flowed onto one line) has one key per chip, so a re-wrap can't lose
    /// the anchor; a "DONE · N" divider has none.
    let keys: [String]
    /// The items this row shows, by STABLE identity — a task id, a quota
    /// prompt's `prompt_key` — the same for an item's open and done rows.
    /// Lapse rule (b) compares these: handling a row (open → done) is not a
    /// new item, a new reminder is.
    let identities: [String]
    /// The row must share a page with the row after it: the "DONE · N"
    /// divider, a Quotas cluster title. An anchor that lands right after one
    /// takes it along, so a page before the anchor never ends on it.
    var staysWithNext = false
}

/// The stored anchor of one list (one per widget kind).
struct PageAnchor: Codable, Equatable {
    /// Which page of the widget it was set on — a Reminders period or task
    /// segment, a Tasks page. A different key lapses it (rule a).
    let pageKey: String
    /// The key of the anchored page's first row.
    let firstKey: String
    /// Every row key, in list order, when the anchor was set — what "the next
    /// surviving row after it" is resolved against once `firstKey` is gone.
    let keys: [String]
    /// Every item identity when the anchor was set (rule b).
    let identities: [String]
    /// The anchored page's index the last time the list was drawn. The
    /// stored page index differing from it means the user paged (‹ ›) since.
    let page: Int

    /// Lapse rule (c): the list is drawn this long after the last widget
    /// tap — the stand-in for "the phone was locked and unlocked".
    static let idleLapse: TimeInterval = 60
}

/// The plain greedy partition — moved here from `WidgetTheme.pages` (which
/// still documents why it is greedy and the divider rule) so the anchored
/// layout and its tests can use it without SwiftUI.
enum ListPaging {
    /// Pages of `range` (default: the whole list): each page takes rows until
    /// the NEXT row genuinely doesn't fit `budget`, breaking only between
    /// whole rows. A page that would END on a divider, with rows still to
    /// come in `range`, hands the divider to the next page — unless the
    /// divider is the page's only row. A row taller than `budget` gets a page
    /// of its own. An empty list is one empty page.
    static func pages(
        heights: [CGFloat], spacing: CGFloat, budget: CGFloat,
        in range: Range<Int>? = nil, isDivider: (Int) -> Bool
    ) -> [Range<Int>] {
        let range = range ?? 0..<heights.count
        guard !range.isEmpty else { return [range] }
        var pages: [Range<Int>] = []
        var start = range.lowerBound
        while start < range.upperBound {
            var end = start
            var used: CGFloat = 0
            while end < range.upperBound {
                let needed = used + (end > start ? spacing : 0) + heights[end]
                if end > start, needed > budget { break }
                used = needed
                end += 1
            }
            if end - start > 1, end < range.upperBound, isDivider(end - 1) {
                end -= 1
            }
            pages.append(start..<end)
            start = end
        }
        return pages
    }
}

/// The anchored partition and the anchor bookkeeping around it.
enum AnchoredPaging {
    struct Result: Equatable {
        let pages: [Range<Int>]
        /// The page to draw — also what the list should store as its page
        /// index, so the pager's next ‹ › counts from what is on screen.
        let page: Int
        /// The anchor to store (nil only for an empty list).
        let anchor: PageAnchor?
    }

    /// Whether `anchor` still holds for this draw — every lapse rule, in
    /// order: same page key (a), drawn within `idleLapse` of the last widget
    /// tap (c), and no item that wasn't there when it was set (b).
    static func isLive(
        _ anchor: PageAnchor?, pageKey: String, rows: [PagedRow], lastTap: Date?, now: Date
    ) -> Bool {
        guard let anchor, anchor.pageKey == pageKey else { return false }
        guard let lastTap, now.timeIntervalSince(lastTap) < PageAnchor.idleLapse else { return false }
        let known = Set(anchor.identities)
        return rows.allSatisfy { row in row.identities.allSatisfy(known.contains) }
    }

    /// The row index the anchored page starts at: the row holding
    /// `firstKey`, else the row holding the first key that came AFTER it in
    /// the anchored list and is still here; `rows.count` when none survives
    /// (everything from the anchor on was handled — the list is then just
    /// paged from the top). Steps back over rows that stay with the next one
    /// (the DONE divider, a cluster title), so they head the anchored page.
    static func anchoredStart(_ anchor: PageAnchor, rows: [PagedRow]) -> Int {
        var rowOfKey: [String: Int] = [:]
        for (index, row) in rows.enumerated() {
            for key in row.keys where rowOfKey[key] == nil { rowOfKey[key] = index }
        }
        var start = rows.count
        if let from = anchor.keys.firstIndex(of: anchor.firstKey) {
            for key in anchor.keys[from...] {
                if let index = rowOfKey[key] {
                    start = index
                    break
                }
            }
        } else if let index = rowOfKey[anchor.firstKey] {
            start = index
        }
        while start > 0, start < rows.count, rows[start - 1].staysWithNext {
            start -= 1
        }
        return start
    }

    /// Pages before `start` filled greedily from the top and ending just
    /// before it, then pages filled greedily from `start` on.
    static func partition(
        count: Int, from start: Int, plain: (Range<Int>) -> [Range<Int>]
    ) -> [Range<Int>] {
        guard count > 0 else { return [0..<0] }
        let start = min(max(start, 0), count)
        var pages: [Range<Int>] = []
        if start > 0 { pages += plain(0..<start) }
        if start < count { pages += plain(start..<count) }
        return pages
    }

    /// The layout to draw.
    ///
    /// - Not live (no anchor, or it lapsed): the plain partition, the stored
    ///   page clamped to it, and a fresh anchor on that page's first row.
    /// - Live, not paged since (`storedPage == anchor.page`): the anchored
    ///   partition, showing the anchored page. The anchor keeps its original
    ///   row order and identities, so a run of taps keeps resolving against
    ///   the list as it was when the user started.
    /// - Live and paged (‹ › moved the stored page): the page that many steps
    ///   from the anchored page, in the anchored partition, becomes the new
    ///   anchor — and the list is re-partitioned from it.
    ///
    /// `plain` is the list's own greedy partition of a sub-range (the
    /// Reminders/Tasks `ListPaging.pages`, Quotas' `QuotaFlow` pages).
    static func layout(
        rows: [PagedRow], pageKey: String, storedPage: Int, anchor: PageAnchor?,
        lastTap: Date?, now: Date, plain: (Range<Int>) -> [Range<Int>]
    ) -> Result {
        guard !rows.isEmpty else { return Result(pages: [0..<0], page: 0, anchor: nil) }

        if let anchor, isLive(anchor, pageKey: pageKey, rows: rows, lastTap: lastTap, now: now) {
            let start = anchoredStart(anchor, rows: rows)
            var pages = partition(count: rows.count, from: start, plain: plain)
            let anchoredPage = pageIndex(startingAt: start, in: pages)
            if storedPage == anchor.page {
                return Result(pages: pages, page: anchoredPage, anchor: anchor.movedTo(page: anchoredPage))
            }
            // Paged: anchor the page the pager moved to, then partition from it.
            let target = clamp(anchoredPage + (storedPage - anchor.page), pages)
            let newStart = pages[target].lowerBound
            pages = partition(count: rows.count, from: newStart, plain: plain)
            let page = pageIndex(startingAt: newStart, in: pages)
            return Result(
                pages: pages, page: page,
                anchor: makeAnchor(rows: rows, pageKey: pageKey, pageStart: newStart, page: page)
            )
        }

        let pages = plain(0..<rows.count)
        let page = clamp(storedPage, pages)
        return Result(
            pages: pages, page: page,
            anchor: makeAnchor(rows: rows, pageKey: pageKey, pageStart: pages[page].lowerBound, page: page)
        )
    }

    // MARK: Helpers

    private static func clamp(_ page: Int, _ pages: [Range<Int>]) -> Int {
        min(max(page, 0), pages.count - 1)
    }

    /// The page beginning at `start`; the last page when `start` is past the
    /// end (nothing from the anchor on survived).
    private static func pageIndex(startingAt start: Int, in pages: [Range<Int>]) -> Int {
        pages.firstIndex { $0.lowerBound == start } ?? (pages.count - 1)
    }

    /// An anchor on the page that begins at row `pageStart`, named by the
    /// first key at or after it (a divider has no key of its own; the row it
    /// heads does, and resolving that row steps back over the divider).
    private static func makeAnchor(rows: [PagedRow], pageKey: String, pageStart: Int, page: Int) -> PageAnchor? {
        guard let firstKey = rows[pageStart...].lazy.compactMap(\.keys.first).first else { return nil }
        var identities: [String] = []
        var seen = Set<String>()
        for identity in rows.flatMap(\.identities) where seen.insert(identity).inserted {
            identities.append(identity)
        }
        return PageAnchor(
            pageKey: pageKey, firstKey: firstKey, keys: rows.flatMap(\.keys),
            identities: identities, page: page
        )
    }
}

extension PageAnchor {
    fileprivate func movedTo(page: Int) -> PageAnchor {
        PageAnchor(pageKey: pageKey, firstKey: firstKey, keys: keys, identities: identities, page: page)
    }
}
