import SwiftUI

/// The notification checklist's two row kinds (NCL-1), shared by the period
/// checklist and the reminder/quota push checklist: a reminder row (the
/// circle: consider) and a quota-prompt row (the dashed circle: consider; the
/// square: did, +1; one choice per row). Titles wrap in full — a reminder is
/// never truncated (2026-09-24). A mark is a tint, never a strike (a mark
/// means "the button applies to this row", 2026-11-21). The held row (NCL-3)
/// is a step stronger in tint; a period label (NCL-8) follows the title in
/// grey when the rows span more than one period.
struct ReminderCheckRow: View {
    let task: TaskDTO
    let checked: Bool
    var held = false
    var periodLabel: String?
    let onToggle: () -> Void

    var body: some View {
        Button(action: onToggle) {
            // .top: on a wrapped title the circle stays beside line one.
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: checked ? "checkmark.circle.fill" : "circle")
                    .font(.body)
                    .foregroundColor(checked ? .green : .secondary)

                (Text(task.title)
                    // §6: priority is prominence — a high priority reminder
                    // renders heavier.
                    .fontWeight(task.priority >= 3 ? .semibold : .regular)
                    + ChecklistPeriodLabel.text(periodLabel))
                    .font(.caption)
                    .foregroundColor(.primary)
                    // `fixedSize` keeps a parent from squeezing the wrapped
                    // rows into each other.
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 6)
            .padding(.horizontal, 8)
            .background(ChecklistFill.color(marked: checked, held: held))
            .cornerRadius(6)
        }
        .buttonStyle(.plain)
    }
}

struct PromptCheckRow: View {
    @Environment(\.displayScale) private var displayScale
    /// A prompt count's em: `.caption` (12pt at the default size), scaled
    /// with the view's own Dynamic Type.
    @ScaledMetric(relativeTo: .caption) private var countEm: CGFloat = 12

    let prompt: QuotaPromptDTO
    let mark: ChecklistMark?
    var held = false
    var periodLabel: String?
    let onChoose: (ChecklistMark) -> Void

    /// A prompt's count in the `.caption` row's em — `QuotaSegmentsText`,
    /// the same builder the widget row draws with. This view can't be
    /// rendered in a preview (a content extension), so sharing the builder
    /// is its verification.
    private func count(_ prompt: QuotaPromptDTO) -> Text {
        let em = countEm
        return QuotaSegmentsText.count(
            QuotaCount.chooseForm(target: prompt.target), current: prompt.current, target: prompt.target,
            word: prompt.segmentWord, em: em, wordSize: em * 0.85, scale: displayScale
        )
    }

    var body: some View {
        let staged = mark != nil
        let did = mark == .did
        HStack(alignment: .top, spacing: 0) {
            Button {
                onChoose(.check)
            } label: {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: staged && !did ? "circle.dashed.inset.filled" : "circle.dashed")
                        .font(.body)
                        .foregroundColor(staged && !did ? .green : .secondary)

                    // A staged did previews the count it will log.
                    (Text(prompt.title) + Text(" ") + count(did ? prompt.handled(did: true) : prompt)
                        + ChecklistPeriodLabel.text(periodLabel))
                        .font(.caption)
                        .foregroundColor(.primary)
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
                onChoose(.did)
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
        .background(ChecklistFill.color(marked: staged, held: held))
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

/// NCL-8: " · Morning" in grey after the title, bound to its last word.
enum ChecklistPeriodLabel {
    static func text(_ label: String?) -> Text {
        guard let label, !label.isEmpty else { return Text("") }
        return Text("\u{00A0}\u{00B7} \(label)").foregroundColor(.secondary)
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
