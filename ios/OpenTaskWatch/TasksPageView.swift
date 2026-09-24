import SwiftUI

/// Tasks page: "Up next" (every open, dated, non-reminder, non-tracked task,
/// soonest first — `WatchSlotLogic.upNextTasks`, the same scope as the phone
/// Tasks widget's "Up next" page). Tap a row to complete; swipe for
/// per-task snooze ("Next period" / "+1 hour"); a banner button when
/// anything is overdue opens the bulk-snooze sheet.
struct TasksPageView: View {
    @ObservedObject var model: WatchViewModel
    @State private var showingBulkSheet = false

    private var upNext: [TaskDTO] { model.upNextTasks }
    private var overdueCount: Int { model.overdueTasks.count }

    var body: some View {
        // See `RemindersPageView`'s doc: `.navigationTitle` anchors to the
        // single `NavigationStack` `WatchRootView` wraps around the TabView.
        List {
            if overdueCount > 0 {
                Button {
                    showingBulkSheet = true
                } label: {
                    HStack {
                        Image(systemName: "clock.badge.exclamationmark")
                        Text("All overdue (\(overdueCount))")
                        Spacer()
                    }
                    .foregroundStyle(.orange)
                }
                .listRowBackground(Color.orange.opacity(0.15))
            }

            if upNext.isEmpty {
                AllCaughtUpView()
                    .listRowBackground(Color.clear)
            } else {
                ForEach(upNext) { task in
                    TaskRow(task: task, project: model.project(for: task))
                        .contentShape(Rectangle())
                        .onTapGesture { model.completeTask(task) }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button {
                                model.snoozeTaskToNextPeriod(task)
                            } label: {
                                Label("Next period", systemImage: "arrow.right.to.line")
                            }
                            .tint(WatchTheme.accent)

                            Button {
                                model.snoozeTaskPlusHour(task)
                            } label: {
                                Label("+1 hour", systemImage: "clock.badge.plus")
                            }
                            .tint(.gray)
                        }
                }
            }
        }
        .navigationTitle("Tasks")
        .refreshable {
            await model.load()
        }
        .sheet(isPresented: $showingBulkSheet) {
            BulkSnoozeSheetView(model: model, isPresented: $showingBulkSheet)
        }
    }
}

/// One "Up next" row: a project-colored leading edge (the same visual as the
/// phone Tasks widget's row marker, §-doc "outlines in the task's PROJECT
/// color"), an un-truncated title up to 3 lines (Trent's "never truncate a
/// reminder" rule extends here to 3 lines rather than unlimited — a task
/// title genuinely can run long, and the watch has no room to show every
/// line of a paragraph), and a day-aware due line.
private struct TaskRow: View {
    let task: TaskDTO
    let project: ProjectDTO?

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            RoundedRectangle(cornerRadius: 2)
                .fill(WatchTheme.projectColor(project?.color))
                .frame(width: 3)

            VStack(alignment: .leading, spacing: 2) {
                Text(task.title)
                    .font(.body.weight(WatchTheme.priorityWeight(task.priority)))
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)

                if let due = task.dueDate {
                    Text(WatchFormatting.dueLine(for: due))
                        .font(.caption2)
                        .foregroundStyle(task.isOverdue() ? .orange : .secondary)
                }
            }
        }
    }
}
