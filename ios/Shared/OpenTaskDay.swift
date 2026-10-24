import Foundation

/// THE OPENTASK DAY on the native clients ("Day starts at" PR 3,
/// 2026-10-24) — the Swift mirror of `src/lib/opentask-day.ts`, and the ONE
/// place a native day boundary is computed. Every "which day is it", "when
/// does today start / end", "when does the day turn next" in `ios/` and
/// `macos/` goes through this type: the Tasks widget's Today page and its
/// timeline, the Mac menu bar's "Next up today", the due labels, the
/// Quotas widget's periods, the Reminders widget's and the watch's slot
/// logic. See docs/TASK-MODEL.md § The OpenTask day.
///
/// The day runs from DAY START to day start ("the rollover"), not midnight
/// to midnight. The day start is the server's `rollover_time` with its task
/// queue switch on, midnight with it off (`DayStartStore`, the browser's
/// `browserDayStart` rule).
///
/// BOTH DIRECTIONS — the naming convention, exactly the server's:
/// - a day start AT OR BEFORE 12:00 names the day by the date it BEGINS on.
///   With 3:00 AM, Monday runs Mon 03:00 → Tue 03:00; Tuesday 01:00 is still
///   Monday.
/// - a day start AFTER 12:00 names the day by the NEXT date. With 11:00 PM,
///   Monday runs Sun 23:00 → Mon 23:00; Sunday 23:30 is already Monday.
/// - midnight is the calendar day.
///
/// For every day start: `openTaskDay(of: x) == D` ⇔
/// `dayStart(of: D) <= x < dayStart(of: D + 1)`.
///
/// DST (`localMoment`): a day start the night's spring-forward gap swallows
/// (02:30 on the night 2:00 jumps to 3:00) is the NEXT VALID MINUTE (3:00),
/// not Foundation's shift-by-the-gap (3:30); a repeated time on a fall-back
/// night is its FIRST instant.
///
/// Pure: the zone and day start are injected (`init(dayStart:timeZone:)`),
/// no clock of its own — every function takes the instant it is asked
/// about. The App Group read is `DayStartStore.current`, at the callers'
/// edge. Checked against the server's own helper by `OpenTaskDayTests`
/// over a shared table of cases (`tests/fixtures/opentask-day/`, written
/// from the TS by `tests/behavioral/tq-day-native-cases.test.ts`).
struct OpenTaskDay: Equatable {

    /// Midnight as a day start: the calendar day (`CALENDAR_DAY_START`).
    static let calendarDayStart = "00:00"

    /// The day start as "HH:MM" (an unparseable one reads as midnight).
    let dayStart: String
    /// `dayStart` in minutes past midnight, 0..1439.
    let dayStartMinutes: Int
    let timeZone: TimeZone

    init(dayStart: String, timeZone: TimeZone) {
        if let minutes = Self.parseHHMM(dayStart) {
            self.dayStart = dayStart
            self.dayStartMinutes = minutes
        } else {
            self.dayStart = Self.calendarDayStart
            self.dayStartMinutes = 0
        }
        self.timeZone = timeZone
    }

    /// The calendar day in `timeZone`.
    static func midnight(timeZone: TimeZone) -> OpenTaskDay {
        OpenTaskDay(dayStart: calendarDayStart, timeZone: timeZone)
    }

    /// "HH:MM" (or "H:MM") as minutes past midnight, nil when malformed —
    /// the server's `parseHHMM`.
    static func parseHHMM(_ time: String) -> Int? {
        let parts = time.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[1].count == 2,
              let h = Int(parts[0]), let m = Int(parts[1]),
              (0...23).contains(h), (0...59).contains(m)
        else { return nil }
        return h * 60 + m
    }

    /// Whether this day start names its day by the NEXT date (after 12:00).
    var namesNextDate: Bool { dayStartMinutes > 12 * 60 }

