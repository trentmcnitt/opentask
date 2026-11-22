import Foundation

/// THE OVERDUE CHECKLIST — a task notification's long-press (2026-11-21).
///
/// Trent: "I can snooze all, but I can't complete multiple." Long-pressing a
/// `TASK_REMINDER` (or a `TASK_SUMMARY`) shows the user's overdue tasks as a
/// checklist over the snooze grid, and Done and every time act on the
/// CHECKED set. This file is the whole rule set, Foundation-only so
/// `OpenTaskLogicTests` pins it (`OverdueChecklistTests`); the content
/// extension (`NotificationViewController`, `OverdueChecklistView`) only
/// draws it and sends what it says. It replaced #499's This task / All
/// overdue switch.
///
/// The rules (ids used by the tests, the PR and the docs; Swift rules are not
/// in `src/lib/rule-registry.ts` yet):
///
/// - TNC-1 ROWS: the badge's overdue set (`GET /api/tasks?overdue=true`, no
///   reminders or quotas), fetched live when the view opens. The held task —
///   the one whose notification was pressed — first; the rest by priority,
///   highest first, then the most overdue first.
/// - TNC-2 HELD MARKER: the held row is checked when the view opens, and is
///   tinted a slightly different gray (unchecked) or green (checked) from the
///   other rows. No icon. It is drawn from the notification's payload at
///   once, so its actions work before (and without) the fetch; a held task
///   missing from the fetched list was handled elsewhere and drops off.
/// - TNC-3 PAGES: never more than 6 rows on a page (Trent, 2026-11-21: 6, not
///   8, "so we're not pushing it too far"): page 1 is the held task and 5
///   more, later pages up to 6. "Show less" (left) and "Show more" (right)
///   under the list; the first page only Show more, the last only Show less,
///   a middle page both, a single page neither. Show less goes back one
///   page. Checked state survives paging, and the header ("2 of 20
///   checked") and every "(N)" count all pages.
/// - TNC-4 ONE REQUEST: Done and every time act on every checked row, on any
///   page, in one request (`bulk/complete`, `bulk/snooze` with `ids`), one
///   undo entry. With two or more checked, each title ends in "(N)".
/// - TNC-5 NOTHING CHECKED: the acting rows are absent (iOS can't disable an
///   action button) — only Cancel; a summary keeps "All → Next period", the
///   ordinary sweep, while nothing is checked.
/// - TNC-6 RE-CHECK: right before sending, the overdue list is fetched again
///   and only checked rows still overdue AT THE SAME TIME are sent — a
///   repeating task done elsewhere would otherwise advance twice, a task
///   deferred elsewhere be moved again. Nothing left: the list reloads and
///   the view stays open.
/// - TNC-7 BANNERS: after a success the view closes and the banners of the
///   tasks acted on go (the ids completed; a snooze's `moved_ids`, as the
///   sweep does). Every other banner stays.
/// - TNC-8 CANCEL: always the last row. Closes the view and removes this
///   notification's banner (Trent: "I want Cancel to mark it as seen and get
///   rid of the banner"). Nothing is sent; the next nag is unchanged.
/// - TNC-9 GRID: unchanged (#499's, Next period beside Next Hour). A picked
///   time is one absolute time for the whole checked set. On a task
///   notification it counts from the held task's own time, on a summary from
///   now; the named action rows count from now (every row is overdue, so that
///   is each row's own rule).
enum OverdueChecklist {

    /// TNC-3 (the shared checklist's page size, NCL-2).
    static var pageSize: Int { NotificationChecklist.pageSize }

    /// One row: what the list draws and what the re-check compares.
    struct Row: ChecklistItem {
        let id: Int
        let title: String
        let priority: Int
        /// The target as the list saw it, compared by instant at the
        /// re-check (TNC-6) — parsed the one way `TaskDTO.dueDate` parses.
        let dueDate: Date?
        /// Drawn from the notification's payload, not the fetched list: its
        /// time is the notifier's (`effective_due_at`), which for a repeating
        /// task need not equal the stored `due_at` the list carries, so the
        /// re-check compares only that it is still overdue (TNC-6).
        let fromPayload: Bool

