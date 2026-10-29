import Foundation

/// The native task row's priority and horizon RULES (2026-10-16), from the
/// web dashboard row's corner (`src/lib/row-corner.ts`, PRs #267/#270).
///
/// The corner STRIP that drew them (`RowCornerStrip`: horizon dot · "!"/"!!"
/// tab before the due label) went on 2026-10-28 with the web's lean row
/// (`LeanRow`): the priority mark now follows the title, bound to its last
/// word, and the horizon dot is gone — the horizon is the done square's
/// border on the rows it governs (`LeanRow.horizonGoverns`).
///
/// Foundation-only: the rules are pure and tested (`RowCornerTests`).
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

    /// Whether a task-segment row's marks (the Reminders widget's square and
    /// circle) take the priority colour: only where the tab would show. The
    /// Tasks widget's square and Up next dot are neutral since 2026-10-28
    /// (`LeanRow`: the "!"/"!!" after the title says it). Medium's yellow and Low's grey
    /// read as a priority mark, which the rule above gives them none of.
    static func markIsColored(_ priority: Int) -> Bool {
        priorityTab(priority) != nil
    }

    // MARK: - Where the horizon decides something

    /// `showsHorizonDot` (the web's name; the dot itself is gone since
    /// 2026-10-28, and `LeanRow.horizonGoverns` adds "and no deadline"): only
    /// where the horizon decides something — a plain one-off (not a quota, a
    /// reminder or a repeating task; the native lists hold open tasks only)
    /// with no target the USER picked: none at all, or only the deadline's
    /// automatic one (`target_auto`). A picked target makes the task quiet
    /// until its date (spec §1).
    static func showsHorizonDot(_ task: TaskDTO) -> Bool {
        let plainOneOff = !task.isReminder && (task.rrule ?? "").isEmpty && !task.isTracked
        return plainOneOff && (task.dueAt == nil || task.targetAuto)
    }

    /// The task's horizon: nil when unset or unknown.
    static func horizon(of task: TaskDTO) -> TaskHorizon? {
        TaskHorizon(rawValue: task.horizon ?? "")
    }
}
