import SwiftUI

/// The overdue checklist over the snooze grid — a task notification's
/// long-press (2026-11-21; the rules are `OverdueChecklist`, TNC-1…9).
///
/// Like the period checklist (`ReminderChecklistView`), every tap here only
/// STAGES: checking a row, paging, picking a time in the grid. The request
/// goes out from the notification's action buttons
/// (`NotificationViewController.commitOverdueChecklist`), the only surface
/// iOS guarantees will run. And the view never scrolls — a content extension
/// can't — so a page holds at most `OverdueChecklist.pageSize` rows and the
/// rest are reached with Show more / Show less (TNC-3).
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

    /// One row's drawn height (padding included), and the gap between rows.
    /// A page with fewer rows than the page size is padded to the full
    /// height while there is more than one page (TNC-3: the links don't move).
    private let rowSpacing: CGFloat = 4

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            list
        }
        .padding(.horizontal, 12)
        .padding(.top, 12)
        .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "checklist")
                .font(.subheadline)
                .foregroundColor(.secondary)
            Text(TaskWording.overdue)
                .font(.subheadline.weight(.semibold))
            Spacer()
            if let count = model.state.headerCount {
                Text(count)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
    }

    // MARK: - List

    @ViewBuilder
    private var list: some View {
        let state = model.state
        if state.isEmpty {
            Text("Nothing \(TaskWording.overdueLower)")
                .font(.caption)
                .foregroundColor(.secondary)
                .padding(.vertical, 6)
        } else {
            VStack(spacing: rowSpacing) {
                ForEach(state.pageRows, id: \.id) { row in
                    rowView(row)
                }
                if state.pageCount > 1 {
                    // Hidden copies of a row hold the page at full height.
                    ForEach(0 ..< (OverdueChecklist.pageSize - state.pageRows.count), id: \.self) { _ in
                        rowView(OverdueChecklist.Row(id: -1, title: " ", priority: 0, dueAt: nil))
                            .hidden()
                    }
                }
                footer
            }
        }
    }

    @ViewBuilder
    private var footer: some View {
        let state = model.state
        if state.load == .loading {
            statusLine("Loading the other \(TaskWording.overdueLower) tasks\u{2026}", spinner: true)
        } else if state.load == .failed {
            statusLine("Couldn\u{2019}t load the other \(TaskWording.overdueLower) tasks", spinner: false)
        } else if state.pageCount > 1 {
            HStack {
                if state.showsLess {
                    pageLink("Show less") { model.update { $0.showLess() } }
                }
                Spacer()
                if state.showsMore {
                    pageLink("Show more") { model.update { $0.showMore() } }
                }
            }
        }
    }

    private func statusLine(_ text: String, spinner: Bool) -> some View {
        HStack(spacing: 6) {
            if spinner { ProgressView().controlSize(.mini) }
            Text(text)
                .font(.caption)
                .foregroundColor(.secondary)
            Spacer()
        }
        .padding(.top, 2)
    }

    private func pageLink(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.footnote.weight(.medium))
                .foregroundColor(.blue)
                // A finger-sized target around a short word.
                .frame(minWidth: 44, minHeight: 28, alignment: .center)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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
            .background(fill(checked: checked, held: held))
            .cornerRadius(6)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(LeanRowStyle.spokenTitle(row.title, priority: row.priority))
        .accessibilityValue(timeWords(row) ?? "")
        .accessibilityAddTraits(checked ? .isSelected : [])
    }

    /// TNC-2: the held row's gray and green are a step stronger than the
    /// other rows', so it reads as "the one you pressed" without an icon.
    private func fill(checked: Bool, held: Bool) -> Color {
        (checked ? Color.green : Color.gray).opacity(held ? 0.24 : 0.12)
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
