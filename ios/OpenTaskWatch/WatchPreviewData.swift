#if DEBUG
import Foundation

/// Trent's REAL quotas, for the watch app's `#Preview`s only (DEBUG — never in
/// a shipped binary). Read-only snapshot of prod (user 1, every open
/// `is_tracked` / `progress_target > 1` task) taken 2026-09-24, plus his real
/// `label_config`. The long titles ("Check for new certifications — …",
/// "Balloon breathing practice (…)") are why this is real data and not a tidy
/// sample: they are what a watch-width row actually has to wrap.
///
/// Same approach as the Smart Stack widget's `ReminderStackPreviewData`
/// (which lives in the widget extension and so can't be reached from here).
enum WatchPreviewData {
    static let labelConfig: [LabelConfigDTO] = [
        LabelConfigDTO(name: "health", color: "blue"),
        LabelConfigDTO(name: "house", color: "orange"),
        LabelConfigDTO(name: "kids", color: "purple"),
        LabelConfigDTO(name: "ideas", color: "pink"),
    ]

    private static func quota(
        id: Int, title: String, rrule: String, current: Int, target: Int,
        labels: [String] = [], shortTitle: String? = nil
    ) -> TaskDTO {
        TaskDTO(
            id: id, title: title, rrule: rrule,
            progressTarget: target, progressCurrent: current,
            trackedFlag: true, labels: labels, shortTitle: shortTitle
        )
    }

    static let quotas: [TaskDTO] = [
        quota(id: 129, title: "High-Fiber Food (e.g. Bran, Oats)", rrule: "FREQ=WEEKLY", current: 0, target: 3),
        quota(id: 27, title: "Music Practice", rrule: "FREQ=WEEKLY", current: 2, target: 1, labels: ["kids"]),
        quota(id: 114, title: "Evening Shower", rrule: "FREQ=WEEKLY", current: 1, target: 2, labels: ["kids"]),
        quota(id: 152, title: "Charge jump starter", rrule: "FREQ=MONTHLY", current: 0, target: 1, labels: ["house", "finance"]),
        quota(id: 3307, title: "Check for new certifications — vendor academies, platform certs, automation credentials", rrule: "FREQ=WEEKLY", current: 0, target: 1, labels: ["ideas"]),
        quota(id: 309, title: "Clean earbuds + phone speakers", rrule: "FREQ=MONTHLY", current: 0, target: 1, labels: ["house"]),
        quota(id: 111, title: "Clean bedroom fans", rrule: "FREQ=MONTHLY", current: 0, target: 1, labels: ["house"]),
        quota(id: 276, title: "Clean the car seats", rrule: "FREQ=MONTHLY", current: 0, target: 1, labels: ["kids", "house"]),
        quota(id: 255, title: "Cook daily vegetables (incl. black beans)", rrule: "FREQ=WEEKLY", current: 3, target: 5, labels: ["health"]),
        quota(id: 83, title: "Daily Walks", rrule: "FREQ=DAILY", current: 1, target: 2, labels: ["health"]),
        quota(id: 192, title: "Empty the dishwasher (chore)", rrule: "FREQ=WEEKLY", current: 0, target: 5, labels: ["kids", "house"]),
        quota(id: 103, title: "Say something kind to someone every day", rrule: "FREQ=WEEKLY", current: 0, target: 2, labels: ["kids", "relationships"]),
        quota(id: 21829, title: "Iron-Rich Meal (e.g. lentils, spinach)", rrule: "FREQ=WEEKLY", current: 2, target: 2),
        quota(id: 116, title: "Green Vegetables", rrule: "FREQ=WEEKLY", current: 1, target: 3),
        quota(id: 193, title: "Protein Breakfast", rrule: "FREQ=WEEKLY", current: 0, target: 2),
        quota(id: 132, title: "Daily Supplements (Vit. D, maybe Omega-3, etc.)", rrule: "FREQ=WEEKLY", current: 0, target: 3, labels: ["health", "kids"]),
        quota(id: 163, title: "Balloon breathing practice (slow exhale, relaxed shoulders, breathe into the upper back, seated)", rrule: "FREQ=WEEKLY", current: 0, target: 4, labels: ["health", "kids"]),
        quota(id: 160, title: "Trail mix bites", rrule: "FREQ=WEEKLY", current: 0, target: 2),
        quota(id: 21771, title: "Play Catch in the Backyard", rrule: "FREQ=WEEKLY", current: 0, target: 1),
        quota(id: 605, title: "Play a card game after dinner", rrule: "FREQ=WEEKLY", current: 0, target: 1, labels: ["kids", "media"]),
        quota(id: 295, title: "Reset the router (power everything off for 10 sec)", rrule: "FREQ=MONTHLY", current: 0, target: 1, labels: ["house"]),
        quota(id: 23532, title: "Review book highlights", rrule: "FREQ=WEEKLY", current: 0, target: 1, labels: ["hub"]),
        quota(id: 23534, title: "Run the weekly maintenance checklist in a fresh chat", rrule: "FREQ=WEEKLY", current: 0, target: 1, labels: ["hub", "ai-added"]),
        quota(id: 221, title: "Weight Lift", rrule: "FREQ=WEEKLY", current: 2, target: 3, labels: ["health"]),
    ]
}
#endif
