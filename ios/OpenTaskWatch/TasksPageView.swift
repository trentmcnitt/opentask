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
                    .tint(WatchTheme.accent)
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

/// One "Up next" row: a project-coloured leading edge (the phone Tasks
/// widget's old marker, §-doc "outlines in the task's PROJECT color"), an
/// un-truncated title up to 3 lines (Trent's "never truncate a reminder"
/// rule extends here to 3 lines rather than unlimited — a task title
/// genuinely can run long, and the watch has no room to show every line of a
/// paragraph), and a day-aware due line.
///
/// THE LEAN ROW (2026-10-28, the web's PR #410, `LeanRow` / `LeanRowStyle`):
/// - High "!" / Urgent "!!" right after the title, bound to its last word
///   (Medium, Low and None get none); the corner strip at the row's trailing
///   top, and its horizon dot, are gone.
/// - The due line is the target's BLUE (the dark value — the watch is always
///   dark), over target too; the attempts count "· 3×" is grey; a red flag
///   once the deadline has passed.
/// - The row's STATE is its tint over the list platter (`LeanRow.state`): a
///   passed deadline red, over target blue (the normal title ink), a
///   target later today a faint blue. The edge's plum while over target
///   (2026-10-11) went with it: the edge is the project's colour only.
private struct TaskRow: View {
    let task: TaskDTO
    let project: ProjectDTO?

    /// The watch is always dark.
    private let scheme: ColorScheme = .dark

    private var state: LeanRow.State? {
        LeanRow.state(task, isOverdue: task.isOverdue(), now: Date(), day: DayStartStore.current)
    }

    /// The due line, then the attempts count folded into it (spec §7,
    /// 2026-10-12, the Tasks widget's "Thu · 3×"): the server's "3×"
    /// (`attempts_label`) — the days the task was over target, never counted
    /// here — grey, semibold, no pill. Then a red flag once the deadline has
    /// passed.
    private func dueLine(_ due: Date) -> Text {
        var line = Text(WatchFormatting.dueLine(for: due))
            .foregroundStyle(LeanRowStyle.target(scheme, isOverdue: task.isOverdue()))
        if let label = TargetAge.attemptsBadge(task) {
            line = line + Text(" · ").foregroundStyle(.secondary)
                + Text(label).fontWeight(.semibold).monospacedDigit().foregroundStyle(.secondary)
        }
        if TargetAge.isPastDeadline(task) {
            line = line + Text("\u{00A0}")
                + Text(Image(systemName: "flag.fill")).font(.system(size: 9, weight: .semibold))
                .foregroundStyle(LeanRowStyle.passed(scheme))
        }
        return line
    }

    /// The list platter's grey on watchOS 26 (#222223, read off a render)
    /// with the state's dark tint (`LeanRow.tint`) composited over it —
    /// opaque, since a platter tint replaces the platter's colour. Nil for a
    /// state with no tint (later today, since 2026-10-29): the plain platter.
    static func platterTint(_ state: LeanRow.State) -> Color? {
        let platter: (r: Double, g: Double, b: Double) = (34, 34, 35)
        guard let tone = LeanRow.tint(state)?.dark else { return nil }
        let a = tone.alpha
        func mix(_ base: Double, _ shift: UInt32) -> Double {
            (base * (1 - a) + Double((tone.hex >> shift) & 0xFF) * a) / 255
        }
        return Color(red: mix(platter.r, 16), green: mix(platter.g, 8), blue: mix(platter.b, 0))
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
        let state = state
        HStack(alignment: .top, spacing: 6) {
            RoundedRectangle(cornerRadius: 2)
                .fill(WatchTheme.projectColor(project?.color))
                .frame(width: 3)

            VStack(alignment: .leading, spacing: 2) {
                LeanRowStyle.titleWithMark(Text(task.title), priority: task.priority)
                    .font(.body.weight(WatchTheme.priorityWeight(task.priority)))
                    .foregroundStyle(.primary)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
                    .accessibilityLabel(Text(LeanRowStyle.spokenTitle(task.title, priority: task.priority)))

                if let due = task.dueDate {
                    dueLine(due)
                        .font(.caption2)
                        .accessibilityLabel(Text(spokenDueLine(due)))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        // The tint IS the row's platter: `listItemTint` recolours the
        // system platter (its shape and insets kept), with
        // the tint laid over the platter's own grey (`platterTint`), so a
        // tinted row reads as the web's tint over its row, not a new hue.
        .listItemTint(state.flatMap(Self.platterTint).map { ListItemTint.fixed($0) })
    }
}

#if DEBUG
// The lean row (2026-10-28): every mark and tint on the first screens — see
// `WatchPreviewData.cornerTasks`.
#Preview("Tasks — lean row") {
    NavigationStack {
        TasksPageView(model: .previewTasks())
    }
}

// The same corpus past its two overdue rows (so no sweep button): a target
// later today (the faint tint), "!!" and "!" after titles, Medium and Low
// with no mark.
#Preview("Tasks — lean row, upcoming rows") {
    NavigationStack {
        TasksPageView(model: .previewTasks(Array(WatchPreviewData.cornerTasks.dropFirst(2))))
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

#Preview("Tasks — lean row, XXX Large") {
    NavigationStack {
        TasksPageView(model: .previewTasks())
    }
    .dynamicTypeSize(.xxxLarge)
}
#endif
