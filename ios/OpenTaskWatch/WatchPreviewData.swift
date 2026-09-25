#if DEBUG
import Foundation

/// Trent's REAL quotas, for the watch app's `#Preview`s only (DEBUG — never in
/// a shipped binary). Read-only snapshot of prod (user 1, every open
/// `is_tracked` / `progress_target > 1` task) taken 2026-09-24, plus his real
/// `label_config`. The long titles ("Check for new certifications — …",
/// "Kids all blow up balloon (…)") are why this is real data and not a tidy
/// sample: they are what a watch-width row actually has to wrap.
///
/// Same approach as the Smart Stack widget's `ReminderStackPreviewData`
/// (which lives in the widget extension and so can't be reached from here).
enum WatchPreviewData {
    // MARK: Reminders page — quota prompts (2026-09-24)

    private static func prompt(
        _ taskId: Int, _ number: Int?, _ title: String, _ current: Int, _ target: Int,
        _ period: String?, _ stripe: String?
    ) -> QuotaPromptDTO {
        QuotaPromptDTO(
            promptKey: "q:\(taskId):\(number ?? 0):2026-09-24", taskId: taskId, number: number,
            title: title, current: current, target: target, period: period, stripeColor: stripe
        )
    }

    /// His REAL quota prompts (read-only from the dev server, his prod
    /// snapshot with PR #79's prompts on), where they all prompt in Early
    /// morning.
    static let earlyMorningPrompts: [QuotaPromptDTO] = [
        prompt(116, nil, "Broccoli Avocado", 1, 3, "WEEKLY", nil),
        prompt(3307, nil, "Check for new certifications — Anthropic Skilljar, platform certs, business automation credentials, cowork, automation", 0, 1, "WEEKLY", "pink"),
        prompt(276, nil, "Clean car seat for Owen", 0, 1, "MONTHLY", "purple"),
        prompt(255, nil, "Cook daily vegetables (incl. black beans)", 0, 5, "WEEKLY", "blue"),
        prompt(83, 1, "Daily Walks", 0, 2, "DAILY", "blue"),
        prompt(193, nil, "Eggs", 1, 2, "WEEKLY", nil),
        prompt(129, nil, "Grinding food (ie bran cereal)", 1, 3, "WEEKLY", nil),
        prompt(192, nil, "Josie clean dishes (chore)", 0, 5, "WEEKLY", "purple"),
        prompt(21400, nil, "Kid's Iron Meal (e.g. ground beef, steak)", 0, 2, "WEEKLY", nil),
        prompt(163, nil, "Kids all blow up balloon (teach josie PRI position + breathing into upper back, seated?)", 0, 4, "WEEKLY", "blue"),
        prompt(239, nil, "Kids eat hard cereal (ie grape nuts)", 0, 2, "WEEKLY", nil),
        prompt(258, nil, "Kids Smoothie (+Owen omega-3)", 0, 2, "WEEKLY", "blue"),
        prompt(132, nil, "Kids supplements ( Vitamin D, Omega-3 )", 1, 3, "WEEKLY", "blue"),
        prompt(13, nil, "Owen (+Kids) Playground", 1, 4, "WEEKLY", nil),
        prompt(118, nil, "Owen Swim", 1, 2, "WEEKLY", nil),
        prompt(160, nil, "Peanut butter bites", 1, 3, "WEEKLY", nil),
    ]

    /// Early morning as the page shows it: his two last real reminders of
    /// the slot, then the sixteen prompts. Three prompts `handled` to show
    /// they leave the list: Daily Walks did (1/2), two considered.
    static func reminderGroups(handled: [String: Bool] = [:]) -> [ReminderGroupDTO] {
        let early = ReminderGroupDTO(
            slot: TimeSlotDTO(id: 11, label: "Early morning", startTime: "07:00"),
            reminders: [
                TaskDTO(id: 223, title: "Walk and move in a way that pumps blood to the pelvis", isReminder: true),
                TaskDTO(id: 23432, title: "Cold Shower (Naval)", isReminder: true),
            ],
            considered: 6,
            prompts: earlyMorningPrompts.map { p in handled[p.promptKey].map { p.handled(did: $0) } ?? p }
        )
        let morning = ReminderGroupDTO(
            slot: TimeSlotDTO(id: 12, label: "Morning", startTime: "09:00"),
            reminders: [TaskDTO(id: 2226, title: "Check GitHub issues", priority: 2, isReminder: true)],
            prompts: [prompt(83, 2, "Daily Walks", 0, 2, "DAILY", "blue")]
        )
        return [early, morning]
    }

