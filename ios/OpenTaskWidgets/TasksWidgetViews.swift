import SwiftUI
import WidgetKit

/// The Tasks widget's rendering, across all four supported families.
///
/// Two row shapes share the list. An ordinary task is a dot, a title and a due
/// time. A *tracked* task (§5, `progress_target > 1`) is a quota, so it renders
/// its count and a bar instead of a check-off — and its button is `+1`, which
/// hits `/api/tasks/:id/progress` rather than a completion endpoint. That
/// distinction is the whole point of Track: at 2/2 the task is met but still
/// open, so a third log shows 3/2 rather than being swallowed.
struct TasksWidgetView: View {
    @Environment(\.widgetFamily) private var family

    let entry: TasksEntry

    var body: some View {
        content
            .containerBackground(for: .widget) {
                if family == .systemMedium || family == .systemLarge {
                    Rectangle().fill(.fill.tertiary)
                } else {
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
        case .systemMedium:
            TasksListView(entry: entry, maxRows: 3)
        default:
            TasksListView(entry: entry, maxRows: 6)
        }
    }
}

// MARK: - Home Screen list

private struct TasksListView: View {
    let entry: TasksEntry
    let maxRows: Int

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
                            if task.isTracked {
                                TrackedTaskRow(task: task)
                            } else {
                                TaskRow(task: task, now: entry.date)
                            }
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
                next: ShiftProjectScopeIntent(offset: 1)
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
                    .frame(width: 26, height: 26)
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

/// A tracked task (§5): count, bar, and a `+1` that logs progress.
private struct TrackedTaskRow: View {
    let task: TaskDTO

    private var fraction: Double {
        guard task.progressTarget > 0 else { return 0 }
        return min(Double(task.progressCurrent) / Double(task.progressTarget), 1)
    }

    private var barColor: Color {
        task.isProgressMet ? .green : WidgetTheme.priorityColor(max(task.priority, 2))
    }

    var body: some View {
        HStack(spacing: 10) {
            Link(destination: WidgetLink.task(task.id)) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(task.title)
                            .font(.subheadline)
                            .fontWeight(WidgetTheme.priorityWeight(task.priority))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)

                        // Overflow (3/2) stays visible — the count is the fact,
                        // the bar only tracks the first `target`.
                        Text("\(task.progressCurrent)/\(task.progressTarget)")
                            .font(.caption2)
                            .monospacedDigit()
                            .foregroundStyle(task.isProgressMet ? Color.green : Color.secondary)
                    }

                    ProgressView(value: fraction)
                        .progressViewStyle(.linear)
                        .tint(barColor)
                        .scaleEffect(x: 1, y: 0.7, anchor: .center)
                }
                .contentShape(Rectangle())
            }

            Button(intent: IncrementProgressIntent(taskId: task.id)) {
                Text("+1")
                    .font(.caption.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(.primary)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(.fill.secondary, in: Capsule())
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
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
