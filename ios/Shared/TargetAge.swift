import Foundation

/// The target rules of the 2026-10-10 task model that the native surfaces
/// draw — a Swift port of the parts of `src/lib/task-segments.ts` they need
/// (`impliedTargetAt`, `effectiveTargetAt`, `targetAgeDays`, `targetAgeTone`,
/// `isPastDeadline`). Keep the numbers in step with that file.
///
/// A task's `due_at` is its TARGET: when nagging starts. Once the target has
/// passed the task is "over target" (`TaskWording.overTarget`, what used to be
/// "overdue"). A deadline implies a target too (rulings A2/B2, 2026-10-11): the
/// user's MORNING on the local day `DEADLINE_LEAD_DAYS` before the deadline,
/// for a one-off whose own target is missing or later than the deadline —
/// computed, never stored, so `due_at` doesn't carry it and every client has
/// to derive it. The effective target is the EARLIER of the two.
///
/// Foundation-only (the widget extensions, the watch, the apps and
/// `OpenTaskLogicTests` all compile it).
enum TargetAge {

    /// The server's `DEADLINE_LEAD_DAYS` (tentative, Trent 10-10: "maybe 4
    /// days early for all priorities").
    static let deadlineLeadDays = 4

    /// The server's `TARGET_AGE_MEDIUM_DAYS` / `TARGET_AGE_STRONG_DAYS`
    /// (placeholders Trent may tune).
    static let mediumDays = 3
    static let strongDays = 7

    /// The deadline's implied target, when it applies (the server's
    /// `impliedTargetAt`): a one-off (no rrule) with a deadline, the nag not
    /// turned off by remove-target, and EITHER no target of its own OR one
    /// set AFTER the deadline. Its time is the user's morning (`morningTime`,
    /// "HH:MM", `users.morning_time` — cached by `TargetContextStore`) on the
    /// local day `deadlineLeadDays` before the deadline's local day; with no
    /// morning time known, a plain deadline − 4 × 24h (the server's own
    /// context-less fallback).
    static func impliedTargetDate(
        _ task: TaskDTO, morningTime: String? = TargetContextStore.morningTime, calendar: Calendar = .current,
        now: Date = Date()
    ) -> Date? {
        guard task.rrule == nil, let deadline = task.deadlineDate else { return nil }
        // A target of the user's own at or before the deadline is honored as set.
        if let due = task.dueDate, due <= deadline { return nil }
        if task.deadlineNagOff {
            // Silenced — but it RE-ARMS on the deadline day itself (ruling A4,
            // 2026-10-11): the morning of the deadline's own day, or the
            // deadline if earlier. A task with its own target (a deliberate
            // snooze past the deadline) is left to it once the deadline passes.
            if task.dueDate != nil, deadline <= now { return nil }
            guard let morningTime, let (hour, minute) = parseHHMM(morningTime),
                  let morning = calendar.date(bySettingHour: hour, minute: minute, second: 0, of: deadline)
            else { return calendar.startOfDay(for: deadline) }
            return min(morning, deadline)
        }
        guard let morningTime, let (hour, minute) = parseHHMM(morningTime),
              let leadDay = calendar.date(byAdding: .day, value: -deadlineLeadDays, to: deadline),
              let morning = calendar.date(bySettingHour: hour, minute: minute, second: 0, of: leadDay)
        else {
            return deadline.addingTimeInterval(-Double(deadlineLeadDays) * 24 * 60 * 60)
        }
        return morning
    }

    /// The target the task nags from: the EARLIER of its own and the
    /// deadline's implied one (the server's `effectiveTargetAt`).
    static func effectiveTargetDate(
        _ task: TaskDTO, morningTime: String? = TargetContextStore.morningTime, calendar: Calendar = .current,
        now: Date = Date()
    ) -> Date? {
        let implied = impliedTargetDate(task, morningTime: morningTime, calendar: calendar, now: now)
        guard let due = task.dueDate else { return implied }
        guard let implied else { return due }
        return implied < due ? implied : due
    }

