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
            TasksListView(entry: entry, isLarge: false)
                .backgroundTapOpens(WidgetLink.dashboard)
        default:
            // No row ceiling (2026-09-24): the list pages by real row
            // height, as many as fit — see `TasksListView`'s doc.
            TasksListView(entry: entry, isLarge: true)
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

                    // Shrinks rather than truncating (2026-09-24) — see
                    // `RemindersSmallView`'s title.
                    Text(next.title)
                        .font(.caption2)
                        .fontWeight(WidgetTheme.priorityWeight(next.priority))
                        .foregroundStyle(.primary)
                        .minimumScaleFactor(WidgetTheme.overflowTitleScale)

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
/// the two lists' item enums are private to their own files.
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

/// One row's size, decided once and used twice — by the pager and as the
/// row's exact frame. See `ReminderRowLayout`.
private struct TaskRowLayout {
    let lines: Int
    let height: CGFloat
    /// Whether the due label stacks day-over-time — see `TaskRow.dueStacked`.
    let dueStacked: Bool
    /// Longer than the whole card — see `ReminderRowLayout.shrinks`.
    var shrinks = false
}

/// The Home Screen list.
///
/// HOW MANY ROWS: as many as genuinely fit, page after page — the same
/// height-based paging as `RemindersListView` (see its doc and
/// `WidgetTheme.pages`). Trent's phone on 2026-09-24 showed why the old
/// uniform `ViewThatFits` pages had to go on this widget especially: "26
/// due" as 13 pages of TWO rows, because one page's longest titles set every
/// page's size.
private struct TasksListView: View {
    let entry: TasksEntry
    /// systemLarge. Drives wrapped titles, 10pt row gaps, the project edge,
    /// the DONE section, snooze/select modes and the bottom row.
    let isLarge: Bool

    /// The scope ring is Today + Up next + every project with something due
    /// (2026-09-23, item 4), and it wraps (`ShiftProjectScopeIntent`) — the
    /// two unified pages always exist, so the ring never has fewer than 2
    /// entries and the chevrons are always live.
    private var canPage: Bool { true }

    private var snoozeMode: Bool { isLarge && WidgetStore.tasksSnoozeMode }
    private var selectMode: Bool { isLarge && WidgetStore.tasksSelectMode }

    /// "Show completed" is on AND reachable — systemLarge, resting mode.
    /// Snooze/select mode suppress the DONE section entirely (2026-09-23,
    /// Phase 2): a completed item has no due date to snooze and no
    /// meaningful "select for bulk action" affordance, so showing it
    /// interleaved with rows that DO act would only invite taps that go
    /// nowhere.
    private var showCompleted: Bool {
        isLarge && !snoozeMode && !selectMode && WidgetStore.showCompleted(for: TasksWidget.kind)
    }

    /// ONE flat sequence — see `RemindersListView.combinedItems`' doc.
    private var combinedItems: [TaskListItem] {
        let openItems = entry.tasks.map(TaskListItem.open)
        guard showCompleted, !entry.doneTasks.isEmpty else { return openItems }
        return openItems + [.divider(count: entry.doneTasks.count)] + entry.doneTasks.map(TaskListItem.done)
    }

    /// Which trailing control/tap-behavior every row in THIS card renders —
    /// one mode for the whole list. `.select`'s `isSelected` is a
    /// placeholder here; `modeForRow` substitutes each row's own answer.
    private var rowMode: TaskRowMode {
        if snoozeMode { return .snooze }
        if selectMode { return .select(isSelected: false) }
        return .normal
    }

    /// Bulk-select's current picks, intersected with what's actually in
    /// `entry.tasks` right now (2026-09-23, PR review) — a stored id can go
    /// stale if the task it named was completed/deleted from elsewhere
    /// while select mode was open; the COUNT the user sees should match
    /// what they can see selected. See `WidgetStore.selectedTaskIds(for:)`
    /// for the scope pairing.
    private var selectedIds: Set<Int> {
        WidgetStore.selectedTaskIds(for: entry.scope).intersection(Set(entry.tasks.map(\.id)))
    }

