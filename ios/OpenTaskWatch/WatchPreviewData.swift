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
        labels: [String] = [], shortTitle: String? = nil, interval: Int? = nil, ends: String? = nil
    ) -> TaskDTO {
        TaskDTO(
            id: id, title: title, rrule: rrule,
            progressTarget: target, progressCurrent: current,
            trackedFlag: true, labels: labels, shortTitle: shortTitle,
            periodInterval: interval, periodLabel: ends
        )
    }

    static let quotas: [TaskDTO] = PreviewLocalData.openTasks?.filter(\.isTracked) ?? [
        quota(id: 129, title: "Whole-Grain Meal (e.g. Rice, Barley)", rrule: "FREQ=WEEKLY", current: 0, target: 3),
        quota(id: 27, title: "Sketchbook Time", rrule: "FREQ=WEEKLY", current: 2, target: 1, labels: ["family"]),
        quota(id: 114, title: "Evening Tidy-up", rrule: "FREQ=WEEKLY", current: 1, target: 2, labels: ["family"]),
        quota(id: 152, title: "Check the smoke alarm", rrule: "FREQ=MONTHLY", current: 0, target: 1, labels: ["house", "finance"]),
        quota(id: 3307, title: "Look for new evening courses — community colleges, library programs, weekend workshops", rrule: "FREQ=WEEKLY", current: 0, target: 1, labels: ["ideas"]),
        quota(id: 309, title: "Wipe keyboard + mouse + screen", rrule: "FREQ=MONTHLY", current: 0, target: 1, labels: ["house"]),
        // An interval quota (2026-10-16): "Every 2 weeks", its row saying its end.
        quota(id: 24001, title: "Deep-clean the oven", rrule: "FREQ=WEEKLY;INTERVAL=2", current: 0, target: 1, labels: ["house"], interval: 2, ends: "by Oct 24"),
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

    /// Task segments (2026-10-10) — invented titles: a Days segment with a
    /// pulled-in Weeks task, a future target and a deadline.
    static var taskSegments: [TaskSegmentDTO] {
        let day: TimeInterval = 24 * 60 * 60
        let soon = DateHelpers.formatISO(Date().addingTimeInterval(3 * day))
        let deadline = DateHelpers.formatISO(Date().addingTimeInterval(6 * day))
        let tomorrow = DateHelpers.formatISO(Date().addingTimeInterval(day))
        return [
            TaskSegmentDTO(horizon: "days", tasks: [
                SegmentTaskDTO(task: TaskDTO(id: 9101, title: "Call the insurance office about the renewal letter", priority: 3, horizon: "days"), state: .waiting),
                SegmentTaskDTO(task: TaskDTO(id: 9102, title: "Fix the squeaky gate hinge", dueAt: soon, horizon: "days"), state: .waiting),
                SegmentTaskDTO(task: TaskDTO(id: 9103, title: "Book the dentist for the kids", deadlineAt: deadline, horizon: "weeks"), state: .waiting),
                SegmentTaskDTO(task: TaskDTO(id: 9104, title: "Return the library books", horizon: "days"), state: .considered),
            ]),
            // Upcoming (2026-10-12), after Days: a one-off with a deadline
            // and a repeating task — target dates, never a horizon word.
            // In its two sections since 2026-10-26: the one due tomorrow in
            // Tomorrow (its time alone), the other in Later.
            TaskSegmentDTO(horizon: "upcoming", tasks: [
                SegmentTaskDTO(task: TaskDTO(id: 9301, title: "Renew the car registration", priority: 2, dueAt: tomorrow, deadlineAt: deadline, horizon: "weeks"), state: .waiting, recurring: false, upcomingSection: .tomorrow),
                SegmentTaskDTO(task: TaskDTO(id: 9302, title: "Water the balcony plants", dueAt: soon, rrule: "FREQ=DAILY;INTERVAL=3"), state: .waiting, recurring: true, upcomingSection: .later),
            ]),
        ]
    }

    /// Upcoming with nothing for tomorrow (2026-10-26): "Tomorrow  0 of 0 ✓"
    /// and "Nothing today ✓", then Later's row.
    static var upcomingTomorrowEmpty: TaskSegmentDTO {
        let soon = DateHelpers.formatISO(Date().addingTimeInterval(3 * 24 * 60 * 60))
        return TaskSegmentDTO(horizon: "upcoming", tasks: [
            SegmentTaskDTO(task: TaskDTO(id: 9302, title: "Water the balcony plants", dueAt: soon, rrule: "FREQ=DAILY;INTERVAL=3"), state: .waiting, recurring: true, upcomingSection: .later),
        ])
    }

    /// The Tasks page's row corner (2026-10-16) — invented titles: "!!" and
    /// "!", Medium/Low with no mark, the horizon dot on deadline tasks on
    /// their automatic target (Days beside "!", Months beside "!!",
    /// Eventually, unset), and a High task 3× over target.
    static var cornerTasks: [TaskDTO] {
        let calendar = Calendar.current
        func at(days: Int = 0, _ hour: Int) -> String {
            let base = calendar.date(byAdding: .day, value: days, to: Date()) ?? Date()
            return DateHelpers.formatISO(calendar.date(bySettingHour: hour, minute: 0, second: 0, of: base) ?? base)
        }
        func auto(_ id: Int, _ title: String, priority: Int, hour: Int, horizon: String?) -> TaskDTO {
            TaskDTO(
                id: id, projectId: 2, title: title, priority: priority, dueAt: at(days: 1, hour),
                deadlineAt: at(days: 4, 17), horizon: horizon, targetAuto: true
            )
        }
        return [
            TaskDTO(id: 9501, projectId: 1, title: "Send the signed contract back", priority: 3, dueAt: at(days: -3, 8), attempts: 3, attemptsLabel: "3×"),
            TaskDTO(id: 9502, projectId: 1, title: "Renew the domain", priority: 4, dueAt: at(days: 1, 9)),
            TaskDTO(id: 9503, projectId: 2, title: "Order new printer ink", priority: 2, dueAt: at(days: 1, 10)),
            TaskDTO(id: 9504, projectId: 2, title: "Look up the library hours", priority: 1, dueAt: at(days: 1, 11)),
            auto(9505, "File the dishwasher warranty claim", priority: 3, hour: 12, horizon: "days"),
            auto(9506, "Pay the parking fine", priority: 4, hour: 13, horizon: "months"),
            auto(9507, "Sort the photo backups", priority: 0, hour: 14, horizon: "eventually"),
            auto(9508, "Return the borrowed ladder", priority: 0, hour: 15, horizon: nil),
        ]
    }

    /// The night rule's due lines (2026-10-26), drawn with a 3:00 AM day
    /// start (the preview seeds it) after 3:00 AM: last night's 1:00 AM
    /// ("Last night 1:00 AM"), tonight's (the time alone), tomorrow night's
    /// ("Tomorrow night 1:30 AM"), a later night ("Fri night 12:30 AM").
    static var nightTasks: [TaskDTO] {
        let calendar = Calendar.current
        func at(days: Int, _ hour: Int, _ minute: Int = 0) -> String {
            let base = calendar.date(byAdding: .day, value: days, to: Date()) ?? Date()
            return DateHelpers.formatISO(calendar.date(bySettingHour: hour, minute: minute, second: 0, of: base) ?? base)
        }
        return [
            TaskDTO(id: 9601, projectId: 1, title: "Join the late call", priority: 1, dueAt: at(days: 0, 1)),
            TaskDTO(id: 9602, projectId: 2, title: "Check the backup ran", priority: 1, dueAt: at(days: 1, 1)),
            TaskDTO(id: 9603, projectId: 2, title: "Meet the airport shuttle", priority: 1, dueAt: at(days: 2, 1, 30)),
            TaskDTO(id: 9604, projectId: 1, title: "Submit the timesheet", priority: 1, dueAt: at(days: 4, 0, 30)),
        ]
    }

    static let cornerProjects: [ProjectDTO] = [
        ProjectDTO(id: 1, name: "Work", color: "red"),
        ProjectDTO(id: 2, name: "Home", color: "blue"),
    ]
}
#endif
