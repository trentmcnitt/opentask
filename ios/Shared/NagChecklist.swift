import Foundation

/// THE CHECKLIST ON A REMINDER OR QUOTA PUSH (`REMINDER_NAG`, `QUOTA_NAG`;
/// 2026-11-21, rules NCL-1…8 of `NotificationChecklist`).
///
/// Trent: "anything that's currently not done or nagging has the ability to
/// defer. It would need to list which period it's from in case there's
/// something from early morning and from morning that I hadn't finished
/// with." Long-pressing a named reminder (or quota-prompt) push shows every
/// reminder and quota prompt waiting today in a period that has OPENED (never
/// Anytime): the pushed one first and checked, then the rest grouped by
/// period in day order, each wearing a small grey period label while the
/// rows span more than one period (NCL-8). The buttons:
/// - the commit — "Consider (N)", "Did (N)" (every mark a prompt's square)
///   or "Log (N)" for a mix (`NotificationWords.commitVerb`): ONE
///   `bulk/complete` with reminder `ids` and prompt `prompts`;
/// - the one-day move — "→ Afternoon · 4:00 PM (N)": to the first period that
///   opens after now AND after every checked row's own period (RM-MOVE-TARGET
///   on the server); absent when no such period is left today (a Bedtime
///   reminder shows only the commit and Cancel);
/// - Cancel, last.
/// Foundation-only; `NagChecklistTests` pins it.
enum NagChecklist {

    /// One row: a reminder or prompt, and the period it is in today.
    struct Item: ChecklistItem {
        let item: PeriodChecklist.Item
        let slot: TimeSlotDTO

        var checklistKey: String { item.checklistKey }
        var isPrompt: Bool { item.isPrompt }
    }

    typealias State = ChecklistState<Item>

    /// The pushed item's key: "r:<task id>" for a reminder, its `prompt_key`
    /// for a quota prompt.
    static func reminderKey(_ taskId: Int) -> String { "r:\(taskId)" }

    /// Opening: nothing listed yet, the pushed item marked (NCL-3); its row
    /// comes in with the list and keeps its mark while it is still waiting.
    static func opening(heldKey: String) -> State {
        State(rows: [], marks: [heldKey: .check], load: .loading, heldKey: heldKey)
    }

    // MARK: - Rows

    /// Every reminder, then every waiting prompt, of each period that has
    /// opened (within the OpenTask day), in day order; Anytime never.
    static func items(_ groups: [ReminderGroupDTO], now: Date, day: OpenTaskDay) -> [Item] {
        let opened = groups.compactMap { group -> (TimeSlotDTO, ReminderGroupDTO)? in
            guard let slot = group.slot, let start = slot.startMinutes,
                  day.minutesIntoDay(start) <= day.minutesIntoDay(of: now) else { return nil }
            return (slot, group)
        }
        .sorted { day.minutesIntoDay($0.0.startMinutes ?? 0) < day.minutesIntoDay($1.0.startMinutes ?? 0) }
        return opened.flatMap { slot, group in
            PeriodChecklist.items(group).map { Item(item: $0, slot: slot) }
        }
    }

    /// NCL-8: a row names its period while the rows span more than one.
    static func showsPeriodLabels(_ state: State) -> Bool {
        Set(state.rows.map(\.slot.id)).count > 1
    }

    // MARK: - The move's period (RM-MOVE-TARGET)

    /// The first period that opens after now and after every marked row's
    /// own period, within the OpenTask day. Nil with nothing marked or none
    /// left.
    static func moveTarget(
        marked: [Item], slots: [TimeSlotDTO], now: Date, day: OpenTaskDay
    ) -> TimeSlotDTO? {
        guard !marked.isEmpty else { return nil }
        let nowInto = day.minutesIntoDay(of: now)
        let latestOwn = marked.compactMap { $0.slot.startMinutes.map(day.minutesIntoDay) }.max() ?? nowInto
        return slots
            .compactMap { slot in slot.startMinutes.map { (slot, day.minutesIntoDay($0)) } }
            .filter { $0.1 > nowInto && $0.1 > latestOwn }
            .min { $0.1 < $1.1 }?
            .0
    }

    /// Whether any period opens later today — what the fixed (Watch, Mac,
    /// lock-screen) lists check before offering "→ Next period".
    static func laterPeriodRemains(slots: [TimeSlotDTO], now: Date, day: OpenTaskDay) -> Bool {
        let nowInto = day.minutesIntoDay(of: now)
        return slots.contains { $0.startMinutes.map { day.minutesIntoDay($0) > nowInto } ?? false }
    }

    /// The first period opening after now — where a fixed list's "→ Next
    /// period" sends its one item (its own period has opened: a push only
    /// comes in an opened period).
    static func nextPeriod(slots: [TimeSlotDTO], now: Date, day: OpenTaskDay) -> TimeSlotDTO? {
        let nowInto = day.minutesIntoDay(of: now)
        return slots
            .compactMap { slot in slot.startMinutes.map { (slot, day.minutesIntoDay($0)) } }
            .filter { $0.1 > nowInto }
            .min { $0.1 < $1.1 }?
            .0
    }

