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
/// The rules, each a `RULE NCL-n:` block at the code it governs (registered
/// in `src/lib/rule-registry.ts`, pinned by `NotificationChecklistTests` and
/// `NagChecklistTests`): NCL-1 one component (`ChecklistState`), NCL-2 pages
/// (`pageSize`), NCL-3 the held row (`apply(fetched:)`), NCL-4 one request
/// (`marked`), NCL-6 Cancel (`NotificationWords.cancel`); NCL-5 the re-check
/// and NCL-7 after a success in `PeriodChecklist`, NCL-8 period names in
/// `NagChecklist`.
enum NotificationChecklist {
    /// RULE NCL-2: PAGES. At most `pageSize` (6) rows on a page. Under the list,
    ///   "Previous" at the left, "Next" at the right and the page ("2 of 3")
    ///   centred between them: the first page shows Next only, the last
    ///   Previous only, a middle page both, a single page none of the three.
    ///   Marks survive paging, and the header counts every page ("2 of 20
    ///   checked"). A page is padded to the page size with one-line spacers
    ///   while there is more than one page. (Trent, 2026-11-25: "Show more /
    ///   Show less" was wrong for paging.)
    /// Why: the links stay put while paging; the phone scrolls the whole
    ///   expanded notification (measured 2026-11-21), so a page never clips.
    /// Ruling: Trent 2026-11-21: 6, "so we're not pushing it too far".
    static let pageSize = 6
}

/// What a row is marked with: the circle (a task or reminder selected, a
/// prompt considered) or the square (a prompt done).
enum ChecklistMark: String, Hashable, Codable {
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
///
/// RULE NCL-1: ONE COMPONENT. One state (`ChecklistState`), one set of words
///   (`NotificationWords`), one look (`ChecklistChrome` in the content
///   extension) for every notification checklist. Row kinds: a task or
///   reminder row has a circle; a quota prompt row has a circle (consider)
///   and a square (did), one choice per row (`ChecklistMark`).
/// Why: each kind of push brings only its rows, order and actions.
/// Ruling: Trent 2026-11-21: "consistent visually and on the code side".
struct ChecklistState<Item: ChecklistItem>: Equatable {
    private(set) var rows: [Item]
    private(set) var marks: [String: ChecklistMark]
    private(set) var page = 0
    private(set) var load: ChecklistLoad
    /// A page restored from `ChecklistMemory`, taken (and clamped) when the
    /// fetched list lands: before that only the payload's row is listed.
    private var restoredPage: Int?
    /// The pushed item's key (NCL-3); nil for a push about a whole list.
    let heldKey: String?

    init(rows: [Item], marks: [String: ChecklistMark] = [:], load: ChecklistLoad, heldKey: String? = nil) {
        self.rows = rows
        self.marks = marks
        self.load = load
        self.heldKey = heldKey
    }

    // MARK: Rows

    /// RULE NCL-3: HELD ROW. A push about one item shows it first, marked, a
    ///   step stronger in tint; a period push has none and starts with nothing
    ///   marked.
    /// Why: the push was about that item; a period push is about the whole
    ///   period.
    /// Ruling: none recorded (the design session, 2026-11-21).
    ///
    /// The fetched list landed, in its kind's order. The held row goes
    /// first while listed and drops off once it isn't; marks stay on rows
    /// still listed.
    mutating func apply(fetched ordered: [Item]) {
        let held = heldKey.flatMap { key in ordered.first { $0.checklistKey == key } }
        rows = (held.map { [$0] } ?? []) + ordered.filter { $0.checklistKey != heldKey }
        let live = Set(rows.map(\.checklistKey))
        marks = marks.filter { live.contains($0.key) }
        load = .loaded
        if let restoredPage {
            page = restoredPage
            self.restoredPage = nil
        }
        page = min(page, max(pageCount - 1, 0))
    }

    /// Put back what `ChecklistMemory` kept for this notification: its marks
    /// at once (any row the fetch no longer lists drops them), its page once
    /// the list has landed.
    mutating func restore(marks: [String: ChecklistMark], page: Int) {
        self.marks = marks
        if load == .loaded {
            self.page = min(max(page, 0), max(pageCount - 1, 0))
        } else {
            restoredPage = max(page, 0)
        }
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

    /// "2 of 3" between Previous and Next; nil on a single page.
    var pageLabel: String? { pageCount > 1 ? NotificationWords.page(page + 1, of: pageCount) : nil }

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

    /// RULE NCL-4: ONE REQUEST. Each action covers every marked row, on any
    ///   page, in one request and one undo entry, and titles end in "(N)" from
    ///   two up (`NotificationWords.counted`). Nothing marked: the acting rows
    ///   are absent.
    /// Why: one press is one action and one Undo; iOS can't disable a button.
    /// Ruling: none recorded (the design session, 2026-11-21).
    ///
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
    /// The pager under the list (NCL-2, Trent 2026-11-25).
    static let previous = "Previous"
    static let next = "Next"
    static func page(_ number: Int, of count: Int) -> String { "\(number) of \(count)" }
    /// RULE NCL-6: CANCEL. Always the last row. It closes the view and removes
    ///   that banner; nothing is sent.
    /// Why: a way out that also clears what was seen (as TNC-8).
    /// Ruling: none recorded (the design session, 2026-11-21).
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