    /// A Gregorian calendar in this day's zone.
    var calendar: Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        return cal
    }

    // MARK: Instants ↔ dates

    /// The local CALENDAR date of an instant — midnight to midnight, whatever
    /// the day start (`calendarDateOf`).
    func calendarDate(of instant: Date) -> LocalDate {
        let c = calendar.dateComponents([.year, .month, .day], from: instant)
        return LocalDate(year: c.year ?? 1970, month: c.month ?? 1, day: c.day ?? 1)
    }

    /// Wall-clock minutes past midnight of an instant in this zone.
    func minuteOfDay(_ instant: Date) -> Int {
        let c = calendar.dateComponents([.hour, .minute], from: instant)
        return (c.hour ?? 0) * 60 + (c.minute ?? 0)
    }

    /// A LOCAL WALL-CLOCK MOMENT: `minutes` past midnight on the local date
    /// `date`, as an instant (`localMoment`). A time the spring-forward gap
    /// swallows is the next valid minute that day; a repeated one on a
    /// fall-back night its first (earlier) instant.
    ///
    /// Worked out from the zone's offsets rather than `Calendar.date(from:)`,
    /// whose answer for a gap is the time shifted by the gap and for a
    /// repeated time is not specified: a wall time W is the instant W − o for
    /// each offset o the zone has around it, valid when the zone's offset at
    /// that instant really is o; the earliest valid one wins. The offsets are
    /// sampled up to a day either side of W, so a transition is bracketed
    /// whatever the zone's offset (Auckland's +13 puts the instant 13 hours
    /// before W — a 12-hour window missed its fall-back's first 02:30).
    func localMoment(_ date: LocalDate, minutes: Int) -> Date {
        let midnightAsUTC = date.utcMidnight.timeIntervalSince1970
        for m in max(minutes, 0)..<(24 * 60) {
            let wall = midnightAsUTC + Double(m * 60)
            let offsets = Set([-86_400.0, -43_200, 0, 43_200, 86_400].map {
                Double(timeZone.secondsFromGMT(for: Date(timeIntervalSince1970: wall + $0)))
            })
            let valid = offsets
                .map { Date(timeIntervalSince1970: wall - $0) }
                .filter { Double(timeZone.secondsFromGMT(for: $0)) == wall - $0.timeIntervalSince1970 }
            if let first = valid.min() { return first }
        }
        // Unreachable in practice: no zone skips the rest of a day.
        return localMoment(date.adding(days: 1), minutes: 0).addingTimeInterval(-1)
    }

    /// The instant the OpenTask day `date` STARTS (`dayStartMoment`): the
    /// day start on that date (≤ 12:00) or on the date before (> 12:00).
    func dayStart(of date: LocalDate) -> Date {
        localMoment(namesNextDate ? date.adding(days: -1) : date, minutes: dayStartMinutes)
    }

    /// The OpenTask day an instant belongs to (`openTaskDayOf`). With 06:30,
    /// 00:00–06:29 belongs to the previous date; with 23:00, 23:00 exactly is
    /// already the next date.
    func openTaskDay(of instant: Date) -> LocalDate {
        let calendarDay = calendarDate(of: instant)
        let candidate = namesNextDate ? calendarDay.adding(days: 1) : calendarDay
        return instant >= dayStart(of: candidate) ? candidate : candidate.adding(days: -1)
    }

    // MARK: Spans

    /// One OpenTask day: its date and the instants it runs between, `[start, end)`.
    struct Span: Equatable {
        let date: LocalDate
        let start: Date
        let end: Date

        func contains(_ instant: Date) -> Bool { start <= instant && instant < end }
    }

    /// The OpenTask day `date` as a span (`openTaskDateSpan`).
    func dateSpan(_ date: LocalDate) -> Span {
        Span(date: date, start: dayStart(of: date), end: dayStart(of: date.adding(days: 1)))
    }

    /// The OpenTask day `instant` belongs to, as a span (`openTaskDaySpan`).
    func daySpan(containing instant: Date) -> Span {
        dateSpan(openTaskDay(of: instant))
    }

    /// The first day start STRICTLY after `now` — the end of its day
    /// (`nextRollover`). At exactly the day start it is the next one.
    func nextRollover(after now: Date) -> Date {
        daySpan(containing: now).end
    }

    /// The latest day start AT OR BEFORE `now` — the start of its day
    /// (`latestRollover`).
    func latestRollover(atOrBefore now: Date) -> Date {
        daySpan(containing: now).start
    }

    /// Whole OpenTask days from `a` to `b` (negative when `b` is earlier):
    /// the gap between their OpenTask dates (`openTaskDaysBetween`).
    func daysBetween(_ a: Date, _ b: Date) -> Int {
        openTaskDay(of: a).days(to: openTaskDay(of: b))
    }

    /// Instants after local midnight that still belong to the day before
    /// (`isLateNight`) — 00:00–02:59 with a 3:00 AM start; none for a start
    /// at midnight or after 12:00.
    func isLateNight(_ instant: Date) -> Bool {
        openTaskDay(of: instant) < calendarDate(of: instant)
    }

    // MARK: Periods within a day

    /// Minutes from the day start to a minute of the day, 0..1439
    /// (`minutesIntoDay`): where a time of day falls within an OpenTask day.
    /// With 3:00, a 1:00 AM period is 1320 — the end of the day.
    func minutesIntoDay(_ minuteOfDay: Int) -> Int {
        (((minuteOfDay - dayStartMinutes) % 1440) + 1440) % 1440
    }

    /// `minutesIntoDay` of an instant's wall-clock time.
    func minutesIntoDay(of instant: Date) -> Int {
        minutesIntoDay(minuteOfDay(instant))
    }

    /// When a reminder period starting at `startMinutes` opens within the
    /// OpenTask day `date` (`periodOpensAt`): the one instant inside that day
    /// at that wall-clock time — on the date the day begins on when the
    /// period starts at or after the day start, else the date after.
    func periodOpensAt(_ date: LocalDate, startMinutes: Int) -> Date {
        let begins = namesNextDate ? date.adding(days: -1) : date
        let onDate = startMinutes >= dayStartMinutes ? begins : begins.adding(days: 1)
        return localMoment(onDate, minutes: startMinutes)
    }

    /// Groups in the order their periods come round in the day
    /// (`orderGroupsByDay`): with 3:00, a 1:00 AM period comes LAST. Stable;
    /// the un-slotted group (and a malformed start) keeps its place after
    /// the slotted ones. At midnight, groups already in start order come
    /// back unchanged.
    func orderedByDay<G>(_ groups: [G], startMinutes: (G) -> Int?) -> [G] {
        groups.enumerated()
            .map { (index: $0.offset, group: $0.element, key: startMinutes($0.element).map(minutesIntoDay) ?? .max) }
            .sorted { ($0.key, $0.index) < ($1.key, $1.index) }
            .map(\.group)
    }
}

