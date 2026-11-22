import Foundation

/// THE PERIOD CHECKLIST — a period push's long-press (`SLOT_REMINDER`, §6.1),
/// on the shared notification checklist since 2026-11-21 (`NotificationChecklist`,
/// NCL-1…7).
///
/// The rows are the period's waiting reminders, then its waiting quota
/// prompts (the web's and the widgets' order), fetched live when the view
/// opens. Nothing is marked to start with (NCL-3: a period push is about the
/// whole period). A reminder row has the circle (consider); a prompt row the
/// circle (consider) and the square (did, +1), one choice per row. The commit
/// is ONE `POST /api/tasks/bulk/complete` — reminder `ids` plus `prompts` with
/// their did keys — one transaction, one undo entry; its button is named for
/// what is marked: "Consider (N)", "Did (N)" or "Log (N)" for a mix
/// (`NotificationWords.commitVerb`). "Consider all" takes the whole period;
/// Cancel is last.
///
/// Since 2026-11-21 the view CLOSES after a commit, like every checklist
/// (NCL-7; until then it reloaded in place, because the 8-row cap's "+N more"
/// rows had no other way back — paging is that way now). The period's banner
/// goes when nothing in it is left waiting and otherwise stays.
enum PeriodChecklist {

    /// One row: a reminder or a waiting quota prompt.
    enum Item: ChecklistItem {
        case reminder(TaskDTO)
        case prompt(QuotaPromptDTO)

        /// A prompt is keyed by `prompt_key`, never its quota's id: a daily
        /// quota's prompts share one.
        var checklistKey: String {
            switch self {
            case .reminder(let task): return "r:\(task.id)"
            case .prompt(let prompt): return prompt.promptKey
            }
        }

        var isPrompt: Bool {
            if case .prompt = self { return true }
            return false
        }
    }

    typealias State = ChecklistState<Item>

    /// A period's rows: its reminders, then its waiting prompts.
    static func items(_ group: ReminderGroupDTO?) -> [Item] {
        (group?.reminders ?? []).map(Item.reminder) + (group?.waitingPrompts ?? []).map(Item.prompt)
    }

    /// The list before the fetch lands: nothing marked, nothing listed.
    static func opening() -> State { State(rows: [], load: .loading) }

    // MARK: - The action rows (NCL-4, NCL-6)

    /// Marked: the commit ("Consider (3)", "Did", "Log (2)"), Consider all,
    /// Cancel. Nothing marked: Consider all, Cancel. Nothing waiting: Cancel.
    static func actions(for state: State) -> [TaskNotificationList.Row] {
        let cancel = TaskNotificationList.Row(identifier: NotificationAction.cancel, title: NotificationWords.cancel)
        if state.isEmpty { return [cancel] }
        var rows: [TaskNotificationList.Row] = []
        if let verb = NotificationWords.commitVerb(state.marked.map(\.mark)) {
            rows.append(TaskNotificationList.Row(
                identifier: NotificationAction.completeChecked,
                title: NotificationWords.counted(verb, state.markedCount)
            ))
        }
        rows.append(TaskNotificationList.Row(
            identifier: NotificationAction.completeAll, title: NotificationWords.considerAll
        ))
        return rows + [cancel]
    }

    // MARK: - The commit (NCL-4, NCL-5, NCL-7)

    enum CommitOutcome {
        /// The server acted. `periodEmpty`: nothing in the period is left
        /// waiting, so its banner goes too.
        case sent(periodEmpty: Bool)
        case nothingMarked
        /// The re-check left nothing to send (or the server acted on
        /// nothing): reload with `current`, stay open.
        case nothingLeft(current: ReminderGroupDTO?)
        /// A refused batch (4xx — likeliest a prompt key from before
        /// midnight): reload, stay open.
        case refused
    }

    /// The marked rows, re-checked against the period as it is now, in ONE
    /// request. A row that left the period (considered elsewhere, a
    /// yesterday's prompt) is dropped rather than refusing the batch.
    static func commit(_ state: State, slotId: Int, api: PeriodChecklistAPI) async throws -> CommitOutcome {
        let marked = state.marked
        guard !marked.isEmpty else { return .nothingMarked }
        do {
            let group = try await api.fetchSlotGroup(slotId: slotId)
            let live = Set(items(group).map(\.checklistKey))
            let send = marked.filter { live.contains($0.item.checklistKey) }
            guard !send.isEmpty else { return .nothingLeft(current: group) }

            var ids: [Int] = []
            var prompts: [APIClient.PromptCommit] = []
            for (item, mark) in send {
                switch item {
                case .reminder(let task): ids.append(task.id)
                case .prompt(let prompt): prompts.append(APIClient.PromptCommit(key: prompt.promptKey, did: mark == .did))
                }
            }
            let affected = try await api.completeChecklist(ids: ids, prompts: prompts)
            guard affected > 0 else { return .nothingLeft(current: group) }
            return .sent(periodEmpty: live.count == send.count)
        } catch APIError.serverError(let code) where (400..<500).contains(code) {
            return .refused
        }
    }
}

/// The calls the period checklist makes — `APIClient`'s, behind a protocol so
/// `PeriodChecklistTests` can record them with a stub.
protocol PeriodChecklistAPI {
    /// The period's group from `GET /api/reminders`.
    func fetchSlotGroup(slotId: Int) async throws -> ReminderGroupDTO?
    /// `POST /api/tasks/bulk/complete` with `ids` and `prompts`; how many
    /// things the server acted on.
    func completeChecklist(ids: [Int], prompts: [APIClient.PromptCommit]) async throws -> Int
}

extension APIClient: PeriodChecklistAPI {
    func completeChecklist(ids: [Int], prompts: [APIClient.PromptCommit]) async throws -> Int {
        try await completeTasks(ids: ids, prompts: prompts).total
    }
}
