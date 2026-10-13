import Foundation

/// The target rules of the task model that the native surfaces draw — the
/// few they still need from `src/lib/task-segments.ts`. Keep the numbers in
/// step with that file.
///
/// A task's `due_at` is its TARGET: when nagging starts. Once the target has
/// passed the task is "over target" (`TaskWording.overTarget`, what used to be
/// "overdue"). Since 2026-10-12 (spec §8) a deadline's target is STORED — a
/// one-off with a deadline always carries a real `due_at`, flagged
/// `target_auto` when the user didn't pick it — so `due_at` is the whole
/// answer. The native port of the old IMPLIED target (computed from the
/// deadline and the user's morning time, `TargetContextStore`) is gone, and so
/// is the device-computed target-age tab ("2d"): the badges are the server's
/// `attempts_label` and `age_label`. Dropped rather than kept for an older
/// server: the server is the one keeping compatibility (it still sends
/// `deadline_nag_off` and `original_due_at` for builds already installed); a
/// new build is installed against a server at least as new as these fields,
/// and against an older one it merely draws no badge.
///
/// Foundation-only (the widget extensions, the watch, the apps and
/// `OpenTaskLogicTests` all compile it).
enum TargetAge {

    /// The server's `ATTEMPTS_MEDIUM` / `ATTEMPTS_STRONG`
    /// (`src/lib/task-segments.ts`).
    static let mediumAttempts = 3
    static let strongAttempts = 7

    /// Three depths of ONE calm plum (the web's `--over-target`), never red or
    /// amber: an arrived target signals nothing wrong (Trent, 2026-10-11). Red
    /// is kept for a passed deadline only.
    enum Tone: Equatable {
        case light, medium, strong
    }

    /// The attempts badge's depth (the web's `attemptsTone`): 1–2 light, 3–6
    /// medium, 7+ strong.
    static func tone(attempts: Int) -> Tone {
        if attempts >= strongAttempts { return .strong }
        if attempts >= mediumAttempts { return .medium }
        return .light
    }

    /// The attempts badge's text when a row draws one: the server's
    /// `attempts_label` ("3×"), only while the task has a target (the web's
    /// guard — the server already sends nil without one) and never on a quota.
    static func attemptsBadge(_ task: TaskDTO) -> String? {
        guard task.dueAt != nil, !task.isTracked, let label = task.attemptsLabel, !label.isEmpty else { return nil }
        return label
    }

    /// Whether the deadline has passed — the past-deadline marker.
    static func isPastDeadline(_ task: TaskDTO, now: Date = Date()) -> Bool {
        guard let deadline = task.deadlineDate else { return false }
        return deadline < now
    }

    /// A FUTURE target's day, "Nov 1" — the chip a task segment row wears
    /// (amendment 5): its OWN target (a deadline shows as itself). Nil when none, or not
    /// in the future (a segment row's target is never today: a target today
    /// takes the task out of the segment).
    static func futureTargetChip(_ task: TaskDTO, now: Date = Date(), calendar: Calendar = .current) -> String? {
        guard let target = task.dueDate, target > now else { return nil }
        return dayText(target, calendar: calendar)
    }

    /// "Nov 1" in `calendar`'s zone.
    static func dayText(_ date: Date, calendar: Calendar = .current) -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "MMM d"
        return formatter.string(from: date)
    }

    /// "Tue Oct 13" in `calendar`'s zone — the web's `ccc LLL d`, Upcoming's
    /// target and deadline words.
    static func weekdayDayText(_ date: Date, calendar: Calendar = .current) -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "EEE MMM d"
        return formatter.string(from: date)
    }
}

