import XCTest

/// The night rule on the native labels (native catch-up PR 2, 2026-10-26):
/// `NightDay` against the TS helper's answers over TQ-LN21's grid (the
/// shared table `label-cases.json`, written from `src/lib/night-day.ts` by
/// `tests/behavioral/tq-label-native-cases.test.ts`), the surfaces' own
/// strings on named cases (`DueLabel.parts`, `WatchFormatting.dueLine`, a
/// segment row's target and deadline words), and TQ-LN21's property: no
/// label pairs one day's weekday with another day's date.
final class NightDayTests: WidgetStoreTestCase {

    private let chicago = TimeZone(identifier: "America/Chicago")!

    private func instant(_ iso: String) -> Date { DateHelpers.parseISO(iso)! }

    /// A wall-clock "yyyy-MM-ddTHH:mm" in `zone` as an instant. The surface
    /// cases use the machine's zone (`.current`) — the due labels format
    /// their times in it — so they read the same on a UTC CI runner.
    private func local(_ wall: String, in zone: TimeZone = .current) -> Date {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = zone
        f.dateFormat = "yyyy-MM-dd'T'HH:mm"
        return f.date(from: wall)!
    }

    private func day(_ start: String, in zone: TimeZone = .current) -> OpenTaskDay {
        OpenTaskDay(dayStart: start, timeZone: zone)
    }

    // MARK: The shared table (TQ-LN30)

    /// [dayStart, now, at, day, gap, night, date, dateGap, wordsAgree,
    /// timedWeekday, nightWeekday, futureWords, pastWords].
    private struct Row: Decodable {
        let dayStart, now, at, day: String
        let gap: Int
        let night: Bool
        let date: String
        let dateGap: Int
        let wordsAgree: Bool
        let timedWeekday, nightWeekday, futureWords, pastWords: String

        init(from decoder: Decoder) throws {
            var c = try decoder.unkeyedContainer()
            dayStart = try c.decode(String.self)
            now = try c.decode(String.self)
            at = try c.decode(String.self)
            day = try c.decode(String.self)
            gap = try c.decode(Int.self)
            night = try c.decode(Bool.self)
            date = try c.decode(String.self)
            dateGap = try c.decode(Int.self)
            wordsAgree = try c.decode(Bool.self)
            timedWeekday = try c.decode(String.self)
            nightWeekday = try c.decode(String.self)
            futureWords = try c.decode(String.self)
            pastWords = try c.decode(String.self)
        }
    }

    private struct Table: Decodable {
        let timezone: String
        let cases: [Row]
    }

    private func table() throws -> Table {
        try JSONDecoder().decode(Table.self, from: Fixtures.data("label-cases"))
    }

    func testTableFactsAndWordsMatchTheWeb() throws {
        let t = try table()
        XCTAssertEqual(t.timezone, "America/Chicago")
        XCTAssertGreaterThan(t.cases.count, 2000)
        for row in t.cases {
            let n = NightDay(at: instant(row.at), now: instant(row.now), day: day(row.dayStart, in: chicago))
            let label = "\(row.dayStart) now \(row.now) at \(row.at)"
            XCTAssertEqual(n.day.description, row.day, label)
            XCTAssertEqual(n.gap, row.gap, label)
            XCTAssertEqual(n.night, row.night, label)
            XCTAssertEqual(n.date.description, row.date, label)
            XCTAssertEqual(n.dateGap, row.dateGap, label)
            XCTAssertEqual(n.wordsAgree, row.wordsAgree, label)
            XCTAssertEqual(n.timedWeekday, row.timedWeekday, label)
            XCTAssertEqual(n.nightWeekday, row.nightWeekday, label)
            XCTAssertEqual(n.words(past: false), row.futureWords, label)
            XCTAssertEqual(n.words(past: true), row.pastWords, label)
        }
    }

    // MARK: The surfaces' strings (TQ-LN21b's cases)

    private func parts(_ at: String, now: String, start: String = "03:00") -> DueLabel.Parts {
        let due = local(at), clock = local(now)
        return DueLabel.parts(for: due, now: clock, isOverdue: due < clock, day: day(start))
    }

