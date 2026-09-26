import Foundation

/// A task's due label, as words — the day word and the time the Tasks widget
/// draws beside a row ("Tomorrow" / "4:00 pm", "Yesterday" / "12:00 pm").
///
/// Foundation-only on purpose (2026-09-25): `WidgetTheme` (SwiftUI) styles
/// these strings and the pager measures them, but the rule for WHICH words
/// lives here, so the macOS logic-test bundle (`OpenTaskLogicTests`,
/// `DueLabelTests`) can pin it. See `WidgetTheme`'s "Due-date day-naming"
/// section for the rendering side.
enum DueLabel {

    struct Parts: Equatable {
        /// nil when the due date is today (the time alone says it).
        let dayWord: String?
        /// nil when the due date is date-only (local time-of-day exactly
        /// midnight).
        let time: String?

        /// The exact string shown — `"\(dayWord) \(time)"`, or whichever
        /// half is present alone, or "" if somehow both are nil (a
        /// date-only task due exactly today: no day word because it's
        /// today, no time because it's date-only — nothing to say).
        var plainString: String {
            switch (dayWord, time) {
            case let (.some(d), .some(t)): return "\(d) \(t)"
            case let (.some(d), nil): return d
            case let (nil, .some(t)): return t
            case (nil, nil): return ""
            }
        }

        /// Both halves present ("Tomorrow" + "4:00 pm") — the shape that
        /// STACKS, day word over time, on every family.
        var hasTwoParts: Bool { dayWord != nil && time != nil }
    }

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "h:mm a"
        f.amSymbol = "am"
        f.pmSymbol = "pm"
        return f
    }()

    private static let weekdayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "EEE"
        return f
    }()

    private static let monthDayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f
    }()

    static func shortTime(_ date: Date) -> String {
        timeFormatter.string(from: date)
    }

    /// The single source of truth for a due date's day word + time.
    ///
    /// Upcoming: "8:30 pm" (today), "Tomorrow" / "9:00 am", "Sun" / "9:00 am"
    /// (2–6 days out), "Oct 1" / "9:00 am" (7+ days out), "Oct 2" alone
    /// (date-only).
    ///
    /// Overdue (2026-09-25 — Trent's rule: a day word always sits above the
    /// time): the same ladder, backwards — the time alone when it was due
    /// earlier TODAY, else "Yesterday", a weekday ("Wed", 2–6 days back) or a
    /// date ("Sep 12", a week or more back) over the time. Before this an
    /// overdue row showed only the time, so a task due yesterday at noon read
    /// "12:00 pm" on the Overdue page — indistinguishable from today at noon.
    /// A date-only overdue task shows the day word alone ("12:00 am" would
    /// read as a real due time).
    ///
    /// `isOverdue` is passed in (`TaskDTO.isOverdue(now:)`) rather than
    /// recomputed, so this function reads the clock for one job only:
    /// bucketing days.
    static func parts(for due: Date, now: Date = Date(), isOverdue: Bool) -> Parts {
        let calendar = Calendar.current
        let isDateOnly =
            calendar.component(.hour, from: due) == 0 && calendar.component(.minute, from: due) == 0
        let time = isDateOnly ? nil : shortTime(due)
        let days = calendar.dateComponents(
            [.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: due)
        ).day ?? 0

        let dayWord: String?
        if isOverdue {
            switch days {
            case 0...:
                // Due earlier today (or, in principle, a clock skew putting
                // an overdue instant on a later day): the time alone. A
                // date-only task due today that is somehow overdue has no
                // time either — "Today" says what there is to say.
                dayWord = time == nil ? "Today" : nil
            case -1:
                dayWord = "Yesterday"
            case -6 ... -2:
                dayWord = weekdayFormatter.string(from: due)
            default:
                dayWord = monthDayFormatter.string(from: due)
            }
        } else {
            switch days {
            case ..<1:
                // Today (0), or still-negative-but-not-overdue (never reached
                // in practice — `isOverdue` catches every past instant).
                dayWord = nil
            case 1:
                dayWord = "Tomorrow"
            case 2...6:
                dayWord = weekdayFormatter.string(from: due)
            default:
                dayWord = monthDayFormatter.string(from: due)
            }
        }
        return Parts(dayWord: dayWord, time: time)
    }
}
