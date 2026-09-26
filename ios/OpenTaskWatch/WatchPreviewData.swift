#if DEBUG
import Foundation

/// Realistic sample quotas, for the watch app's `#Preview`s only (DEBUG —
/// never in a shipped binary). Invented titles with the shape of a real
/// account on 2026-09-24 (every open `is_tracked` / `progress_target > 1`
/// task, and a `label_config`): the same counts, periods, labels, label
/// colors and title lengths. The long titles ("Look for new evening courses
/// — …", "Posture practice (…)") are the point: they are what a watch-width
/// row actually has to wrap. With `ios/Previews.local/` present
/// (`PreviewLocalData`, gitignored) the previews render that account data
/// instead.
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
            title: title, current: current, target: target, period: period, stripeColor: stripe,
            hasNotes: false
        )
    }

    /// Sample quota prompts, all prompting in Early morning (the default
    /// period) — or every prompt of the local data, when there is some.
    static let earlyMorningPrompts: [QuotaPromptDTO] = PreviewLocalData.reminderGroups?.flatMap(\.prompts) ?? [
        prompt(116, nil, "Oatmeal + Berries", 1, 3, "WEEKLY", nil),
        prompt(3307, nil, "Look for new evening courses — community colleges, library programs, weekend workshops", 0, 1, "WEEKLY", "pink"),
        prompt(276, nil, "Vacuum the car mats", 0, 1, "MONTHLY", "purple"),
        prompt(255, nil, "Bake bread from scratch (incl. sourdough)", 0, 5, "WEEKLY", "blue"),
        prompt(83, 1, "Piano Scales", 0, 2, "DAILY", "blue"),
        prompt(193, nil, "Figs", 1, 2, "WEEKLY", nil),
        prompt(129, nil, "Whole grains (ie brown rice)", 1, 3, "WEEKLY", nil),
        prompt(192, nil, "Sort the recycling (chore)", 0, 5, "WEEKLY", "purple"),
        prompt(21400, nil, "Citrus Snack (e.g. oranges, clementines)", 0, 2, "WEEKLY", nil),
        prompt(163, nil, "Posture practice (tall spine, soft jaw, shoulders down and back, feet flat on the floor, seated)", 0, 4, "WEEKLY", "blue"),
        prompt(239, nil, "Home-cooked soup (ie minestrone)", 0, 2, "WEEKLY", nil),
        prompt(258, nil, "Green smoothie (+ginger)", 0, 2, "WEEKLY", "blue"),
        prompt(132, nil, "Evening tea ( Chamomile, Peppermint )", 1, 3, "WEEKLY", "blue"),
        prompt(13, nil, "Bike ride (+neighbors)", 1, 4, "WEEKLY", nil),
        prompt(118, nil, "Guitar class", 1, 2, "WEEKLY", nil),
        prompt(160, nil, "Yogurt parfait", 1, 3, "WEEKLY", nil),
    ]

    /// Early morning as the page shows it: the slot's last two reminders,
    /// then the sixteen prompts. Three prompts `handled` to show they leave
    /// the list: Piano Scales did (1/2), two considered.
    static func reminderGroups(handled: [String: Bool] = [:]) -> [ReminderGroupDTO] {
        if let local = PreviewLocalData.reminderGroups {
            return local.map { g in
                g.replacingPrompts(g.prompts.map { p in handled[p.promptKey].map { p.handled(did: $0) } ?? p })
            }
        }
        let early = ReminderGroupDTO(
            slot: TimeSlotDTO(id: 11, label: "Early morning", startTime: "07:00"),
            reminders: [
                TaskDTO(id: 223, title: "Sit tall at the desk and let the shoulders drop and relax", isReminder: true),
                TaskDTO(id: 23432, title: "Open blinds (morning)", isReminder: true),
            ],
            considered: 6,
            prompts: earlyMorningPrompts.map { p in handled[p.promptKey].map { p.handled(did: $0) } ?? p }
        )
        let morning = ReminderGroupDTO(
            slot: TimeSlotDTO(id: 12, label: "Morning", startTime: "09:00"),
            reminders: [TaskDTO(id: 2226, title: "Check the team inbox", priority: 2, isReminder: true)],
            prompts: [prompt(83, 2, "Piano Scales", 0, 2, "DAILY", "blue")]
        )
        return [early, morning]
    }

    static let labelConfig: [LabelConfigDTO] = PreviewLocalData.labelConfig ?? [
        LabelConfigDTO(name: "health", color: "blue"),
        LabelConfigDTO(name: "house", color: "orange"),
        LabelConfigDTO(name: "family", color: "purple"),
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

    static let quotas: [TaskDTO] = PreviewLocalData.openTasks?.filter(\.isTracked) ?? [
        quota(id: 129, title: "Whole-Grain Meal (e.g. Rice, Barley)", rrule: "FREQ=WEEKLY", current: 0, target: 3),
        quota(id: 27, title: "Sketchbook Time", rrule: "FREQ=WEEKLY", current: 2, target: 1, labels: ["family"]),
        quota(id: 114, title: "Evening Tidy-up", rrule: "FREQ=WEEKLY", current: 1, target: 2, labels: ["family"]),
        quota(id: 152, title: "Check the smoke alarm", rrule: "FREQ=MONTHLY", current: 0, target: 1, labels: ["house", "finance"]),
        quota(id: 3307, title: "Look for new evening courses — community colleges, library programs, weekend workshops", rrule: "FREQ=WEEKLY", current: 0, target: 1, labels: ["ideas"]),
        quota(id: 309, title: "Wipe keyboard + mouse + screen", rrule: "FREQ=MONTHLY", current: 0, target: 1, labels: ["house"]),
        quota(id: 111, title: "Dust the bookshelf", rrule: "FREQ=MONTHLY", current: 0, target: 1, labels: ["house"]),
        quota(id: 276, title: "Vacuum the car mats", rrule: "FREQ=MONTHLY", current: 0, target: 1, labels: ["family", "house"]),
        quota(id: 255, title: "Bake bread from scratch (incl. sourdough)", rrule: "FREQ=WEEKLY", current: 3, target: 5, labels: ["health"]),
        quota(id: 83, title: "Piano Scales", rrule: "FREQ=DAILY", current: 1, target: 2, labels: ["health"]),
        quota(id: 192, title: "Sort the recycling (chore)", rrule: "FREQ=WEEKLY", current: 0, target: 5, labels: ["family", "house"]),
        quota(id: 103, title: "Send a thank-you note to someone this week", rrule: "FREQ=WEEKLY", current: 0, target: 2, labels: ["family", "social"]),
        quota(id: 21829, title: "Citrus Snack (e.g. oranges, clementines)", rrule: "FREQ=WEEKLY", current: 2, target: 2),
        quota(id: 116, title: "Fresh Fruit Bowl", rrule: "FREQ=WEEKLY", current: 1, target: 3),
        quota(id: 193, title: "Hearty Breakfast", rrule: "FREQ=WEEKLY", current: 0, target: 2),
        quota(id: 132, title: "Evening Herbal Tea (Chamomile, maybe Mint, etc.)", rrule: "FREQ=WEEKLY", current: 0, target: 3, labels: ["health", "family"]),
        quota(id: 163, title: "Posture practice (tall spine, soft jaw, shoulders down and back, feet flat on the floor, seated)", rrule: "FREQ=WEEKLY", current: 0, target: 4, labels: ["health", "family"]),
        quota(id: 160, title: "Yogurt parfait", rrule: "FREQ=WEEKLY", current: 0, target: 2),
        quota(id: 21771, title: "Frisbee Toss at the Park", rrule: "FREQ=WEEKLY", current: 0, target: 1),
        quota(id: 605, title: "Do a jigsaw puzzle after dinner", rrule: "FREQ=WEEKLY", current: 0, target: 1, labels: ["family", "media"]),
        quota(id: 295, title: "Flush the water heater (drain a gallon from the valve)", rrule: "FREQ=MONTHLY", current: 0, target: 1, labels: ["house"]),
        quota(id: 23532, title: "Review saved articles", rrule: "FREQ=WEEKLY", current: 0, target: 1, labels: ["admin"]),
        quota(id: 23534, title: "Run the weekly backup check on the external drive", rrule: "FREQ=WEEKLY", current: 0, target: 1, labels: ["admin", "ai-added"]),
        quota(id: 221, title: "Rowing Sets", rrule: "FREQ=WEEKLY", current: 2, target: 3, labels: ["health"]),
    ]
}
#endif
