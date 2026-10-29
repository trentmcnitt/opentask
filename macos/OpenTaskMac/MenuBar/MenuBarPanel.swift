import SwiftUI

/// The menu bar item's panel (a popover, `StatusItemController`): quick add,
/// then the overdue tasks — or, with nothing overdue, the rest of today —
/// each checkable and snoozable, and a bulk bar for the whole overdue set.
///
/// Row controls mirror the phone Tasks widget's snooze mode: a circle to
/// complete, "⏭" for the next period, "+1h". The bulk bar is the widget's
/// "Defer 2 of 3: ⏭ 4:30 PM · +1h" (`OverdueSweepWords`, 2026-10-26: it
/// read "All overdue (2)" under a header of "3 overdue").
struct MenuBarPanel: View {
    @Environment(\.colorScheme) private var colorScheme
    @ObservedObject var model: MenuBarModel
    @FocusState private var addFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            quickAdd
            Divider()
            content
            if model.sweepCount > 0 {
                Divider()
                bulkBar
            }
            if let note = model.note {
                Text(note)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let error = model.errorText {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .padding(14)
        .frame(width: 360)
        // Opaque: the popover's default glass let the window behind it show
        // through the task titles.
        .background(Color(nsColor: .windowBackgroundColor))
        .task { await model.refresh() }
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 1) {
                Text("OpenTask").font(.headline)
                Text(summary)
                    .font(.caption)
                    // Plain grey, overdue or not (2026-10-28: Trent ruled
                    // plum out, "I can't be memorizing these colors"; it was
                    // plum while anything was overdue). The badge in the menu
                    // bar is what calls for attention.
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                openApp(path: "/")
            } label: {
                Image(systemName: "macwindow")
            }
            .buttonStyle(.borderless)
            .help("Open OpenTask")
        }
    }

    private var summary: String {
        guard model.hasLoaded else { return "Loading…" }
        let n = model.overdue.count
        return n == 0 ? "Nothing \(TaskWording.overdueLower)" : "\(n) \(TaskWording.overdueLower)"
    }

    // MARK: - Quick add

    private var quickAdd: some View {
        HStack(spacing: 6) {
            Image(systemName: "plus")
                .foregroundStyle(.secondary)
            TextField("Add a task…", text: $model.draftTitle)
                .textFieldStyle(.plain)
                .focused($addFocused)
                .onSubmit { model.addDraft() }
                .disabled(model.isAdding)
            if model.isAdding {
                ProgressView().controlSize(.small)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 7).fill(Color.primary.opacity(0.06)))
    }

    // MARK: - Lists

    @ViewBuilder
    private var content: some View {
        let overdue = model.overdue
        if !model.hasLoaded {
            ProgressView().frame(maxWidth: .infinity)
        } else if !overdue.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(overdue.prefix(MenuBarModel.maxRows)) { task in
                    row(task, isOverdue: true)
                }
                if overdue.count > MenuBarModel.maxRows {
                    Button("and \(overdue.count - MenuBarModel.maxRows) more…") {
                        openApp(path: "/?filter=overdue")
                    }
                    .buttonStyle(.link)
                    .font(.caption)
                }
            }
        } else {
            let next = model.nextUp
            VStack(alignment: .leading, spacing: 8) {
                Text(next.isEmpty ? "All clear for today" : "Next up today")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                ForEach(next) { task in
                    row(task, isOverdue: false)
                }
            }
        }
    }

    /// One task row — the web's LEAN ROW rules (2026-10-28, `LeanRow`):
    /// High "!" / Urgent "!!" after the title (none for Medium, Low, None);
    /// the target's time in its blue whether or not it has passed, the
    /// attempts count grey; the row's tint (`LeanRow.state`: a passed deadline
    /// red, over target blue (normal title ink), later today a faint blue),
    /// bled outward behind the row so its size never changes. The square
    /// keeps its PROJECT colour (the panel's only project cue — not a
    /// priority mark, so the lean row's neutral square isn't copied here).
    /// The panel draws no deadline, so no flag or countdown.
    private func row(_ task: TaskDTO, isOverdue: Bool) -> some View {
        let busy = model.busyIds.contains(task.id)
        let state = LeanRow.state(task, isOverdue: isOverdue, now: model.now, day: DayStartStore.current)
        return HStack(alignment: .top, spacing: 8) {
            Button {
                model.complete(task)
            } label: {
                // A task's check-off is a square in its project's colour —
                // the Tasks widget's marker; circles are reminders' (Trent,
                // 2026-09-28).
                RoundedRectangle(cornerRadius: 4, style: .continuous)
                    .strokeBorder(projectColor(for: task), lineWidth: 1.5)
                    .frame(width: 15, height: 15)
                    .padding(.top, 2)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .help("Mark done")

            Button {
                openApp(path: "/?task=\(task.id)&highlight=1")
            } label: {
                VStack(alignment: .leading, spacing: 1) {
                    LeanRowStyle.titleWithMark(Text(task.title), priority: task.priority)
                        .font(.callout.weight(task.priority >= 3 ? .semibold : .regular))
                        .foregroundStyle(.primary)
                        .accessibilityLabel(Text(LeanRowStyle.spokenTitle(task.title, priority: task.priority)))
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    if let due = task.dueDate {
                        // The attempts count (spec §7, 2026-10-12): the
                        // server's "3×" folded into the time, "Thu 9:00 AM ·
                        // 3×" — the Tasks widget's form: grey, semibold, no
                        // pill. Label only (the web's 3× offer stays in the app).
                        let time = Text(dueText(due, isOverdue: isOverdue))
                            .foregroundStyle(LeanRowStyle.target(colorScheme, isOverdue: isOverdue))
                        Group {
                            if let badge = TargetAge.attemptsBadge(task) {
                                time + Text(" · ").foregroundStyle(.secondary)
                                    + Text(badge)
                                    .fontWeight(.semibold)
                                    .foregroundStyle(.secondary)
                            } else {
                                time
                            }
                        }
                        .font(.caption)
                        .accessibilityLabel(Text(
                            TargetAge.attemptsBadge(task) == nil
                                ? dueText(due, isOverdue: isOverdue)
                                : "\(dueText(due, isOverdue: isOverdue)), \(TaskWording.overdueLower) on \(task.attempts) day\(task.attempts == 1 ? "" : "s")"
                        ))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Show in OpenTask")

            HStack(spacing: 4) {
                pill(systemImage: "forward.end.fill", text: nil, filled: true) {
                    model.snooze(task, .nextPeriod)
                }
                .disabled(model.slots.isEmpty)
                .help(nextPeriodHelp(for: task))
                pill(systemImage: nil, text: "+1h", filled: false) {
                    model.snooze(task, .plusOneHour)
                }
                .help("Defer one hour")
            }
        }
        .modifier(LeanRowTint(color: LeanRowStyle.tint(state, colorScheme), horizontal: 6, vertical: 3))
        .opacity(busy ? 0.4 : 1)
        .disabled(busy || model.isSweeping)
    }

    // MARK: - Bulk

    private var bulkBar: some View {
        HStack(spacing: 6) {
            Text(OverdueSweepWords.barLabel(count: model.sweepCount, total: model.overdue.count))
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: 4)
            if model.isSweeping {
                ProgressView().controlSize(.small)
            }
            pill(
                systemImage: "forward.end.fill",
                text: model.nextPeriodStart.map(DateHelpers.formatShortTime),
                filled: true
            ) {
                model.snoozeAll(.nextPeriod)
            }
            .help("Defer everything \(TaskWording.overdueLower) to the next period")
            pill(systemImage: nil, text: "+1h", filled: false) {
                model.snoozeAll(.plusOneHour)
            }
            .help("Defer everything \(TaskWording.overdueLower) one hour")
        }
        .disabled(model.isSweeping)
    }

    // MARK: - Pieces

    private func pill(systemImage: String?, text: String?, filled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 3) {
                if let systemImage { Image(systemName: systemImage).font(.system(size: 9, weight: .semibold)) }
                if let text { Text(text) }
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(filled ? Color.white : Color.primary)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Capsule().fill(filled ? Color.indigo : Color.primary.opacity(0.1)))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    /// `WidgetTheme.projectColor`'s palette (the widget's own file is
    /// SwiftUI-heavy and not compiled into the app).
    private func projectColor(for task: TaskDTO) -> Color {
        switch model.projects[task.projectId]?.color {
        case "red": return .red
        case "orange": return .orange
        case "yellow": return .yellow
        case "green": return .green
        case "blue": return .blue
        case "purple": return .purple
        case "pink": return .pink
        case "gray": return .gray
        default: return .secondary
        }
    }

    private func dueText(_ due: Date, isOverdue: Bool) -> String {
        DueLabel.parts(for: due, now: model.now, isOverdue: isOverdue, day: DayStartStore.current).plainString
    }

    private func nextPeriodHelp(for task: TaskDTO) -> String {
        let target = TaskSnoozePlan.target(.nextPeriod, dueAt: task.dueDate, now: model.now, slots: model.slots)
        return target.map { "Defer to \(DateHelpers.formatShortTime($0))" } ?? "Defer to the next period"
    }

    private func openApp(path: String) {
        WebViewManager.shared.navigate(path: path)
        WebViewManager.shared.showWindow()
    }
}