        init(id: Int, title: String, priority: Int, dueAt: String?, fromPayload: Bool = false) {
            self.id = id
            self.title = title
            self.priority = priority
            self.dueDate = dueAt.flatMap(DateHelpers.parseISO)
            self.fromPayload = fromPayload
        }

        init(_ task: TaskDTO) {
            self.init(id: task.id, title: task.title, priority: task.priority, dueAt: task.dueAt)
        }

        var checklistKey: String { Self.key(id) }
        static func key(_ id: Int) -> String { "t:\(id)" }
    }

    typealias Load = ChecklistLoad

    /// The overdue list on screen: the shared checklist state
    /// (`ChecklistState`, NCL-1…6), addressed by task id.
    struct State: Equatable {
        private(set) var list: ChecklistState<Row>
        /// The pressed notification's task; nil on a summary.
        let heldId: Int?

        /// A task notification: the held row from the payload, checked.
        static func held(_ row: Row) -> State {
            State(
                list: ChecklistState(rows: [row], marks: [row.checklistKey: .check], load: .loading, heldKey: row.checklistKey),
                heldId: row.id
            )
        }

        /// A summary: no held row, nothing checked.
        static func summary() -> State {
            State(list: ChecklistState(rows: [], load: .loading), heldId: nil)
        }

        var isSummary: Bool { heldId == nil }
        var rows: [Row] { list.rows }
        var load: Load { list.load }
        var page: Int { list.page }

        // MARK: Rows and pages (TNC-1, TNC-3)

        /// The fetched overdue list landed (on open, after a refused batch,
        /// or when a re-check left nothing to send), in TNC-1's order. Checked
        /// rows that are still listed stay checked; the held row keeps its
        /// place first while listed, and drops off (unchecked) once it isn't.
        mutating func apply(fetched tasks: [TaskDTO]) {
            list.apply(fetched: tasks.map(Row.init).sorted(by: OverdueChecklist.ordered))
        }

        mutating func fetchFailed() { list.fetchFailed() }

        var pageCount: Int { list.pageCount }
        var pageRows: [Row] { list.pageRows }
        var pageSpacers: Int { list.pageSpacers }
        var showsLess: Bool { list.showsLess }
        var showsMore: Bool { list.showsMore }
        mutating func showMore() { list.showMore() }
        mutating func showLess() { list.showLess() }

        // MARK: Checking (TNC-2, TNC-4)

        var checked: Set<Int> { Set(list.marked.map(\.item.id)) }
        func isChecked(_ id: Int) -> Bool { list.mark(of: Row.key(id)) != nil }
        mutating func toggle(_ id: Int) { list.toggle(Row.key(id)) }

        /// Every checked row, in list order, on any page.
        var checkedRows: [Row] { list.marked.map(\.item) }

        /// "2 of 20 checked"; "20 overdue" with nothing checked.
        var headerCount: String? { list.headerCount(noun: TaskWording.overdueLower) }

        /// Nothing overdue at all (the held task too was handled first).
        var isEmpty: Bool { list.isEmpty }
    }

    /// TNC-1's order for every row but the held one: priority, highest
    /// first, then the most overdue (earliest target) first; undated last,
    /// then by id so the order is total.
    static func ordered(_ a: Row, _ b: Row) -> Bool {
        if a.priority != b.priority { return a.priority > b.priority }
        switch (a.dueDate, b.dueDate) {
        case let (x?, y?) where x != y: return x < y
        case (.some, nil): return true
        case (nil, .some): return false
        default: return a.id < b.id
        }
    }

    // MARK: - The action rows (TNC-4, TNC-5, TNC-8)

    static let cancel = TaskNotificationList.Row(identifier: NotificationAction.cancel, title: NotificationWords.cancel)

