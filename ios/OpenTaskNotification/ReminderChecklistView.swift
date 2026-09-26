import SwiftUI

/// Batch checklist for a §6 time slot (REDESIGN-V03 §6.1).
///
/// The user long-presses a SLOT_REMINDER notification, checks the reminders
/// they considered, and commits them all with ONE action button. This file is
/// the staging half; `NotificationViewController` owns the fetch and the commit.
///
/// TWO THINGS ARE DELIBERATE AND EASY TO BREAK:
///
/// 1. **Buttons here stage, they never commit.** Tapping a row only mutates
///    `staged`. The commit happens in the notification ACTION button
///    (`didReceive(_:completionHandler:)`), which is the only surface iOS
///    guarantees will run — the same discipline the snooze grid uses.
/// 2. **The list must not need to scroll.** A notification content extension
///    resizes to fit via `preferredContentSize`; it does NOT scroll natively,
///    so a long list is simply clipped and the rows past the cut are invisible
///    AND untappable. Hence the hard `maxVisibleRows` cap and the "+N more"
///    footer, which tells the truth about what is off-screen.
///
/// QUOTA PROMPTS (quota reminders, 2026-09-24): the slot's waiting quota
/// prompts are rows too, after its reminders (the web and the widgets put
/// them there). A prompt row has an eye where the reminder row has its
/// circle — staging CONSIDERED ("seen") — plus a square beside its count ("Piano Scales · 1/2") staging
/// DID IT (+1, and considered). The two are one choice per prompt: tapping
/// the other switches it, tapping the same one again un-stages it. The whole
/// staged set, reminders and prompts, commits in ONE
/// `POST /api/tasks/bulk/complete` (`ids` + `prompts`): one transaction, one
/// undo entry. Rows are identified by `prompt_key`, never task id — a daily
/// quota's prompts share one.
enum ReminderChecklistState {
    case loading
    case loaded([ChecklistItem])
    case failed(String)
}

/// One checklist row: a reminder, or a quota prompt.
enum ChecklistItem: Identifiable {
    case reminder(TaskDTO)
    case prompt(QuotaPromptDTO)

    var id: String {
        switch self {
        case .reminder(let task): return "r:\(task.id)"
        case .prompt(let prompt): return prompt.promptKey
        }
    }
}

/// What one tap staged — the commit payload, item by item.
enum StagedAction: Equatable {
    case reminder(Int)
    case prompt(key: String, did: Bool)

    /// The row this belongs to (`ChecklistItem.id`).
    var itemId: String {
        switch self {
        case .reminder(let id): return "r:\(id)"
        case .prompt(let key, _): return key
        }
    }
}

@MainActor
final class ReminderChecklistModel: ObservableObject {
    @Published var state: ReminderChecklistState = .loading

    /// Staged actions, in the order the user staged them.
    ///
    /// An ARRAY, not a Set: it is the commit's payload, and each half of the
    /// request (`ids`, `prompts`) keeps the order the user staged it in. The
    /// server applies the batch in one transaction with one undo entry, so
    /// the interleaving between the two halves carries no meaning.
    @Published private(set) var staged: [StagedAction] = []

    let slotLabel: String

    /// Count from the push payload — shown while the live list is loading, and
    /// deliberately not trusted afterwards (see `SlotReminderKey`).
    let expectedCount: Int

    /// Fired whenever the staged set changes, with its new size, so the view
    /// controller can relabel its action buttons ("Complete 3 checked").
    var onStagedChange: ((Int) -> Void)?

    init(slotLabel: String, expectedCount: Int) {
        self.slotLabel = slotLabel
        self.expectedCount = expectedCount
    }

    /// Every row currently loaded, including rows past the visible cap.
    var loadedItemIds: Set<String> {
        if case .loaded(let items) = state { return Set(items.map(\.id)) }
        return []
    }

    /// The staged reminder ids — the commit's `ids`.
    var stagedReminderIds: [Int] {
        staged.compactMap { if case .reminder(let id) = $0 { return id } else { return nil } }
    }

    /// The staged prompt actions — the commit's `prompts`.
    var stagedPrompts: [APIClient.PromptCommit] {
        staged.compactMap {
            if case .prompt(let key, let did) = $0 { return APIClient.PromptCommit(key: key, did: did) }
            return nil
        }
    }

    func isChecked(reminder id: Int) -> Bool {
        staged.contains(.reminder(id))
    }

    /// `nil` = not staged; `false` = considered; `true` = did it.
    func promptChoice(_ key: String) -> Bool? {
        for action in staged {
            if case .prompt(let k, let did) = action, k == key { return did }
        }
        return nil
    }

    func toggle(reminder id: Int) {
        if let index = staged.firstIndex(of: .reminder(id)) {
            staged.remove(at: index)
        } else {
            staged.append(.reminder(id))
        }
        onStagedChange?(staged.count)
    }

    /// Stage a prompt's circle (`did: false`) or square (`did: true`). One
    /// choice per prompt: the same control again un-stages it, the other
    /// switches it in place (keeping its position in the order).
    func choose(prompt key: String, did: Bool) {
        if let index = staged.firstIndex(where: { $0.itemId == key }) {
            if staged[index] == .prompt(key: key, did: did) {
                staged.remove(at: index)
            } else {
                staged[index] = .prompt(key: key, did: did)
            }
        } else {
            staged.append(.prompt(key: key, did: did))
        }
        onStagedChange?(staged.count)
    }

