import SwiftUI
import WatchKit

/// Tasks page: "Up next" (every open, dated, non-reminder, non-tracked task,
/// soonest first — `WatchSlotLogic.upNextTasks`, the same scope as the phone
/// Tasks widget's "Up next" page). Tap a row to complete; touch and hold for
/// per-task snooze ("Next period" / "+1 hour"); a "Snooze all over target"
/// button when anything is over target opens the bulk-snooze sheet.
///
/// Per-task snooze was a trailing `.swipeActions` until 2026-09-24, when the
/// root pager turned horizontal (`WatchRootView`): this is the MIDDLE page,
/// so a left swipe on a row now means "next page" too. Verified in the
/// watchOS 26.5 simulator — even a short, slow left swipe on a row flipped
/// to Quotas (and half-opened the row's actions behind it), and a leading
/// swipe would collide with "back to Reminders" the same way. A long press
/// is the one row gesture the pager doesn't claim.
struct TasksPageView: View {
    @ObservedObject var model: WatchViewModel
    @State private var showingBulkSheet = false
    /// The row whose long-press snooze chooser is open.
    @State private var snoozeTarget: TaskDTO?

    private var upNext: [TaskDTO] { model.upNextTasks }
    private var overdueCount: Int { model.overdueTasks.count }

    var body: some View {
        // See `RemindersPageView`'s doc: `.navigationTitle` anchors to the
        // single `NavigationStack` `WatchRootView` wraps around the TabView.
        List {
            // Same `hasLoadedOnce` gate as the Reminders page — see
            // `WatchViewModel.hasLoadedOnce`'s doc. Without it, "All caught
            // up" flashes for the first ~1-3s of every launch before real
            // data lands.
            if !model.hasLoadedOnce {
                HStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
                .listRowBackground(Color.clear)
            } else if let error = model.loadError, model.tasks.isEmpty {
                LoadErrorView(message: error)
                    .listRowBackground(Color.clear)
            } else {
                if overdueCount > 0 {
                    // An ACTION, and it must read as one (Trent, 2026-10-11:
                    // "All over target (4)" looked like a section header): a
                    // verb, and a filled capsule button set apart from the
                    // rows below, rather than a tinted row.
                    Button {
                        showingBulkSheet = true
                    } label: {
                        Label(
                            "Snooze all \(TaskWording.overTargetLower) (\(overdueCount))",
                            systemImage: "moon.zzz.fill"
                        )
                        .font(.footnote.weight(.semibold))
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.capsule)
                    .tint(WatchTheme.overdue)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 2, leading: 0, bottom: 6, trailing: 0))
                }

                if upNext.isEmpty {
                    AllCaughtUpView()
                        .listRowBackground(Color.clear)
                } else {
                    ForEach(upNext) { task in
                        TaskRow(task: task, project: model.project(for: task))
                            .contentShape(Rectangle())
                            .onTapGesture { model.completeTask(task) }
                            // `minimumDuration` 0.4s: long enough that a
                            // tap still completes and a scroll never
                            // triggers it, short enough not to feel stuck.
                            .onLongPressGesture(minimumDuration: 0.4) {
                                WKInterfaceDevice.current().play(.click)
                                snoozeTarget = task
                            }
                    }
                }
            }
        }
        .navigationTitle("Tasks")
        // Undo on every page (Trent, 2026-10-11): the Reminders and Quotas
        // pages' toolbar Undo, here too — a tap completes a task, so this page
        // needs it most.
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    model.undo()
                } label: {
                    Image(systemName: "arrow.uturn.backward.circle")
                }
                .disabled(!model.canUndo)
            }
        }
        .refreshable {
            await model.load()
        }
        .sheet(isPresented: $showingBulkSheet) {
            BulkSnoozeSheetView(model: model, isPresented: $showingBulkSheet)
        }
        // A chooser, not a confirmation: each button IS the action (Trent's
        // "undo over confirm" rule — both land in the toolbar-Undo log).
        // Both count from the task's own due time while it is upcoming
        // (`WatchViewModel.snoozeTask` → the phone's shared `TaskSnoozePlan`).
        .confirmationDialog(
            snoozeTarget?.title ?? "Snooze",
            isPresented: Binding(
                get: { snoozeTarget != nil },
                set: { if !$0 { snoozeTarget = nil } }
            ),
            titleVisibility: .visible,
            presenting: snoozeTarget
        ) { task in
            // Disabled with no cached time slots (nothing to plan against),
            // like the phone's dimmed ⏭ — never a tap that just buzzes.
            Button("Next period") { model.snoozeTask(task, target: .nextPeriod) }
                .disabled(TimeSlotStore.cachedSlots.isEmpty)
            Button("+1 hour") { model.snoozeTask(task, target: .plusOneHour) }
        }
    }
}

/// One "Up next" row: a project-colored leading edge (plum while over target) (the same visual as the
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
            // The project's color — or plum once the task is over target, the
            // web row's stripe (2026-10-11), so the edge and the time agree.
            RoundedRectangle(cornerRadius: 2)
                .fill(task.isOverdue() ? WatchTheme.overdue : WatchTheme.projectColor(project?.color))
                .frame(width: 3)

            VStack(alignment: .leading, spacing: 2) {
                Text(task.title)
                    .font(.body.weight(WatchTheme.priorityWeight(task.priority)))
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)

                if let due = task.dueDate {
                    HStack(spacing: 4) {
                        Text(WatchFormatting.dueLine(for: due))
                            .font(.caption2)
                            .foregroundStyle(task.isOverdue() ? WatchTheme.overdue : .secondary)
                        // The attempts badge (spec §7, 2026-10-12): the
                        // server's "3×" (`attempts_label`) — the days the task
                        // was over target, never counted here — in the
                        // Tasks widget's tab: plum on a plum tint for 1–6,
                        // white on solid plum for 7+. It replaced the
                        // device-computed "2d" age tab. Then a red flag once
                        // the deadline has passed (red is for that only).
                        if let label = TargetAge.attemptsBadge(task) {
                            let strong = TargetAge.tone(attempts: task.attempts) == .strong
                            let medium = TargetAge.tone(attempts: task.attempts) == .medium
                            Text(label)
                                .font(.caption2.weight(.semibold).monospacedDigit())
                                .foregroundStyle(strong ? Color.white : WatchTheme.overdue)
                                .padding(.horizontal, 3)
                                .background(
                                    RoundedRectangle(cornerRadius: 3)
                                        .fill(strong ? WatchTheme.overTargetBadge : WatchTheme.overdue.opacity(medium ? 0.15 : 0.08))
                                )
                                .accessibilityLabel(
                                    Text("\(TaskWording.overTarget) on \(task.attempts) day\(task.attempts == 1 ? "" : "s")")
                                )
                        }
                        if TargetAge.isPastDeadline(task) {
                            Image(systemName: "flag.fill")
                                .font(.system(size: 9, weight: .semibold))
                                .foregroundStyle(.red)
                                .accessibilityLabel(Text(TaskWording.pastDeadline))
                        }
                    }
                }
            }
        }
    }
}
