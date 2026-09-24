import SwiftUI
import WidgetKit

/// The Tasks widget's rendering, across all five supported families.
///
/// One row shape only: a dot to check off, a title, a due time. Tracked items
/// (§5, `progress_target > 1`) used to render here as quota rows and no longer
/// do — §8 as amended 2026-07-27 gave them their own widget, because a
/// double-height row answering "how far in" buried the ordinary rows answering
/// "what's left".
struct TasksWidgetView: View {
    @Environment(\.widgetFamily) private var family

    let entry: TasksEntry

    var body: some View {
        content
            .containerBackground(for: .widget) {
                switch family {
                case .systemSmall, .systemMedium, .systemLarge:
                    Rectangle().fill(.fill.tertiary)
                default:
                    Color.clear
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch family {
        #if os(iOS)
        case .accessoryCircular:
            TasksCircularView(entry: entry)
        case .accessoryRectangular:
            TasksRectangularView(entry: entry)
        #endif
        case .systemSmall:
            TasksSmallView(entry: entry)
        case .systemMedium:
            TasksListView(entry: entry, maxRows: 3, isLarge: false)
                .backgroundTapOpens(WidgetLink.dashboard)
        default:
            // 6 was tuned against the OLD flat per-row cost (2 lines always
            // reserved). Both platforms now size rows to their real content
            // (see WidgetTheme's "row-height truthing" note — macOS since
            // 2026-09-22, iOS since 2026-09-23), so 6 stops being "as many
            // as fit" well before the card is full on either one. Raised to
            // 10 on both — `listContent`'s candidate list matches.
            TasksListView(entry: entry, maxRows: 10, isLarge: true)
                .backgroundTapOpens(WidgetLink.dashboard)
        }
    }
}

// MARK: - systemSmall

/// The 2×2: glanceable only, by design.
///
/// The overdue count is the number worth a 2×2 (§4.5 — the stale-first burial
/// is what makes "how many are late" the honest headline), then the next thing
/// due and when. No check-off circle and no pager: at ~126pt across those
/// targets would be cramped enough to complete the wrong task, so the whole
/// card is one tap into the dashboard instead.
private struct TasksSmallView: View {
    let entry: TasksEntry

    var body: some View {
        if entry.isSignedOut {
            WidgetSignedOutView(compact: true)
        } else {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    if !entry.isUnifiedScope {
                        Circle()
                            .fill(entry.scopeColor)
                            .frame(width: 6, height: 6)
                    }
                    Text(entry.scopeLabel)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }

                if let next = entry.tasks.first {
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text("\(entry.overdueCount(now: entry.date))")
                            .font(.system(size: 40, weight: .semibold, design: .rounded))
                            .monospacedDigit()
                            .minimumScaleFactor(0.6)
                            .lineLimit(1)
                        Text("overdue")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    Text(next.title)
                        .font(.caption2)
                        .fontWeight(WidgetTheme.priorityWeight(next.priority))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .minimumScaleFactor(0.85)

                    if next.dueDate != nil {
                        // Day-naming (2026-09-23) — see `WidgetTheme.
                        // dueLabelText`'s doc; "anywhere a task time shows"
                        // includes this 2×2's "next up" line.
                        WidgetTheme.dueLabelText(for: next, now: entry.date)
                            .font(.caption2)
                            .monospacedDigit()
                    }
                    Spacer(minLength: 0)
                } else {
                    Spacer(minLength: 0)
                    WidgetEmptyView(
                        symbol: "checkmark.circle", message: "Nothing due today", compact: true
                    )
                    Spacer(minLength: 0)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .widgetURL(WidgetLink.dashboard)
        }
    }
}

// MARK: - Home Screen list

/// One row of the combined open+divider+done list (2026-09-23, "show
/// completed") — the Tasks twin of `ReminderListItem`, not shared with it:
/// the two lists have no common protocol to hang a shared enum off of (see
/// `TasksListView.shouldMeasureRealWidth`'s identical "no common protocol"
/// note for the established precedent of duplicating rather than forcing an
/// abstraction across the two files).
private enum TaskListItem: Identifiable {
    case open(TaskDTO)
    case divider(count: Int)
    case done(CompletionDTO)

    var id: String {
        switch self {
        case .open(let task): return "open-\(task.id)"
        case .divider: return "divider"
        case .done(let completion): return "done-\(completion.id)"
        }
    }
}

/// The Home Screen list.
///
/// HOW MANY ROWS: as many as actually fit, and no more — see the same note on
/// `RemindersListView`, which this mirrors. A fixed six rows asked for more
/// height than the card had, and WidgetKit answered by squeezing every row down
/// to one truncated line and pushing the header off the top edge.
private struct TasksListView: View {
    let entry: TasksEntry
    let maxRows: Int
    /// systemLarge. Drives two-line titles, 10pt row gaps and the "+N more"
    /// line — the three things a 4×2 has no height for.
    let isLarge: Bool

    /// The scope ring is Today + Up next + every project with something due
    /// (2026-09-23, item 4), and it wraps (`ShiftProjectScopeIntent`) — the
    /// two unified pages always exist, so the ring never has fewer than 2
    /// entries and the chevrons are always live.
    private var canPage: Bool { true }

    /// ONE flat sequence — see `RemindersListView.combinedItems`'s identical
    /// doc for why paging this exact array is what makes "recount on toggle
    /// flip, clamp into range, break only on whole rows" fall out of the
    /// EXISTING `pagedTasks` paging math, unmodified.
    private var combinedItems: [TaskListItem] {
        let openItems = entry.tasks.map(TaskListItem.open)
        // Snooze/select mode suppress the DONE section entirely (2026-09-23,
        // Phase 2) — a completed item has no due date to snooze and no
        // meaningful "select for bulk action" affordance the mockups define,
        // so showing it interleaved with rows that DO act would only invite
        // taps that go nowhere.
        guard isLarge, !WidgetStore.tasksSnoozeMode, !WidgetStore.tasksSelectMode,
            WidgetStore.showCompleted(for: TasksWidget.kind), !entry.doneTasks.isEmpty
        else {
            return openItems
        }
        return openItems + [.divider(count: entry.doneTasks.count)] + entry.doneTasks.map(TaskListItem.done)
    }

    /// Which trailing control/tap-behavior every row in THIS card renders —
    /// one mode for the whole list, computed once per `card(rows:width:)`
    /// call rather than re-read per row. `systemMedium` never enters either
    /// mode (`isLarge`-gated, matching `ShowCompletedToggle`'s identical
    /// gating — no row/header budget there for a third control cluster).
    private var rowMode: TaskRowMode {
        guard isLarge else { return .normal }
        if WidgetStore.tasksSnoozeMode { return .snooze }
        if WidgetStore.tasksSelectMode { return .select(isSelected: false) } // per-row overridden below
        return .normal
    }

    /// Bulk-select's current picks, scoped to the on-screen scope — see
    /// `WidgetStore.selectedTaskIds(for:)`'s doc for the scope-pairing.
    /// The raw stored picks — used only to build `selectedIds` below and by
    /// row rendering's own `modeForRow` (which already checks membership
    /// against a real task, so a stale id there is harmless: it just never
    /// matches any row). Prefer `selectedIds` at every OTHER call site.
    private var rawSelectedIds: Set<Int> { WidgetStore.selectedTaskIds(for: entry.scope) }

    /// The picks, intersected with what's actually in `entry.tasks` right
    /// now (2026-09-23, PR review) — a stored id can go stale if the task it
    /// named was completed/deleted from elsewhere (the web, another device)
    /// WHILE this select-mode session was open; without this, "N selected"
    /// and `hasSelection` would count/enable against ids the widget can no
    /// longer act on honestly. The server would simply ignore an unowned/
    /// missing id if it were sent, but the COUNT the user sees should match
    /// what they can see selected on screen.
    private var selectedIds: Set<Int> {
        rawSelectedIds.intersection(Set(entry.tasks.map(\.id)))
    }

    /// The next time slot's start, formatted — `nil` when `TimeSlotStore`
    /// has no cached slots (see `SnoozeAllOverdueBar.nextPeriodLabel`'s doc).
    private var nextPeriodTimeLabel: String? {
        TimeSlotStore.nextPeriodStart(now: entry.date).map { WidgetTheme.shortTime($0) }
    }

    private var rowSpacing: CGFloat {
        isLarge ? WidgetTheme.rowSpacing : WidgetTheme.compactRowSpacing
    }

    /// See `RemindersListView.shouldMeasureRealWidth` — identical rule,
    /// mirrored here rather than shared because the two `List` types have no
    /// common protocol to hang a shared implementation off of.
    private var shouldMeasureRealWidth: Bool {
        #if os(macOS)
        true
        #else
        isLarge
        #endif
    }

    var body: some View {
        if entry.isSignedOut {
            WidgetSignedOutView()
        } else if shouldMeasureRealWidth {
            // GeometryReader OUTSIDE ViewThatFits — never inside a candidate,
            // which would report "fits" at every height and defeat the whole
            // mechanism (see WidgetTheme's "row-height truthing" note).
            // Reports the card's real width so each row can measure its own
            // title instead of assuming a flat budget.
            GeometryReader { geo in
                listContent(width: geo.size.width)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else {
            listContent(width: nil)
                // The candidates carry no Spacer — a flexible child would report
                // "fits" at every height and defeat the measurement — so the card
                // is pinned to the top here instead.
                //
                // No `.widgetURL` here (removed 2026-09-22, the misclick fix):
                // systemMedium/Large used to make the WHOLE card one tap target,
                // so a near-miss on a row's check-off dot deep-linked into the
                // app instead of doing nothing. Now only the header (below) and
                // each row's `Link` are tap targets — see `header`.
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    /// `width`: the row's real available width when `shouldMeasureRealWidth`
    /// is true, else `nil` (rows fall back to their flat per-family budget).
    private func listContent(width: CGFloat?) -> some View {
        // Tallest first — ViewThatFits renders the first that fits. Written
        // out rather than looped: ViewThatFits has to see each candidate as
        // its own child, and a ForEach would hand it one. 10, on both
        // platforms now — see `content`'s comment.
        ViewThatFits(in: .vertical) {
            card(rows: min(10, maxRows), width: width)
            card(rows: min(9, maxRows), width: width)
            card(rows: min(8, maxRows), width: width)
            card(rows: min(7, maxRows), width: width)
            card(rows: min(6, maxRows), width: width)
            card(rows: min(5, maxRows), width: width)
            card(rows: min(4, maxRows), width: width)
            card(rows: min(3, maxRows), width: width)
            card(rows: min(2, maxRows), width: width)
            card(rows: 1, width: width)
        }
    }

    private func card(rows: Int, width: CGFloat?) -> some View {
        let window = pagedTasks(rows: rows)
        let mode = rowMode
        let picks = selectedIds
        return VStack(alignment: .leading, spacing: rowSpacing) {
            header

            if window.items.isEmpty {
                WidgetEmptyView(symbol: "checkmark.circle", message: "Nothing due today")
            } else {
                VStack(alignment: .leading, spacing: rowSpacing) {
                    ForEach(window.items) { item in
                        switch item {
                        case .open(let task):
                            TaskRow(
                                task: task, now: entry.date, titleLineLimit: isLarge ? 2 : 1,
                                availableWidth: width, projectColor: entry.projectColor(for: task),
                                // Project edge: systemLarge, unified pages only —
                                // see `TaskRow.showsProjectEdge`.
                                showsProjectEdge: isLarge && entry.isUnifiedScope,
                                // Select mode's per-row selection state
                                // (2026-09-23, Phase 2) — `rowMode` itself
                                // carries a placeholder `isSelected: false`
                                // for the whole card (it's computed once,
                                // before any one row's id is known), so this
                                // row substitutes its OWN answer in.
                                mode: modeForRow(task.id, base: mode, selected: picks)
                            )
                        case .divider(let count):
                            DoneDivider(count: count)
                        case .done(let completion):
                            DoneTaskRow(
                                completion: completion,
                                projectColor: entry.projectColor(forProjectId: completion.projectId)
                            )
                        }
                    }
                }
            }

            // The bottom area (2026-09-23, Phase 2) is now ALWAYS present on
            // `isLarge` — not just "when there's more than one page" the way
            // the plain pager used to be — because "Select" needs a resting-
            // mode home even at a single page, and the snooze-mode "All
            // overdue" bar acts on the WHOLE server-side set regardless of
            // what the on-screen scope/page happens to contain (it can be
            // relevant even when THIS scope's own list, or even the whole
            // page, is empty). This costs one row of height on every Tasks
            // Large card now, intentionally, per the mockup.
            if isLarge {
                // Pinned to the card's bottom edge (Trent, 2026-09-23: "the
                // page switcher should not move") — see `RemindersListView.
                // card`'s identical comment. A Spacer's ideal height is its
                // minLength, 0, so `ViewThatFits` still measures each
                // candidate at its content height and picks the same row
                // count; only the chosen card, laid out in the full widget
                // height, stretches.
                Spacer(minLength: 0)
                bottomArea(window: window, mode: mode, hasSelection: !picks.isEmpty)
            }

            if let staleSince = entry.staleSince {
                HStack {
                    Spacer()
                    StalenessNote(fetchedAt: staleSince)
                }
            }
        }
    }

    /// Substitutes a row's own selection state into the card-wide `base`
    /// mode — see `card(rows:width:)`'s call site comment for why `rowMode`
    /// itself can't already know this (it has no task id to check against).
    /// A no-op for `.normal`/`.snooze`.
    private func modeForRow(_ taskId: Int, base: TaskRowMode, selected: Set<Int>) -> TaskRowMode {
        if case .select = base {
            return .select(isSelected: selected.contains(taskId))
        }
        return base
    }

    /// The bottom-of-card control area — the plain pager in resting mode
    /// (plus "Select", `bulk.png`'s bottom-left placement), the "All
    /// overdue" sweep bar in snooze mode, or the bulk-select action bar in
    /// select mode. The pager, when needed, sits ABOVE whichever bar is
    /// showing (mockup annotation: "pages keep your picks" — paging must
    /// stay possible even mid-selection) rather than the two competing for
    /// the same row.
    @ViewBuilder
    private func bottomArea(
        window: (items: [TaskListItem], page: Int, totalPages: Int),
        mode: TaskRowMode, hasSelection: Bool
    ) -> some View {
        if WidgetStore.tasksSnoozeMode {
            VStack(spacing: 6) {
                pagerIfNeeded(window)
                // Hidden entirely at N == 0 — see `SnoozeAllOverdueBar`'s doc.
                if entry.overdueSweepCount > 0 {
                    SnoozeAllOverdueBar(count: entry.overdueSweepCount, nextPeriodLabel: nextPeriodTimeLabel)
                }
            }
        } else if WidgetStore.tasksSelectMode {
            VStack(spacing: 6) {
                pagerIfNeeded(window)
                SelectModeActionBar(hasSelection: hasSelection)
            }
        } else {
            // Resting mode: "Select" bottom-LEFT (Trent's pick — see
            // `SelectEntryButton`'s doc), the pager centred — an OVERLAY,
            // not a second stacked row, since both are short and narrow
            // enough to share one row without colliding (unlike the wider,
            // edge-to-edge snooze/select bars above, which get their own
            // row instead).
            ZStack {
                pagerIfNeeded(window)
                HStack {
                    SelectEntryButton()
                    Spacer(minLength: 0)
                }
            }
        }
    }

    @ViewBuilder
    private func pagerIfNeeded(_ window: (items: [TaskListItem], page: Int, totalPages: Int)) -> some View {
        if window.totalPages > 1 {
            ListPager(
                page: window.page,
                totalPages: window.totalPages,
                previous: ShiftTasksPageIntent(offset: -1),
                next: ShiftTasksPageIntent(offset: 1)
            )
        }
    }

    /// A page window into `entry.tasks`, the Tasks twin of
    /// `RemindersListView.pagedReminders` — see that function's doc for the
    /// paging math and its accepted imperfection.
    private func pagedTasks(rows: Int) -> (items: [TaskListItem], page: Int, totalPages: Int) {
        let items = combinedItems
        guard rows > 0, !items.isEmpty else {
            return (items, 0, 1)
        }
        // `WidgetTheme.pageBoundaries` (2026-09-23) keeps the "DONE · N"
        // divider off the tail of a page — see its doc.
        let pages = WidgetTheme.pageBoundaries(for: items, rows: rows) { item in
            if case .divider = item { return true }
            return false
        }
        let totalPages = pages.count
        let page = min(max(WidgetStore.tasksPage(for: entry.scope), 0), totalPages - 1)
        return (Array(items[pages[page]]), page, totalPages)
    }

    /// The header IS the card's tap target now that the whole-card link is
    /// gone (see `TasksListView.body`) — see `RemindersListView.header` for
    /// why the `Link` wraps only the text and not the `ChevronPager`, and why
    /// it isn't stretched to a 40pt frame.
    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: WidgetTheme.headerSpacing) {
            Link(destination: headerDestination) {
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 5) {
                        if !entry.isUnifiedScope {
                            Circle()
                                .fill(entry.scopeColor)
                                .frame(width: 7, height: 7)
                        }
                        Text(entry.scopeLabel)
                            .font(.headline)
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                    // "Undid: …" / "Redid: …" for ~60s after an undo/redo —
                    // see `RemindersListView.header`'s identical comment.
                    // Snooze/select mode override this subtitle entirely
                    // (2026-09-23, Phase 2 — mockup: "Snooze mode" / "N
                    // selected") — see `subtitleText`'s doc.
                    //
                    // `minimumScaleFactor` dropped to 0.6 (2026-09-23,
                    // review fix) — the toggle-on three-part count ("N due ·
                    // N overdue · N done") is genuinely longer than anything
                    // this subtitle showed before "show completed", and 0.8
                    // (the title's own floor, still right for the shorter
                    // strings this shares a scale factor pool with) let it
                    // truncate with an ellipsis instead of shrinking to fit.
                    Text(subtitleText)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                }
                .contentShape(Rectangle())
            }
            Spacer(minLength: 0)
            // "Show completed" (2026-09-23) — systemLarge only, see
            // `ShowCompletedToggle`'s doc. Hidden during snooze/select mode
            // (2026-09-23, Phase 2): the DONE section it toggles is already
            // suppressed there (`combinedItems`'s guard), so a live toggle
            // that visibly does nothing would only be confusing.
            if isLarge, !WidgetStore.tasksSnoozeMode, !WidgetStore.tasksSelectMode {
                ShowCompletedToggle(
                    kind: TasksWidget.kind, isOn: WidgetStore.showCompleted(for: TasksWidget.kind)
                )
            }
            // The snooze-mode clock (2026-09-23, Phase 2) — systemLarge
            // only, same gating as the eye toggle. Stays visible/tappable
            // even while select mode is active (and vice versa for the eye
            // toggle's replacement, "Select" — see `bottomArea`), so
            // switching directly between the two modes never requires
            // returning to resting mode first; `ToggleTasksSnoozeModeIntent`
            // itself clears select mode when it turns snooze mode on.
            if isLarge {
                SnoozeModeToggle(isOn: WidgetStore.tasksSnoozeMode)
            }
            // Right-aligned, before the chevrons (2026-09-23) — see
            // `UndoRedoButtons`' doc.
            UndoRedoButtons(canUndo: entry.canUndo, canRedo: entry.canRedo)
            ChevronPager(
                previous: ShiftProjectScopeIntent(offset: -1),
                next: ShiftProjectScopeIntent(offset: 1),
                hasPrevious: canPage,
                hasNext: canPage
            )
        }
        // systemMedium gets none — see `RemindersListView`: on a 128pt card
        // those 6pt cost a whole row.
        .padding(.top, isLarge ? WidgetTheme.headerTopPadding : 0)
    }

    /// The header title `Link`'s destination (2026-09-23, item 2) — Trent:
    /// "the header ... should scroll down to the actual afternoon section,"
    /// applied here to Tasks: "Up next" (the unified scope) → `/`, a
    /// project page → `/?project=<id>`.
    private var headerDestination: URL {
        guard !entry.isUnifiedScope else { return WidgetLink.dashboard }
        return WidgetLink.project(entry.scope)
    }

    /// The header subtitle — snooze/select mode override it entirely
    /// (mockup: "Snooze mode" / "N selected"), taking priority even over
    /// `actionDescription`'s "Undid: …"/"Redid: …" indication (2026-09-23,
    /// Phase 2): a mode's OWN state is more relevant to what's on screen
    /// right now than a ~60s-old undo/redo notice would be, and it would
    /// otherwise read as contradicting what the header's own clock/Select-
    /// bar UI is showing.
    private var subtitleText: String {
        guard isLarge else { return entry.actionDescription ?? countLabel }
        if WidgetStore.tasksSnoozeMode { return "Snooze mode" }
        if WidgetStore.tasksSelectMode {
            let count = selectedIds.count
            return count == 0 ? "Select tasks" : "\(count) selected"
        }
        return entry.actionDescription ?? countLabel
    }

    /// Ordinarily "N due"/"N overdue"; "N left · M done" once "show
    /// completed" is on (2026-09-23) — `isLarge`-gated like the toggle
    /// itself, matching `RemindersListView.countLabel`'s identical split so
    /// both widgets' DONE subtitle reads the same way.
    private var countLabel: String {
        guard isLarge, WidgetStore.showCompleted(for: TasksWidget.kind) else {
            guard !entry.tasks.isEmpty else { return "all clear" }
            let overdue = entry.overdueCount(now: entry.date)
            let due = "\(entry.tasks.count) due"
            // "300 due · 300 overdue" is pure noise — when everything due is
            // overdue, one number tells the whole story.
            if overdue == entry.tasks.count { return "\(overdue) overdue" }
            return overdue > 0 ? "\(due) · \(overdue) overdue" : due
        }
        // With the toggle on, the overdue count stays (Trent's review of the
        // first cut: it's the headline number on this widget) — "5 due · 1
        // overdue · 1 done" — rather than being replaced by the Reminders-
        // style "N left". Each part is dropped when it's 0, same "no
        // redundant zero" rule `RemindersListView.countLabel`'s "all clear"
        // fallback already follows; the all-overdue collapse above applies
        // here too, for the same "pure noise" reason.
        let overdue = entry.overdueCount(now: entry.date)
        let doneCount = entry.doneTasks.count
        var parts: [String] = []
        if !entry.tasks.isEmpty {
            if overdue == entry.tasks.count {
                parts.append("\(overdue) overdue")
            } else {
                parts.append("\(entry.tasks.count) due")
                if overdue > 0 { parts.append("\(overdue) overdue") }
            }
        }
        if doneCount > 0 { parts.append("\(doneCount) done") }
        return parts.isEmpty ? "all clear" : parts.joined(separator: " · ")
    }
}

/// Which trailing control (and tap behavior) a `TaskRow` renders — mutually
/// exclusive per `WidgetStore`'s "Tasks snooze mode / bulk select" doc
/// (2026-09-23, Phase 2). `.select`'s `isSelected` rides on the case itself
/// rather than a separate row property, so a row can never be constructed
/// with a select-mode marker but no selection state to draw it from.
private enum TaskRowMode {
    case normal
    case snooze
    case select(isSelected: Bool)
}

/// An ordinary task row: a tappable title (with its due time just before the
/// checkbox) and, at the row's trailing edge, a square check-off.
///
/// In systemLarge the title wraps rather than truncating at one line
/// ("Register for the fall choir tryo…" is a task you have to open the app to
/// identify, which is the one thing the widget exists to save you), capped
/// at `WidgetTheme.iOSMaxTitleLines` on iOS and unbounded on macOS.
///
/// 2026-09-23: the check-off moved from a leading priority-colored DOT to a
/// trailing PROJECT-colored SQUARE — see this type's `projectColor` and
/// `ReminderRow`'s doc for why moving the control to the trailing edge needs
/// no overlap handling (plain `HStack` siblings). Priority is no longer drawn
/// here at all: it already reads through the title's font weight
/// (`WidgetTheme.priorityWeight`), and doubling it as a dot color was
/// redundant once the dot's color slot was needed for something the title
/// can't express — which project a row belongs to. That matters most on the
/// unified "Up next" scope (`TasksEntry.scopeLabel`), where rows from every
/// project sit in one list and only the checkbox says which is which.
private struct TaskRow: View {
    let task: TaskDTO
    let now: Date
    var titleLineLimit = 2
    /// The row's real available width, threaded down from `TasksListView`'s
    /// `GeometryReader`. `nil` whenever the card isn't measuring real widths
    /// (iOS systemMedium) — see `TasksListView.shouldMeasureRealWidth`.
    var availableWidth: CGFloat? = nil
    /// This task's project's color (`TasksEntry.projectColor(for:)`), reused
    /// from wherever the widget already resolves one — the same
    /// `WidgetTheme.projectColor(_:)` the "Personal" project header dot uses.
    var projectColor: Color = WidgetTheme.projectColor(nil)
    /// The project identity chip (2026-09-23, item 5) — Trent: "Up Next and
    /// Today should both have some indication, like a chip or something next
    /// to the tasks, that shows what project they're from because it's hard
    /// to tell." `nil` on a single-project page (redundant there — the whole
    /// card is already one project) and, deliberately, on systemMedium (see
    /// `TasksListView.card`'s call site: that family has no real-width
    /// measurement to keep the reservation below honest, and a 4×2's rows are
    /// already `lineLimit(1)` with no `minimumScaleFactor` to protect the
    /// title if the row got any tighter).
    ///
    /// SHOWN AS A COLORED EDGE, NOT A NAME (Trent, 2026-09-23, option B of
    /// three rendered for him). The first version printed the project's name
    /// beside the due time, in a fixed-width column reserved on every row —
    /// which halved every title's width and wrapped them after three words.
    /// A 3pt bar in the project's color costs 11pt, and the checkbox already
    /// carries the same color.
    var showsProjectEdge = false
    /// Defaults to `.normal` — every EXISTING call site (DONE rows aside,
    /// which use a different type entirely) keeps compiling unchanged; only
    /// `TasksListView.card` passes `.snooze`/`.select` when those modes are
    /// active.
    var mode: TaskRowMode = .normal

    private var isOverdue: Bool { task.isOverdue(now: now) }

    /// Real per-title line count at this row's actual text column: the card
    /// width minus the marker column, its 10pt `HStack` spacing, the project
    /// edge (3pt plus its 8pt spacing, when shown), and — when a due time
    /// shows — that label's own measured width plus its 8pt spacing. The
    /// title's column is narrower whenever a due time or chip sits beside
    /// it, so both are measured/reserved first. Capped on iOS — see
    /// WidgetTheme's "row-height truthing" note, the 2026-09-23 addendum.
    ///
    /// The due-time width is measured from `DueLabelParts.plainString`
    /// (2026-09-23, day-naming), NOT `WidgetTheme.shortTime(due)` alone —
    /// that plain string is the SAME source `WidgetTheme.dueLabelText`
    /// renders from below, so a wide label like "Tomorrow 9:00 AM" reserves
    /// exactly as much room as it actually draws, never less.
    ///
    /// The trailing column's own width is MODE-DEPENDENT (2026-09-23, Phase
    /// 2, PR review fix): snooze mode's ⏭/+1h pair and select mode's smaller
    /// selection circle are neither of them `WidgetTheme.rowMarkerSize` wide
    /// — reserving the wrong width here would either clip the real controls
    /// or under-wrap the title, the exact row-height-truthing bug this
    /// file's whole measurement apparatus exists to prevent.
    private var trailingControlWidth: CGFloat {
        switch mode {
        case .normal: return WidgetTheme.rowMarkerSize
        case .snooze: return WidgetTheme.snoozeRowControlsWidth
        case .select: return WidgetTheme.selectionMarkerSize
        }
    }

    private var measuredLines: Int {
        guard let availableWidth else { return titleLineLimit }
        var textWidth = availableWidth - trailingControlWidth - 10
        if showsProjectEdge {
            textWidth -= 3 + 8
        }
        if let due = task.dueDate {
            let parts = WidgetTheme.dueLabelParts(for: due, now: now, isOverdue: isOverdue)
            let dueWidth = WidgetTheme.measuredWidth(for: parts.plainString, font: WidgetTheme.caption2Font)
            textWidth -= dueWidth + 8
        }
        let font = WidgetTheme.subheadlineFont(weight: WidgetTheme.priorityWeight(task.priority))
        let real = WidgetTheme.measuredLineCount(for: task.title, maxWidth: textWidth, font: font)
        #if os(iOS)
        return min(real, WidgetTheme.iOSMaxTitleLines)
        #else
        return real
        #endif
    }

    /// The row's reserved text height: the title's real measured line count
    /// where it's known, else the flat `titleLineLimit` budget.
    private var reservedHeight: CGFloat {
        CGFloat(measuredLines) * WidgetTheme.rowTitleLineHeight
    }

    /// See `ReminderRow.markerHeight` — identical iOS floor / macOS no-floor
    /// rule, mirrored here rather than shared for the same reason
    /// `shouldMeasureRealWidth` is duplicated on `TasksListView`.
    private var markerHeight: CGFloat {
        #if os(iOS)
        guard availableWidth == nil else { return reservedHeight + 2 * markerBleed }
        return max(reservedHeight, WidgetTheme.rowMarkerSize)
        #else
        reservedHeight
        #endif
    }

    /// How far the check-off's tap area reaches into the gap above and below
    /// its row, without taking layout space (Trent, 2026-09-23: the gap under
    /// a one-line title). On iOS systemLarge the row is exactly as tall as its
    /// text, and the finger target instead stretches half a `rowSpacing` into
    /// each neighbouring gap — applied as negative vertical padding on the
    /// Button, so adjacent targets meet but never overlap, and a one-line
    /// row's pitch drops from 46pt (the old 36pt floor + 10) to 28pt. Zero
    /// elsewhere: systemMedium keeps the 36pt floor, macOS needs none.
    private var markerBleed: CGFloat {
        #if os(iOS)
        availableWidth == nil ? 0 : WidgetTheme.rowSpacing / 2
        #else
        0
        #endif
    }

    private var lineLimitValue: Int? {
        guard availableWidth != nil else { return titleLineLimit }
        #if os(iOS)
        return WidgetTheme.iOSMaxTitleLines
        #else
        return nil
        #endif
    }

    /// Whether this row is currently picked, in select mode — `false` for
    /// every other mode. Drives the row's background tint (mockup: selected
    /// rows get a subtle indigo fill spanning the whole row).
    private var isSelected: Bool {
        if case .select(let selected) = mode { return selected }
        return false
    }

    /// The title/due-time content shared by every mode — ONLY the wrapper
    /// (`Link` to open the task, or `Button` to toggle selection in select
    /// mode) and the trailing control (below) change per mode; the leading
    /// content itself, including the due-time label, is identical in all
    /// three (2026-09-23, Phase 2: the mockup's snooze/select-mode rows
    /// still show due times exactly like a resting row does).
    @ViewBuilder
    private var titleAndDueTime: some View {
        // .firstTextBaseline keeps the due time on the title's first line
        // when the title wraps, rather than drifting down beside the
        // second. The due time sits at the END of this HStack — "just left
        // of the checkbox" (Trent, 2026-09-23), which falls out naturally
        // once the checkbox itself moved to the row's trailing edge below.
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if showsProjectEdge {
                Capsule()
                    .fill(projectColor)
                    .frame(width: 3, height: max(reservedHeight - 2, 10))
                    // Its bottom sits on the title's first baseline
                    // otherwise; this lines its top up with the text.
                    .alignmentGuide(.firstTextBaseline) { $0[.top] + WidgetTheme.rowTitleLineHeight * 0.75 }
            }
            Text(task.title)
                .font(.subheadline)
                .fontWeight(WidgetTheme.priorityWeight(task.priority))
                .foregroundStyle(.primary)
                .lineLimit(lineLimitValue)
                .multilineTextAlignment(.leading)
                // See `ReminderRow`: fixedSize stops any parent from
                // squeezing the wrap back out, minHeight reserves the
                // row's lines so `ViewThatFits` counts rows honestly.
                .fixedSize(horizontal: false, vertical: true)
                .frame(
                    maxWidth: .infinity,
                    minHeight: reservedHeight,
                    alignment: .topLeading
                )

            if task.dueDate != nil {
                // Day-naming (2026-09-23): "8:30 PM" today, "Tomorrow
                // 9:00 AM", "Sun 9:00 AM" (2-6 days out), "Oct 1 9:00
                // AM" (further), "Oct 2" (date-only). Overdue is
                // unchanged — plain time, red — see
                // `WidgetTheme.dueLabelText`'s doc.
                WidgetTheme.dueLabelText(for: task, now: now)
                    .font(.caption2)
                    .monospacedDigit()
            }
        }
        .contentShape(Rectangle())
    }

    /// The leading content's TAP WRAPPER — a `Link` to the task in normal/
    /// snooze mode (snooze mode's OWN action lives entirely in the trailing
    /// buttons, so the title stays a navigable link there too), a `Button`
    /// toggling selection in select mode (mockup: "tapping a row selects
    /// it" — there is nowhere else for a select-mode tap on the title to
    /// go, since opening the task's editor mid-selection makes no sense).
    @ViewBuilder
    private var titleContent: some View {
        switch mode {
        case .normal, .snooze:
            Link(destination: WidgetLink.task(task.id)) { titleAndDueTime }
        case .select:
            Button(intent: ToggleTaskSelectionIntent(taskId: task.id)) { titleAndDueTime }
                .buttonStyle(.plain)
        }
    }

    /// The trailing control — the ordinary check-off square, snooze mode's
    /// ⏭/+1h pair, or select mode's selection circle. Sized to
    /// `trailingControlWidth` (mode-aware — see that property's doc) and
    /// `markerHeight` (unchanged across modes: a 36pt floor is still the
    /// right finger-target HEIGHT regardless of which control fills it).
    @ViewBuilder
    private var trailingControl: some View {
        switch mode {
        case .normal:
            Button(intent: CompleteTaskIntent(taskId: task.id, kind: TasksWidget.kind)) {
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .strokeBorder(projectColor, lineWidth: 1.5)
                    .frame(width: 16, height: 16)
                    // THREE frames — see `ReminderRow`'s identical trick for
                    // the full explanation. The 16×16 square is sized here,
                    // then centred within one line's height (default
                    // alignment), and only THEN is that already-centred
                    // result pinned to the top of the full `markerHeight` —
                    // so the square centres on the title's FIRST line, and
                    // the hit target hangs below it for a wrapped title
                    // (26pt missed too often, iOS's finger-sized floor — see
                    // `markerHeight`). Collapsing the last two frames into
                    // one `alignment: .top` would instead pin the square
                    // itself to the marker's top edge, floating it above
                    // where the first line of text actually sits once a
                    // title wraps to 2+ lines.
                    .frame(width: WidgetTheme.rowMarkerSize, height: WidgetTheme.rowTitleLineHeight)
                    // The bleed above is part of the target, not the glyph's
                    // offset: pad it back so the glyph stays on line 1.
                    .padding(.top, markerBleed)
                    .frame(width: WidgetTheme.rowMarkerSize, height: markerHeight, alignment: .top)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.vertical, -markerBleed)
        case .snooze:
            // No `markerBleed` trick here (2026-09-23, Phase 2) — snooze
            // mode's controls are already comfortably finger-sized on their
            // own (32pt circle, a full pill), so the extra touch-target
            // bleed the single small checkbox needs isn't worth the same
            // complexity for a first cut of this feature.
            SnoozeRowButtons(taskId: task.id)
                .frame(width: trailingControlWidth, height: markerHeight, alignment: .top)
        case .select:
            SelectionMarker(isSelected: isSelected)
                .frame(width: trailingControlWidth, height: markerHeight, alignment: .top)
        }
    }

    var body: some View {
        // .top, not .center: on a two-line row a centred marker floats down
        // into the gap between the lines, reading as if it belongs to neither.
        HStack(alignment: .top, spacing: 10) {
            titleContent
            trailingControl
        }
        // Selected-row background (2026-09-23, Phase 2, select mode only) —
        // bled OUTWARD via negative padding on the FILL SHAPE, not on the
        // row's own content, so the row's reported layout size never
        // changes between selected/unselected (which would otherwise
        // silently drift the row-height-truthing measurement this whole
        // file is built around) — same "paint past the frame without
        // costing layout space" trick as `ReminderSlotStrip.segmentBleed`.
        .background(
            Group {
                if isSelected {
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(WidgetTheme.indigoAccent.opacity(0.16))
                        .padding(.horizontal, -6)
                        .padding(.vertical, -4)
                }
            }
        )
    }
}

/// One completed task in the DONE section (2026-09-23, "show completed") —
/// struck-through title, with "Done H:MM" on its OWN line beneath (a
/// STACKED second line, per the mockup — not side-by-side like `TaskRow`'s
/// due time, since the completion time is secondary-to-the-secondary here).
/// Row grammar mirrors `DoneReminderRow`'s (title = `Link`, trailing marker
/// = `Button`) — see that struct's doc for why.
///
/// `.lineLimit(1)` on the title, same "completed items are secondary
/// content, not the never-truncate case" reasoning as `DoneReminderRow`.
private struct DoneTaskRow: View {
    let completion: CompletionDTO
    let projectColor: Color

    private var doneTimeText: String {
        guard let date = completion.completedDate else { return "Done" }
        return "Done \(WidgetTheme.shortTime(date))"
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Link(destination: WidgetLink.task(completion.taskId)) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(completion.taskTitle)
                        .font(.subheadline)
                        .strikethrough()
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Text(doneTimeText)
                        .font(.caption2)
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }

            Button(intent: UncompleteTaskIntent(taskId: completion.taskId, kind: TasksWidget.kind)) {
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .fill(projectColor.opacity(0.7))
                    .frame(width: 16, height: 16)
                    .overlay(
                        Image(systemName: "checkmark")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(.white)
                    )
                    // Two lines' worth of height (title + "Done H:MM"),
                    // centred on the first line — same trick as `TaskRow`'s
                    // marker, sized to this row's fixed two-line height
                    // instead of a measured one since a done row never wraps.
                    .frame(width: WidgetTheme.rowMarkerSize, height: WidgetTheme.rowTitleLineHeight)
                    .frame(
                        width: WidgetTheme.rowMarkerSize,
                        height: WidgetTheme.rowTitleLineHeight * 2,
                        alignment: .top
                    )
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }
}

// MARK: - Lock Screen
//
// Lock Screen accessory families don't exist on macOS — see the #if os(iOS)
// guard on `content` above. AccessoryWidgetBackground below only compiles on
// iOS, so these views are gated out entirely on macOS rather than left as
// dead code.
#if os(iOS)

/// Glanceable only — see `RemindersRectangularView` for why there are no
/// buttons on the Lock Screen families.
private struct TasksRectangularView: View {
    let entry: TasksEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if entry.isSignedOut {
                Text("OpenTask")
                    .font(.headline)
                    .widgetAccentable()
                Text("Open to sign in")
                    .font(.caption2)
            } else {
                HStack(spacing: 4) {
                    Text(entry.scopeLabel)
                        .font(.headline)
                        .widgetAccentable()
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    let overdue = entry.overdueCount(now: entry.date)
                    if overdue > 0 {
                        Text("\(overdue) late")
                            .font(.caption2.weight(.semibold))
                            .widgetAccentable()
                    }
                }
                Text(entry.tasks.first?.title ?? "Nothing due today")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .widgetURL(WidgetLink.dashboard)
    }
}

/// Overdue count — the one number worth waking the screen for.
private struct TasksCircularView: View {
    let entry: TasksEntry

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: -1) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 10, weight: .medium))
                Text("\(entry.overdueCount(now: entry.date))")
                    .font(.system(size: 17, weight: .semibold, design: .rounded))
                    .minimumScaleFactor(0.7)
            }
        }
        .widgetURL(WidgetLink.dashboard)
    }
}

#endif
