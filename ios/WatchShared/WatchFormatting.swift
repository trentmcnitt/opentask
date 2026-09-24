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

    private static let weekdayTimeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "EEE h:mm a"
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
    static func dueLine(for date: Date, now: Date = Date()) -> String {
        let calendar = Calendar.current
        let startOfToday = calendar.startOfDay(for: now)
        guard let startOfDate = calendar.dateInterval(of: .day, for: date)?.start else {
            return timeFormatter.string(from: date)
        }
        let dayDelta = calendar.dateComponents([.day], from: startOfToday, to: startOfDate).day ?? 0
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)

        if dayDelta == 0 {
            return timeFormatter.string(from: date)
        }
        if dayDelta == 1 {
            return "Tomorrow \(timeFormatter.string(from: date))"
        }
        if dayDelta == -1 {
            return "Yesterday \(timeFormatter.string(from: date))"
        }
        // Future only, within the next 6 days: a bare weekday reads faster
        // than a date, and — unlike the past — "next Thursday" said as just
        // "Thu" is unambiguous, since there's only one Thursday ahead of now
        // inside that window.
        if dayDelta > 1 && dayDelta < 7 {
            return weekdayTimeFormatter.string(from: date)
        }
        // Older overdue (dayDelta <= -2): explicit date, WITH time — how
        // overdue is exactly what matters here.
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