    static let labelConfig: [LabelConfigDTO] = [
        LabelConfigDTO(name: "health", color: "blue"),
        LabelConfigDTO(name: "house", color: "orange"),
        LabelConfigDTO(name: "kids", color: "purple"),
        LabelConfigDTO(name: "job-hunt", color: "pink"),
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
        quota(id: 129, title: "All Kids Grinding Food (e.g. Bran, Grape Nuts)", rrule: "FREQ=WEEKLY", current: 0, target: 3),
        quota(id: 27, title: "All Kids Kazoo", rrule: "FREQ=WEEKLY", current: 2, target: 1, labels: ["kids"]),
        quota(id: 114, title: "All Kids Shower", rrule: "FREQ=WEEKLY", current: 1, target: 2, labels: ["kids"]),
        quota(id: 152, title: "Charge jump starter", rrule: "FREQ=MONTHLY", current: 0, target: 1, labels: ["house", "finance"]),
        quota(id: 3307, title: "Check for new certifications — Anthropic Skilljar, platform certs, business automation credentials, cowork, automation", rrule: "FREQ=WEEKLY", current: 0, target: 1, labels: ["job-hunt"]),
        quota(id: 309, title: "Clean AirPods + Phone Speakers", rrule: "FREQ=MONTHLY", current: 0, target: 1, labels: ["house"]),
        quota(id: 111, title: "Clean bedroom fans", rrule: "FREQ=MONTHLY", current: 0, target: 1, labels: ["house"]),
        quota(id: 276, title: "Clean car seat for Owen", rrule: "FREQ=MONTHLY", current: 0, target: 1, labels: ["kids", "house"]),
        quota(id: 255, title: "Cook daily vegetables (incl. black beans)", rrule: "FREQ=WEEKLY", current: 3, target: 5, labels: ["health"]),
        quota(id: 83, title: "Daily Walks", rrule: "FREQ=DAILY", current: 1, target: 2, labels: ["health"]),
        quota(id: 192, title: "Josie clean dishes (chore)", rrule: "FREQ=WEEKLY", current: 0, target: 5, labels: ["kids", "house"]),
        quota(id: 103, title: "Kel + I compliment each other in front of kids", rrule: "FREQ=WEEKLY", current: 0, target: 2, labels: ["kids", "relationships"]),
        quota(id: 21829, title: "Kid's Iron Meal (e.g. ground beef, steak)", rrule: "FREQ=WEEKLY", current: 2, target: 2),
        quota(id: 116, title: "Kids Eat Broccoli", rrule: "FREQ=WEEKLY", current: 1, target: 3),
        quota(id: 193, title: "Kids Eggs", rrule: "FREQ=WEEKLY", current: 0, target: 2),
        quota(id: 132, title: "Kids Supplements (Vit. D, maybe Omega-3, etc.)", rrule: "FREQ=WEEKLY", current: 0, target: 3, labels: ["health", "kids"]),
        quota(id: 163, title: "Kids all blow up balloon (teach josie PRI position + breathing into upper back, seated?)", rrule: "FREQ=WEEKLY", current: 0, target: 4, labels: ["health", "kids"]),
        quota(id: 160, title: "Peanut butter bites", rrule: "FREQ=WEEKLY", current: 0, target: 2),
        quota(id: 21771, title: "Play Catch With All Three Kids", rrule: "FREQ=WEEKLY", current: 0, target: 1),
        quota(id: 605, title: "Play poker or another card game with Josie", rrule: "FREQ=WEEKLY", current: 0, target: 1, labels: ["kids", "media"]),
        quota(id: 295, title: "Reset Router+Modem (just power off everything for 10sec)", rrule: "FREQ=MONTHLY", current: 0, target: 1, labels: ["house"]),
        quota(id: 23532, title: "Review audiobook highlights", rrule: "FREQ=WEEKLY", current: 0, target: 1, labels: ["hub"]),
        quota(id: 23534, title: "Run the card maintenance skill (/maintenance:cards) in a fresh chat", rrule: "FREQ=WEEKLY", current: 0, target: 1, labels: ["hub", "ai-added"]),
        quota(id: 221, title: "Weight Lift", rrule: "FREQ=WEEKLY", current: 2, target: 3, labels: ["health"]),
    ]
}
#endif
