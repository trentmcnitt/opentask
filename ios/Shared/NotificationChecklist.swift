import Foundation

/// THE NOTIFICATION CHECKLIST — one list model for every long-press
/// (2026-11-21, Trent: "consistent visually and on the code side").
///
/// A notification's expanded view lists what is waiting — a task push its
/// overdue tasks (`OverdueChecklist`), a period push its period's reminders
/// and quota prompts (`PeriodChecklist`) — and its action buttons act on the
/// rows marked here. This file is the part they share; each kind brings its
/// rows, its order and its actions. Foundation-only, pinned by
/// `NotificationChecklistTests`.
///
/// The rules (ids used by the tests, the PRs and the docs):
///
/// - NCL-1 ONE COMPONENT: one state (`ChecklistState`), one set of words
///   (`NotificationWords`), one look (`ChecklistChrome` in the content
///   extension). Row kinds: a task or reminder row has a circle; a quota
///   prompt row has a circle (consider) and a square (did), one choice per
///   row (`ChecklistMark`).
/// - NCL-2 PAGES: at most `pageSize` (6) rows on a page; "Show less" at the
///   left and "Show more" at the right under the list — the first page only
///   Show more, the last only Show less, a middle page both, a single page
///   neither; Show less goes back one page. Marks survive paging, and the
///   header counts every page ("2 of 20 checked"). A page is padded to the
///   page size with one-line spacers while there is more than one page, so
///   the links stay put (a reminder title that wraps still makes its page
///   taller: reminders are never truncated).
/// - NCL-3 HELD ROW: a push about one item shows it first, marked, a step
///   stronger in tint; a period push has none and starts with nothing marked.
/// - NCL-4 ONE REQUEST: each action covers every marked row, on any page, in
///   one request and one undo entry, and titles end in "(N)" from two up.
///   Nothing marked: the acting rows are absent (iOS can't disable an action
///   button).
/// - NCL-5 RE-CHECK: right before sending, the list is fetched again and only
///   rows still waiting are sent; nothing left → the list reloads and the
///   view stays open.
/// - NCL-6 CANCEL: always the last row. Closes the view and removes that
///   banner; nothing is sent.
/// - NCL-7 AFTER A SUCCESS the view closes (Trent, 2026-11-21: "completing
///   them should close them, but only because now we have a way to select
///   the rest"). The banners of the items acted on go; a period banner goes
///   when its period is left empty and otherwise stays — with its old count,
///   accepted: a delivered banner's words can't be edited, and the next push
///   for the period (same collapse id) replaces it.
/// - NCL-8 (with the reminder push, later): rows from more than one period
///   each carry a small grey period label, grouped in period order.
enum NotificationChecklist {
    /// NCL-2 (Trent, 2026-11-21: 6, "so we're not pushing it too far"; the
    /// phone scrolls the whole expanded notification, so it never clips).
    static let pageSize = 6
}

/// What a row is marked with: the circle (a task or reminder selected, a
/// prompt considered) or the square (a prompt done).
enum ChecklistMark: Hashable {
    case check
    case did
}

enum ChecklistLoad: Equatable {
    /// Only what the payload drew so far.
    case loading
    case loaded
    /// The fetch failed; what is drawn still works.
    case failed
}

/// A row the checklist can hold: anything with a stable key.
protocol ChecklistItem: Hashable {
    var checklistKey: String { get }
}

/// The list on screen: rows, marks, the page, and whether it has loaded.
struct ChecklistState<Item: ChecklistItem>: Equatable {
    private(set) var rows: [Item]
    private(set) var marks: [String: ChecklistMark]
    private(set) var page = 0
    private(set) var load: ChecklistLoad
    /// The pushed item's key (NCL-3); nil for a push about a whole list.
    let heldKey: String?

    init(rows: [Item], marks: [String: ChecklistMark] = [:], load: ChecklistLoad, heldKey: String? = nil) {
        self.rows = rows
        self.marks = marks
        self.load = load
        self.heldKey = heldKey
    }

    // MARK: Rows

