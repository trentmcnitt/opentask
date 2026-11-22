import SwiftUI

/// The overdue checklist over the snooze grid — a task notification's
/// long-press (2026-11-21; the rules are `OverdueChecklist`, TNC-1…9).
///
/// The shared checklist's frame (`ChecklistFrame`, NCL-1) around this kind's
/// rows: one line each, the title giving way to the "!" mark and the red
/// time. Every tap only STAGES; the request goes out from the notification's
/// action buttons (`NotificationViewController.commitOverdueChecklist`).
@MainActor
final class OverdueChecklistModel: ObservableObject {
    @Published private(set) var state: OverdueChecklist.State

    /// Fired whenever what the action list depends on changes (checked set,
    /// rows), so the view controller can rewrite it.
    var onChange: (() -> Void)?

    init(_ state: OverdueChecklist.State) {
        self.state = state
    }

    func update(_ change: (inout OverdueChecklist.State) -> Void) {
        change(&state)
        onChange?()
    }
}

struct OverdueChecklistView: View {
    @ObservedObject var model: OverdueChecklistModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let state = model.state
        ChecklistFrame(
            title: TaskWording.overdue,
            state: state.list,
            count: state.headerCount,
            emptyText: "Nothing \(TaskWording.overdueLower)",
            loadingText: "Loading the other \(TaskWording.overdueLower) tasks\u{2026}",
            failedText: "Couldn\u{2019}t load the other \(TaskWording.overdueLower) tasks",
            onShowLess: { model.update { $0.showLess() } },
            onShowMore: { model.update { $0.showMore() } },
            row: { rowView($0) },
            spacerRow: { rowView(OverdueChecklist.Row(id: -1, title: " ", priority: 0, dueAt: nil)) }
        )
    }

    // MARK: - Row

    private func rowView(_ row: OverdueChecklist.Row) -> some View {
        let checked = model.state.isChecked(row.id)
        let held = row.id == model.state.heldId
        return Button {
            model.update { $0.toggle(row.id) }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: checked ? "checkmark.circle.fill" : "circle")
                    .font(.body)
                    .foregroundColor(checked ? .green : .secondary)
                // One line (TNC-1): the title gives way, the mark and the
                // time never do.
                HStack(spacing: 4) {
                    Text(row.title)
                        .font(.caption.weight(row.priority >= 3 ? .semibold : .regular))
                        .foregroundColor(.primary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .layoutPriority(0)
                    if let tab = RowCorner.priorityTab(row.priority) {
                        Text(tab.text)
                            .font(.caption.weight(LeanRowStyle.markWeight))
                            .foregroundColor(LeanRowStyle.color(LeanRow.priorityHex(tab)))
                            .fixedSize()
                    }
                    if let time = timeWords(row) {
                        Text("\u{00B7} \(time)")
                            .font(.caption)
                            .foregroundColor(LeanRowStyle.passed(colorScheme))
                            .lineLimit(1)
                            .fixedSize()
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 7)
            .padding(.horizontal, 8)
            .background(ChecklistFill.color(marked: checked, held: held))
            .cornerRadius(6)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(LeanRowStyle.spokenTitle(row.title, priority: row.priority))
        .accessibilityValue(timeWords(row) ?? "")
        .accessibilityAddTraits(checked ? .isSelected : [])
    }

    /// "Yesterday 3:00 pm" — the widgets' words (`DueLabel`), every one
    /// overdue, so every one red.
    private func timeWords(_ row: OverdueChecklist.Row) -> String? {
        guard let due = row.dueDate else { return nil }
        let words = DueLabel.parts(for: due, isOverdue: true, day: DayStartStore.current).plainString
        return words.isEmpty ? nil : words
    }
}

/// The whole long-press: the checklist over the grid (TNC-9). The grid goes
/// when nothing is overdue — with nothing to act on, Cancel is all there is.
struct OverdueLongPressView: View {
    @ObservedObject var model: OverdueChecklistModel
    let gridMode: SnoozeMode
    var slots: [TimeSlotDTO] = TimeSlotStore.cachedSlots
    var onGridSelection: (String) -> Void
    var onDirtyStateChanged: ((Bool) -> Void)?

    var body: some View {
        VStack(spacing: 0) {
            OverdueChecklistView(model: model)
            if model.state.isEmpty {
                Color.clear.frame(height: 12)
            } else {
                // Nothing checked: nothing for a time to act on, so the grid
                // is dimmed and ignores taps until a row is checked
                // (2026-11-21). What was picked stays picked.
                let idle = model.state.checked.isEmpty
                SnoozeGridView(
                    mode: gridMode,
                    onGridSelection: onGridSelection,
                    onDirtyStateChanged: onDirtyStateChanged,
                    slots: slots,
                    showsHeader: false
                )
                .disabled(idle)
                .opacity(idle ? 0.35 : 1)
            }
        }
    }
}
