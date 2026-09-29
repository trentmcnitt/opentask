import Foundation

/// The detail lines under a bulk snooze ("sweep") result: which High and
/// Urgent counts apply this run. One list, rendered by every surface that
/// reports a sweep — the watch sheet (`BulkSnoozeSheetView`), the watch
/// Smart Stack card (`SnoozedCardView`), the Mac menu bar
/// (`MenuBarModel.sweepSummary`) and the Mac's "Nothing to snooze" alert
/// (`MenuActions`).
///
/// Structured cases rather than strings so each surface can word them for
/// its space (the menu bar says "2 High left", the watch "2 High still
/// overdue") and style them (Urgent is drawn in the overdue colour) while the
/// set of lines, and their order, stays the same everywhere. They drifted
/// when each surface built its own: the watch sheet had no line for High
/// left behind, so a High task still overdue after the sweep went unmentioned.
///
/// Only nonzero counts become lines, so a batch with no High or Urgent tasks
/// reads as a clean confirmation rather than a list of zeros. What the
/// numbers mean server-side: `filterForBulkSnooze` in `src/core/tasks/bulk.ts`
/// (P0-P2 always, P3 only once nothing lower is left, P4 never).
enum SweepLine: Equatable {
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
        case .includedHigh(let n): return "Included \(n) High"
        case .highStillOverdue(let n): return "\(n) High still overdue"
        case .urgentStillOverdue(let n): return "\(n) Urgent still overdue"
        }
    }

    /// Urgent left overdue is the one line drawn as a warning.
    var isUrgent: Bool {
        if case .urgentStillOverdue = self { return true }
        return false
    }

    static func lines(snoozedHigh: Int, skippedHigh: Int, skippedUrgent: Int) -> [SweepLine] {
        var lines: [SweepLine] = []
        if snoozedHigh > 0 { lines.append(.includedHigh(snoozedHigh)) }
        if skippedHigh > 0 { lines.append(.highStillOverdue(skippedHigh)) }
        if skippedUrgent > 0 { lines.append(.urgentStillOverdue(skippedUrgent)) }
        return lines
    }
}

extension APIClient.BulkSnoozeResult {
    var summaryLines: [SweepLine] {
        SweepLine.lines(snoozedHigh: snoozedHigh, skippedHigh: skippedHigh, skippedUrgent: skippedUrgent)
    }
}
