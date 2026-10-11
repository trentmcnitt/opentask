import Foundation

/// The target rules of the 2026-10-10 task model that the native surfaces
/// draw — a Swift port of the parts of `src/lib/task-segments.ts` they need
/// (`impliedTargetAt`, `effectiveTargetAt`, `targetAgeDays`, `targetAgeTone`,
/// `isPastDeadline`). Keep the numbers in step with that file.
///
/// A task's `due_at` is its TARGET: when nagging starts. Once the target has
/// passed the task is "over target" (`TaskWording.overTarget`, what used to be
/// "overdue"). A deadline with no target nags from `DEADLINE_LEAD_DAYS` before
/// the deadline — computed, never stored, so `due_at` stays null on such a
/// task and every client has to derive the target itself.
///
/// Foundation-only (the widget extensions, the watch, the apps and
/// `OpenTaskLogicTests` all compile it).
enum TargetAge {

    /// The server's `DEADLINE_LEAD_DAYS` (tentative, Trent 10-10: "maybe 4
    /// days early for all priorities").
    static let deadlineLeadDays = 4

    /// The server's `TARGET_AGE_AMBER_DAYS` / `TARGET_AGE_RED_DAYS`
    /// (placeholders Trent may tune).
    static let amberDays = 3
    static let redDays = 7

    /// The deadline's implied target (deadline − 4 days), when it applies: no
    /// target of its own, a deadline, the nag not turned off by remove-target,
    /// and not recurring.
    static func impliedTargetDate(_ task: TaskDTO) -> Date? {
        guard task.dueAt == nil, !task.deadlineNagOff, task.rrule == nil,
              let deadline = task.deadlineDate
        else { return nil }
        return deadline.addingTimeInterval(-Double(deadlineLeadDays) * 24 * 60 * 60)
    }

    /// The target the task nags from: its own, else the deadline's implied one.
    static func effectiveTargetDate(_ task: TaskDTO) -> Date? {
        task.dueDate ?? impliedTargetDate(task)
    }

    /// Whole local days since the task's FIRST target (`original_due_at` —
    /// a snooze keeps it, a deliberate re-target resets it), or nil when the
    /// task has no target, its target has not arrived yet, or today IS the
    /// first target's day: the badge is blank then (Trent, 10-10: "no word on
    /// the badge for the target day").
    static func days(_ task: TaskDTO, now: Date = Date(), calendar: Calendar = .current) -> Int? {
        guard let target = effectiveTargetDate(task), target <= now else { return nil }
        let first: Date
        if task.dueDate != nil {
            first = task.originalDueAt.flatMap(DateHelpers.parseISO) ?? target
        } else {
            first = target
        }
        let days = calendar.dateComponents(
            [.day], from: calendar.startOfDay(for: first), to: calendar.startOfDay(for: now)
        ).day ?? 0
        return days > 0 ? days : nil
    }

    enum Tone: Equatable {
        case gray, amber, red
    }

    /// 1–2 days gray, 3–6 amber, 7+ red.
    static func tone(days: Int) -> Tone {
        if days >= redDays { return .red }
        if days >= amberDays { return .amber }
        return .gray
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
}

extension TaskDTO {
    /// The small words after a task segment row's title — the web row's
    /// rule (docs/TASK-MODEL.md § Task segments, "the row"): the task's SET
    /// horizon only when it differs from the segment it sits in (a deadline
    /// pulled it in — "Weeks" on a Days page), never for an unset horizon
    /// (shown as nothing, never as "Weeks"); a future target's day ("Nov 1");
    /// and the deadline ("deadline Oct 16"). "Weeks · Nov 1". Nil when there
    /// is nothing to say. Spaces are non-breaking so the words wrap as one
    /// unit, like a prompt's count. `segmentHorizon` nil = no segment context
    /// (the watch's compact rows): the set horizon always shows.
    func segmentMeta(segmentHorizon: String? = nil, now: Date = Date(), calendar: Calendar = .current) -> String? {
        let horizonWord = (segmentHorizon != nil && horizon == segmentHorizon) ? nil : horizonLabel
        let deadline = deadlineDate.map { "deadline \(TargetAge.dayText($0, calendar: calendar))" }
        let parts = [horizonWord, TargetAge.futureTargetChip(self, now: now, calendar: calendar), deadline]
            .compactMap { $0?.replacingOccurrences(of: " ", with: "\u{00A0}") }
        return parts.isEmpty ? nil : parts.joined(separator: "\u{00A0}·\u{00A0}")
    }

    /// The whole segment row label as ONE string — title, separator, meta —
    /// the string both the row's `Text` and the pager's measurement build
    /// from (the `QuotaPromptDTO.labelText` rule).
    func segmentLabelText(segmentHorizon: String? = nil, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let meta = segmentMeta(segmentHorizon: segmentHorizon, now: now, calendar: calendar) else { return title }
        return "\(title)\(QuotaPromptDTO.countSeparator)\(meta)"
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