/// How short an Upcoming row's small words are (2026-10-12, Trent's review of
/// #251: "the Upcoming row meta must fit on ONE line"). The widget row
/// measures and takes the FIRST form whose words fit on one line
/// (`TaskSegmentListView.layout`); surfaces that can't measure pick one
/// (the watch row by `ViewThatFits` over the same ladder, the Smart Stack
/// card `.short`). A one-off's forms differ only in the dates and the
/// deadline-before-target words, so neighbouring forms can be equal.
enum UpcomingMetaForm: Int, CaseIterable, Equatable {
    /// "Wed Oct 14 · deadline Sat Oct 17", "Wed Oct 14 · every Wed at 9 AM".
    case full
    /// The schedule without its time: "every Wed".
    case noScheduleTime
    /// The schedule without its "on …" clause either: "every 2 weeks",
    /// "monthly"; and "(deadline first)" for "(deadline before target)".
    case noScheduleOn
    /// No weekdays on the dates: "Oct 14 · deadline Oct 17".
    case short
    /// No words after a deadline that falls before the target — the two
    /// dates already show the order ("Oct 16 · deadline Oct 11"). Only that
    /// row differs from `.short`; its "(deadline first)" wrapped at the
    /// default Large text size in a 3-control row (render, 2026-10-12).
    case shortest

    var includesWeekdays: Bool { self.rawValue < UpcomingMetaForm.short.rawValue }
    var scheduleIncludesTime: Bool { self == .full }
    var scheduleIncludesOn: Bool { self == .full || self == .noScheduleTime }
    /// The words after a deadline before its target; nil = none.
    var deadlineFirstWords: String? {
        switch self {
        case .full, .noScheduleTime: return "(deadline before target)"
        case .noScheduleOn, .short: return "(deadline first)"
        case .shortest: return nil
        }
    }
}

extension TaskDTO {
    /// The small words after a task segment row's title — the web row's
    /// rule (docs/TASK-MODEL.md § Task segments, "the row"): the task's SET
    /// horizon only when it differs from the segment it sits in (a deadline
    /// pulled it in — "Weeks" on a Days page), never for an unset horizon
    /// (shown as nothing, never as "Weeks"); a future target's day ("Nov 1");
    /// the deadline ("deadline Oct 16"); then the two badges, the web's
    /// `BadgeChips` (spec §7, 2026-10-12): the attempts ("3×", the server's
    /// `attempts_label`, LAST when present — `SegmentTaskRow` tints it plum)
    /// or the age (">1 mo", `age_label`, undated tasks only — never both).
    /// "Weeks · Nov 1". Nil when there is nothing to say. Spaces inside each
    /// part are non-breaking, so a part ("deadline Oct 16") never splits;
    /// parts are joined by `metaJoiner`, which lets a long meta wrap only
    /// AFTER a dot, never before one. `segmentHorizon` nil = no segment
    /// context (the watch's compact rows): the set horizon always shows.
    /// `upcomingForm` applies to an Upcoming row only.
    func segmentMeta(
        segmentHorizon: String? = nil, now: Date = Date(), calendar: Calendar = .current,
        upcomingForm: UpcomingMetaForm = .full
    ) -> String? {
        let parts: [String?]
        if segmentHorizon == SegmentKind.upcomingRaw {
            parts = upcomingParts(calendar: calendar, form: upcomingForm)
        } else {
            let horizonWord = (segmentHorizon != nil && horizon == segmentHorizon) ? nil : horizonLabel
            let deadline = deadlineDate.map { "deadline \(TargetAge.dayText($0, calendar: calendar))" }
            parts = [horizonWord, TargetAge.futureTargetChip(self, now: now, calendar: calendar), deadline]
        }
        let all = (parts + [ageLabel, TargetAge.attemptsBadge(self)])
            .compactMap { $0?.replacingOccurrences(of: " ", with: "\u{00A0}") }
        return all.isEmpty ? nil : all.joined(separator: Self.metaJoiner)
    }

    /// An UPCOMING row's small words (2026-10-12) — after the web's
    /// `upcomingGap` (`src/lib/task-segments.ts`), shortened to fit one line
    /// (Trent's review of #251): the target's day with no "Target" word
    /// ("Wed Oct 14"), a repeating row's schedule (`RecurrenceSummary`:
    /// "every Wed at 9 AM"), then the deadline ("deadline Sat Oct 17"). No
    /// "(+3d)" gap (Trent didn't know what it meant) and no "(same day)" (both
    /// dates are already shown); a deadline before the target — only possible
    /// once the deadline has passed — says "(deadline before target)", or
    /// "(deadline first)" in the shorter forms, nothing in the shortest. No horizon word: a targeted
    /// task's horizon decides nothing until the target is removed (spec §1).
    /// Days are local calendar days in `calendar`'s zone. See
    /// `UpcomingMetaForm` for what each form drops.
    func upcomingMeta(calendar: Calendar = .current, form: UpcomingMetaForm = .full) -> String? {
        let parts = upcomingParts(calendar: calendar, form: form)
            .compactMap { $0?.replacingOccurrences(of: " ", with: "\u{00A0}") }
        return parts.isEmpty ? nil : parts.joined(separator: Self.metaJoiner)
    }

