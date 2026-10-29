import Foundation

/// THE LEAN ROW'S RULES on the native task rows (2026-10-28, Trent's rulings
/// for the web's lean row, PR #410) — the Foundation-only mirror of
/// `src/lib/lean-row-state.ts` (which tint), `src/lib/lean-chip-words.ts`
/// (the deadline countdown, "Today" once per row — "Tonight" counts as
/// Today) and
/// `src/lib/horizon-square.ts` (the done square's border), plus the colours
/// those rows draw in, as 0xRRGGBB light/dark pairs (`WidgetTheme`,
/// `WatchTheme` and the Mac panel each make the `Color`: the watch and the
/// Mac app don't compile `WidgetTheme`).
///
/// Drawn by the Tasks widget's rows (`TaskRow` in `TasksWidgetViews.swift`),
/// the watch Tasks page (`TasksPageView`) and the Mac menu bar panel
/// (`MenuBarPanel`):
///
/// - the target's time is BLUE while ahead and the plum "over" tone once
///   passed (M1, 2026-10-29); the attempts count ("2×") is neutral;
/// - the row's tint (`state`): a passed deadline red, over target blue with a
///   normal title ink (no slate since 2026-10-29), a target or deadline
///   later today a faint blue — no stripe;
/// - High "!" / Urgent "!!" after the title (`RowCorner.priorityTab`, drawn
///   inside the title's own text), never in a corner strip; the horizon dot
///   is gone.
///
/// What these surfaces do NOT draw (so the rules below are pinned by tests,
/// ready for a surface that does, but change nothing on screen today):
/// - a deadline's moment — they show only the red flag once it has passed —
///   so no countdown (`countdownWords`) and no "Today" to say once
///   (`todayOnce`; a native target today is already its time alone,
///   `DueLabel.parts`);
/// - the horizon's look on the square (`squareLook(for:)`): the web draws it
///   only in Scan's Horizon sections (2026-10-29), and no native list is
///   one, so every native square is plain; `horizonGoverns` (every one-off)
///   and the looks stay pinned by tests.
///
/// Pure: the clock and the OpenTask day come in. Tested by `LeanRowTests`,
/// the web's own cases.
enum LeanRow {

    // MARK: - The row's tint

    /// `LeanRowState` on the web.
    enum State: Equatable {
        /// The deadline has passed — red; it wins over everything.
        case passed
        /// The deadline AND the target have passed — the red at 1.75×
        /// (2026-10-29; the web keeps `passed` and marks `data-both-passed`).
        case bothPassed
        /// Over target — blue (the title in its normal ink since 2026-10-29).
        case over
        /// A target or deadline LATER TODAY (the OpenTask day), not yet over
        /// — a faint blue, the title unchanged.
        case soon
    }

    /// `leanRowState`: which tint a row wears, or nil for none. `isOverdue`
    /// is the list's own answer for over target (`TaskDTO.isOverdue(now:)`).
    static func state(_ task: TaskDTO, isOverdue: Bool, now: Date, day: OpenTaskDay) -> State? {
        if TargetAge.isPastDeadline(task, now: now) { return isOverdue ? .bothPassed : .passed }
        if isOverdue { return .over }
        let today = day.openTaskDay(of: now)
        func laterToday(_ at: Date?) -> Bool {
            guard let at else { return false }
            return at > now && day.openTaskDay(of: at) == today
        }
        return laterToday(task.dueDate) || laterToday(task.deadlineDate) ? .soon : nil
    }

    // MARK: - The deadline countdown

    /// `countdownWords`: whole hours from the NEXT top of the hour (strictly
    /// after `now`, in the day's zone — so a half-hour zone counts right) to
    /// `deadline`, so it changes only on the hour: at 8:30 AM a 6 PM deadline
    /// is "in 9 hrs"; from 7:00 PM to an 8 PM deadline it is "in <1 hr".
    static func countdownWords(deadline: Date, now: Date, day: OpenTaskDay) -> String {
        let nextHour = day.calendar.dateInterval(of: .hour, for: now)?.end ?? now.addingTimeInterval(3600)
        let hours = Int((deadline.timeIntervalSince(nextHour) / 3600).rounded(.down))
        if hours < 1 { return "in <1 hr" }
        return "in \(hours) hr\(hours == 1 ? "" : "s")"
    }

