import SwiftUI

/// Reminders page: the current time slot's reminders (`GET /api/reminders`,
/// same payload the phone widgets render — read-only aside from checking
/// items off, no create/edit on the watch). Title + "N left", a slim
/// per-slot progress strip, ‹ › to page between slots, tap a row to consider
/// (check off) it, and a toolbar Undo. "All caught up" when every slot that
/// has started is finished.
struct RemindersPageView: View {
    @ObservedObject var model: WatchViewModel

    private var group: ReminderGroupDTO? { model.displayedGroup }

    var body: some View {
        // `.navigationTitle`/`.toolbar` anchor to the single `NavigationStack`
        // `WatchRootView` wraps around the whole paged `TabView` — see that
        // file's doc for why a NavigationStack here too (one per page)
        // crashed on first run.
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                header
                if !model.reminderGroups.isEmpty {
                    SlotProgressStrip(groups: model.reminderGroups, currentIndex: model.displayedSlotIndex)
                }

                if let description = model.lastActionDescription {
                    Text(description)
                        .font(.caption2)
                        .foregroundStyle(WatchTheme.accent)
                }

                content
            }
            .padding(.horizontal, 4)
        }
        .navigationTitle("Reminders")
        .toolbar {
            ToolbarItemGroup(placement: .bottomBar) {
                Button {
                    step(-1)
                } label: {
                    Image(systemName: "chevron.left")
                }
                .disabled(model.reminderGroups.count < 2)

                Spacer()

                Button {
                    step(1)
                } label: {
                    Image(systemName: "chevron.right")
                }
                .disabled(model.reminderGroups.count < 2)
            }
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
    }

    @ViewBuilder
    private var header: some View {
        if let group {
            VStack(alignment: .leading, spacing: 2) {
                Text(group.label)
                    .font(.headline)
                Text(group.reminders.isEmpty ? "Done" : "\(group.reminders.count) left")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } else if model.isLoading {
            Text("Reminders")
                .font(.headline)
        }
    }

    @ViewBuilder
    private var content: some View {
        if let group {
            if group.reminders.isEmpty {
                AllCaughtUpView()
            } else {
                // No `lineLimit` here — Trent's rule (memory:
                // "never truncate a reminder"): a reminder is a short
                // prompted thought, and the watch's column is narrow enough
                // that clipping one defeats the point of showing it at all.
                ForEach(group.reminders) { task in
                    Button {
                        model.completeReminder(task)
                    } label: {
                        HStack(alignment: .top, spacing: 8) {
                            Image(systemName: "circle")
                                .foregroundStyle(WatchTheme.accent)
                                .font(.caption)
                                .padding(.top, 3)
                            Text(task.title)
                                .font(.body.weight(WatchTheme.priorityWeight(task.priority)))
                                .multilineTextAlignment(.leading)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        } else if !model.isLoading {
            Text("No reminders configured yet.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func step(_ offset: Int) {
        guard !model.reminderGroups.isEmpty else { return }
        let count = model.reminderGroups.count
        let current = model.displayedSlotIndex
        model.slotOverride = ((current + offset) % count + count) % count
    }
}

/// One segment per slot with something in it — indigo while waiting, green
/// once finished, a faint placeholder before it starts. The on-screen
/// segment draws slightly thicker so it's identifiable without reading text,
/// same instinct as the phone widget's `ReminderSlotStrip` (its own doc notes
/// a plain height bump alone didn't read clearly enough — this watch version
/// adds a matching outline for the same reason, at a smaller scale).
private struct SlotProgressStrip: View {
    let groups: [ReminderGroupDTO]
    let currentIndex: Int

    var body: some View {
        HStack(spacing: 3) {
            ForEach(Array(groups.enumerated()), id: \.offset) { index, group in
                Capsule()
                    .fill(color(for: group))
                    .frame(height: index == currentIndex ? 5 : 3)
                    .overlay(
                        Capsule()
                            .stroke(WatchTheme.accent, lineWidth: index == currentIndex ? 1 : 0)
                            .padding(-1.5)
                    )
            }
        }
        .frame(height: 8)
    }

    private func color(for group: ReminderGroupDTO) -> Color {
        switch WatchSlotLogic.state(for: group) {
        case .notStarted: return Color.secondary.opacity(0.25)
        case .waiting: return WatchTheme.accent
        case .finished: return WatchTheme.done
        }
    }
}

/// Shared empty state — used by the Reminders page (a slot with nothing
/// left) via the specific "Done" header above, and here for the truly empty
/// "nothing anywhere today" case.
struct AllCaughtUpView: View {
    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: "checkmark.circle.fill")
                .font(.title2)
                .foregroundStyle(WatchTheme.done)
            Text("All caught up")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
    }
}
