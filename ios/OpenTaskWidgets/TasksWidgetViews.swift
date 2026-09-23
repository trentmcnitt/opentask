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

                    if let due = next.dueDate {
                        Text(WidgetTheme.shortTime(due))
                            .font(.caption2)
                            .monospacedDigit()
                            .foregroundStyle(
                                next.isOverdue(now: entry.date)
                                    ? Color.red.opacity(0.9) : Color.secondary
                            )
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
        return VStack(alignment: .leading, spacing: rowSpacing) {
            header

            if entry.tasks.isEmpty {
                WidgetEmptyView(symbol: "checkmark.circle", message: "Nothing due today")
            } else {
                VStack(alignment: .leading, spacing: rowSpacing) {
                    ForEach(window.items) { task in
                        TaskRow(
                            task: task, now: entry.date, titleLineLimit: isLarge ? 2 : 1,
                            availableWidth: width, projectColor: entry.projectColor(for: task),
                            // Project edge: systemLarge, unified pages only —
                            // see `TaskRow.showsProjectEdge`.
                            showsProjectEdge: isLarge && entry.isUnifiedScope
                        )
                    }
                }
                // systemMedium drops this band, as Track's does: at 4×2 it
                // costs a whole row, and the header's count already states
                // the total — there is no pager at that size.
                //
                // The bottom pager (2026-09-23) replacing "+N more" — see
                // `RemindersListView.card`'s identical comment; tapping
                // "+N more" used to open the app, paging in place replaces it.
                if isLarge, window.totalPages > 1 {
                    ListPager(
                        page: window.page,
                        totalPages: window.totalPages,
                        previous: ShiftTasksPageIntent(offset: -1),
                        next: ShiftTasksPageIntent(offset: 1)
                    )
                }
            }

            if let staleSince = entry.staleSince {
                HStack {
                    Spacer()
                    StalenessNote(fetchedAt: staleSince)
                }
            }
        }
    }

    /// A page window into `entry.tasks`, the Tasks twin of
    /// `RemindersListView.pagedReminders` — see that function's doc for the
    /// paging math and its accepted imperfection.
    private func pagedTasks(rows: Int) -> (items: [TaskDTO], page: Int, totalPages: Int) {
        guard rows > 0, !entry.tasks.isEmpty else {
            return (entry.tasks, 0, 1)
        }
        let totalPages = max(1, Int(ceil(Double(entry.tasks.count) / Double(rows))))
        let page = min(max(WidgetStore.tasksPage(for: entry.scope), 0), totalPages - 1)
        let start = page * rows
        let end = min(start + rows, entry.tasks.count)
        return (Array(entry.tasks[start..<end]), page, totalPages)
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
                    Text(entry.actionDescription ?? countLabel)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                .contentShape(Rectangle())
            }
            Spacer(minLength: 0)
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

    private var countLabel: String {
        guard !entry.tasks.isEmpty else { return "all clear" }
        let overdue = entry.overdueCount(now: entry.date)
        let due = "\(entry.tasks.count) due"
        // "300 due · 300 overdue" is pure noise — when everything due is
        // overdue, one number tells the whole story.
        if overdue == entry.tasks.count { return "\(overdue) overdue" }
        return overdue > 0 ? "\(due) · \(overdue) overdue" : due
    }
}

/// An ordinary task row: a tappable title (with its due time just before the
/// checkbox) and, at the row's trailing edge, a square check-off.
///
/// In systemLarge the title wraps rather than truncating at one line
/// ("Register Josie for Viking Vo…" is a task you have to open the app to
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

    private var isOverdue: Bool { task.isOverdue(now: now) }

    /// Real per-title line count at this row's actual text column: the card
    /// width minus the marker column, its 10pt `HStack` spacing, the project
    /// edge (3pt plus its 8pt spacing, when shown), and — when a due time shows — that label's own measured
    /// width plus its 8pt spacing. The title's column is narrower whenever a
    /// due time or chip sits beside it, so both are measured/reserved first.
    /// Capped on iOS — see WidgetTheme's "row-height truthing" note, the
    /// 2026-09-23 addendum.
    private var measuredLines: Int {
        guard let availableWidth else { return titleLineLimit }
        var textWidth = availableWidth - WidgetTheme.rowMarkerSize - 10
        if showsProjectEdge {
            textWidth -= 3 + 8
        }
        if let due = task.dueDate {
            let dueWidth = WidgetTheme.measuredWidth(
                for: WidgetTheme.shortTime(due), font: WidgetTheme.caption2Font
            )
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

    var body: some View {
        // .top, not .center: on a two-line row a centred marker floats down
        // into the gap between the lines, reading as if it belongs to neither.
        HStack(alignment: .top, spacing: 10) {
            Link(destination: WidgetLink.task(task.id)) {
                // .firstTextBaseline keeps the due time on the title's first
                // line when the title wraps, rather than drifting down beside
                // the second. The due time sits at the END of this HStack —
                // "just left of the checkbox" (Trent, 2026-09-23), which falls
                // out naturally once the checkbox itself moved to the row's
                // trailing edge below.
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

                    if let due = task.dueDate {
                        Text(WidgetTheme.shortTime(due))
                            .font(.caption2)
                            .monospacedDigit()
                            .foregroundStyle(isOverdue ? Color.red.opacity(0.9) : Color.secondary)
                    }
                }
                .contentShape(Rectangle())
            }

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
