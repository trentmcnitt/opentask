import Foundation

/// Time-slot and "Up next" logic shared by the watch app (`OpenTaskWatch`)
/// and its Smart Stack widget (`OpenTaskWatchWidgets`) — the two watchOS
/// targets that both need "which slot is current" and "what counts as an
/// up-next task" to agree, without either importing `ios/OpenTaskWidgets`
/// (the phone widget extension's private code — see `WatchTheme.swift`'s
/// doc). The slot half is the watch's own, smaller than the phone's
/// `RemindersTimeline` (no paging, no auto-advance). The task lists are NOT
/// the watch's own: they forward to `TaskLists` (`ios/Shared`), the rules the
/// phone Tasks widget and the Mac menu bar use, so every surface agrees on
/// what is overdue and in what order.
enum WatchSlotLogic {

    // MARK: - Reminders: current slot

    private static func minutesSinceMidnight(_ date: Date, calendar: Calendar = .current) -> Int {
        let comps = calendar.dateComponents([.hour, .minute], from: date)
        return (comps.hour ?? 0) * 60 + (comps.minute ?? 0)
    }

    /// The slot the clock is currently in: the LATEST slot whose start has
    /// already passed today. Before the first slot starts (e.g. 3am), falls
    /// back to the day's first real slot so there's always something sane to
    /// land on rather than the un-slotted "Anytime" group. Empty `groups`
    /// (fresh fetch, or an account with no reminders at all) returns 0 —
    /// callers must check `groups.isEmpty` themselves before indexing.
    static func naturalSlotIndex(in groups: [ReminderGroupDTO], now: Date = Date()) -> Int {
        guard !groups.isEmpty else { return 0 }
        let nowMinutes = minutesSinceMidnight(now)

        var best = -1
        var bestStart = -1
        for (index, group) in groups.enumerated() {
            guard let start = group.slot?.startMinutes else { continue }
            if start <= nowMinutes && start > bestStart {
                bestStart = start
                best = index
            }
        }
        if best >= 0 { return best }
        // Nothing has started yet today — use the first real (non-"Anytime") slot.
        return groups.firstIndex(where: { $0.slot != nil }) ?? 0
    }

    /// Draw state for one segment of the Reminders progress strip. "Started"
    /// means the slot's clock time has passed today; "Anytime" (`slot ==
    /// nil`) is always treated as started, since it has no clock time to wait
    /// on. Named states rather than raw colors so `WatchTheme`, not this
    /// file, owns what each one looks like.
    enum SlotState {
        /// Hasn't started yet today — drawn as a faint placeholder.
        case notStarted
        /// Started and still has pending reminders or quota prompts — the
        /// accent fill.
        case waiting
        /// Everything in it has been handled — the done fill. Also a period
        /// that hasn't started yet but was finished EARLY (2026-09-28, Trent:
        /// pre-bedtime and evening done at 8 PM still drew gray) — the web's
        /// `ReminderSlotBar` rule: fully considered reads as finished whatever
        /// the clock says.
        case finished
    }

    static func state(for group: ReminderGroupDTO, now: Date = Date()) -> SlotState {
        // Waiting quota prompts count like reminders (2026-09-24).
        if group.hasNothingWaiting, group.consideredCount > 0 { return .finished }
        if let start = group.slot?.startMinutes, start > minutesSinceMidnight(now) {
            return .notStarted
        }
        return group.hasNothingWaiting ? .finished : .waiting
    }

    // MARK: - Tasks: "Up next"

    /// The phone Tasks widget's "Up next" (`TaskLists.upNext`): every open
    /// task with a due date, excluding reminders and tracked (quota) items —
    /// no end-of-day cutoff, soonest first, higher priority first on a tie.
    /// Shared by the app's Tasks page and the widget's timeline so the two
    /// surfaces never disagree about what "Up next" means.
    static func upNextTasks(from tasks: [TaskDTO]) -> [TaskDTO] {
        TaskLists.upNext(tasks)
    }

    /// `TaskLists.overdue`: the "Up next" tasks already past due, most
    /// overdue first.
    static func overdueTasks(from tasks: [TaskDTO], now: Date = Date()) -> [TaskDTO] {
        TaskLists.overdue(tasks, now: now)
    }
}
