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
        case .accessoryCircular:
            TasksCircularView(entry: entry)
        case .accessoryRectangular:
            TasksRectangularView(entry: entry)
        case .systemSmall:
            TasksSmallView(entry: entry)
        case .systemMedium:
            TasksListView(entry: entry, maxRows: 3, showsChevronLabels: false)
        default:
            TasksListView(entry: entry, maxRows: 6, showsChevronLabels: true)
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

private struct TasksListView: View {
    let entry: TasksEntry
    let maxRows: Int
    /// systemLarge only — see `ChevronPager`.
    let showsChevronLabels: Bool

    /// The scope ring is All + every project with something due, and it wraps
    /// (`ShiftProjectScopeIntent`), so both chevrons stay live as long as there
    /// is somewhere else to be. One project and nothing pages.
    private var canPage: Bool { ringLabels.count > 1 }

    /// Ring labels in scope order: "All" first, then the projects.
    private var ringLabels: [(id: Int, name: String)] {
        [(WidgetStore.allProjects, "All")] + entry.projects.map { ($0.id, $0.name) }
    }

    private func neighborLabel(offset: Int) -> String? {
        let ring = ringLabels
        guard ring.count > 1, let index = ring.firstIndex(where: { $0.id == entry.scope })
        else {
            return nil
        }
        let count = ring.count
        return ring[((index + offset) % count + count) % count].name
    }

    var body: some View {
        if entry.isSignedOut {
            WidgetSignedOutView()
        } else {
            VStack(alignment: .leading, spacing: WidgetTheme.rowSpacing) {
                header

                if entry.tasks.isEmpty {
                    WidgetEmptyView(symbol: "checkmark.circle", message: "Nothing due today")
                } else {
                    VStack(alignment: .leading, spacing: WidgetTheme.rowSpacing) {
                        ForEach(entry.tasks.prefix(maxRows)) { task in
                            TaskRow(task: task, now: entry.date)
                        }
                    }
                    if entry.tasks.count > maxRows {
                        Text("+\(entry.tasks.count - maxRows) more")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    Spacer(minLength: 0)
                }

                if let staleSince = entry.staleSince {
                    HStack {
                        Spacer()
                        StalenessNote(fetchedAt: staleSince)
                    }
                }
            }
            .widgetURL(WidgetLink.dashboard)
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: WidgetTheme.headerSpacing) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 5) {
                    if entry.scope != WidgetStore.allProjects {
                        Circle()
                            .fill(entry.scopeColor)
                            .frame(width: 7, height: 7)
                    }
                    Text(entry.scopeLabel)
                        .font(.headline)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                Text(countLabel)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            ChevronPager(
                previous: ShiftProjectScopeIntent(offset: -1),
                next: ShiftProjectScopeIntent(offset: 1),
                hasPrevious: canPage,
                hasNext: canPage,
                previousLabel: neighborLabel(offset: -1),
                nextLabel: neighborLabel(offset: 1),
                showsLabels: showsChevronLabels
            )
        }
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
private struct TaskRow: View {
    let task: TaskDTO
    let now: Date

    private var isOverdue: Bool { task.isOverdue(now: now) }

    var body: some View {
        HStack(spacing: 10) {
            Button(intent: CompleteTaskIntent(taskId: task.id)) {
                Circle()
                    .fill(WidgetTheme.priorityColor(task.priority))
                    .frame(width: 9, height: 9)
                    // 36pt hit target around the 9pt dot — 26pt missed too often.
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Link(destination: WidgetLink.task(task.id)) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(task.title)
                        .font(.subheadline)
                        .fontWeight(WidgetTheme.priorityWeight(task.priority))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)

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
