import Foundation

/// Day-aware due-date formatting for the Tasks page's "Up next" rows.
///
/// The watch's rows are narrow, so a due line has to say the day at a glance
/// without spelling out a full date for anything happening soon — "9:00 AM"
/// only when it's unambiguous (today), "Tomorrow 9:00 AM" for the very next
/// day, a weekday name inside the current week, and a bare month/day past
/// that. Mirrors the phone's relative-date instinct
/// (`src/lib/format-date.ts`'s day-aware formatting) without importing it —
/// this is Swift, not a port of the TS.
enum WatchFormatting {
    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "h:mm a"
        f.timeZone = .current
        return f
    }()

    private static let monthDayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        f.timeZone = .current
        return f
    }()

    private static let monthDayYearFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d, yyyy"
        f.timeZone = .current
        return f
    }()

    /// Past-and-older dates carry their time too ("Sep 20 10:00 AM") — unlike
    /// the far-future bare-date case below, an overdue task's TIME is exactly
    /// what a glance needs (how overdue, not just which day).
    private static let monthDayTimeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d h:mm a"
        f.timeZone = .current
        return f
    }()

    private static let monthDayYearTimeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d, yyyy h:mm a"
        f.timeZone = .current
        return f
    }()

    /// "9:00 AM" (today) · "Tomorrow 9:00 AM" · "Sun 9:00 AM" (a FUTURE day
    /// within the next 6 days only) · "Oct 1" (further future) · "Oct 1,
    /// 2027" (a different year) · "Yesterday 10:00 AM" · "Sep 20 10:00 AM"
    /// (older overdue).
    ///
    /// Weekday names are future-only (2026-09-24 fix, coordinator review on
    /// PR #60): the original version also used a bare weekday for any day
    /// already this week, PAST included — so an overdue task from last
    /// Tuesday read "Tue 10:00 AM", which is genuinely ambiguous with THIS
    /// coming Tuesday (a weekday name alone doesn't say which one). Past
    /// dates now get "Yesterday" for -1, then an explicit month/day (+ time)
    /// for anything older — never a bare weekday, which is exactly the
    /// ambiguity this fixes.
    ///
    /// The days are OPENTASK days ("Day starts at" PR 3, `DayStartStore`):
    /// with the day starting at 3:00 AM, a 1:30 AM target tonight is
    /// today's ("1:30 AM"), and at 1:00 AM last evening's 8:00 PM is today's
    /// too. The words are the date's own (its weekday, its month and day),
    /// as on the web and the phone (`DueLabel.parts`).
    ///
    /// THE NIGHT RULE (2026-10-26, native catch-up PR 2; `NightDay`): a
    /// target between midnight and a before-noon day start names its evening
    /// — "Tomorrow night 1:00 AM", "Mon night 1:00 AM", "Last night 1:00 AM".
    /// Outside the night "Tomorrow" / "Yesterday" only where the OpenTask day
    /// and the target's own date agree (an 11 PM start: at Sat 12:30 a Sat
    /// 23:30 target reads "Sat 11:30 PM", never "Tomorrow"); a yesterday they
    /// disagree on reads as its date, since past weekdays are out (above).
    static func dueLine(for date: Date, now: Date = Date(), day: OpenTaskDay = DayStartStore.current) -> String {
        let calendar = Calendar.current
        let n = NightDay(at: date, now: now, day: day)
        let dayDelta = n.gap
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
        let time = timeFormatter.string(from: date)

        if dayDelta == 0 {
            return time
        }
        if dayDelta == 1 {
            return "\(NightDay.capitalized(n.words(past: false))) \(time)"
        }
        if dayDelta == -1, n.wordsAgree {
            return "\(NightDay.capitalized(n.words(past: true))) \(time)"
        }
        // Future only, within the next 6 days: a bare weekday reads faster
        // than a date, and — unlike the past — "next Thursday" said as just
        // "Thu" is unambiguous, since there's only one Thursday ahead of now
        // inside that window. In the night, the evening's: "Mon night".
        if dayDelta > 1 && dayDelta < 7 {
            return "\(n.timedWeekday) \(time)"
        }
        // Older overdue (dayDelta <= -2, or a yesterday the words can't name):
        // explicit date, WITH time — how overdue is exactly what matters here.
        if dayDelta < 0 {
            return sameYear
                ? monthDayTimeFormatter.string(from: date)
                : monthDayYearTimeFormatter.string(from: date)
        }
        // Further future (dayDelta >= 7): bare date, no time — unchanged
        // from before this fix, not flagged as wrong.
        return sameYear
            ? monthDayFormatter.string(from: date)
            : monthDayYearFormatter.string(from: date)
    }
}