/// A local date, yyyy-MM-dd, with no zone — what an OpenTask day is named
/// by. Calendar arithmetic only (`addDays` in opentask-day.ts).
struct LocalDate: Hashable, Comparable, CustomStringConvertible {
    let year: Int
    let month: Int
    let day: Int

    init(year: Int, month: Int, day: Int) {
        self.year = year
        self.month = month
        self.day = day
    }

    /// "2026-10-20", or nil when it is not a real date.
    init?(_ string: String) {
        let parts = string.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2])
        else { return nil }
        let candidate = LocalDate(year: y, month: m, day: d)
        let c = Self.utc.dateComponents([.year, .month, .day], from: candidate.utcMidnight)
        guard c.year == y, c.month == m, c.day == d else { return nil }
        self = candidate
    }

    var description: String { String(format: "%04d-%02d-%02d", year, month, day) }

    static func < (lhs: LocalDate, rhs: LocalDate) -> Bool {
        (lhs.year, lhs.month, lhs.day) < (rhs.year, rhs.month, rhs.day)
    }

    /// `days` days on (or back).
    func adding(days: Int) -> LocalDate {
        let moved = utcMidnight.addingTimeInterval(Double(days) * 86_400)
        let c = Self.utc.dateComponents([.year, .month, .day], from: moved)
        return LocalDate(year: c.year ?? year, month: c.month ?? month, day: c.day ?? day)
    }

    /// Whole days from this date to `other` (negative when `other` is earlier).
    func days(to other: LocalDate) -> Int {
        Int((other.utcMidnight.timeIntervalSince(utcMidnight) / 86_400).rounded())
    }

    /// `Calendar` weekday numbering: 1 = Sunday … 7 = Saturday.
    var weekday: Int { Self.utc.component(.weekday, from: utcMidnight) }

    /// This date's midnight read as UTC — the zone-free base the arithmetic
    /// above runs on.
    var utcMidnight: Date {
        Self.utc.date(from: DateComponents(year: year, month: month, day: day)) ?? Date(timeIntervalSince1970: 0)
    }

    private static let utc: Calendar = {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        return cal
    }()
}
