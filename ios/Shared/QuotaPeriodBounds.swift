import Foundation

/// A quota period's clock — its bounds, how much of it has run and how many
/// days are left — for the Quotas widget's section headings and bars
/// (`QuotaSectionBuilder`). Foundation-only and in ios/Shared (moved out of
/// TrackWidget.swift, "Day starts at" PR 3) so `OpenTaskLogicTests` can pin it.
///
/// THE OPENTASK DAY ("Day starts at" PR 3, docs/TASK-MODEL.md § The OpenTask
/// day, `periodBounds` / `unitStartAt` / `quotaPeriodEnd` /
/// `periodDaysLeft` in src/lib/track.ts and src/lib/week-start.ts): the
/// week, month or year `now` is in is the one its OPENTASK DATE is in, and
/// the period runs from the day start of its first date to the day start of
/// the next period's first date. With 3:00 AM a Sunday week runs Sunday
/// 03:00 → Sunday 03:00; with 11:00 PM the week named by its Sunday starts
/// Saturday 23:00. Every step is calendar maths on dates, so a DST change
/// inside a period moves nothing. With midnight it is the calendar period.
extension QuotaPeriodKey {

    /// `Calendar` weekday numbers (1 = Sunday, 2 = Monday) for the two week
    /// starts the server allows (`users.week_start`, `src/lib/week-start.ts`).
    static let sundayFirst = 1
    static let mondayFirst = 2

    /// The user's first day of the week: `known` (the fetched `week_start`,
    /// `DayStartStore.cachedFirstWeekday`) when there is one; else read off
    /// the weekly quotas' own anchors — the server anchors every weekly quota
    /// at the day start of the user's first day of the week
    /// (`period-rollover.ts`), so the weekday of the date an anchor stands
    /// for IS the preference. That date is the anchor's own local date for a
    /// wall-clock time at or before 12:00, the NEXT date after 12:00
    /// (`anchorDate` in src/lib/week-start.ts: an 11 PM start stamps a
    /// Sunday week on Saturday 23:00). Sunday — the server's default — when
    /// there is no anchor to read, or one on another weekday (only possible
    /// in the minutes between a preference change and the rollover that
    /// realigns it).
    static func firstWeekday(from tasks: [TaskDTO], known: Int?, timeZone: TimeZone) -> Int {
        if let known, known == sundayFirst || known == mondayFirst { return known }
        let day = OpenTaskDay.midnight(timeZone: timeZone)
        for task in tasks where from(rrule: task.rrule) == .weekly {
            guard let start = task.periodStartDate else { continue }
            let onDate = day.calendarDate(of: start)
            let named = day.minuteOfDay(start) > 12 * 60 ? onDate.adding(days: 1) : onDate
            if named.weekday == sundayFirst || named.weekday == mondayFirst { return named.weekday }
        }
        return sundayFirst
    }

    /// The first DATE of this period's unit containing the OpenTask date
    /// `date` (`periodFirstDate`), and the first date of the next one. Nil
    /// for `.none`, which has no clock.
    func dates(containing date: LocalDate, firstWeekday: Int) -> (first: LocalDate, next: LocalDate)? {
        switch self {
        case .daily:
            return (date, date.adding(days: 1))
        case .weekly:
            let first = date.adding(days: -((date.weekday - firstWeekday + 7) % 7))
            return (first, first.adding(days: 7))
        case .monthly:
            let first = LocalDate(year: date.year, month: date.month, day: 1)
            let next = date.month == 12
                ? LocalDate(year: date.year + 1, month: 1, day: 1)
                : LocalDate(year: date.year, month: date.month + 1, day: 1)
            return (first, next)
        case .yearly:
            return (LocalDate(year: date.year, month: 1, day: 1), LocalDate(year: date.year + 1, month: 1, day: 1))
        case .none:
            return nil
        }
    }

    /// `[start, end)` of this period containing `now`: from the day start of
    /// its first date to the day start of the next period's.
    func bounds(now: Date, firstWeekday: Int, day: OpenTaskDay) -> (start: Date, end: Date)? {
        guard let dates = dates(containing: day.openTaskDay(of: now), firstWeekday: firstWeekday) else { return nil }
        return (day.dayStart(of: dates.first), day.dayStart(of: dates.next))
    }

    /// How much of this period has already run, 0...1 — a ratio of two REAL
    /// durations (DST-safe), mirroring `periodElapsedFraction` exactly.
    func elapsedFraction(now: Date, firstWeekday: Int, day: OpenTaskDay) -> Double? {
        guard let (start, end) = bounds(now: now, firstWeekday: firstWeekday, day: day) else { return nil }
        let total = end.timeIntervalSince(start)
        guard total > 0 else { return nil }
        return min(max(now.timeIntervalSince(start) / total, 0), 1)
    }

    /// The section heading's muted clause — "N days left" for a week or
    /// longer, nil for a day and for `.none`. Mirrors `periodTimeLeftText`
    /// (`src/lib/track.ts`), which since PR #62 (Trent, 2026-09-24) returns
    /// null for DAILY: "Today · ends tonight" said the same thing twice.
    ///
    /// TODAY COUNTED, on OpenTask dates (`periodDaysLeft`): from today's
    /// OpenTask date to the period's last day, plus one — so the number
    /// changes when the day turns (the day start: 1:30 AM with 3:00 is still
    /// yesterday), not the moment `now`'s clock passes midnight.
    func timeLeftText(now: Date, firstWeekday: Int, day: OpenTaskDay) -> String? {
        switch self {
        case .daily, .none: return nil
        case .weekly, .monthly, .yearly:
            let today = day.openTaskDay(of: now)
            guard let dates = dates(containing: today, firstWeekday: firstWeekday) else { return nil }
            let days = today.days(to: dates.next)
            return "\(days) day\(days == 1 ? "" : "s") left"
        }
    }
}