    /// The next time slot's start, formatted — `nil` when `TimeSlotStore`
    /// has no cached slots (see `SnoozeAllOverdueBar.nextPeriodLabel`'s doc).
    private var nextPeriodTimeLabel: String? {
        TimeSlotStore.nextPeriodStart(now: entry.date).map { WidgetTheme.shortTime($0) }
    }

    private var rowSpacing: CGFloat {
        isLarge ? WidgetTheme.rowSpacing : WidgetTheme.compactRowSpacing
    }

    /// See `RemindersListView.rowFloor` — identical rule: iOS systemMedium
    /// keeps the 36pt finger floor, and (since 2026-09-24) wraps its titles
    /// in full like every other family instead of one flat line.
    private var rowFloor: CGFloat {
        #if os(iOS)
        isLarge ? 0 : WidgetTheme.rowMarkerSize
        #else
        0
        #endif
    }

    /// See `RemindersListView.markerBleed` — identical rule.
    private var markerBleed: CGFloat {
        #if os(iOS)
        isLarge ? WidgetTheme.rowSpacing / 2 : 0
        #else
        0
        #endif
    }

    var body: some View {
        if entry.isSignedOut {
            WidgetSignedOutView()
        } else {
            // No `.widgetURL` here (removed 2026-09-22, the misclick fix) —
            // see `RemindersListView.body`.
            VStack(alignment: .leading, spacing: rowSpacing) {
                header

                // The header's real height is laid out, not estimated, and
                // the title line pitch is SwiftUI's own — see
                // `RemindersListView.body`'s identical reader.
                RenderedTextReader { size, metrics in
                    listBody(size: size, metrics: metrics)
                }

                if let staleSince = entry.staleSince {
                    HStack {
                        Spacer()
                        StalenessNote(fetchedAt: staleSince)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    /// The bottom area's exact height — the number the pager subtracts
    /// before it pages, and the frame the area is then drawn in.
    ///
    /// Resting mode: one `bottomBarHeight` row ("Select", the pager, the
    /// completed dot) — always present on systemLarge, since "Select" and
    /// the dot need a home even on a one-page list. Snooze/select mode: the
    /// pager's row (only if there IS more than one page — mockup: "pages
    /// keep your picks") stacked 6pt above that mode's own bar. systemMedium
    /// has none of it.
    private func bottomHeight(withPager: Bool, metrics: WidgetTextMetrics) -> CGFloat {
        guard isLarge else { return 0 }
        let pagerRow = withPager ? metrics.bottomBarHeight + 6 : 0
        if snoozeMode {
            // The "All overdue" bar is hidden at N == 0 — see its doc.
            let bar = entry.overdueSweepCount > 0 ? metrics.actionPillHeight : 0
            return bar > 0 ? pagerRow + bar : max(pagerRow - 6, 0)
        }
        if selectMode {
            return pagerRow + max(SelectModeActionBar.circleDiameter, metrics.actionPillHeight)
        }
        return metrics.bottomBarHeight
    }

    /// The paged rows plus (systemLarge) the bottom area — see
    /// `RemindersListView.listBody` for why the rows sit in their own spaced
    /// stack and the bottom area carries its own `rowSpacing` of top padding
    /// (so the budget subtracts exactly what the layout adds).
    private func listBody(size: CGSize, metrics: WidgetTextMetrics) -> some View {
        let items = combinedItems
        let mode = rowMode
        let picks = selectedIds

        // Page assuming the pager's row is there; if that yields one page,
        // it isn't — and one page with MORE room is still one page, so the
        // second pass can't disagree with the first about that.
        func paginate(withPager: Bool) -> (pages: [Range<Int>], layouts: [TaskRowLayout], bottom: CGFloat) {
            let bottom = bottomHeight(withPager: withPager, metrics: metrics)
            let budget = max(size.height - (bottom > 0 ? bottom + rowSpacing : 0), 0)
            let layouts = items.map { layout(for: $0, mode: mode, width: size.width, budget: budget, metrics: metrics) }
            let pages = WidgetTheme.pages(heights: layouts.map(\.height), spacing: rowSpacing, budget: budget) {
                if case .divider = items[$0] { return true }
                return false
            }
            return (pages, layouts, bottom)
        }
        var paged = paginate(withPager: true)
        if paged.pages.count == 1 { paged = paginate(withPager: false) }
        let pages = paged.pages
        let layouts = paged.layouts
        // systemMedium has no pager, so it always shows the first page.
        let page = isLarge ? min(max(WidgetStore.tasksPage(for: entry.scope), 0), pages.count - 1) : 0

        return VStack(alignment: .leading, spacing: 0) {
            if items.isEmpty {
                WidgetEmptyView(symbol: "checkmark.circle", message: "Nothing due today")
            } else {
                VStack(alignment: .leading, spacing: rowSpacing) {
                    ForEach(pages[page], id: \.self) { index in
                        row(items[index], layout: layouts[index], mode: mode, picks: picks, metrics: metrics)
                            .frame(height: layouts[index].height, alignment: .top)
                    }
                }
            }

            // Pins the bottom area to the card's bottom edge (Trent,
            // 2026-09-23: "the page switcher should not move").
            Spacer(minLength: 0)

            if paged.bottom > 0 {
                bottomArea(page: page, totalPages: pages.count, hasSelection: !picks.isEmpty, metrics: metrics)
                    .frame(height: paged.bottom)
                    .padding(.top, rowSpacing)
            }
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
    }

    /// `item`'s lines and exact height at this card's `width`.
    ///
    /// An open task's title column is the card minus the trailing control
    /// (mode-dependent — see `TaskRow.trailingControlWidth`) and its 10pt
    /// gap, minus the project edge (3pt + 8pt gap) where shown, minus the
    /// due label's own width + 8pt. The due label is `fixedSize` in the row,
    /// so it really does take exactly that width — on Trent's phone it used
    /// to WRAP on its own ("Tomorrow / 4:00 pm"), handing its width back to
    /// a title whose line count had been measured without it, and the row
    /// reserved three lines for a two-line title. Snooze and select mode
    /// floor the height at their controls' own size (a 32pt ⏭ circle, a
    /// 22pt selection circle).
    private func layout(
        for item: TaskListItem, mode: TaskRowMode, width: CGFloat, budget: CGFloat, metrics: WidgetTextMetrics
    ) -> TaskRowLayout {
        switch item {
        case .open(let task):
            // ONE rule for the due label (2026-09-24, Trent's screenshot of
            // "Tomorrow 9:00 am" inline on one row, "Tomorrow" over "12:00
            // pm" on the next, "Sat" over "9:00 am" on a third): a label
            // with a day word AND a time ALWAYS stacks — the day on its own
            // line above the time, right-aligned — on every family. A
            // time-only label (today) and a day-only label (date-only task)
            // are one line. It used to stack only where that made the row
            // shorter, which is exactly what made neighbouring rows
            // disagree.
            let stackedDueHeight = ceil(2 * metrics.caption2LineHeight)
            var column = width - TaskRow.trailingControlWidth(for: mode) - 10
            if isLarge, entry.isUnifiedScope { column -= 3 + 8 }
            let text: (lines: Int, height: CGFloat, dueStacked: Bool, shrinks: Bool)
            if let parts = dueParts(for: task) {
                if parts.hasTwoParts {
                    // Stacked: the title's column gives up only the label's
                    // LONGER half, and the row holds two caption2 lines even
                    // beside a one-line title.
                    let half = max(
                        WidgetTheme.measuredWidth(for: parts.dayWord ?? "", font: metrics.caption2Font),
                        WidgetTheme.measuredWidth(for: parts.time ?? "", font: metrics.caption2Font)
                    )
                    let stacked = titleLayout(
                        task, column: column - half - 8, labelHeight: stackedDueHeight,
                        budget: budget, metrics: metrics
                    )
                    text = (stacked.lines, stacked.height, true, stacked.shrinks)
                } else {
                    let inline = titleLayout(
                        task,
                        column: column - WidgetTheme.measuredWidth(for: parts.plainString, font: metrics.caption2Font) - 8,
                        labelHeight: 0, budget: budget, metrics: metrics
                    )
                    text = (inline.lines, inline.height, false, inline.shrinks)
                }
            } else {
                let plain = titleLayout(task, column: column, labelHeight: 0, budget: budget, metrics: metrics)
                text = (plain.lines, plain.height, false, plain.shrinks)
            }
            let floor: CGFloat
            switch mode {
            case .normal: floor = rowFloor
            case .snooze: floor = SnoozeRowButtons.height
            case .select: floor = WidgetTheme.selectionMarkerSize
            }
            return TaskRowLayout(
                lines: text.lines, height: max(text.height, floor), dueStacked: text.dueStacked, shrinks: text.shrinks
            )
        case .divider:
            return TaskRowLayout(lines: 1, height: metrics.caption2Height, dueStacked: false)
        case .done(let completion):
            // Title (wrapped in full since 2026-09-24), 1pt, "Done H:MM" —
            // see `DoneTaskRow`.
            let meta = 1 + metrics.caption2Height
            let fit = metrics.titleLines(
                completion.taskTitle, width: width - WidgetTheme.rowMarkerSize - 10, weight: .regular,
                maxHeight: max(budget - meta, 0)
            )
            if fit.shrinks {
                return TaskRowLayout(lines: fit.lines, height: budget, dueStacked: false, shrinks: true)
            }
            return TaskRowLayout(
                lines: fit.lines, height: metrics.titleHeight(lines: fit.lines) + meta, dueStacked: false
            )
        }
    }

    /// A title's lines at `column` — its full wrap, uncapped since
    /// 2026-09-24 on every family (clamped only when longer than the whole
    /// `budget`, see `WidgetTextMetrics.titleLines`) — and the row height
    /// they need beside a due label `labelHeight` tall.
    private func titleLayout(
        _ task: TaskDTO, column: CGFloat, labelHeight: CGFloat, budget: CGFloat, metrics: WidgetTextMetrics
    ) -> (lines: Int, height: CGFloat, shrinks: Bool) {
        let weight = WidgetTheme.priorityWeight(task.priority)
        let fit = metrics.titleLines(task.title, width: column, weight: weight, maxHeight: budget)
        // Longer than the whole card: a page of its own, title shrunk to fit.
        if fit.shrinks { return (fit.lines, budget, true) }
        return (fit.lines, max(metrics.titleHeight(lines: fit.lines), labelHeight), false)
    }

    /// `task`'s due label, split — `nil` when it has no due date.
    private func dueParts(for task: TaskDTO) -> WidgetTheme.DueLabelParts? {
        guard let due = task.dueDate else { return nil }
        return WidgetTheme.dueLabelParts(for: due, now: entry.date, isOverdue: task.isOverdue(now: entry.date))
    }

    @ViewBuilder
    private func row(
        _ item: TaskListItem, layout: TaskRowLayout, mode: TaskRowMode, picks: Set<Int>, metrics: WidgetTextMetrics
    ) -> some View {
        switch item {
        case .open(let task):
            TaskRow(
                task: task, now: entry.date, lines: layout.lines, height: layout.height, shrinks: layout.shrinks,
                firstLineHeight: metrics.titleHeight(lines: 1),
                dueStacked: layout.dueStacked,
                markerBleed: mode.isNormal ? markerBleed : 0,
                projectColor: entry.projectColor(for: task),
                // Project edge: systemLarge, unified pages only — see
                // `TaskRow.showsProjectEdge`.
                showsProjectEdge: isLarge && entry.isUnifiedScope,
                mode: modeForRow(task.id, base: mode, selected: picks)
            )
        case .divider(let count):
            DoneDivider(count: count)
        case .done(let completion):
            DoneTaskRow(
                completion: completion,
                projectColor: entry.projectColor(forProjectId: completion.projectId),
                firstLineHeight: metrics.titleHeight(lines: 1),
                lines: layout.lines,
                height: layout.height,
                titleHeight: layout.height - 1 - metrics.caption2Height,
                shrinks: layout.shrinks
            )
        }
    }

    /// Substitutes a row's own selection state into the card-wide `base`
    /// mode. A no-op for `.normal`/`.snooze`.
    private func modeForRow(_ taskId: Int, base: TaskRowMode, selected: Set<Int>) -> TaskRowMode {
        if case .select = base {
            return .select(isSelected: selected.contains(taskId))
        }
        return base
    }

    /// The bottom-of-card control area — resting mode's one row ("Select"
    /// bottom-left, the pager centred, the completed dot bottom-right —
    /// 2026-09-24, Trent: "change the eyeball to a dot and move it to the
    /// bottom by the paginator"), or, in snooze/select mode, the pager's row
    /// (when there is more than one page) stacked ABOVE that mode's bar —
    /// mockup: "pages keep your picks", so paging must stay possible
    /// mid-selection. Heights come from `bottomHeight(withPager:)`; the
    /// caller frames this to exactly that.
    @ViewBuilder
    private func bottomArea(page: Int, totalPages: Int, hasSelection: Bool, metrics: WidgetTextMetrics) -> some View {
        let bar = metrics.bottomBarHeight
        if snoozeMode || selectMode {
            VStack(spacing: 6) {
                if totalPages > 1 {
                    ListBottomBar(height: bar) {
                        EmptyView()
                    } pager: {
                        pager(page: page, totalPages: totalPages)
                    } trailing: {
                        EmptyView()
                    }
                }
                if snoozeMode {
                    if entry.overdueSweepCount > 0 {
                        SnoozeAllOverdueBar(count: entry.overdueSweepCount, nextPeriodLabel: nextPeriodTimeLabel)
                            .frame(height: metrics.actionPillHeight)
                    }
                } else {
                    SelectModeActionBar(hasSelection: hasSelection)
                        .frame(height: max(SelectModeActionBar.circleDiameter, metrics.actionPillHeight))
                }
            }
        } else {
            ListBottomBar(height: bar) {
                SelectEntryButton(height: bar)
            } pager: {
                if totalPages > 1 {
                    pager(page: page, totalPages: totalPages)
                }
            } trailing: {
                CompletedDotToggle(
                    intent: ToggleShowCompletedIntent(kind: TasksWidget.kind),
                    isOn: showCompleted, label: "done", height: bar
                )
            }
        }
    }

    private func pager(page: Int, totalPages: Int) -> some View {
        ListPager(
            page: page,
            totalPages: totalPages,
            previous: ShiftTasksPageIntent(offset: -1),
            next: ShiftTasksPageIntent(offset: 1)
        )
    }

    /// The header IS the card's tap target now that the whole-card link is
    /// gone — see `RemindersListView.header` for why the `Link` wraps only
    /// the text and not the buttons.
    ///
    /// THE TITLE NEVER TRUNCATES (2026-09-24 — "Up…" on Trent's phone, at
    /// XXX Large text, with an eye, a clock, Undo, Redo and ‹ › beside it).
    /// `fixedSize` horizontally, layout priority on its block, and the
    /// header thinned: the eye is now the completed dot in the bottom row,
    /// and the icon cluster sits in its own tight `HStack` instead of paying
    /// `headerSpacing` (12pt) between every button. The ‹ › stay — they
    /// switch the SCOPE (Today, Up next, then each project with something
    /// due), which nothing else on the card does.
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
                            .fixedSize(horizontal: true, vertical: false)
                    }
                    // "Undid: …" / "Redid: …" for ~60s after an undo/redo —
                    // see `RemindersListView.header`'s identical comment.
                    // Snooze/select mode override this subtitle entirely
                    // (mockup: "Snooze mode" / "N selected") — see
                    // `subtitleText`'s doc. Shrinks rather than truncating
                    // the three-part "N due · N overdue · N done".
                    Text(subtitleText)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                }
                .contentShape(Rectangle())
            }
            .layoutPriority(1)
            Spacer(minLength: 0)
            HStack(spacing: 0) {
                // The snooze-mode clock (2026-09-23, Phase 2) — systemLarge
                // only. Stays tappable while select mode is active, so
                // switching directly between the two modes never requires
                // returning to resting mode first; `ToggleTasksSnoozeModeIntent`
                // itself clears select mode when it turns snooze mode on.
                if isLarge {
                    SnoozeModeToggle(isOn: WidgetStore.tasksSnoozeMode)
                }
                // See `UndoRedoButtons`' doc.
                UndoRedoButtons(canUndo: entry.canUndo, canRedo: entry.canRedo)
                ChevronPager(
                    previous: ShiftProjectScopeIntent(offset: -1),
                    next: ShiftProjectScopeIntent(offset: 1),
                    hasPrevious: canPage,
                    hasNext: canPage
                )
            }
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
    /// right now than a ~60s-old undo/redo notice would be.
    private var subtitleText: String {
        if snoozeMode { return "Snooze mode" }
        if selectMode {
            let count = selectedIds.count
            return count == 0 ? "Select tasks" : "\(count) selected"
        }
        return entry.actionDescription ?? countLabel
    }

    /// Ordinarily "N due"/"N overdue"; "N due · N overdue · M done" once
    /// "show completed" is on (2026-09-23) — the overdue count stays (Trent's
    /// review of the first cut: it's the headline number on this widget),
    /// each part dropped when it's 0, and "N due · N overdue" collapses to
    /// "N overdue" when everything due is overdue ("300 due · 300 overdue"
    /// is pure noise).
    private var countLabel: String {
        let overdue = entry.overdueCount(now: entry.date)
        var parts: [String] = []
        if !entry.tasks.isEmpty {
            if overdue == entry.tasks.count {
                parts.append("\(overdue) overdue")
            } else {
                parts.append("\(entry.tasks.count) due")
                if overdue > 0 { parts.append("\(overdue) overdue") }
            }
        }
        if showCompleted, !entry.doneTasks.isEmpty { parts.append("\(entry.doneTasks.count) done") }
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

    var isNormal: Bool {
        if case .normal = self { return true }
        return false
    }
}

/// An ordinary task row: a tappable title (with its due time just before the
/// checkbox) and, at the row's trailing edge, a square check-off.
///
/// The title wraps rather than truncating ("Register Josie for Viking Vo…"
/// is a task you have to open the app to identify, which is the one thing
/// the widget exists to save you), to its full `lines` — uncapped on every
/// family and platform since 2026-09-24.
///
/// 2026-09-23: the check-off moved from a leading priority-colored DOT to a
/// trailing PROJECT-colored SQUARE — see `ReminderRow`'s doc for why moving
/// the control to the trailing edge needs no overlap handling (plain `HStack`
/// siblings). Priority is no longer drawn here at all: it already reads
/// through the title's font weight (`WidgetTheme.priorityWeight`), and the
/// square's color says which project a row belongs to — which matters most on
/// the unified "Up next" scope, where rows from every project share one list.
///
/// DUMB ABOUT ITS OWN SIZE (2026-09-24) — `lines`/`height` come from
/// `TasksListView.layout(for:)`, the same numbers the pager added up; see
/// `ReminderRow`'s identical note.
private struct TaskRow: View {
    let task: TaskDTO
    let now: Date
    let lines: Int
    let height: CGFloat
    /// Longer than the whole card — draw ALL of it, smaller, in `height`.
    var shrinks = false
    /// One title line's height — the checkbox centres on the FIRST line.
    let firstLineHeight: CGFloat
    /// The due label on two lines, day word over time ("Tomorrow" / "4:00
    /// pm"), right-aligned — true for EVERY two-part label, on every family
    /// (`TasksListView.layout(for:)`, 2026-09-24). It first stacked only
    /// where that made the row shorter, so neighbouring rows mixed "Tomorrow
    /// 9:00 am" on one line with "Tomorrow" over "12:00 pm" — Trent asked for
    /// one rule. On one line "Tomorrow 4:00 pm" also took half the row at
    /// his text size and pushed titles like "Josie Allowance ($8)" to three
    /// narrow lines.
    let dueStacked: Bool
    /// See `TasksListView.markerBleed`. Zero outside normal mode: snooze
    /// mode's controls are already finger-sized on their own (a 32pt circle,
    /// a full pill), and select mode's whole row is the target.
    let markerBleed: CGFloat
    /// This task's project's color (`TasksEntry.projectColor(for:)`) — the
    /// same `WidgetTheme.projectColor(_:)` a project page's header dot uses.
    var projectColor: Color = WidgetTheme.projectColor(nil)
    /// The project identity mark on the unified Today/Up next pages
    /// (2026-09-23, item 5 — Trent: "Up Next and Today should both have some
    /// indication... that shows what project they're from").
    ///
    /// SHOWN AS A COLORED EDGE, NOT A NAME (Trent, 2026-09-23, option B of
    /// three rendered for him). The first version printed the project's name
    /// beside the due time, in a fixed-width column reserved on every row —
    /// which halved every title's width and wrapped them after three words.
    /// A 3pt bar in the project's color costs 11pt, and the checkbox already
    /// carries the same color.
    var showsProjectEdge = false
    var mode: TaskRowMode = .normal

    /// The trailing column's width per mode (2026-09-23, Phase 2, PR review
    /// fix): snooze mode's ⏭/+1h pair and select mode's smaller selection
    /// circle are neither of them `rowMarkerSize` wide, and the title's
    /// measured column (`TasksListView.layout(for:)`) must subtract the
    /// width actually drawn.
    static func trailingControlWidth(for mode: TaskRowMode) -> CGFloat {
        switch mode {
        case .normal: return WidgetTheme.rowMarkerSize
        case .snooze: return WidgetTheme.snoozeRowControlsWidth
        case .select: return WidgetTheme.selectionMarkerSize
        }
    }

    private var trailingControlWidth: CGFloat { Self.trailingControlWidth(for: mode) }

    /// Whether this row is currently picked, in select mode — `false` for
    /// every other mode. Drives the row's background tint.
    private var isSelected: Bool {
        if case .select(let selected) = mode { return selected }
        return false
    }

    /// The title/due-time content shared by every mode — ONLY the wrapper
    /// (`Link`, or `Button` in select mode) and the trailing control change
    /// per mode.
    @ViewBuilder
    private var titleAndDueTime: some View {
        // .firstTextBaseline keeps the due time on the title's first line
        // when the title wraps. The due time sits at the END of this HStack —
        // "just left of the checkbox" (Trent, 2026-09-23).
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if showsProjectEdge {
                Capsule()
                    .fill(projectColor)
                    .frame(width: 3, height: max(height - 2, 10))
                    // Its bottom sits on the title's first baseline
                    // otherwise; this lines its top up with the text.
                    .alignmentGuide(.firstTextBaseline) { $0[.top] + firstLineHeight * 0.75 }
            }
            Text(task.title)
                .font(.subheadline)
                .fontWeight(WidgetTheme.priorityWeight(task.priority))
                .foregroundStyle(.primary)
                .modifier(RowTitleFit(lines: lines, height: height, shrinks: shrinks))

            if task.dueDate != nil {
                // Day-naming (2026-09-23): "8:30 PM" today, "Tomorrow
                // 9:00 AM", "Sun 9:00 AM" (2-6 days out), "Oct 1 9:00
                // AM" (further), "Oct 2" (date-only). Overdue is
                // unchanged — plain time, red — see
                // `WidgetTheme.dueLabelText`'s doc.
                //
                // `fixedSize` (2026-09-24): exactly the lines it was built
                // with (one, or two when `dueStacked` — an explicit break,
                // never a wrap), at exactly the width the title's line count
                // was measured against. Left flexible, the HStack used to
                // wrap it on its own ("Tomorrow / 4:00 pm") and hand the
                // freed width to a title whose line count had been measured
                // without it — the row kept an empty third line.
                WidgetTheme.dueLabelText(for: task, now: now, stacked: dueStacked)
                    .font(.caption2)
                    .monospacedDigit()
                    .multilineTextAlignment(.trailing)
                    .lineLimit(dueStacked ? 2 : 1)
                    .fixedSize()
            }
        }
        .contentShape(Rectangle())
    }

    /// The leading content's TAP WRAPPER — a `Link` to the task in normal/
    /// snooze mode, a `Button` toggling selection in select mode (mockup:
    /// "tapping a row selects it").
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

    /// The trailing control — the check-off square, snooze mode's ⏭/+1h
    /// pair, or select mode's selection circle.
    @ViewBuilder
    private var trailingControl: some View {
        switch mode {
        case .normal:
            Button(intent: CompleteTaskIntent(taskId: task.id, kind: TasksWidget.kind)) {
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .strokeBorder(projectColor, lineWidth: 1.5)
                    .frame(width: 16, height: 16)
                    // THREE frames — see `ReminderRow`'s identical trick: the
                    // square is centred within one line's height, and only
                    // THEN pinned to the top of the full target, so it sits
                    // on the title's FIRST line and the hit target hangs
                    // below it for a wrapped title.
                    .frame(width: WidgetTheme.rowMarkerSize, height: firstLineHeight)
                    .padding(.top, markerBleed)
                    .frame(width: WidgetTheme.rowMarkerSize, height: height + 2 * markerBleed, alignment: .top)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.vertical, -markerBleed)
        case .snooze:
            SnoozeRowButtons(taskId: task.id)
                .frame(width: trailingControlWidth, height: height, alignment: .top)
        case .select:
            SelectionMarker(isSelected: isSelected)
                .frame(width: trailingControlWidth, height: height, alignment: .top)
        }
    }

    var body: some View {
        // .top, not .center: on a two-line row a centred marker floats down
        // into the gap between the lines, reading as if it belongs to neither.
        HStack(alignment: .top, spacing: 10) {
            titleContent
            trailingControl
        }
        // Selected-row background (select mode only) — bled OUTWARD via
        // negative padding on the FILL SHAPE, not on the row's own content,
        // so the row's layout size never changes between selected and
        // unselected.
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
/// The title wraps in full, like `DoneReminderRow`'s (2026-09-24 — it was
/// `.lineLimit(1)` as "secondary content"; the never-truncate rule has no
/// exception for done). `height` (the title's lines + 1pt + a caption2
/// line) is what the pager counted.
private struct DoneTaskRow: View {
    let completion: CompletionDTO
    let projectColor: Color
    let firstLineHeight: CGFloat
    /// Title lines — wrapped in full since 2026-09-24 (it was `.lineLimit(1)`).
    let lines: Int
    let height: CGFloat
    /// The title's share of `height` (minus the "Done H:MM" line).
    let titleHeight: CGFloat
    let shrinks: Bool

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
                        .modifier(RowTitleFit(lines: lines, height: shrinks ? titleHeight : 0, shrinks: shrinks))
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
                    // Centred on the title line, the target spanning the
                    // whole two-line row — same trick as `TaskRow`'s marker.
                    .frame(width: WidgetTheme.rowMarkerSize, height: firstLineHeight)
                    .frame(width: WidgetTheme.rowMarkerSize, height: height, alignment: .top)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            // Belt and braces: `TasksTimeline.doneTasks` already keeps quota
            // completions out of this list, and /undone refuses a quota.
            .disabled(completion.isQuota)
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
                // Shrinks rather than truncating (2026-09-24).
                Text(entry.tasks.first?.title ?? "Nothing due today")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .minimumScaleFactor(WidgetTheme.overflowTitleScale)
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
