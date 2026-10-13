import Foundation

/// The parts of an RRULE string, keys upper-cased: "FREQ=WEEKLY;BYDAY=WE" →
/// ["FREQ": "WEEKLY", "BYDAY": "WE"]. An optional "RRULE:" prefix is
/// dropped, and a part without a key and a value is skipped — the web's
/// `parseRRuleParts` (`src/lib/format-rrule.ts`). Values keep their case;
/// readers upper-case what they compare.
enum RRuleParts {
    static func parse(_ rrule: String) -> [String: String] {
        var body = rrule.trimmingCharacters(in: .whitespaces)
        if body.uppercased().hasPrefix("RRULE:") { body = String(body.dropFirst(6)) }
        var parts: [String: String] = [:]
        for part in body.split(separator: ";") {
            let pair = part.split(separator: "=", maxSplits: 1)
            guard pair.count == 2 else { continue }
            let key = pair[0].trimmingCharacters(in: .whitespaces).uppercased()
            let value = pair[1].trimmingCharacters(in: .whitespaces)
            guard !key.isEmpty, !value.isEmpty else { continue }
            parts[key] = value
        }
        return parts
    }
}

/// A repeating task's schedule in a few words — "every Wed", "daily at 9 AM",
/// "monthly on the 1st" — for the small words after an Upcoming row's title
/// (`TaskDTO.upcomingMeta`), where it replaced a bare "repeats" (2026-10-12,
/// Trent: "repeats" doesn't say when).
///
/// The web's row line is the model: `formatRRuleCompact`
/// (`src/lib/format-rrule.ts`, `TaskRow`'s second line) — same branches, same
/// time rule (BYHOUR/BYMINUTE, else the task's `anchor_time`). Where this
/// differs, on purpose, for a widget row that sits mid-sentence after
/// "Target Wed Oct 14 ·":
/// - lower-case first letter, like its neighbours "deadline …" and the old
///   "repeats";
/// - three-letter days ("Mon, Wed") rather than the web's M/Tu/W letters,
///   and "every Wed" rather than "Wednesdays";
/// - the web's "at", with ":00" dropped: "at 9 AM", "at 9:30 AM", "at noon",
///   "at midnight" ("monthly on the 1st at noon" reads; "… 1st noon" didn't);
/// - the monthly ordinal is kept ("the 2nd Tue", "the last Fri" — BYDAY=2TU,
///   or BYDAY=TU with BYSETPOS=2), which the web drops ("Monthly on Tue");
/// - BYMONTHDAY=-1 reads "the last day"; YEARLY with BYMONTH and BYMONTHDAY
///   reads "yearly on Mar 15".
/// Anything it can't read — no FREQ, HOURLY and finer, a day it doesn't know
/// — falls back to "repeats", never to the raw rule (the web's fallback).
enum RecurrenceSummary {
    static let fallback = "repeats"

    /// `includeTime: false` drops " at 9 AM"; `includeOn: false` drops the
    /// "on …" clause too ("every 2 weeks on Wed" → "every 2 weeks", "monthly
    /// on the 1st" → "monthly") — the shorter forms an Upcoming row falls back
    /// to so its words fit one line (`UpcomingMetaForm`, 2026-10-12).
    static func text(rrule: String?, anchorTime: String? = nil, includeTime: Bool = true, includeOn: Bool = true) -> String {
        guard let rrule, !rrule.isEmpty else { return fallback }
        return summary(rrule: rrule, anchorTime: anchorTime, includeTime: includeTime, includeOn: includeOn) ?? fallback
    }

    private static let shortDays = ["MO": "Mon", "TU": "Tue", "WE": "Wed", "TH": "Thu", "FR": "Fri", "SA": "Sat", "SU": "Sun"]
    private static let dayOrder = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
    private static let monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    private static func summary(rrule: String, anchorTime: String?, includeTime: Bool, includeOn: Bool) -> String? {
        let parts = RRuleParts.parse(rrule)
        guard let freq = parts["FREQ"]?.uppercased() else { return nil }
        let interval = parts["INTERVAL"].flatMap { Int($0) } ?? 1
        guard interval >= 1 else { return nil }
        let byDay = (parts["BYDAY"]?.uppercased()).map { $0.split(separator: ",").map(String.init) } ?? []
        let byMonthDay = parts["BYMONTHDAY"].map { $0.split(separator: ",").compactMap { Int($0) } } ?? []
        let time = includeTime ? timeText(parts: parts, anchorTime: anchorTime).map { " at \($0)" } ?? "" : ""

        let base: String?
        switch freq {
        case "DAILY":
            base = interval == 1 ? "daily" : "every \(interval) days"
        case "WEEKLY":
            base = weekly(interval: interval, byDay: byDay)
        case "MONTHLY":
            base = monthly(interval: interval, byDay: byDay, byMonthDay: byMonthDay, setPos: parts["BYSETPOS"].flatMap { Int($0) })
        case "YEARLY":
            base = yearly(interval: interval, byMonth: parts["BYMONTH"].flatMap { Int($0) }, byMonthDay: byMonthDay)
        default:
            base = nil
        }
        guard var base else { return nil }
        if !includeOn, let on = base.range(of: " on ") { base = String(base[..<on.lowerBound]) }
        return base + time
    }

