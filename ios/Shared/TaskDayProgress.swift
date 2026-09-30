import Foundation

/// "Day complete" for the Tasks widget's Today page (2026-09-29) — the pure
/// half of its finished states, covered by `TaskDayProgressTests`
/// (`OpenTaskLogicTests`). The Tasks twin of `ReminderDayProgress`: same
/// words, same tint, same seal, so the two widgets finish a day alike.
///
/// Foundation-only on purpose: every rule a render depends on lives here (or
/// in `TasksTimeline`, which adds the page gating), and the views only pick
/// fonts.
///
/// The states of the Today page (approved from mockups t1b/t2/t3/t5b):
/// - **Mid-day**: the list, and "2 of 6" at the bottom left (`TodayCount`):
///   done today over done today plus still open on Today.
/// - **Day complete** (`isDayComplete`): Today has no open tasks — and since
///   Today includes everything overdue, nothing is overdue either — AND at
///   least one task was completed today. A green wash over the card, the
///   seal, "Congratulations / Day complete", and "N done today" in the header.
/// - **Nothing due** (Today empty, nothing done today): the seal and "Nothing
///   due today", then the next few tasks due after today (`upcoming`). No
///   tint — nothing was finished, so there is nothing to celebrate.
enum TaskDayProgress {

    /// How many tasks `upcoming` returns — the Today page's "Up next" list
    /// under "Nothing due today". Also the cap on what the timeline entry
    /// carries, since WidgetKit archives every entry.
    static let upcomingLimit = 3

    // MARK: Done today

    /// The completions that fall on `now`'s local day. The cached list is
    /// fetched for the local day (`APIClient.fetchTodaysCompletions`), but a
    /// cache drawn after midnight still holds yesterday's — and "5 done
    /// today" at 12:05 am would be a false claim — so the day is checked
    /// here rather than trusted.
    static func doneToday(_ completions: [CompletionDTO], now: Date, calendar: Calendar = .current) -> [CompletionDTO] {
        completions.filter { completion in
            guard let date = completion.completedDate else { return false }
            return calendar.isDate(date, inSameDayAs: now)
        }
    }

    // MARK: Day complete

    /// Nothing open on Today and at least one task done today. A day with
    /// nothing due AND nothing done is never "complete": there was no work
    /// to finish, so it keeps the calmer "Nothing due today" instead.
    static func isDayComplete(openToday: Int, doneToday: Int) -> Bool {
        openToday == 0 && doneToday > 0
    }

    // MARK: "N of M"

    /// The Today page's bottom-left "2 of 6": done today over the day's
    /// whole load (done today plus still open on Today), so the total never
    /// shrinks as tasks are checked off. A task that becomes due mid-day, or
    /// is snoozed off Today, moves the total — it is the day as it stands.
    struct TodayCount: Equatable {
        let done: Int
        let total: Int

        init(doneToday: Int, openToday: Int) {
            done = doneToday
            total = doneToday + openToday
        }

        /// "2 of 6". The caller hides it when `total == 0` — "0 of 0"
        /// reports nothing.
        var text: String { "\(done) of \(total)" }

        var isEmpty: Bool { total == 0 }
    }

    // MARK: Up next

    /// The first `limit` open tasks due AFTER today — the list under "Nothing
    /// due today". The same exclusions as every Tasks list
    /// (`TaskLists.eligible`: undated, reminders, quotas) and the same order
    /// (soonest first, priority breaking ties). Anything due today or
    /// overdue is Today's, not "next", so it is left out.
    static func upcoming(_ tasks: [TaskDTO], now: Date, limit: Int = upcomingLimit, calendar: Calendar = .current) -> [TaskDTO] {
        guard let startOfTomorrow = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)) else {
            return []
        }
        let later = TaskLists.eligible(tasks).filter { ($0.dueDate ?? .distantPast) >= startOfTomorrow }
        return Array(TaskLists.sortedSoonestFirst(later).prefix(max(limit, 0)))
    }

    // MARK: What an empty Today shows

    /// The Today page's body when it has no rows to draw.
    enum EmptyBody: Equatable {
        /// Something was done today: "Congratulations / Day complete".
        case dayComplete
        /// Nothing was: "Nothing due today" (and Up next under it).
        case nothingDue
    }

    static func emptyBody(doneToday: Int) -> EmptyBody {
        doneToday > 0 ? .dayComplete : .nothingDue
    }
}