    /// The action list for the state on screen.
    ///
    /// Checked: Done, the next period by name, +1 hour, the two periods
    /// after it, Cancel — or, with a time picked in the grid, Done, that
    /// time, Cancel. With two or more checked, each acting title ends in
    /// "(N)". Nothing checked: Cancel, after "All → Next period" on a
    /// summary that lists anything (TNC-5). No cached period: no period rows.
    static func actions(
        for state: State, picked: Date?, now: Date, slots: [TimeSlotDTO], calendar: Calendar = .current
    ) -> [TaskNotificationList.Row] {
        let count = state.checked.count
        guard count > 0 else {
            if state.isSummary, !state.rows.isEmpty, !slots.isEmpty {
                return [TaskNotificationList.allNextPeriod, cancel]
            }
            return [cancel]
        }
        let row = { (identifier: String, title: String) in
            TaskNotificationList.Row(identifier: identifier, title: NotificationWords.counted(title, count))
        }
        var rows = [row(NotificationAction.done, NotificationWords.done)]
        if let picked {
            rows.append(row(NotificationAction.snoozeCustom, DateHelpers.formatShortTime(picked)))
            return rows + [cancel]
        }
        let periods = TaskNotificationList.upcoming(dueAtISO: nil, now: now, slots: slots, calendar: calendar)
        if let next = periods.first {
            rows.append(row(
                NotificationAction.snoozeNextPeriod,
                TaskNotificationList.named(next.slot.label, next.at, now: now, calendar: calendar)
            ))
        }
        rows.append(row(
            NotificationAction.snooze1hr,
            TaskNotificationList.named("+1 hour", DateHelpers.snapToNextHour(now: now), now: now, calendar: calendar)
        ))
        rows += periods.dropFirst().prefix(namedPeriodsAfterNext).map { period in
            row(
                NotificationAction.snoozeSlotIdentifier(startTime: period.slot.startTime),
                TaskNotificationList.named(period.slot.label, period.at, now: now, calendar: calendar)
            )
        }
        return rows + [cancel]
    }

    /// The periods named after the next one: two, so a full list is six rows
    /// with Cancel (the mockup's Done · next · +1 hour · two more · Cancel).
    static let namedPeriodsAfterNext = 2

    // MARK: - What a button does (TNC-4, TNC-8, TNC-9)

    enum Intent: Equatable {
        /// Done on the checked set: `POST /api/tasks/bulk/complete {ids}`.
        case complete
        /// A time for the checked set: `POST /api/tasks/bulk/snooze` with
        /// `ids`, `include_task_ids` and one `until`.
        case snooze(until: Date)
        /// Close and remove this banner; nothing sent.
        case cancel
        /// "All → Next period" on a summary with nothing checked: the
        /// ordinary sweep (`NotificationActionRunner`).
        case sweep
        /// Nothing to do (a period that is gone, a custom time with none
        /// picked, an identifier this list never offers).
        case none
    }

    /// The intent of the button pressed. Times are worked out now, from now
    /// (every checked row is overdue), so a list left open still does what
    /// its title says.
    static func intent(
        for identifier: String, picked: Date?, now: Date, slots: [TimeSlotDTO], calendar: Calendar = .current
    ) -> Intent {
        switch identifier {
        case NotificationAction.cancel: return .cancel
        case NotificationAction.done: return .complete
        case NotificationAction.snooze1hr: return .snooze(until: DateHelpers.snapToNextHour(now: now))
        case NotificationAction.snoozeCustom: return picked.map { .snooze(until: $0) } ?? .none
        case TaskNotificationList.allNextPeriod.identifier: return .sweep
        default:
            let target = TaskNotificationList.singleTarget(
                for: identifier, dueAtISO: nil, now: now, slots: slots, calendar: calendar
            )
            return target.map { .snooze(until: $0) } ?? .none
        }
    }

    // MARK: - The re-check (TNC-6)

    /// The checked rows to send, in list order: those the fresh overdue list
    /// still holds at the SAME target instant as the list showed. A row whose
    /// target moved (a repeating task done elsewhere, a task deferred
    /// elsewhere) or that left the list is dropped.
    /// A payload row (the list never loaded) is sent while it is still
    /// overdue at all.
    static func toSend(checked: [Row], current: [TaskDTO]) -> [Int] {
        let now = Dictionary(current.map { ($0.id, $0.dueDate) }, uniquingKeysWith: { first, _ in first })
        return checked.compactMap { row in
            guard let fresh = now[row.id] else { return nil }
            guard row.fromPayload || fresh == row.dueDate else { return nil }
            return row.id
        }
    }

    // MARK: - The commit (TNC-4, TNC-6, TNC-7)

