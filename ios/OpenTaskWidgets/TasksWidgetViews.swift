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
        default:
            // 6 was tuned against iOS's per-row cost (2 lines always
            // reserved, ~40pt). On macOS rows are now sized to their real
            // content (see WidgetTheme's "macOS row-height truthing" note) —
            // often under half that — so 6 stops being "as many as fit"
            // well before the card is full. `listContent`'s candidate list
            // is extended to match on macOS; iOS keeps the original 6.
            #if os(macOS)
            TasksListView(entry: entry, maxRows: 10, isLarge: true)
            #else
            TasksListView(entry: entry, maxRows: 6, isLarge: true)
            #endif
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
                    if entry.scope != WidgetStore.allProjects {
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

    /// The scope ring is All + every project with something due, and it wraps
    /// (`ShiftProjectScopeIntent`), so both chevrons stay live as long as there
    /// is somewhere else to be. One project and nothing pages.
    private var canPage: Bool { ringLabels.count > 1 }

    /// Ring labels in scope order: "All" first, then the projects.
    private var ringLabels: [(id: Int, name: String)] {
        [(WidgetStore.allProjects, "All")] + entry.projects.map { ($0.id, $0.name) }
    }

    private var rowSpacing: CGFloat {
        isLarge ? WidgetTheme.rowSpacing : WidgetTheme.compactRowSpacing
    }

    var body: some View {
        if entry.isSignedOut {
            WidgetSignedOutView()
        } else {
            #if os(macOS)
            // GeometryReader OUTSIDE ViewThatFits — never inside a candidate,
            // which would report "fits" at every height and defeat the whole
            // mechanism (see WidgetTheme's "macOS row-height truthing" note).
            // Reports the card's real width so each row can measure its own
            // title instead of assuming a flat two-line budget.
            GeometryReader { geo in
                listContent(width: geo.size.width)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            #else
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
            #endif
        }
    }

    /// `width`: the row's real available width — non-nil only on macOS (see
    /// `body`); always `nil` on iOS, where rows never consult it.
    @ViewBuilder
    private func listContent(width: CGFloat?) -> some View {
        // Tallest first — ViewThatFits renders the first that fits. Written
        // out rather than looped: ViewThatFits has to see each candidate as
        // its own child, and a ForEach would hand it one.
        #if os(macOS)
        // Extended to match macOS's raised `maxRows` ceiling (see `content`
        // above) — `min(N, maxRows)` still no-ops harmlessly if maxRows is
        // ever lower than 10.
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
        #else
        ViewThatFits(in: .vertical) {
            card(rows: min(6, maxRows), width: width)
            card(rows: min(5, maxRows), width: width)
            card(rows: min(4, maxRows), width: width)
            card(rows: min(3, maxRows), width: width)
            card(rows: min(2, maxRows), width: width)
            card(rows: 1, width: width)
        }
        #endif
    }

    private func card(rows: Int, width: CGFloat?) -> some View {
        VStack(alignment: .leading, spacing: rowSpacing) {
            header

            if entry.tasks.isEmpty {
                WidgetEmptyView(symbol: "checkmark.circle", message: "Nothing due today")
            } else {
                VStack(alignment: .leading, spacing: rowSpacing) {
                    ForEach(entry.tasks.prefix(rows)) { task in
                        TaskRow(
                            task: task, now: entry.date, titleLineLimit: isLarge ? 2 : 1,
                            availableWidth: width
                        )
                    }
                }
                // systemMedium drops the overflow line, as Track's does: at 4×2
                // that band costs a whole row, and the header's count already
                // states the total.
                //
                // A tap target, same as the header — see RemindersListView's
                // identical comment.
                if isLarge, entry.tasks.count > rows {
                    Link(destination: WidgetLink.dashboard) {
                        Text("+\(entry.tasks.count - rows) more")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
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

    /// The header IS the card's tap target now that the whole-card link is
    /// gone (see `TasksListView.body`) — see `RemindersListView.header` for
    /// why the `Link` wraps only the text and not the `ChevronPager`, and why
    /// it isn't stretched to a 40pt frame.
    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: WidgetTheme.headerSpacing) {
            Link(destination: WidgetLink.dashboard) {
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 5) {
                        if entry.scope != WidgetStore.allProjects {
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
                    Text(countLabel)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .contentShape(Rectangle())
            }
            Spacer(minLength: 0)
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

/// An ordinary task row: check off on the left, open on the title.
///
/// In systemLarge the title wraps to two lines. A task cut at one line
/// ("Register Josie for Viking Vo…") is a task you have to open the app to
/// identify, which is the one thing the widget exists to save you.
private struct TaskRow: View {
    let task: TaskDTO
    let now: Date
    var titleLineLimit = 2
    /// The row's real available width, threaded down from `TasksListView`'s
    /// `GeometryReader` — macOS only; always `nil` on iOS. See WidgetTheme's
    /// "macOS row-height truthing" note.
    var availableWidth: CGFloat? = nil

    private var isOverdue: Bool { task.isOverdue(now: now) }

    #if os(macOS)
    /// Real per-title line count at this row's actual text column: the card
    /// width minus the 36pt marker, its 10pt `HStack` spacing, and — when a
    /// due time shows — that label's own measured width plus its 8pt
    /// spacing. The title's column is narrower whenever a due time sits
    /// beside it, so the due time has to be measured first.
    private var measuredLines: Int {
        guard let availableWidth else { return titleLineLimit }
        var textWidth = availableWidth - 36 - 10
        if let due = task.dueDate {
            let dueWidth = WidgetTheme.measuredWidth(
                for: WidgetTheme.shortTime(due), font: WidgetTheme.caption2Font
            )
            textWidth -= dueWidth + 8
        }
        let font = WidgetTheme.subheadlineFont(weight: WidgetTheme.priorityWeight(task.priority))
        return WidgetTheme.measuredLineCount(for: task.title, maxWidth: textWidth, font: font)
    }
    #endif

    /// The row's reserved text height — macOS: the title's REAL measured
    /// line count; iOS: unchanged, the flat `titleLineLimit` budget (same
    /// formula this always used).
    private var reservedHeight: CGFloat {
        #if os(macOS)
        CGFloat(measuredLines) * WidgetTheme.rowTitleLineHeight
        #else
        CGFloat(titleLineLimit) * WidgetTheme.rowTitleLineHeight
        #endif
    }

    /// `nil` (unlimited) on macOS — `reservedHeight` above already reserves
    /// the title's real line count, so nothing needs to cap and ellipsize
    /// it. iOS keeps the flat cap unchanged.
    private var lineLimitValue: Int? {
        #if os(macOS)
        nil
        #else
        titleLineLimit
        #endif
    }

    var body: some View {
        // .top, not .center: on a two-line row a centred dot floats down into
        // the gap between the lines, reading as if it belongs to neither.
        HStack(alignment: .top, spacing: 10) {
            Button(intent: CompleteTaskIntent(taskId: task.id, kind: TasksWidget.kind)) {
                Circle()
                    .fill(WidgetTheme.priorityColor(task.priority))
                    .frame(width: 9, height: 9)
                    // The dot centres on the title's first line; the hit
                    // target then hangs below it (26pt missed too often,
                    // iOS's finger-sized floor). macOS matches the row's own
                    // reserved height instead of that flat 36 — see
                    // WidgetTheme's "macOS row-height truthing" note.
                    .frame(width: 36, height: WidgetTheme.rowTitleLineHeight)
                    #if os(macOS)
                    .frame(width: 36, height: reservedHeight, alignment: .top)
                    #else
                    .frame(width: 36, height: 36, alignment: .top)
                    #endif
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Link(destination: WidgetLink.task(task.id)) {
                // .firstTextBaseline keeps the due time on the title's first
                // line when the title wraps, rather than drifting down beside
                // the second.
                HStack(alignment: .firstTextBaseline, spacing: 8) {
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
