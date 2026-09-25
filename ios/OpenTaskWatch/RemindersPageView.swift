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
                // Reminders plus waiting quota prompts (2026-09-24).
                Text(group.hasNothingWaiting ? "Done" : "\(group.waitingCount) left")
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
        // Gate the empty/loaded states on `hasLoadedOnce` — before the first
        // fetch completes, `group` is nil (no data yet) exactly like the
        // genuinely-empty case below, and without this a launch would flash
        // "All caught up" for the ~1-3s a real network round trip takes
        // before honestly landing on real content. See `WatchViewModel.
        // hasLoadedOnce`'s doc.
        if !model.hasLoadedOnce {
            ProgressView()
                .frame(maxWidth: .infinity)
                .padding(.vertical, 24)
        } else if let error = model.loadError, model.reminderGroups.isEmpty {
            LoadErrorView(message: error)
        } else if let group {
            if group.hasNothingWaiting {
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
                // Quota prompts after the reminders, as on the web
                // (`SlotPromptList`) and the phone widget. Keyed by
                // `prompt_key` — a daily quota's rows share one task id.
                ForEach(group.waitingPrompts) { prompt in
                    PromptRowView(
                        prompt: prompt,
                        consider: { model.actOnPrompt(prompt, did: false) },
                        didIt: { model.actOnPrompt(prompt, did: true) }
                    )
                }
            }
        } else {
            // Loaded, no error, and still no group at all — a real state
            // (an account with no time slots and no un-slotted reminders
            // either), not a loading flicker: `hasLoadedOnce` above already
            // owns the "still fetching" case.
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

/// One waiting quota PROMPT (quota reminders, 2026-09-24) — drawn as a
/// reminder row (the circle, the full-width wrapped title, tap to consider),
/// plus the three things a prompt adds everywhere: a thin leading stripe in
/// the quota's label color, the count ("1/2"), and a SQUARE for "did it".
///
/// WHY A SQUARE BUTTON, NOT PRESS-AND-HOLD (the judgment call): "did it" is
/// the prompt's success action — the one Trent is meant to reach for when he
/// has done the thing — and a hold is invisible; the Tasks page keeps hold
/// for its RARE action (snooze). A mis-tap logs +1, which the toolbar Undo
/// takes back.
///
/// WHY THE COUNT AND SQUARE SIT ON THEIR OWN LINE: the first build put the
/// square in a column beside the title, and on the 44mm SE simulator that
/// left his real titles one or two words per line ("certifica-tions"
/// hyphenated) with the count wrapping away from its "·". Under the title,
/// right-aligned, the title keeps a reminder's full width, and the square is
/// literally "next to the count": `1/3 ☐`. It costs one short line per
/// prompt; the page scrolls. The square is its own button (a 40×28 target),
/// a sibling of the row's consider button, never nested in it.
struct PromptRowView: View {
    let prompt: QuotaPromptDTO
    let consider: () -> Void
    let didIt: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            RoundedRectangle(cornerRadius: 2)
                .fill(WatchTheme.labelColor(prompt.stripeColor))
                .frame(width: 3)

            VStack(alignment: .leading, spacing: 0) {
                Button(action: consider) {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "circle")
                            .foregroundStyle(WatchTheme.accent)
                            .font(.caption)
                            .padding(.top, 3)
                        Text(prompt.title)
                            .font(.body)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("Considered: \(prompt.title), \(prompt.countText)"))

                HStack(spacing: 0) {
                    Spacer(minLength: 0)
                    Text(prompt.countText)
                        .font(.body.monospacedDigit())
                        .foregroundStyle(.secondary)
                    Button(action: didIt) {
                        Image(systemName: "square")
                            .font(.body)
                            .foregroundStyle(WatchTheme.accent)
                            .frame(width: PromptRowView.didTarget.width, height: PromptRowView.didTarget.height)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text("Did it: \(prompt.title), \(prompt.countText)"))
                }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    /// The did-it square's tap target — a finger target on the narrowest watch.
    static let didTarget = CGSize(width: 40, height: 28)
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

/// Shared by both pages (Reminders and Tasks) — shown only when a fetch
/// failed AND there's no cached payload to fall back on (`WatchViewModel.
/// load()`'s doc: a stale-but-present cache is preferred over this).
struct LoadErrorView: View {
    let message: String

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: "wifi.exclamationmark")
                .font(.title2)
                .foregroundStyle(.orange)
            Text("Couldn't load")
                .font(.subheadline)
            Text(message)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
    }
}

#if DEBUG
// Quota prompts (2026-09-24) on Trent's real data: two reminders, then the
// sixteen prompts — stripe, count, the circle (tap = considered) and the
// square (did it). The second preview has three handled, so they're gone.
#Preview("Reminders — prompts") {
    NavigationStack {
        RemindersPageView(model: .previewReminders())
    }
}

#Preview("Reminders — prompts, three handled") {
    NavigationStack {
        RemindersPageView(model: .previewReminders(handled: [
            "q:83:1:2026-09-24": true, "q:116:0:2026-09-24": false, "q:3307:0:2026-09-24": false,
        ]))
    }
}

#Preview("Reminders — prompts, XXX Large") {
    NavigationStack {
        RemindersPageView(model: .previewReminders())
    }
    .dynamicTypeSize(.xxxLarge)
}

// A preview can't scroll, so the page previews above only show the first
// rows. These draw every one of his sixteen real prompt rows, five or six at
// a time, as the page lists them.
private struct PromptRowsPreview: View {
    let range: Range<Int>

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(WatchPreviewData.earlyMorningPrompts[range]) { prompt in
                PromptRowView(prompt: prompt, consider: {}, didIt: {})
            }
        }
        .padding(.horizontal, 4)
        .frame(maxHeight: .infinity, alignment: .top)
    }
}

#Preview("Prompt rows 1-5") { PromptRowsPreview(range: 0..<5) }
#Preview("Prompt rows 6-10") { PromptRowsPreview(range: 5..<10) }
#Preview("Prompt rows 11-16") { PromptRowsPreview(range: 10..<16) }
#Preview("Prompt rows 1-4, XXX Large") {
    PromptRowsPreview(range: 0..<4).dynamicTypeSize(.xxxLarge)
}
#endif
