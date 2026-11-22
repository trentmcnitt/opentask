import SwiftUI

/// The period checklist — a period push's long-press (`SLOT_REMINDER`, §6.1),
/// on the shared checklist since 2026-11-21 (`PeriodChecklist`,
/// `NotificationChecklist`, NCL-1…7).
///
/// The shared frame (`ChecklistFrame`) around this kind's rows: a reminder
/// row (the circle: consider), and a quota-prompt row (the dashed circle:
/// consider; the square: did, +1; one choice per row). Titles wrap in full —
/// a reminder is never truncated (2026-09-24) — so a page with long titles
/// is taller than one without; paging (6 rows a page, NCL-2) replaced the
/// 8-row cap and its "+N more" line. Every tap only stages; the request goes
/// out from the notification's action buttons
/// (`NotificationViewController.commitPeriodChecklist`).
@MainActor
final class PeriodChecklistModel: ObservableObject {
    @Published private(set) var state: PeriodChecklist.State

    let slotLabel: String

    /// Count from the push payload — shown while the live list is loading,
    /// and not trusted afterwards (see `SlotReminderKey`).
    let expectedCount: Int

    /// Fired whenever what the action list depends on changes.
    var onChange: (() -> Void)?

    init(slotLabel: String, expectedCount: Int) {
        self.slotLabel = slotLabel
        self.expectedCount = expectedCount
        self.state = PeriodChecklist.opening()
    }

    func update(_ change: (inout PeriodChecklist.State) -> Void) {
        change(&state)
        onChange?()
    }

    /// The header's count: the live one once loaded, the payload's before.
    var headerCount: String? {
        if state.load != .loaded, state.markedCount == 0 {
            return expectedCount > 0 ? "\(expectedCount) waiting" : nil
        }
        return state.headerCount(noun: "waiting")
    }
}

struct PeriodChecklistView: View {
    @Environment(\.displayScale) private var displayScale
    /// A prompt count's em: `.caption` (12pt at the default size), scaled
    /// with the view's own Dynamic Type.
    @ScaledMetric(relativeTo: .caption) private var countEm: CGFloat = 12

    @ObservedObject var model: PeriodChecklistModel

    var body: some View {
        ChecklistFrame(
            title: model.slotLabel,
            state: model.state,
            count: model.headerCount,
            emptyText: "Nothing left in this period.",
            loadingText: "Loading reminders\u{2026}",
            failedText: "Couldn\u{2019}t load this period",
            onShowLess: { model.update { $0.showLess() } },
            onShowMore: { model.update { $0.showMore() } },
            row: { item in
                switch item {
                case .reminder(let task): reminderRow(task, key: item.checklistKey)
                case .prompt(let prompt): promptRow(prompt)
                }
            },
            spacerRow: { reminderRow(TaskDTO(id: -1, title: " "), key: "spacer") }
        )
        .padding(.bottom, 12)
    }

    // MARK: - Reminder row

    private func reminderRow(_ task: TaskDTO, key: String) -> some View {
        let checked = model.state.mark(of: key) != nil

        return Button {
            model.update { $0.toggle(key) }
        } label: {
            // .top: on a wrapped title the circle stays beside line one.
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: checked ? "checkmark.circle.fill" : "circle")
                    .font(.body)
                    .foregroundColor(checked ? .green : .secondary)

                Text(task.title)
                    .font(.caption)
                    // §6: priority is prominence — a high priority reminder
                    // renders heavier.
                    .fontWeight(task.priority >= 3 ? .semibold : .regular)
                    .foregroundColor(checked ? .secondary : .primary)
                    .strikethrough(checked, color: .secondary)
                    // Wraps in full (2026-09-24) — a reminder is never
                    // truncated, and `fixedSize` keeps a parent from
                    // squeezing the wrapped rows into each other.
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 6)
            .padding(.horizontal, 8)
            .background(ChecklistFill.color(marked: checked))
            .cornerRadius(6)
        }
        .buttonStyle(.plain)
    }

    // MARK: - Prompt row

    /// A prompt's count in the `.caption` row's em — `QuotaSegmentsText`,
    /// the same builder the widget row draws with. This view can't be
    /// rendered in a preview (a content extension), so sharing the builder
    /// is its verification.
    private func promptCount(_ prompt: QuotaPromptDTO) -> Text {
        let em = countEm
        return QuotaSegmentsText.count(
            QuotaCount.chooseForm(target: prompt.target), current: prompt.current, target: prompt.target,
            word: prompt.segmentWord, em: em, wordSize: em * 0.85, scale: displayScale
        )
    }

    /// A quota prompt: the reminder row's shape with a DASHED circle (stage
    /// consider — "seen", not "done"; 2026-09-25), the quota's label-colour
    /// stripe on the leading edge, the count after the title, and a square
    /// on the trailing edge (stage did, +1). One choice per row: the same
    /// control again clears it, the other switches it. The square is its own
    /// button beside the row's, not nested in it.
    private func promptRow(_ prompt: QuotaPromptDTO) -> some View {
        let key = prompt.promptKey
        let mark = model.state.mark(of: key)
        let staged = mark != nil
        let did = mark == .did

        return HStack(alignment: .top, spacing: 0) {
            Button {
                model.update { $0.choose(key, .check) }
            } label: {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: staged && !did ? "circle.dashed.inset.filled" : "circle.dashed")
                        .font(.body)
                        .foregroundColor(staged && !did ? .green : .secondary)

                    // A staged did previews the count it will log (the
                    // server's rule: a daily #k rises to k, else +1).
                    (Text(prompt.title) + Text(" ") + promptCount(did ? prompt.handled(did: true) : prompt))
                        .font(.caption)
                        .foregroundColor(staged ? .secondary : .primary)
                        .strikethrough(staged, color: .secondary)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.vertical, 6)
                .padding(.leading, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("\(NotificationWords.consider): \(prompt.title), \(prompt.spokenCount)"))

            Button {
                model.update { $0.choose(key, .did) }
            } label: {
                Image(systemName: did ? "checkmark.square.fill" : "square")
                    .font(.body)
                    .foregroundColor(did ? .green : .secondary)
                    .padding(.vertical, 6)
                    .padding(.horizontal, 8)
                    .frame(maxHeight: .infinity, alignment: .top)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("\(NotificationWords.did): \(prompt.title)"))
        }
        .fixedSize(horizontal: false, vertical: true)
        .background(ChecklistFill.color(marked: staged))
        .overlay(alignment: .leading) {
            // The quota's label colour, the stripe every prompt row wears.
            RoundedRectangle(cornerRadius: 1.5)
                .fill(PromptStripe.color(prompt.stripeColor))
                .frame(width: 3)
                .padding(.vertical, 5)
                .padding(.leading, 2)
        }
        .cornerRadius(6)
    }
}

/// The prompt stripe's color: the quota's label color (the eight-name
/// palette the server resolves, never green) or a faint neutral. Same rule as
/// the widget's `PromptRowMetrics.stripeColor` and the watch's
/// `WatchTheme.labelColor` — this target compiles neither.
enum PromptStripe {
    static func color(_ name: String?) -> Color {
        switch name {
        case "red": return .red
        case "orange": return .orange
        case "yellow": return .yellow
        case "green": return .green
        case "blue": return .blue
        case "purple": return .purple
        case "pink": return .pink
        case "gray": return .gray
        default: return Color.secondary.opacity(0.35)
        }
    }
}
