import SwiftUI
import WatchKit

/// Tasks page: "Up next" (every open, dated, non-reminder, non-tracked task,
/// soonest first — `WatchSlotLogic.upNextTasks`, the same scope as the phone
/// Tasks widget's "Up next" page). Tap a row to complete; touch and hold for
/// per-task snooze ("Next period" / "+1 hour"); a "Defer all overdue"
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
    /// What the sweep would move (`OverdueSweepWords`, 2026-10-26: the button
    /// said "Defer all overdue (3)" for a sweep that moves 2). Zero — only
    /// Urgent left, which a sweep never moves — shows no button: there is
    /// nothing honest for it to say, the phone widget's rule.
    private var sweepCount: Int { model.overdueSweepCount }

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
                if sweepCount > 0 {
                    // An ACTION, and it must read as one (Trent, 2026-10-11:
                    // "All over target (4)" looked like a section header): a
                    // verb, and a filled capsule button set apart from the
                    // rows below, rather than a tinted row. Its words are the
                    // phone's and the Mac's ("Defer 2 of 3", "Defer all 3
                    // overdue", 2026-10-26).
                    Button {
                        showingBulkSheet = true
                    } label: {
                        Label(
                            OverdueSweepWords.label(count: sweepCount, total: overdueCount),
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
            snoozeTarget?.title ?? "Defer",
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
///
/// THE CORNER (2026-10-16, the web row's corner and the phone Tasks widget's
/// strip): at the row's trailing top, the horizon dot where the horizon
/// decides something and "!"/"!!" for High/Urgent only — Medium, Low and None
/// get nothing (`RowCorner`, `RowCornerStrip`). It takes its own column, so a
/// long title wraps a little sooner on those rows only.
private struct TaskRow: View {
    let task: TaskDTO
    let project: ProjectDTO?

    /// The due line, then the attempts count folded into it (spec §7,
    /// 2026-10-12, the Tasks widget's "Thu · 3×"): the server's "3×"
    /// (`attempts_label`) — the days the task was over target, never counted
    /// here — plum, semibold, heavy from 7×, no pill. Then a red flag once
    /// the deadline has passed (red is for that only).
    private func dueLine(_ due: Date) -> Text {
        let overdue = task.isOverdue()
        var line = Text(WatchFormatting.dueLine(for: due))
            .foregroundStyle(overdue ? WatchTheme.overdue : .secondary)
        if let label = TargetAge.attemptsBadge(task) {
            let weight: Font.Weight = TargetAge.tone(attempts: task.attempts) == .strong ? .heavy : .semibold
            line = line + Text(" · ").foregroundStyle(WatchTheme.overdue)
                + Text(label).fontWeight(weight).monospacedDigit().foregroundStyle(WatchTheme.overdue)
        }
        if TargetAge.isPastDeadline(task) {
            line = line + Text("\u{00A0}")
                + Text(Image(systemName: "flag.fill")).font(.system(size: 9, weight: .semibold)).foregroundStyle(.red)
        }
        return line
    }

    private func spokenDueLine(_ due: Date) -> String {
        var words = [WatchFormatting.dueLine(for: due)]
        if TargetAge.attemptsBadge(task) != nil {
            words.append("\(TaskWording.overdueLower) on \(task.attempts) day\(task.attempts == 1 ? "" : "s")")
        }
        if TargetAge.isPastDeadline(task) { words.append(TaskWording.pastDeadline) }
        return words.joined(separator: ", ")
    }

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
                    dueLine(due)
                        .font(.caption2)
                        .accessibilityLabel(Text(spokenDueLine(due)))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            let corner = RowCornerStrip(task: task)
            if !corner.isEmpty {
                // Centred on the `.body` title's first line.
                corner.padding(.top, 4)
            }
        }
    }
}

#if DEBUG
// The row corner (2026-10-16): every state on the first screens — see
// `WatchPreviewData.cornerTasks`.
#Preview("Tasks — row corner") {
    NavigationStack {
        TasksPageView(model: .previewTasks())
    }
}

// The night rule (2026-10-26): `WatchPreviewData.nightTasks` with a 3:00 AM
// day start.
#Preview("Tasks — night labels") {
    let _ = DayStartStore.seedForPreview("03:00")
    NavigationStack {
        TasksPageView(model: .previewTasks(WatchPreviewData.nightTasks))
    }
}

#Preview("Tasks — row corner, XXX Large") {
    NavigationStack {
        TasksPageView(model: .previewTasks())
    }
    .dynamicTypeSize(.xxxLarge)
}
#endif
