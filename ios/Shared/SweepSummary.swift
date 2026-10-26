import Foundation

/// The detail lines under a bulk snooze ("sweep") result: which High and
/// Urgent counts apply this run. One list, rendered by every surface that
/// reports a sweep — the watch sheet (`BulkSnoozeSheetView`), the watch
/// Smart Stack card (`SnoozedCardView`), the Mac menu bar
/// (`MenuBarModel.sweepSummary`) and the Mac's "Nothing to defer" alert
/// (`MenuActions`).
///
/// Structured cases rather than strings so each surface can word them for
/// its space (the menu bar says "2 High left", the watch "2 High still
/// overdue") and style them (Urgent is drawn in the overdue colour) while the
/// counts and their order come from one place. The Mac surfaces show only
/// what was left behind and skip `.includedHigh`. The lists drifted
/// when each surface built its own: the watch sheet had no line for High
/// left behind, so a High task still overdue after the sweep went unmentioned.
///
/// Only nonzero counts become lines, so a batch with no High or Urgent tasks
/// reads as a clean confirmation rather than a list of zeros. What the
/// numbers mean server-side: `filterForBulkSnooze` in `src/core/tasks/bulk.ts`
/// (P0-P2 always, P3 only once nothing lower is left, P4 never).
enum SweepLine: Equatable {
    /// Tasks sent to the Tasks queue at the next day start (`queued`, the
    /// task queue) rather than to the period the sweep asked for — the
    /// server lands a below-High task there whenever the asked-for time is
    /// at or after the rollover ("Day starts at" PR 3). `at` is
    /// `queued_until`.
    case queued(Int, at: Date?)
    /// High (P3) tasks the sweep moved — only in a round with nothing lower
    /// left, or the one High task a notification's own action rescued.
    case includedHigh(Int)
    /// High tasks left overdue because something lower moved this round; a
    /// second sweep takes them.
    case highStillOverdue(Int)
    /// Urgent (P4) tasks, which a sweep never moves.
    case urgentStillOverdue(Int)

    /// The watch's wording, used on both watch surfaces.
    var text: String {
        switch self {
        case .queued(let n, let at):
            return at.map { "\(n) to the queue at \(Self.timeWords($0))" } ?? "\(n) to the queue"
        case .includedHigh(let n): return "Included \(n) High"
        case .highStillOverdue(let n): return "\(n) High still \(TaskWording.overdueLower)"
        case .urgentStillOverdue(let n): return "\(n) Urgent still \(TaskWording.overdueLower)"
        }
    }

    /// Urgent left overdue is the one line drawn as a warning.
    var isUrgent: Bool {
        if case .urgentStillOverdue = self { return true }
        return false
    }

    /// "3:00 AM" — fixed English 12-hour, like the snooze pad's words.
    static func timeWords(_ date: Date, timeZone: TimeZone = .current) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = timeZone
        f.dateFormat = "h:mm a"
        return f.string(from: date)
    }

    static func lines(
        snoozedHigh: Int, skippedHigh: Int, skippedUrgent: Int, queued: Int = 0, queuedAt: Date? = nil
    ) -> [SweepLine] {
        var lines: [SweepLine] = []
        if queued > 0 { lines.append(.queued(queued, at: queuedAt)) }
        if snoozedHigh > 0 { lines.append(.includedHigh(snoozedHigh)) }
        if skippedHigh > 0 { lines.append(.highStillOverdue(skippedHigh)) }
        if skippedUrgent > 0 { lines.append(.urgentStillOverdue(skippedUrgent)) }
        return lines
    }
}

extension APIClient.BulkSnoozeResult {
    var summaryLines: [SweepLine] {
        SweepLine.lines(
            snoozedHigh: snoozedHigh, skippedHigh: skippedHigh, skippedUrgent: skippedUrgent,
            queued: queued, queuedAt: queuedUntil
        )
    }

    /// A cached task list as it stands after this sweep: the tasks it moved
    /// taken out (their new targets aren't known here — the server resolved
    /// "next" — so they're removed rather than guessed at, and the next
    /// successful fetch puts them back with real dates). The watch's
    /// `WatchCache.removeSweptOverdueTasks` applies it, so a Smart Stack
    /// reload whose own fetch fails can't fall back to the pre-sweep overdue
    /// set and flip the card straight back into overdue mode.
    ///
    /// - With `moved_ids` (2026-10-26): exactly those ids leave, nothing
    ///   else — not a task held back for a passed deadline, not a High task
    ///   the press didn't take, not an Urgent one.
    /// - From an older server (`movedIds` nil): the old guess from the counts.
    ///   Every overdue task that isn't a reminder or a quota leaves, except
    ///   Urgent (never swept) and High while the server reports skipping any
    ///   (`skippedHigh > 0`).
    func tasksLeft(after tasks: [TaskDTO], now: Date = Date()) -> [TaskDTO] {
        if let movedIds {
            let moved = Set(movedIds)
            return tasks.filter { !moved.contains($0.id) }
        }
        let keepHigh = skippedHigh > 0
        return tasks.filter { task in
            guard task.isOverdue(now: now), !task.isReminder, !task.isTracked else { return true }
            if task.priority >= 4 { return true }
            if task.priority == 3 { return keepHigh }
            return false
        }
    }
}
