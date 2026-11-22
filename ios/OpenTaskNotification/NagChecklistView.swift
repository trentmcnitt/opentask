import SwiftUI

/// The checklist on a named reminder or quota-prompt push (`REMINDER_NAG`,
/// `QUOTA_NAG`; 2026-11-21) — `NagChecklist`'s rules in the shared frame and
/// rows (NCL-1…8): every reminder and quota prompt waiting today in a period
/// that has opened, the pushed one first and checked (a step stronger in
/// tint), the rest by period; each row names its period while the rows span
/// more than one. Every tap only stages; the request goes out from the
/// notification's action buttons (`NotificationViewController.commitNagChecklist`).
@MainActor
final class NagChecklistModel: ObservableObject {
    @Published private(set) var state: NagChecklist.State

    /// Fired whenever what the action list depends on changes.
    var onChange: (() -> Void)?

    init(heldKey: String) {
        self.state = NagChecklist.opening(heldKey: heldKey)
    }

    func update(_ change: (inout NagChecklist.State) -> Void) {
        change(&state)
        onChange?()
    }
}

struct NagChecklistView: View {
    @ObservedObject var model: NagChecklistModel

    var body: some View {
        let state = model.state
        let labels = NagChecklist.showsPeriodLabels(state)
        ChecklistFrame(
            title: "Waiting today",
            state: state,
            count: state.headerCount(noun: "waiting"),
            emptyText: "Nothing waiting now.",
            loadingText: "Loading reminders\u{2026}",
            failedText: "Couldn\u{2019}t load today\u{2019}s reminders",
            onShowLess: { model.update { $0.showLess() } },
            onShowMore: { model.update { $0.showMore() } },
            row: { item in
                let key = item.checklistKey
                let held = key == state.heldKey
                let label = labels ? item.slot.label : nil
                switch item.item {
                case .reminder(let task):
                    ReminderCheckRow(task: task, checked: state.mark(of: key) != nil, held: held, periodLabel: label) {
                        model.update { $0.toggle(key) }
                    }
                case .prompt(let prompt):
                    PromptCheckRow(prompt: prompt, mark: state.mark(of: key), held: held, periodLabel: label) { mark in
                        model.update { $0.choose(key, mark) }
                    }
                }
            },
            spacerRow: { ReminderCheckRow(task: TaskDTO(id: -1, title: " "), checked: false) {} }
        )
        .padding(.bottom, 12)
    }
}