    /// The countdown a row's deadline would carry: only a deadline LATER
    /// TODAY (the OpenTask day, not yet passed) counts down. Targets never do.
    static func countdown(_ task: TaskDTO, now: Date, day: OpenTaskDay) -> String? {
        guard let deadline = task.deadlineDate, deadline > now,
              day.openTaskDay(of: deadline) == day.openTaskDay(of: now)
        else { return nil }
        return countdownWords(deadline: deadline, now: now, day: day)
    }

    // MARK: - "Today" once per row

    /// The day words that name today's OpenTask day. "Tonight" counts as
    /// Today (Trent, 2026-10-29): a deadline "Tonight 12:30 AM" is the row's
    /// one day word, so a target "Today 5:00 PM" beside it reads "5:00 PM".
    static let todayWords = ["Today ", "Tonight "]

    /// The today word `words` start with, or nil.
    static func todayWord(_ words: String?) -> String? {
        guard let words else { return nil }
        return todayWords.first { words.hasPrefix($0) }
    }

    /// `leanChipWords`' last step: when the deadline's words say "Today" or
    /// "Tonight", a target today or tonight shows just its time ("Today
    /// 5:00 PM" → "5:00 PM"). Other days are unchanged.
    static func todayOnce(deadline: String?, target: String?) -> String? {
        guard let target, let word = todayWord(target), todayWord(deadline) != nil else {
            return target
        }
        return String(target.dropFirst(word.count))
    }

    // MARK: - The horizon done square

    /// `horizonGoverns`: the square shows the horizon the user SET on EVERY
    /// one-off (not repeating, not a reminder or a quota) — targeted or not,
    /// deadline or not (Trent, 2026-10-29: "the checkbox always reflects the
    /// horizon, regardless of whether it has a target"; "it should reflect
    /// the set horizon not the way it's acting"), never the effective one.
    /// Only repeating tasks keep the plain square. It was "no picked target
    /// and no deadline" until then.
    static func horizonGoverns(_ task: TaskDTO) -> Bool {
        RowCorner.isPlainOneOff(task)
    }

    /// A square's border, `SquareLook` on the web.
    enum SquareLook: Equatable {
        /// Days: the plain square itself.
        case solid
        /// Weeks: long dashes, one gap per side.
        case dashes
        /// Months: a dash mid-side ("Months A").
        case midDash
        /// Eventually: dots.
        case dots
    }

    /// The look of a horizon; unset looks like whatever unset MEANS
    /// (`TaskHorizon.unsetReadsAs`, the web's `UNSET_HORIZON`) — never a
    /// literal.
    static func squareLook(_ horizon: TaskHorizon?) -> SquareLook {
        switch horizon ?? TaskHorizon.unsetReadsAs {
        case .days: return .solid
        case .weeks: return .dashes
        case .months: return .midDash
        case .eventually: return .dots
        }
    }

    /// The square a row draws: the horizon's look only in a Horizon section
    /// (the web's Scan, where every row shares one horizon — Trent,
    /// 2026-10-29: "my eye doesn't like that the task checkbox is changing
    /// shape"), else the plain square. No native list is a Horizon section,
    /// so every native square is plain.
    static func squareLook(for task: TaskDTO, inHorizonSection: Bool = false) -> SquareLook {
        inHorizonSection && horizonGoverns(task) ? squareLook(RowCorner.horizon(of: task)) : .solid
    }

    /// The native square's geometry (the Tasks widget's check-off): 16pt, a
    /// 4pt corner radius, a 1.5pt stroke — so each straight side between the
    /// corner arcs is 8pt. The web's 22px / 5px square has a 12px side.
    static let squareSize: Double = 16
    static let squareRadius: Double = 4
    static let squareStroke: Double = 1.5
    static var squareSide: Double { squareSize - 2 * squareRadius }

