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
                let key = item.checklistKey
                switch item {
                case .reminder(let task):
                    ReminderCheckRow(task: task, checked: model.state.mark(of: key) != nil) {
                        model.update { $0.toggle(key) }
                    }
                case .prompt(let prompt):
                    PromptCheckRow(prompt: prompt, mark: model.state.mark(of: key)) { mark in
                        model.update { $0.choose(key, mark) }
                    }
                }
            },
            spacerRow: { ReminderCheckRow(task: TaskDTO(id: -1, title: " "), checked: false) {} }
        )
        .padding(.bottom, 12)
    }
}