    private func upcomingParts(calendar: Calendar, form: UpcomingMetaForm) -> [String?] {
        func day(_ date: Date) -> String {
            form.includesWeekdays
                ? TargetAge.weekdayDayText(date, calendar: calendar)
                : TargetAge.dayText(date, calendar: calendar)
        }
        let target = dueDate.map(day)
        var deadline: String?
        if let deadlineDate {
            deadline = "deadline \(day(deadlineDate))"
            if let due = dueDate, deadlineDate < due, let words = form.deadlineFirstWords {
                deadline! += " \(words)"
            }
        }
        let repeats = rrule != nil && target != nil
            ? RecurrenceSummary.text(
                rrule: rrule, anchorTime: anchorTime,
                includeTime: form.scheduleIncludesTime, includeOn: form.scheduleIncludesOn
            )
            : nil
        return [target, repeats, deadline]
    }

    /// Between two parts of a segment row's small words, and between the
    /// title and them when they share a line: " · " with the space BEFORE
    /// the dot non-breaking, so a line can break only after the dot. A wrap
    /// then leaves the dot trailing the line before ("… for the car ·"),
    /// never leading the next ("· Target Wed Oct 14", 2026-10-12, Trent's
    /// phone) — and the widget row avoids even that, measuring and picking a
    /// `SegmentMetaPlacement` so no dot is left at either end of a line.
    static let metaJoiner = "\u{00A0}· "

    /// The whole segment row label as ONE string — title, then the small
    /// words — the string both the row's `Text` and the pager's measurement
    /// build from (the `QuotaPromptDTO.labelText` rule), laid out per
    /// `placement` (2026-10-12; `TaskSegmentListView` measures and picks).
    func segmentLabelText(
        segmentHorizon: String? = nil, now: Date = Date(), calendar: Calendar = .current,
        placement: SegmentMetaPlacement = .inline, upcomingForm: UpcomingMetaForm = .full
    ) -> String {
        guard let meta = segmentMeta(
            segmentHorizon: segmentHorizon, now: now, calendar: calendar, upcomingForm: upcomingForm
        ) else { return title }
        return title + placement.joined(meta: meta)
    }
}

/// Where a segment row's small words go relative to its title (2026-10-12,
/// "· Target Wed Oct 14 · repeats" on Trent's phone: a wrap left a dot at
/// the start of a line). The widget row measures and picks the first that
/// keeps every dot mid-line:
/// - `inline`: the words fit on the title's last line — "Title · words".
/// - `ownLine`: they don't, but fit on one line of their own — "Title" /
///   "Target Wed Oct 14 · every Wed", no separator before them.
/// - `partsOnOwnLines`: even alone they wrap — one part per line, no dots at
///   all ("Target Wed Oct 14" / "deadline Sat Oct 17 (+3d)").
enum SegmentMetaPlacement: Equatable {
    case inline, ownLine, partsOnOwnLines

    /// What follows the title: the separator or line break, then the words.
    func joined(meta: String) -> String {
        switch self {
        case .inline: return TaskDTO.metaJoiner + meta
        case .ownLine: return "\n" + meta
        case .partsOnOwnLines: return "\n" + meta.components(separatedBy: TaskDTO.metaJoiner).joined(separator: "\n")
        }
    }
}

/// User-facing words of the 2026-10-10 task model that are PROVISIONAL
/// (amendment 4): each lives in exactly one constant so a rename is one edit.
/// API names are unchanged — the server still says `overdue` in
/// `/api/tasks/counts`, and the `opentask://overdue` deep link keeps its host.
enum TaskWording {
    /// What used to read "Overdue": a task whose target has passed.
    static let overTarget = "Over target"

    /// Mid-sentence form: "3 over target".
    static var overTargetLower: String { overTarget.lowercased() }

    /// The past-deadline marker's word.
    static let pastDeadline = "Past deadline"
}