    /// The Tasks widget's and the Mac menu bar's label: the night pairs name
    /// the evening, yesterday's night is "Last night", and a word never
    /// contradicts the date.
    func testDueLabelNightWords() {
        // Sun Oct 25 12:30, 3:00 AM start: Tue Oct 27 01:00 is Monday night's.
        XCTAssertEqual(parts("2026-10-27T01:00", now: "2026-10-25T12:30"), .init(dayWord: "Tomorrow night", time: "1:00 am"))
        XCTAssertEqual(parts("2026-10-28T01:00", now: "2026-10-25T12:30"), .init(dayWord: "Tue night", time: "1:00 am"))
        XCTAssertEqual(parts("2026-10-27T09:00", now: "2026-10-25T12:30"), .init(dayWord: "Tue", time: "9:00 am"))
        // The switch off: the calendar day, no cue.
        XCTAssertEqual(
            parts("2026-10-28T01:00", now: "2026-10-25T12:30", start: OpenTaskDay.calendarDayStart),
            .init(dayWord: "Wed", time: "1:00 am")
        )
        // Overdue, read Mon 10:00: Mon 01:00 was Sunday night's.
        XCTAssertEqual(parts("2026-10-26T01:00", now: "2026-10-26T10:00"), .init(dayWord: "Last night", time: "1:00 am"))
        XCTAssertEqual(parts("2026-10-25T21:00", now: "2026-10-26T10:00"), .init(dayWord: "Yesterday", time: "9:00 pm"))
        XCTAssertEqual(parts("2026-10-24T01:00", now: "2026-10-26T10:00"), .init(dayWord: "Fri night", time: "1:00 am"))
        // Tonight's night, still ahead: today, the time alone.
        XCTAssertEqual(parts("2026-10-27T01:00", now: "2026-10-26T22:00"), .init(dayWord: nil, time: "1:00 am"))
        // An 11 PM start, Sat 12:30: Sat 23:30 is on Sunday's list but dated
        // Saturday — "Sat", never "Tomorrow".
        XCTAssertEqual(parts("2026-10-24T23:30", now: "2026-10-24T12:30", start: "23:00"), .init(dayWord: "Sat", time: "11:30 pm"))
        XCTAssertEqual(parts("2026-10-25T09:00", now: "2026-10-24T12:30", start: "23:00"), .init(dayWord: "Tomorrow", time: "9:00 am"))
    }

    func testWatchDueLineNightWords() {
        func line(_ at: String, now: String, start: String = "03:00") -> String {
            WatchFormatting.dueLine(for: local(at), now: local(now), day: day(start))
        }
        func clean(_ s: String) -> String { s.replacingOccurrences(of: "\u{202F}", with: " ") }
        XCTAssertEqual(clean(line("2026-10-27T01:00", now: "2026-10-25T12:30")), "Tomorrow night 1:00 AM")
        XCTAssertEqual(clean(line("2026-10-28T01:00", now: "2026-10-25T12:30")), "Tue night 1:00 AM")
        XCTAssertEqual(clean(line("2026-10-26T01:00", now: "2026-10-26T10:00")), "Last night 1:00 AM")
        XCTAssertEqual(clean(line("2026-10-24T23:30", now: "2026-10-24T12:30", start: "23:00")), "Sat 11:30 PM")
        // A yesterday the words can't name (11 PM start, Mon noon: Sat 23:30
        // was Sunday's) — the watch says no past weekday, so its date.
        XCTAssertEqual(clean(line("2026-10-24T23:30", now: "2026-10-26T12:00", start: "23:00")), "Oct 24 11:30 PM")
    }

