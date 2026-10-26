import Foundation

/// L9's NIGHT RULE on the native clients (native catch-up PR 2, 2026-10-26)
/// — the Swift mirror of `src/lib/night-day.ts`, for every label that names
/// the day of a moment: the Tasks widget's and the Mac menu bar's due labels
/// (`DueLabel.parts`), the watch's due line (`WatchFormatting.dueLine`) and a
/// task segment row's target and deadline words (`TaskDTO.segmentMeta`).
///
/// A moment between local midnight and the day start belongs to the OpenTask
/// day BEFORE (`OpenTaskDay.isLateNight`): with a 3:00 AM start, Tuesday
/// 01:00 is Monday's. A label that names it by a word says "night", and its
/// weekday and date are both the EVENING's — "Mon night", "Mon night Oct 26",
/// "tomorrow night", "last night" — so the day it names is the day the task
/// is on, and a weekday never sits beside another day's date.
///
/// A LABEL WITH A CLOCK TIME NAMES THE CALENDAR DAY outside the night (Trent,
/// 2026-10-26): with an 11 PM start, Tue 23:47 is on Wednesday's list but is
/// "Tue 11:47 PM", never "Wed" — and it says "today" / "tomorrow" /
/// "yesterday" only when its OpenTask day and its own date agree
/// (`wordsAgree`). There is no night with a start after 12:00 (or at
/// midnight, the switch off), so nothing there says "night".
///
/// Pure: the zone and day start come in with `OpenTaskDay`, the clock with
/// `now`. Checked against the TS over a shared table
/// (`tests/fixtures/opentask-day/label-cases.json`, written by
/// `tests/behavioral/tq-label-native-cases.test.ts`) by `NightDayTests`.
struct NightDay: Equatable {
    /// The OpenTask date the moment counts on.
    let day: LocalDate
    /// OpenTask days from today's to it (negative: before today).
    let gap: Int
    /// The moment is in that day's night: between local midnight and the day start.
    let night: Bool
    /// The moment's own calendar date.
    let date: LocalDate
    /// Days from today's OpenTask date to the moment's own date (`gap`,
    /// unless a start after noon moves it).
    let dateGap: Int

    init(at: Date, now: Date, day openTaskDay: OpenTaskDay) {
        let today = openTaskDay.openTaskDay(of: now)
        day = openTaskDay.openTaskDay(of: at)
        gap = today.days(to: day)
        date = openTaskDay.calendarDate(of: at)
        dateGap = today.days(to: date)
        night = openTaskDay.isLateNight(at)
    }

    /// The word a night label adds: "Thu" → "Thu night".
    static let nightSuffix = " night"
    /// Yesterday's night, as people say it: "last night", never "yesterday night".
    static let lastNight = "last night"

    /// Whether a timed label may name the moment's day by a relative word
    /// ("today", "tomorrow", "yesterday"): in its night, or when its OpenTask
    /// day and its own date are the same distance from today.
    var wordsAgree: Bool { night || gap == dateGap }

    /// The day a label WITH A CLOCK TIME names: in its night the OpenTask day
    /// (said with "night"), else the moment's own date.
    var timedDay: LocalDate { night ? day : date }

    /// The weekday of a timed label: "Tue", "Mon night".
    var timedWeekday: String { Self.weekday(timedDay) + (night ? Self.nightSuffix : "") }

    /// The OpenTask day's weekday, with " night" in its night — for a label
    /// of the whole day.
    var nightWeekday: String { Self.weekday(day) + (night ? Self.nightSuffix : "") }

    /// A timed label's day words, lower case (`nightDayWords`): "today" /
    /// "tonight", "tomorrow" (" night"), "yesterday" / "last night", else the
    /// weekday (" night") — and the moment's own weekday wherever a word would
    /// contradict its date. A moment already past on today's own night is
    /// "Thu night", never "tonight".
    func words(past: Bool) -> String {
        guard wordsAgree else { return timedWeekday }
        let suffix = night ? Self.nightSuffix : ""
        switch gap {
        case 0:
            if !night { return "today" }
            return past ? timedWeekday : "tonight"
        case 1:
            return "tomorrow\(suffix)"
        case -1:
            return night ? Self.lastNight : "yesterday"
        default:
            return timedWeekday
        }
    }

    /// The day words a DATE-shaped label uses (a segment row's target and
    /// deadline, the web's `upcomingGap`): in the night the evening's weekday
    /// and date, "Mon night Oct 26" — with its weekday whatever the form, the
    /// cue needs one — else the moment's own "Tue Oct 27" (`includeWeekday`)
    /// or "Oct 27".
    static func dateWords(_ at: Date, day openTaskDay: OpenTaskDay, includeWeekday: Bool) -> String {
        if openTaskDay.isLateNight(at) {
            let evening = openTaskDay.openTaskDay(of: at)
            return "\(weekday(evening))\(nightSuffix) \(monthDay(evening))"
        }
        let own = openTaskDay.calendarDate(of: at)
        return includeWeekday ? "\(weekday(own)) \(monthDay(own))" : monthDay(own)
    }

    /// "Tue" — a local date's weekday, in English.
    static func weekday(_ date: LocalDate) -> String {
        weekdayFormatter.string(from: date.utcMidnight)
    }

    /// "Oct 27" — a local date's month and day, in English.
    static func monthDay(_ date: LocalDate) -> String {
        monthDayFormatter.string(from: date.utcMidnight)
    }

    /// "Oct 27, 2027" — with the year.
    static func monthDayYear(_ date: LocalDate) -> String {
        monthDayYearFormatter.string(from: date.utcMidnight)
    }

    /// The first letter in capitals: "tonight" → "Tonight"; "Thu night" stays.
    static func capitalized(_ words: String) -> String {
        words.prefix(1).uppercased() + words.dropFirst()
    }

    private static func utcFormatter(_ format: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = format
        return f
    }

    // `LocalDate.utcMidnight` is the date read as UTC, so these format in UTC.
    private static let weekdayFormatter = utcFormatter("EEE")
    private static let monthDayFormatter = utcFormatter("MMM d")
    private static let monthDayYearFormatter = utcFormatter("MMM d, yyyy")
}
