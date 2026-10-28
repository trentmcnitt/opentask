import Foundation

/// The native task row's CORNER (2026-10-16): the web dashboard row's corner
/// (`src/lib/row-corner.ts`, PRs #267/#270), ported to the Tasks widget (iOS
/// and Mac) and the watch's Tasks page. Read left to right as
///
///     horizon dot · priority tab
///
/// The web's middle tab, the attempts count ("2×"), is NOT here: on native
/// it stays folded into the due label's first line ("Thu · 3×",
/// `AttemptsInTime`), Trent's pick (c) of 2026-10-12, so a row never shows
/// it twice.
///
/// Foundation-only: the rules are pure and tested (`RowCornerTests`); the
/// views draw them (`TaskCornerMarks` in the widget, `WatchTaskCorner`).
enum RowCorner {

    // MARK: - Priority tab

    /// The solid priority tab — High and Urgent ONLY. Trent, 2026-10-15:
    /// "just use a colored corner, while only adding '!' and '!!' for high
    /// and urgent (medium and low get no colored corner tab)". Medium, Low
    /// and None get no mark on a task row at all: no tab, and no priority
    /// colour on the row's checkbox or dot either (`markIsColored`).
    enum PriorityTab: Equatable {
        case high
        case urgent

        /// The web's compact ("icons") text: the widget and the watch have
        /// no room for "High"/"Urgent".
        var text: String {
            switch self {
            case .high: return "!"
            case .urgent: return "!!"
            }
        }

        /// The accessible name, the web tab's `aria-label`.
        var name: String {
            switch self {
            case .high: return "High priority"
            case .urgent: return "Urgent priority"
            }
        }
    }

    /// `src/lib/row-corner.ts` `priorityTab`: 3 → High, 4 → Urgent, else nil.
    static func priorityTab(_ priority: Int) -> PriorityTab? {
        switch priority {
        case 3: return .high
        case 4: return .urgent
        default: return nil
        }
    }

    /// Whether a task row's other marks (the Tasks widget's checkbox outline,
    /// the Up next dot, a task-segment row's circle) take the priority
    /// colour: only where the tab would show. Medium's yellow and Low's grey
    /// read as a priority mark, which the rule above gives them none of.
    static func markIsColored(_ priority: Int) -> Bool {
        priorityTab(priority) != nil
    }

    // MARK: - Horizon dot (R1, "perspective dot")

    /// The dot's radius (points, in the web's 12×12 box) and opacity over the
    /// mark colour (foreground at 78–80%) — `HORIZON_DOT` in
    /// `src/lib/row-corner.ts`, EXACT values (change them together): Days 4 /
    /// 1.0, Weeks 3 / 0.7, Months 2.5 / 0.55, Eventually 2.25 / 0.42 (raised
    /// from the mockup's 4px / 0.22, which vanished at real size).
    struct DotStyle: Equatable {
        let radius: Double
        let opacity: Double
        /// Unset only: drawn as a hollow ring, not a fill.
        let ring: Bool
    }

    static func dotStyle(_ horizon: TaskHorizon?) -> DotStyle {
        switch horizon {
        case .days: return DotStyle(radius: 4, opacity: 1, ring: false)
        case .weeks: return DotStyle(radius: 3, opacity: 0.7, ring: false)
        case .months: return DotStyle(radius: 2.5, opacity: 0.55, ring: false)
        case .eventually: return DotStyle(radius: 2.25, opacity: 0.42, ring: false)
        // Unset (read as weeks, never shown as set): a hollow ring the size of
        // the Weeks dot — `HORIZON_DOT_UNSET`, r 2.5 + stroke 1 = 6pt across,
        // opacity 0.36. Dashed (r 3, "1.6 1.3") until 2026-10-28: on a 1x
        // monitor the dashes broke up, and the ring was Trent's pick. 0.8
        // until later that day ("a little too strong… It looks intentionally
        // set"): fainter than every set dot now, so it reads as nothing set.
        case nil: return DotStyle(radius: 2.5, opacity: 0.36, ring: true)
        }
    }

    /// The unset ring's stroke, `HORIZON_DOT_UNSET`.
    static let unsetStroke: Double = 1

    /// The box the dot sits in — the web's 12×12 `viewBox`.
    static let dotBox: Double = 12

    /// `showsHorizonDot`: only where the horizon decides something — a plain
    /// one-off (not a quota, a reminder or a repeating task; the native lists
    /// hold open tasks only) with no target the USER picked: none at all, or
    /// only the deadline's automatic one (`target_auto`). A picked target
    /// makes the task quiet until its date (spec §1), so the dot hides.
    ///
    /// The Tasks widget and the watch list dated tasks only
    /// (`TaskLists.eligible`), so in practice the dot shows there on a
    /// deadline task still on its automatic target.
    static func showsHorizonDot(_ task: TaskDTO) -> Bool {
        let plainOneOff = !task.isReminder && (task.rrule ?? "").isEmpty && !task.isTracked
        return plainOneOff && (task.dueAt == nil || task.targetAuto)
    }

    /// The task's horizon as the dot reads it: nil when unset or unknown.
    static func horizon(of task: TaskDTO) -> TaskHorizon? {
        TaskHorizon(rawValue: task.horizon ?? "")
    }

    /// The dot's spoken words: "Horizon Weeks" / "Horizon unset".
    static func dotAccessibilityLabel(_ horizon: TaskHorizon?) -> String {
        "Horizon \(horizon?.label ?? "unset")"
    }
}
