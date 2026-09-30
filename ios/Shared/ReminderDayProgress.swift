import Foundation

/// "Day complete" and the per-period counts (2026-09-29) — the pure half of
/// the Reminders widget's finished states, shared by the phone/Mac widget and
/// the watch, and covered by `ReminderDayProgressTests` (`OpenTaskLogicTests`).
///
/// Foundation-only on purpose: every rule a render depends on lives here, and
/// the views only pick fonts.
///
/// The vocabulary (approved from mockups r3, "remove the word considered"):
/// - **Mid-period**: the list, and "4 of 7" at the bottom left (`countText`).
/// - **A finished period** (nothing waiting, something handled): a seal,
///   "All done", and "7 reminders" under it (`itemsText`). No tint.
/// - **Day complete** (`isDayComplete`): every period has nothing waiting —
///   including the ones that haven't started — and at least one item was
///   handled today. A faint green wash over the whole card on EVERY period,
///   and the clock's period reads "Congratulations / Day complete".
///
/// It replaced "All caught up", which fired once every STARTED period was
/// finished — at 9 pm with Night's reminders still to come, it was a false
/// finish line.
///
/// Quota prompts count exactly like reminders here, as in every other count
/// the Reminders surfaces show (`ReminderGroupDTO.waitingCount`/
/// `consideredCount`).
enum ReminderDayProgress {

    // MARK: Day complete

    /// Everything handled today, across every period: considered reminders
    /// plus handled quota prompts.
    static func handledTotal(_ groups: [ReminderGroupDTO]) -> Int {
        groups.reduce(0) { $0 + $1.consideredCount }
    }

    /// Every period of today — started or not — has nothing waiting, and at
    /// least one item was handled. A day with nothing configured (or nothing
    /// in any period) is never "complete": there was no work to finish, so it
    /// keeps its ordinary empty state rather than a celebration.
    static func isDayComplete(_ groups: [ReminderGroupDTO]) -> Bool {
        handledTotal(groups) > 0 && groups.allSatisfy(\.hasNothingWaiting)
    }

    // MARK: Per-period counts

    /// One period's "handled of total" — the bottom-left "4 of 7". The total
    /// is the period's whole day (waiting plus handled), so it never shrinks
    /// as things are checked off.
    struct PeriodCount: Equatable {
        let handled: Int
        let total: Int

        init(handled: Int, total: Int) {
            self.handled = handled
            self.total = total
        }

        init(_ group: ReminderGroupDTO) {
            handled = group.consideredCount
            total = group.waitingCount + group.consideredCount
        }

        /// "4 of 7". The caller hides it when `total == 0` — "0 of 0" reports
        /// nothing.
        var text: String { "\(handled) of \(total)" }
    }

    // MARK: Noun

    /// "1 reminder" / "7 reminders" — under "All done".
    ///
    /// ONE noun, prompts included: the Reminders widget already counts a
    /// quota prompt as a reminder everywhere ("N left", the strip, "DONE · N"),
    /// and the prompts are "quota reminders" in the product's own words. A
    /// noun that switched to "items" only when a period happened to hold a
    /// prompt would make the same period read differently from one day to
    /// the next.
    static func itemsText(_ count: Int) -> String {
        count == 1 ? "1 reminder" : "\(count) reminders"
    }

    // MARK: What the body shows when the on-screen period has no rows

    /// The Reminders widget's body when the list for the on-screen period is
    /// empty (nothing waiting, and — with "show completed" on — nothing done
    /// either). `displayedIndex` is the period on screen, `naturalIndex` the
    /// one the clock is in (`RemindersTimeline.naturalSlotIndex`).
    enum EmptyBody: Equatable {
        /// No periods at all today.
        case noReminders
        /// The whole day is done and this is the clock's period.
        case dayComplete
        /// This period is finished: `count` items were handled in it.
        case periodDone(count: Int)
        /// This period never had anything.
        case nothingHere
    }

    static func emptyBody(groups: [ReminderGroupDTO], displayedIndex: Int, naturalIndex: Int) -> EmptyBody {
        guard !groups.isEmpty else { return .noReminders }
        if isDayComplete(groups) && displayedIndex == naturalIndex { return .dayComplete }
        if groups.indices.contains(displayedIndex), groups[displayedIndex].consideredCount > 0 {
            return .periodDone(count: groups[displayedIndex].consideredCount)
        }
        return .nothingHere
    }
}
