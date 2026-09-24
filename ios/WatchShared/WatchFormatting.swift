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

    /// "9:00 AM" (today) · "Tomorrow 9:00 AM" · "Sun 9:00 AM" (this week,
    /// including a day already past today — an overdue task from Monday
    /// still reads "Mon 9:00 AM" rather than snapping to a bare date) ·
    /// "Oct 1" (further out) · "Oct 1, 2027" (a different year).
    static func dueLine(for date: Date, now: Date = Date()) -> String {
        let calendar = Calendar.current
        let startOfToday = calendar.startOfDay(for: now)
        guard let startOfDate = calendar.dateInterval(of: .day, for: date)?.start else {
            return timeFormatter.string(from: date)
        }
        let dayDelta = calendar.dateComponents([.day], from: startOfToday, to: startOfDate).day ?? 0

        if dayDelta == 0 {
            return timeFormatter.string(from: date)
        }
        if dayDelta == 1 {
            return "Tomorrow \(timeFormatter.string(from: date))"
        }
        // Within the next 6 days (and any day already this week, even if it's
        // in the past — an overdue task keeps its weekday name rather than
        // jumping straight to "Oct 1"): a bare weekday reads faster than a date.
        if dayDelta > 1 && dayDelta < 7 {
            return weekdayTimeFormatter.string(from: date)
        }
        if dayDelta < 0 && dayDelta > -7 {
            return weekdayTimeFormatter.string(from: date)
        }

        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
        return sameYear
            ? monthDayFormatter.string(from: date)
            : monthDayYearFormatter.string(from: date)
    }
}