    // MARK: - The action rows (NCL-4, NCL-6)

    static let moveIdentifier = NotificationAction.moveNextPeriod

    static func actions(
        for state: State, slots: [TimeSlotDTO], now: Date, day: OpenTaskDay
    ) -> [TaskNotificationList.Row] {
        let cancel = TaskNotificationList.Row(identifier: NotificationAction.cancel, title: NotificationWords.cancel)
        let marked = state.marked
        guard let verb = NotificationWords.commitVerb(marked.map(\.mark)) else { return [cancel] }
        var rows = [TaskNotificationList.Row(
            identifier: NotificationAction.completeChecked,
            title: NotificationWords.counted(verb, marked.count)
        )]
        if let target = moveTarget(marked: marked.map(\.item), slots: slots, now: now, day: day) {
            rows.append(TaskNotificationList.Row(
                identifier: moveIdentifier,
                title: NotificationWords.counted(moveTitle(target), marked.count)
            ))
        }
        return rows + [cancel]
    }

    /// "→ Afternoon · 4:00 PM".
    static func moveTitle(_ slot: TimeSlotDTO) -> String {
        "\u{2192} \(slot.label) \u{00B7} \(clock(slot))"
    }

    /// A period's start as the app writes a time ("4:00 PM").
    static func clock(_ slot: TimeSlotDTO) -> String {
        guard let minutes = slot.startMinutes,
              let date = Calendar.current.date(bySettingHour: minutes / 60, minute: minutes % 60, second: 0, of: Date())
        else { return slot.startTime }
        return DateHelpers.formatShortTime(date)
    }

    // MARK: - The commit (NCL-4, NCL-5, NCL-7)

    enum Intent: Equatable {
        case commit
        case move
    }

    enum CommitOutcome {
        /// The server acted; clear these banners. `removesOwnBanner`: the
        /// pushed item was one of them.
        case sent(reminderIds: [Int], promptKeys: [String], removesOwnBanner: Bool)
        case nothingMarked
        /// The re-check left nothing to send (or nowhere to move): reload
        /// with `groups`, stay open.
        case nothingLeft(groups: [ReminderGroupDTO])
        /// A refused batch (4xx): reload, stay open.
        case refused
    }

    /// The marked rows, re-checked against today's periods as they are now,
    /// in ONE request: the commit's `bulk/complete`, or the move.
    static func commit(
        _ intent: Intent, state: State, slots: [TimeSlotDTO], now: Date, day: OpenTaskDay, api: NagChecklistAPI
    ) async throws -> CommitOutcome {
        let marked = state.marked
        guard !marked.isEmpty else { return .nothingMarked }
        do {
            let groups = try await api.fetchReminderGroups()
            let live = Dictionary(
                items(groups, now: now, day: day).map { ($0.checklistKey, $0) }, uniquingKeysWith: { a, _ in a }
            )
            let send = marked.compactMap { entry in live[entry.item.checklistKey].map { ($0, entry.mark) } }
            guard !send.isEmpty else { return .nothingLeft(groups: groups) }

            var ids: [Int] = []
            var prompts: [APIClient.PromptCommit] = []
            for (item, mark) in send {
                switch item.item {
                case .reminder(let task): ids.append(task.id)
                case .prompt(let prompt): prompts.append(APIClient.PromptCommit(key: prompt.promptKey, did: mark == .did))
                }
            }
            let keys = prompts.map(\.key)
            let own = state.heldKey.map { held in send.contains { $0.0.checklistKey == held } } ?? false

            switch intent {
            case .commit:
                let affected = try await api.completeChecklist(ids: ids, prompts: prompts)
                guard affected > 0 else { return .nothingLeft(groups: groups) }
            case .move:
                guard let target = moveTarget(marked: send.map(\.0), slots: slots, now: now, day: day) else {
                    return .nothingLeft(groups: groups)
                }
                _ = try await api.moveForToday(ids: ids, promptKeys: keys, slotId: target.id)
            }
            return .sent(reminderIds: ids, promptKeys: keys, removesOwnBanner: own)
        } catch APIError.serverError(let code) where (400..<500).contains(code) {
            return .refused
        }
    }
}

/// The calls the push checklist makes — `APIClient`'s, behind a protocol so
/// `NagChecklistTests` can record them with a stub.
protocol NagChecklistAPI {
    /// Today's period groups from `GET /api/reminders`.
    func fetchReminderGroups() async throws -> [ReminderGroupDTO]
    func completeChecklist(ids: [Int], prompts: [APIClient.PromptCommit]) async throws -> Int
    /// `POST /api/reminders/move`.
    func moveForToday(ids: [Int], promptKeys: [String], slotId: Int) async throws -> APIClient.MoveResult
}

extension APIClient: NagChecklistAPI {
    func fetchReminderGroups() async throws -> [ReminderGroupDTO] {
        try await fetchReminders().groups
    }
}