    /// A segment row's target and deadline words name the evening in the
    /// night, with its weekday in every form.
    func testSegmentRowWordsNightForm() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = chicago
        let now = local("2026-10-24T12:30", in: chicago)
        let at = DateHelpers.formatISO(local("2026-10-27T01:00", in: chicago))
        let nb = "\u{00A0}"
        let deadline = TaskDTO(id: 1, title: "A deadline", deadlineAt: at, horizon: "weeks")
        XCTAssertEqual(
            deadline.segmentMeta(segmentHorizon: "weeks", now: now, calendar: cal, dayStart: "03:00"),
            "deadline\(nb)Mon\(nb)night\(nb)Oct\(nb)26"
        )
        XCTAssertEqual(
            deadline.segmentMeta(segmentHorizon: "weeks", now: now, calendar: cal, dayStart: "00:00"),
            "deadline\(nb)Oct\(nb)27"
        )
        let target = TaskDTO(id: 2, title: "A target", dueAt: at, horizon: "weeks")
        XCTAssertEqual(target.segmentMeta(segmentHorizon: "weeks", now: now, calendar: cal, dayStart: "03:00"), "Mon\(nb)night\(nb)Oct\(nb)26")
        let upcoming = TaskDTO(id: 3, title: "Upcoming", dueAt: at, deadlineAt: at)
        let dot = TaskDTO.metaJoiner
        for form in UpcomingMetaForm.allCases {
            XCTAssertEqual(
                upcoming.upcomingMeta(calendar: cal, form: form, dayStart: "03:00"),
                "Mon\(nb)night\(nb)Oct\(nb)26\(dot)deadline\(nb)Mon\(nb)night\(nb)Oct\(nb)26", "\(form)"
            )
        }
        XCTAssertEqual(
            upcoming.upcomingMeta(calendar: cal, form: .full, dayStart: "00:00"),
            "Tue\(nb)Oct\(nb)27\(dot)deadline\(nb)Tue\(nb)Oct\(nb)27"
        )
    }

    // MARK: TQ-LN21 on the native labels

    private static let weekdays = ["Sun": 1, "Mon": 2, "Tue": 3, "Wed": 4, "Thu": 5, "Fri": 6, "Sat": 7]
    private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    /// The weekday and date a label holds, as (weekday, month, day) — nil
    /// unless it has both.
    private func pair(_ label: String) -> (Int, Int, Int)? {
        let words = label.replacingOccurrences(of: "\u{00A0}", with: " ").split(separator: " ").map(String.init)
        guard let w = words.compactMap({ Self.weekdays[$0] }).first,
              let mi = words.firstIndex(where: { Self.months.contains($0) }), mi + 1 < words.count,
              let d = Int(words[mi + 1].trimmingCharacters(in: .punctuationCharacters))
        else { return nil }
        return (w, Self.months.firstIndex(of: words[mi])! + 1, d)
    }

    /// Every segment row form, over the whole grid: wherever its words hold
    /// a weekday and a date, they are one calendar day; and the due labels
    /// never hold both (a weekday or a date).
    func testNoLabelPairsOneDayWithAnotherDaysDate() throws {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = chicago
        var checked = 0
        for row in try table().cases {
            let at = instant(row.at), now = instant(row.now)
            let task = TaskDTO(id: 1, title: "T", dueAt: row.at, deadlineAt: row.at)
            var labels = UpcomingMetaForm.allCases.compactMap {
                task.upcomingMeta(calendar: cal, form: $0, dayStart: row.dayStart)
            }
            labels.append(contentsOf: [
                TaskDTO(id: 2, title: "T", deadlineAt: row.at, horizon: "days")
                    .segmentMeta(segmentHorizon: "days", now: now, calendar: cal, dayStart: row.dayStart) ?? "",
            ])
            for label in labels {
                for part in label.components(separatedBy: TaskDTO.metaJoiner) {
                    guard let (w, m, d) = pair(part) else { continue }
                    checked += 1
                    var c = DateComponents()
                    c.year = cal.component(.year, from: at)
                    c.month = m
                    c.day = d
                    let date = cal.date(from: c)!
                    XCTAssertEqual(cal.component(.weekday, from: date), w, "\(row.dayStart) \(row.at): \(part)")
                }
            }
            let due = DueLabel.parts(for: at, now: now, isOverdue: at < now, day: day(row.dayStart, in: chicago))
            if let word = due.dayWord {
                XCTAssertNil(pair(word), "\(row.dayStart) \(row.at): \(word)")
            }
        }
        XCTAssertGreaterThan(checked, 1000)
    }
}
