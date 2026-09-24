import Foundation

/// Time-slot and "Up next" logic shared by the watch app (`OpenTaskWatch`)
/// and its Smart Stack widget (`OpenTaskWatchWidgets`) — the two watchOS
/// targets that both need "which slot is current" and "what counts as an
/// up-next task" to agree, without either importing `ios/OpenTaskWidgets`
/// (out of bounds tonight — see `WatchTheme.swift`'s doc). The phone widgets'
/// equivalent logic (`RemindersTimeline`/`TasksTimeline`, private to that
/// extension) was read for reference but not copied line-for-line; this is a
/// smaller, independent implementation sized for the watch's simpler UI (no
/// paging, no auto-advance).
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
        /// Started and still has pending reminders — the accent fill.
        case waiting
        /// Started and everything in it has been considered — the done fill.
        case finished
    }

    static func state(for group: ReminderGroupDTO, now: Date = Date()) -> SlotState {
        if let start = group.slot?.startMinutes, start > minutesSinceMidnight(now) {
            return .notStarted
        }
        return group.reminders.isEmpty ? .finished : .waiting
    }

    // MARK: - Tasks: "Up next"

    /// Same scope as the phone Tasks widget's "Up next": every open task with
    /// a due date, excluding reminders and tracked (quota) items — no
    /// end-of-day cutoff, soonest first. Shared by the app's Tasks page and
    /// the widget's timeline so the two surfaces never disagree about what
    /// "Up next" means.
    static func upNextTasks(from tasks: [TaskDTO]) -> [TaskDTO] {
        tasks
            .filter { $0.dueDate != nil && !$0.isReminder && !$0.isTracked }
            .sorted { ($0.dueDate ?? .distantFuture) < ($1.dueDate ?? .distantFuture) }
    }

    static func overdueTasks(from tasks: [TaskDTO], now: Date = Date()) -> [TaskDTO] {
        upNextTasks(from: tasks).filter { $0.isOverdue(now: now) }
    }
}