    private static func weekly(interval: Int, byDay: [String]) -> String? {
        let every = interval == 1 ? "every" : "every \(interval) weeks on"
        if byDay.isEmpty { return interval == 1 ? "weekly" : "every \(interval) weeks" }
        guard byDay.allSatisfy({ shortDays[$0] != nil }) else { return nil }
        let days = Set(byDay)
        let sorted = dayOrder.filter(days.contains)
        if sorted.count == 7 { return interval == 1 ? "daily" : "every \(interval) weeks, every day" }
        if days == ["MO", "TU", "WE", "TH", "FR"] { return interval == 1 ? "weekdays" : "\(every) weekdays" }
        if days == ["SA", "SU"] { return interval == 1 ? "weekends" : "\(every) weekends" }
        return "\(every) \(sorted.compactMap { shortDays[$0] }.joined(separator: ", "))"
    }

    private static func monthly(interval: Int, byDay: [String], byMonthDay: [Int], setPos: Int?) -> String? {
        let prefix = interval == 1 ? "monthly" : "every \(interval) months"
        if !byMonthDay.isEmpty {
            guard byMonthDay.allSatisfy({ (1...31).contains($0) || $0 == -1 }) else { return nil }
            return "\(prefix) on the \(byMonthDay.map { $0 == -1 ? "last day" : ordinal($0) }.joined(separator: ", "))"
        }
        if let first = byDay.first {
            // "2TU" / "-1FR", or a bare "TU" with BYSETPOS.
            let code = String(first.suffix(2))
            guard let day = shortDays[code] else { return nil }
            let position = Int(first.dropLast(2)) ?? setPos
            guard let position else { return "\(prefix) on \(day)" }
            let which: String
            switch position {
            case -1: which = "last"
            case 1...5: which = ordinal(position)
            default: return nil
            }
            return "\(prefix) on the \(which) \(day)"
        }
        return prefix
    }

    private static func yearly(interval: Int, byMonth: Int?, byMonthDay: [Int]) -> String? {
        let prefix = interval == 1 ? "yearly" : "every \(interval) years"
        if let byMonth, (1...12).contains(byMonth), let day = byMonthDay.first, (1...31).contains(day) {
            return "\(prefix) on \(monthNames[byMonth - 1]) \(day)"
        }
        return prefix
    }

    /// BYHOUR (with BYMINUTE, or :00) wins, else the task's anchor time
    /// ("HH:MM", local). Nil for neither, or an out-of-range value.
    static func timeText(parts: [String: String], anchorTime: String?) -> String? {
        if let hourText = parts["BYHOUR"], !hourText.contains(","), let hour = Int(hourText) {
            let minute = parts["BYMINUTE"].flatMap { $0.contains(",") ? nil : Int($0) } ?? 0
            return clock(hour: hour, minute: minute)
        }
        if let anchorTime {
            let hm = anchorTime.split(separator: ":")
            if hm.count >= 2, let hour = Int(hm[0]), let minute = Int(hm[1]) {
                return clock(hour: hour, minute: minute)
            }
        }
        return nil
    }

    /// "9 AM", "9:30 PM", "noon", "midnight".
    static func clock(hour: Int, minute: Int) -> String? {
        guard (0...23).contains(hour), (0...59).contains(minute) else { return nil }
        if minute == 0 && hour == 12 { return "noon" }
        if minute == 0 && hour == 0 { return "midnight" }
        let h = hour % 12 == 0 ? 12 : hour % 12
        let suffix = hour < 12 ? "AM" : "PM"
        return minute == 0 ? "\(h) \(suffix)" : String(format: "%d:%02d %@", h, minute, suffix)
    }

    /// 1st, 2nd, 3rd, 4th, 11th, 21st — the web's `ordinal`.
    static func ordinal(_ n: Int) -> String {
        let tens = n % 100
        if (11...13).contains(tens) { return "\(n)th" }
        switch n % 10 {
        case 1: return "\(n)st"
        case 2: return "\(n)nd"
        case 3: return "\(n)rd"
        default: return "\(n)th"
        }
    }
}
