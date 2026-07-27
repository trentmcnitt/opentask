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
///    `checkedIds`. The commit happens in the notification ACTION button
///    (`didReceive(_:completionHandler:)`), which is the only surface iOS
///    guarantees will run — the same discipline the snooze grid uses.
/// 2. **The list must not need to scroll.** A notification content extension
///    resizes to fit via `preferredContentSize`; it does NOT scroll natively,
///    so a long list is simply clipped and the rows past the cut are invisible
///    AND untappable. Hence the hard `maxVisibleRows` cap and the "+N more"
///    footer, which tells the truth about what is off-screen.
enum ReminderChecklistState {
    case loading
    case loaded([TaskDTO])
    case failed(String)
}

@MainActor
final class ReminderChecklistModel: ObservableObject {
    @Published var state: ReminderChecklistState = .loading

    /// Staged check-marks, in the order the user checked them.
    ///
    /// An ARRAY, not a Set: this is the payload of the commit request, and the
    /// order the user built it in is the order it should be applied and logged.
    @Published private(set) var checkedIds: [Int] = []

    let slotLabel: String

    /// Count from the push payload — shown while the live list is loading, and
    /// deliberately not trusted afterwards (see `SlotReminderKey`).
    let expectedCount: Int

    /// Fired whenever the staged set changes, so the view controller can
    /// relabel its action buttons ("Complete 3 checked").
    var onStagedChange: (([Int]) -> Void)?

    init(slotLabel: String, expectedCount: Int) {
        self.slotLabel = slotLabel
        self.expectedCount = expectedCount
    }

    /// Every reminder currently loaded, including rows past the visible cap.
    var loadedIds: [Int] {
        if case .loaded(let items) = state { return items.map(\.id) }
        return []
    }

    func isChecked(_ id: Int) -> Bool {
        checkedIds.contains(id)
    }

    func toggle(_ id: Int) {
        if let index = checkedIds.firstIndex(of: id) {
            checkedIds.remove(at: index)
        } else {
            checkedIds.append(id)
        }
        onStagedChange?(checkedIds)
    }

    /// Drop staged ids that are no longer in the loaded list (a reload can
    /// remove a row the user checked — committing it would be a lie).
    func pruneStagedIds() {
        let live = Set(loadedIds)
        let pruned = checkedIds.filter { live.contains($0) }
        if pruned != checkedIds {
            checkedIds = pruned
            onStagedChange?(checkedIds)
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
            return model.checkedIds.isEmpty
                ? "\(items.count) waiting"
                : "\(model.checkedIds.count) of \(items.count) checked"
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

    private func checklist(_ items: [TaskDTO]) -> some View {
        let visible = Array(items.prefix(maxVisibleRows))
        let hidden = items.count - visible.count

        return VStack(spacing: 4) {
            ForEach(visible) { item in
                row(item)
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
        let checked = model.isChecked(item.id)

        return Button {
            model.toggle(item.id)
        } label: {
            HStack(spacing: 8) {
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
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 6)
            .padding(.horizontal, 8)
            .background((checked ? Color.green : Color.gray).opacity(0.12))
            .cornerRadius(6)
        }
        .buttonStyle(.plain)
    }
}
