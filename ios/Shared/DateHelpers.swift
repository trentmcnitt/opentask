import Foundation

/// Date computation helpers for the notification snooze grid.
///
/// Port of essential functions from src/lib/quick-select-dates.ts.
/// Uses the device's current timezone for display purposes.
enum DateHelpers {

    // MARK: - Snap to Next Preset

    /// Returns the next occurrence of a specific hour:minute in the device timezone.
    /// If the time has already passed today, returns tomorrow at that time.
    static func snapToNextPreset(hour: Int, minute: Int, now: Date = Date()) -> Date {
        let calendar = Calendar.current
        var components = calendar.dateComponents([.year, .month, .day], from: now)
        components.hour = hour
        components.minute = minute
        components.second = 0

        guard let todayAtPreset = calendar.date(from: components) else {
            return now
        }

        if todayAtPreset > now {
            return todayAtPreset
        }

        // Preset has passed — use tomorrow (calendar-day arithmetic for DST safety)
        guard let tomorrow = calendar.date(byAdding: .day, value: 1, to: todayAtPreset) else {
            return now
        }
        return tomorrow
    }

    // MARK: - Adjust Date

    /// Add or subtract minutes from an ISO date string. Returns a new ISO string.
    static func adjustByMinutes(_ isoDate: String, minutes: Int) -> String {
        guard let date = parseISO(isoDate) else { return isoDate }
        let adjusted = date.addingTimeInterval(Double(minutes) * 60)
        return formatISO(adjusted)
    }

    /// Add or subtract calendar days from an ISO date string (DST-safe).
    static func adjustByDays(_ isoDate: String, days: Int) -> String {
        guard let date = parseISO(isoDate) else { return isoDate }
        let calendar = Calendar.current
        guard let adjusted = calendar.date(byAdding: .day, value: days, to: date) else {
            return isoDate
        }
        return formatISO(adjusted)
    }

    // MARK: - Format Delta

    /// Format a delta in minutes for display: "+1hr", "+30min", "+2d 3hr", etc.
    /// Always uses the compact format suitable for notification action button labels.
    static func formatDelta(minutes: Int) -> String {
        let absMinutes = abs(minutes)
        let prefix = minutes >= 0 ? "+" : "-"

        let totalHours = absMinutes / 60
        let remainingMinutes = absMinutes % 60
        let days = totalHours / 24
        let hours = totalHours % 24

        if days > 0 && hours > 0 {
            return "\(prefix)\(days)d \(hours)hr"
        } else if days > 0 {
            return "\(prefix)\(days)d"
        } else if hours > 0 && remainingMinutes > 0 {
            return "\(prefix)\(hours)hr \(remainingMinutes)min"
        } else if hours > 0 {
            return "\(prefix)\(hours)hr"
        } else {
            return "\(prefix)\(absMinutes)min"
        }
    }

    /// Format a delta from a task's due date to a target time.
    /// Returns "+7hr", "+30min", etc.
    static func formatDeltaBetween(from dueAtISO: String, to targetISO: String) -> String {
        guard let dueAt = parseISO(dueAtISO),
              let target = parseISO(targetISO)
        else {
            return "+0min"
        }
        let deltaSeconds = target.timeIntervalSince(dueAt)
        let deltaMinutes = Int(deltaSeconds / 60)
        return formatDelta(minutes: deltaMinutes)
    }

    /// Format how long ago an ISO date was relative to now: "3hr 32min ago", "5min ago".
    static func formatRelativeTime(_ isoDate: String, now: Date = Date()) -> String {
        guard let date = parseISO(isoDate) else { return "" }
        let diffSeconds = now.timeIntervalSince(date)
        let absDiff = abs(diffSeconds)
        let isPast = diffSeconds > 0

        let totalMinutes = Int(absDiff / 60)
        let hours = totalMinutes / 60
        let minutes = totalMinutes % 60
        let days = hours / 24

        let text: String
        if days > 0 {
            text = days == 1 ? "1 day" : "\(days) days"
        } else if hours > 0 {
            text = minutes > 0 ? "\(hours)hr \(minutes)min" : "\(hours)hr"
        } else if totalMinutes > 0 {
            text = "\(totalMinutes)min"
        } else {
            return isPast ? "just now" : "in <1min"
        }

        return isPast ? "\(text) ago" : "in \(text)"
    }

    // MARK: - Snap to Next Hour

    private static let hourRoundThreshold = 35

    /// Snap a date to the nearest hour: >=35 min rounds up, <35 truncates down.
    static func snapToHour(_ date: Date) -> Date {
        let calendar = Calendar.current
        let minutes = calendar.component(.minute, from: date)
        // Truncate to start of current hour (bySetting searches forward, so use dateComponents)
        let components = calendar.dateComponents([.year, .month, .day, .hour], from: date)
        guard var result = calendar.date(from: components) else { return date }
        if minutes >= hourRoundThreshold {
            guard let advanced = calendar.date(byAdding: .hour, value: 1, to: result) else { return result }
            result = advanced
        }
        return result
    }

    /// Add 1 hour to now, then snap to the nearest hour boundary.
    /// Matches the web QuickActionPanel "Next Hour" behavior.
    /// - 2:20 PM → 3:00 PM (minutes < 35, snaps down)
    /// - 2:37 PM → 4:00 PM (minutes >= 35, snaps up)
    static func snapToNextHour(now: Date = Date()) -> Date {
        let oneHourLater = now.addingTimeInterval(3600)
        return snapToHour(oneHourLater)
    }

    /// Format a date as a short time string (e.g., "3:00 PM") in the device timezone.
    private static let shortTimeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "h:mm a"
        f.timeZone = TimeZone.current
        return f
    }()

    static func formatShortTime(_ date: Date) -> String {
        shortTimeFormatter.string(from: date)
    }

    // MARK: - ISO 8601 Parsing

    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let isoFormatterNoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func parseISO(_ string: String) -> Date? {
        isoFormatter.date(from: string) ?? isoFormatterNoFrac.date(from: string)
    }

    static func formatISO(_ date: Date) -> String {
        isoFormatterNoFrac.string(from: date)
    }
}