    /// One straight side's on/off pattern in points (starting with "on"),
    /// summing to `squareSide` and symmetric — the web's patterns
    /// (`HORIZON_SQUARE_LOOKS`, on a 12px side) redrawn on the 8pt side in
    /// half points, so every dash starts and ends on a pixel at 2x (and on a
    /// whole point at 1x for the whole-point ones). Nil: solid.
    ///
    /// - Weeks [4,4,4] → [3,2,3]: two long dashes, one gap.
    /// - Months [1,3,4,3,1] → [1,1.5,3,1.5,1]: the corners' curve runs on a
    ///   point, then one dash mid-side.
    /// - Eventually: two dots a side, each a stroke-wide square (1.5pt on
    ///   1.5pt, butt caps), [0,1,1.5,3,1.5,1] — the leading 0 starts the
    ///   side "off"; the corners are dots too (`cornerDots`).
    static func sidePattern(_ look: SquareLook) -> [Double]? {
        switch look {
        case .solid: return nil
        case .dashes: return [3, 2, 3]
        case .midDash: return [1, 1.5, 3, 1.5, 1]
        case .dots: return [0, 1, 1.5, 3, 1.5, 1]
        }
    }

    /// Whether the corners are the arc (solid) or one stroke-wide dot.
    static func cornerDots(_ look: SquareLook) -> Bool { look == .dots }

    /// The spoken words on a governed square: "Horizon Weeks" / "Horizon
    /// unset".
    static func squareAccessibilityLabel(_ horizon: TaskHorizon?) -> String {
        "Horizon \(horizon?.label ?? "unset")"
    }

    // MARK: - Colours (0xRRGGBB, light / dark)

    /// A colour and its alpha in each appearance.
    struct Tone: Equatable {
        let hex: UInt32
        let alpha: Double
    }

    /// The target's time: blue-600 (light) / blue-400 (dark) — the web's
    /// target chip, `TimeChip`'s `target` tone — while the target is ahead.
    static let targetHex: (light: UInt32, dark: UInt32) = (0x155DFC, 0x51A2FF)

    /// A PASSED target's time (M1, 2026-10-29, the web's #410): the app's
    /// plum "over" tone — `TimeChip`'s `over` text, #8e389b light and the
    /// `--over-target` token (#c97cd5) dark.
    static let overTargetHex: (light: UInt32, dark: UInt32) = (0x8E389B, 0xC97CD5)

    /// The target time's colour: plum once it has passed, blue before.
    static func targetTimeHex(isOverdue: Bool) -> (light: UInt32, dark: UInt32) {
        isOverdue ? overTargetHex : targetHex
    }

    /// A passed deadline's flag: red-700 / red-400 (`TimeChip`'s `passed`).
    static let passedHex: (light: UInt32, dark: UInt32) = (0xC10007, 0xFF6467)

    /// High "!" / Urgent "!!": the web tab's orange-500 / red-500.
    static func priorityHex(_ tab: RowCorner.PriorityTab) -> UInt32 {
        switch tab {
        case .high: return 0xF97316
        case .urgent: return 0xEF4444
        }
    }

    /// The row's tint (`STATE_LOOK`): over target an opaque sky-leaning blue
    /// in light (#d6eeff, Trent's pick of 2026-10-29 in dev tools — E2 rgb
    /// 231 245 255 before), the target's blue at 12.5% in dark; later today
    /// #f5fbff in light (a quarter of the over tint's strength), the blue
    /// at 3.125% in dark; a warm red (rgb 200 20 10) at 9.8% light, red-400 at
    /// 14% dark, once the deadline passed; that red at 1.75× (17.15% / 24.5%)
    /// once the target has passed too.
    static func tint(_ state: State) -> (light: Tone, dark: Tone) {
        switch state {
        case .over: return (Tone(hex: 0xD6EEFF, alpha: 1), Tone(hex: 0x51A2FF, alpha: 0.125))
        case .soon: return (Tone(hex: 0xF5FBFF, alpha: 1), Tone(hex: 0x51A2FF, alpha: 0.03125))
        case .passed: return (Tone(hex: 0xC8140A, alpha: 0.098), Tone(hex: 0xFF6467, alpha: 0.14))
        case .bothPassed: return (Tone(hex: 0xC8140A, alpha: 0.1715), Tone(hex: 0xFF6467, alpha: 0.245))
        }
    }
}

extension TaskHorizon {
    /// What an unset horizon is READ as (the web's `UNSET_HORIZON`): Weeks.
    /// Never shown as set — only where unset must look like something (the
    /// horizon square).
    static let unsetReadsAs: TaskHorizon = .weeks
}