    /// "09:00" → (9, 0); nil for anything malformed.
    static func parseHHMM(_ text: String) -> (Int, Int)? {
        let parts = text.split(separator: ":")
        guard parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]),
              (0..<24).contains(h), (0..<60).contains(m)
        else { return nil }
        return (h, m)
    }

    /// Whole local days since the task's FIRST target (`original_due_at` —
    /// a snooze keeps it, a deliberate re-target resets it), or nil when the
    /// task has no target, its target has not arrived yet, or today IS the
    /// first target's day: the badge is blank then (Trent, 10-10: "no word on
    /// the badge for the target day").
    ///
    /// When the effective target IS the implied one (rulings A2/B2), the age
    /// counts from it; otherwise from `original_due_at ?? due_at`.
    static func days(
        _ task: TaskDTO, now: Date = Date(), calendar: Calendar = .current,
        morningTime: String? = TargetContextStore.morningTime
    ) -> Int? {
        guard let target = effectiveTargetDate(task, morningTime: morningTime, calendar: calendar, now: now),
              target <= now
        else { return nil }
        var first: Date
        if let due = task.dueDate, target == due {
            first = task.originalDueAt.flatMap(DateHelpers.parseISO) ?? due
        } else {
            first = target
        }
        // Never from before the task existed (2026-10-11): a task created with a
        // deadline 3 days out has an implied target before its creation, and
        // its age is how long it has been on the list.
        if let created = task.createdAt.flatMap(DateHelpers.parseISO), created > first {
            first = created
        }
        let days = calendar.dateComponents(
            [.day], from: calendar.startOfDay(for: first), to: calendar.startOfDay(for: now)
        ).day ?? 0
        return days > 0 ? days : nil
    }

    /// Three depths of ONE calm plum (the web's `--over-target`), never red or
    /// amber: an arrived target signals nothing wrong (Trent, 2026-10-11). Red
    /// is kept for a passed deadline only.
    enum Tone: Equatable {
        case light, medium, strong
    }

    /// 1–2 days light, 3–6 medium, 7+ strong.
    static func tone(days: Int) -> Tone {
        if days >= strongDays { return .strong }
        if days >= mediumDays { return .medium }
        return .light
    }

    /// The badge's text: just the age — "2d", never "2d over" (spec §4).
    static func badgeText(days: Int) -> String { "\(days)d" }

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

extension TaskDTO {
    /// The small words after a task segment row's title — the web row's
    /// rule (docs/TASK-MODEL.md § Task segments, "the row"): the task's SET
    /// horizon only when it differs from the segment it sits in (a deadline
    /// pulled it in — "Weeks" on a Days page), never for an unset horizon
    /// (shown as nothing, never as "Weeks"); a future target's day ("Nov 1");
    /// and the deadline ("deadline Oct 16"). "Weeks · Nov 1". Nil when there
    /// is nothing to say. Spaces inside each part are non-breaking, so a part
    /// ("deadline Oct 16") never splits; parts are joined by `metaJoiner`,
    /// which lets a long meta wrap only AFTER a dot, never before one.
    /// `segmentHorizon` nil = no segment context (the watch's compact rows):
    /// the set horizon always shows.
    func segmentMeta(segmentHorizon: String? = nil, now: Date = Date(), calendar: Calendar = .current) -> String? {
        if segmentHorizon == SegmentKind.upcomingRaw {
            return upcomingMeta(calendar: calendar)
        }
        let horizonWord = (segmentHorizon != nil && horizon == segmentHorizon) ? nil : horizonLabel
        let deadline = deadlineDate.map { "deadline \(TargetAge.dayText($0, calendar: calendar))" }
        let parts = [horizonWord, TargetAge.futureTargetChip(self, now: now, calendar: calendar), deadline]
            .compactMap { $0?.replacingOccurrences(of: " ", with: "\u{00A0}") }
        return parts.isEmpty ? nil : parts.joined(separator: Self.metaJoiner)
    }