    /// The fetched list landed, in its kind's order. The held row goes
    /// first while listed and drops off once it isn't; marks stay on rows
    /// still listed.
    mutating func apply(fetched ordered: [Item]) {
        let held = heldKey.flatMap { key in ordered.first { $0.checklistKey == key } }
        rows = (held.map { [$0] } ?? []) + ordered.filter { $0.checklistKey != heldKey }
        let live = Set(rows.map(\.checklistKey))
        marks = marks.filter { live.contains($0.key) }
        load = .loaded
        page = min(page, max(pageCount - 1, 0))
    }

    mutating func fetchFailed() {
        if load == .loading { load = .failed }
    }

    /// Nothing waiting at all, once loaded.
    var isEmpty: Bool { load == .loaded && rows.isEmpty }

    // MARK: Pages (NCL-2)

    var pageCount: Int {
        rows.isEmpty ? 0 : (rows.count + NotificationChecklist.pageSize - 1) / NotificationChecklist.pageSize
    }

    var pageRows: [Item] {
        guard !rows.isEmpty else { return [] }
        let start = page * NotificationChecklist.pageSize
        return Array(rows[start ..< min(start + NotificationChecklist.pageSize, rows.count)])
    }

    /// One-line spacers that pad this page to the page size (only while
    /// there is more than one page).
    var pageSpacers: Int { pageCount > 1 ? NotificationChecklist.pageSize - pageRows.count : 0 }

    var showsLess: Bool { page > 0 }
    var showsMore: Bool { page < pageCount - 1 }

    mutating func showMore() { if showsMore { page += 1 } }
    mutating func showLess() { if showsLess { page -= 1 } }

    // MARK: Marks (NCL-1, NCL-4)

    func mark(of key: String) -> ChecklistMark? { marks[key] }

    /// The circle: on, or off again.
    mutating func toggle(_ key: String) {
        choose(key, .check)
    }

    /// One choice per row: the same mark again clears it, the other switches.
    mutating func choose(_ key: String, _ mark: ChecklistMark) {
        guard rows.contains(where: { $0.checklistKey == key }) else { return }
        marks[key] = marks[key] == mark ? nil : mark
    }

    /// Every marked row, in list order, on any page.
    var marked: [(item: Item, mark: ChecklistMark)] {
        rows.compactMap { item in marks[item.checklistKey].map { (item, $0) } }
    }

    var markedCount: Int { marks.count }

    /// "2 of 20 checked"; "20 <noun>" with nothing marked; before the list
    /// has loaded, "1 checked" or nothing.
    func headerCount(noun: String) -> String? {
        guard load == .loaded else { return marks.isEmpty ? nil : "\(marks.count) checked" }
        if rows.isEmpty { return nil }
        if marks.isEmpty { return "\(rows.count) \(noun)" }
        return "\(marks.count) of \(rows.count) checked"
    }
}

/// Every word a notification's buttons say, in one place (2026-11-21,
/// Trent's ruling: imperative — "Consider (N)" and "Did (N)" on every
/// notification). Change a word here and every surface follows.
enum NotificationWords {
    /// A task is done.
    static let done = "Done"
    /// A reminder or a quota prompt is considered for today.
    static let consider = "Consider"
    /// A quota prompt was done (+1).
    static let did = "Did"
    /// A mixed set — some rows considered, some done — in one request. The
    /// word is provisional until Trent names it.
    static let log = "Log"
    /// The period push's whole-period button: every reminder considered for
    /// today, every waiting prompt considered (the app's "Consider all").
    static let considerAll = "Consider all"
    /// NCL-6.
    static let cancel = "Cancel"

    /// "Done (3)" from two up; a single one plain.
    static func counted(_ title: String, _ count: Int) -> String {
        count > 1 ? "\(title) (\(count))" : title
    }

    /// The commit button for a set of reminder/prompt marks: "Consider" when
    /// every mark is the circle, "Did" when every one is the square, "Log"
    /// for a mix; nil with nothing marked.
    static func commitVerb(_ marks: [ChecklistMark]) -> String? {
        guard let first = marks.first else { return nil }
        guard marks.allSatisfy({ $0 == first }) else { return log }
        return first == .check ? consider : did
    }
}