    enum CommitOutcome {
        /// The server acted. Clear `clearBanners`; close the view, removing
        /// the pressed banner only when `removesOwnBanner`.
        case sent(acted: [Int], clearBanners: [Int], removesOwnBanner: Bool)
        /// Nothing checked: nothing sent, the view stays.
        case nothingChecked
        /// The re-check left nothing to send: reload with `current`, stay.
        case nothingLeft(current: [TaskDTO])
        /// The server refused the batch (4xx: a sent id was done or deleted
        /// between the re-check and the request): reload, stay.
        case refused
    }

    /// Done or a time on the checked set: the re-check, then ONE request.
    ///
    /// The one shortcut: when the list never loaded (still loading, or its
    /// fetch failed) and only the pressed task is checked, it is sent as it
    /// is — the notification is about it, and #499's single-task Done never
    /// needed the list. Any other error propagates (the view stays open).
    static func commit(_ intent: Intent, state: State, api: OverdueChecklistAPI) async throws -> CommitOutcome {
        let checked = state.checkedRows
        guard !checked.isEmpty else { return .nothingChecked }
        do {
            let ids: [Int]
            if state.load != .loaded, let held = state.heldId, checked.map(\.id) == [held] {
                ids = [held]
            } else {
                let current = try await api.fetchOverdueTasks()
                ids = toSend(checked: checked, current: current)
                guard !ids.isEmpty else { return .nothingLeft(current: current) }
            }
            switch intent {
            case .complete:
                _ = try await api.completeTasks(ids: ids)
                return .sent(
                    acted: ids, clearBanners: bannersToClear(completed: ids),
                    removesOwnBanner: removesOwnBanner(intent: intent, heldId: state.heldId, acted: ids)
                )
            case .snooze(let until):
                let result = try await api.bulkSnooze(ids: ids, until: until)
                let acted = result.movedIds ?? ids
                return .sent(
                    acted: acted, clearBanners: bannersToClear(snoozed: result),
                    removesOwnBanner: removesOwnBanner(intent: intent, heldId: state.heldId, acted: acted)
                )
            case .cancel, .sweep, .none:
                return .nothingChecked
            }
        } catch APIError.serverError(let code) where (400..<500).contains(code) {
            return .refused
        }
    }

    // MARK: - Banners (TNC-7, TNC-8)

    /// The task ids whose banners go after a successful request: the ids
    /// completed, or the ids a snooze moved (`moved_ids`; nil from an older
    /// server, which then clears nothing here — its silent `dismiss` push
    /// still clears them).
    static func bannersToClear(completed: [Int]) -> [Int] { completed }
    static func bannersToClear(snoozed result: APIClient.BulkSnoozeResult) -> [Int] { result.movedIds ?? [] }

    /// Whether the pressed notification's own banner goes too: always for
    /// Cancel and on a summary; on a task notification only when its task
    /// was acted on (`acted`). Unchecked, it stays (TNC-7).
    static func removesOwnBanner(intent: Intent, heldId: Int?, acted: [Int]) -> Bool {
        if intent == .cancel { return true }
        guard let heldId else { return true }
        return acted.contains(heldId)
    }
}

/// The calls the overdue checklist makes — `APIClient`'s, behind a protocol
/// so `OverdueChecklistTests` can record them with a stub.
protocol OverdueChecklistAPI {
    /// `GET /api/tasks?overdue=true`.
    func fetchOverdueTasks() async throws -> [TaskDTO]
    /// `POST /api/tasks/bulk/complete {ids}`: one transaction, one undo entry.
    func completeTasks(ids: [Int]) async throws -> Int
    /// `POST /api/tasks/bulk/snooze` with `ids`, `include_task_ids` and one
    /// `until` (and `cap_at_deadline_ids`): one undo entry.
    func bulkSnooze(ids: [Int], until: Date) async throws -> APIClient.BulkSnoozeResult
}

extension APIClient: OverdueChecklistAPI {
    func bulkSnooze(ids: [Int], until: Date) async throws -> BulkSnoozeResult {
        try await bulkSnoozeTasks(
            ids: ids, until: DateHelpers.formatISO(until), includeTaskIds: ids, capAtDeadlineIds: ids
        )
    }
}