    /// An UPCOMING row's small words (2026-10-12) — the Swift port of the
    /// web's `upcomingGap` (`src/lib/task-segments.ts`): "Target Tue Oct 13",
    /// then the deadline and how far past the target it falls, "· deadline
    /// Sat Oct 17 (+4d)", "(same day)", or "(deadline before target)" for a
    /// target set past its own deadline. A repeating row adds its schedule
    /// after the target (`RecurrenceSummary`: "· every Wed", "· daily at 9 AM";
    /// the web's target chip still says "repeats", which is also the
    /// fallback for a rule it can't read). No horizon word: a targeted task's horizon decides
    /// nothing until the target is removed (spec §1). Days are local calendar
    /// days in `calendar`'s zone; spaces non-breaking, like `segmentMeta`.
    func upcomingMeta(calendar: Calendar = .current) -> String? {
        let target = dueDate.map { "Target \(TargetAge.weekdayDayText($0, calendar: calendar))" }
        var deadline: String?
        if let deadlineDate {
            let text = "deadline \(TargetAge.weekdayDayText(deadlineDate, calendar: calendar))"
            if let due = dueDate {
                let gap = calendar.dateComponents(
                    [.day], from: calendar.startOfDay(for: due), to: calendar.startOfDay(for: deadlineDate)
                ).day ?? 0
                if deadlineDate < due, gap <= 0 {
                    deadline = "\(text) (deadline before target)"
                } else {
                    deadline = gap == 0 ? "\(text) (same day)" : "\(text) (+\(gap)d)"
                }
            } else {
                deadline = text
            }
        }
        let repeats = rrule != nil && target != nil ? RecurrenceSummary.text(rrule: rrule, anchorTime: anchorTime) : nil
        let parts = [target, repeats, deadline].compactMap { $0?.replacingOccurrences(of: " ", with: "\u{00A0}") }
        return parts.isEmpty ? nil : parts.joined(separator: Self.metaJoiner)
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
        placement: SegmentMetaPlacement = .inline
    ) -> String {
        guard let meta = segmentMeta(segmentHorizon: segmentHorizon, now: now, calendar: calendar) else { return title }
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

/// The user's `morning_time` ("HH:MM", from `GET /api/user/preferences`),
/// cached in the App Group so every native target — the apps, the widget
/// extensions, the watch — reads the implied deadline target on the same
/// clock as the server (`TargetAge.impliedTargetDate`). Written whenever the
/// preferences are fetched (`APIClient.fetchLabelConfig`, which the Quotas
/// widget and the watch already call, and `refreshSlotActions` on every app
/// launch/foreground). Nil until the first fetch: the rule then falls back
/// to deadline − 4 × 24h, the server's own fallback.
enum TargetContextStore {
    #if os(macOS)
    private static let appGroup = "GEL3VGTUJX.group.io.mcnitt.opentask"
    #else
    private static let appGroup = "group.io.mcnitt.opentask"
    #endif
    private static let morningTimeKey = "targetContext.morningTime"

    #if DEBUG
    /// Test seam (`OpenTaskLogicTests`): on macOS the App Group is the
    /// installed Mac app's, so tests set this instead of reading it.
    /// `.some(nil)` = "no morning time cached".
    static var override: String?? = nil
    #endif

    static var morningTime: String? {
        #if DEBUG
        if let override { return override }
        #endif
        return UserDefaults(suiteName: appGroup)?.string(forKey: morningTimeKey)
    }

    static func save(morningTime: String?) {
        #if DEBUG
        if override != nil { return }
        #endif
        guard let morningTime, TargetAge.parseHHMM(morningTime) != nil else { return }
        UserDefaults(suiteName: appGroup)?.set(morningTime, forKey: morningTimeKey)
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