    /// Drop staged actions whose rows are no longer in the loaded list (a
    /// reload can remove a row the user checked — committing it would be a
    /// lie).
    func pruneStaged() {
        let live = loadedItemIds
        let pruned = staged.filter { live.contains($0.itemId) }
        if pruned != staged {
            staged = pruned
            onStagedChange?(staged.count)
        }
    }
}

struct ReminderChecklistView: View {

    @ObservedObject var model: ReminderChecklistModel

    /// See the type doc: the extension cannot scroll, so this is a hard visual
    /// budget, not a paging hint.
    private let maxVisibleRows = 8

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header

            switch model.state {
            case .loading:
                loadingRow
            case .failed(let message):
                failureRow(message)
            case .loaded(let items):
                if items.isEmpty {
                    emptyRow
                } else {
                    checklist(items)
                }
            }
        }
        .padding(12)
        // The checklist's height is its content's, never less: if iOS ever
        // grants the extension less room than `preferredContentSize` asked
        // for, the bottom clips instead of rows being compressed into each
        // other (the "grouped notification" overlap, 2026-09-24).
        .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "checklist")
                .font(.subheadline)
                .foregroundColor(.secondary)
            Text(model.slotLabel)
                .font(.subheadline.weight(.semibold))
            Spacer()
            Text(countLabel)
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }

    private var countLabel: String {
        switch model.state {
        case .loaded(let items):
            return model.staged.isEmpty
                ? "\(items.count) waiting"
                : "\(model.staged.count) of \(items.count) checked"
        case .loading:
            return model.expectedCount > 0 ? "\(model.expectedCount) waiting" : ""
        case .failed:
            return ""
        }
    }

    // MARK: - States

    private var loadingRow: some View {
        HStack(spacing: 8) {
            ProgressView()
            Text("Loading reminders\u{2026}")
                .font(.caption)
                .foregroundColor(.secondary)
        }
        .padding(.vertical, 6)
    }

    private func failureRow(_ message: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundColor(.orange)
            Text(message)
                .font(.caption)
                .foregroundColor(.secondary)
                .lineLimit(2)
        }
        .padding(.vertical, 6)
    }

    private var emptyRow: some View {
        Text("Nothing left in this slot.")
            .font(.caption)
            .foregroundColor(.secondary)
            .padding(.vertical, 6)
    }

    // MARK: - Checklist

    private func checklist(_ items: [ChecklistItem]) -> some View {
        let visible = Array(items.prefix(maxVisibleRows))
        let hidden = items.count - visible.count

        return VStack(spacing: 4) {
            ForEach(visible) { item in
                switch item {
                case .reminder(let task):
                    row(task)
                case .prompt(let prompt):
                    promptRow(prompt)
                }
            }

            if hidden > 0 {
                // "Complete all" still covers these — the button acts on the
                // slot, not on what happens to be rendered.
                Text("+\(hidden) more \u{2014} open OpenTask to see them")
                    .font(.caption2)
                    .foregroundColor(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 2)
            }
        }
    }

    private func row(_ item: TaskDTO) -> some View {
        let checked = model.isChecked(reminder: item.id)

        return Button {
            model.toggle(reminder: item.id)
        } label: {
            // .top: on a wrapped title the circle stays beside line one.
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: checked ? "checkmark.circle.fill" : "circle")
                    .font(.body)
                    .foregroundColor(checked ? .green : .secondary)

                Text(item.title)
                    .font(.caption)
                    // §6: priority is prominence, not interruption — a high
                    // priority reminder renders heavier, it never nags.
                    .fontWeight(item.priority >= 3 ? .semibold : .regular)
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
            .background((checked ? Color.green : Color.gray).opacity(0.12))
            .cornerRadius(6)
        }
        .buttonStyle(.plain)
    }

    /// A quota prompt: the reminder row's shape, with an EYE where its circle
    /// is (tap the row = stage CONSIDERED — "seen", not "done"; 2026-09-25), plus the quota's label-color stripe on the leading
    /// edge, the count after the title, and a square on the trailing edge
    /// (stage DID IT). The square is its own button beside the row's, not
    /// nested in it; both only stage (see the file doc).
    private func promptRow(_ prompt: QuotaPromptDTO) -> some View {
        let choice = model.promptChoice(prompt.promptKey)
        let staged = choice != nil
        let did = choice == true

        return HStack(alignment: .top, spacing: 0) {
            Button {
                model.choose(prompt: prompt.promptKey, did: false)
            } label: {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: staged && !did ? "eye.fill" : "eye")
                        .font(.body)
                        .foregroundColor(staged && !did ? .green : .secondary)

                    // A staged did-it previews the count it will log (the
                    // server's rule: a daily #k rises to k, else +1).
                    (Text(prompt.title)
                        + Text("\(QuotaPromptDTO.countSeparator)\((did ? prompt.handled(did: true) : prompt).countText)")
                            .foregroundColor(.secondary))
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
            .accessibilityLabel(Text("Considered: \(prompt.title), \(prompt.countText)"))

            Button {
                model.choose(prompt: prompt.promptKey, did: true)
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
            .accessibilityLabel(Text("Did it: \(prompt.title)"))
        }
        .fixedSize(horizontal: false, vertical: true)
        .background((staged ? Color.green : Color.gray).opacity(0.12))
        .overlay(alignment: .leading) {
            // The quota's label color, the stripe every prompt row wears.
            // Drawn over the row's leading edge, inside its rounded corner.
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
