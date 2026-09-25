#if DEBUG
import SwiftUI
import WidgetKit

/// Trent's REAL data, for `#Preview`s only (DEBUG — never in a shipped
/// binary, never in the widget gallery, which uses `ReminderStackPlaceholder`).
///
/// Read-only snapshot of prod (user 1) taken 2026-09-24 ~08:55 CDT: his five
/// time slots, today's reminders grouped the way `GET /api/reminders` groups
/// them (`getRemindersBySlot`: by slot, priority desc then id), and his
/// soonest-due open tasks. Nothing was overdue at snapshot time, so the
/// overdue states use his two real High tasks due today (23533 at 9:00 AM,
/// 22067 at 5:00 PM CDT) viewed from 5:30 PM, when both are.
///
/// Each state is the REAL builder (`ReminderStackTimeline.entry`) run at a
/// fixed instant, so a preview exercises the same slot/overdue/position logic
/// the live widget does — not a hand-built entry that could drift from it.
enum ReminderStackPreviewData {
    static let slots: [TimeSlotDTO] = [
        TimeSlotDTO(id: 11, label: "Early morning", startTime: "07:00"),
        TimeSlotDTO(id: 12, label: "Morning", startTime: "09:00"),
        TimeSlotDTO(id: 13, label: "Midday", startTime: "12:00"),
        TimeSlotDTO(id: 14, label: "Afternoon", startTime: "16:00"),
        TimeSlotDTO(id: 15, label: "Evening", startTime: "20:30"),
    ]

    private static func reminder(_ id: Int, _ title: String, priority: Int = 0) -> TaskDTO {
        TaskDTO(id: id, title: title, priority: priority, isReminder: true)
    }

    /// Leads with 24, which he had already considered at snapshot time — the
    /// `considered:` counts below take reminders off the FRONT of each list.
    static let earlyMorning: [TaskDTO] = [
        reminder(24, "Yesterday = Lesson, Tomorrow = Plan, Today = Practice"),
        reminder(604, "Supplements ( Vitamin C, Zinc, Magnesium )", priority: 2),
        reminder(64, "Learning a physical skill needs a feedback loop: watch, listen and adjust while doing it, so the thinking part of the brain can guide the body. Record, review, repeat, and notice what changed each time. (That is how practice turns into progress, one small correction at a time.) Keep sessions short and specific."),
        reminder(168, "Skin care (Cleanse, Moisturize, SPF)"),
        reminder(208, "Think of improvement as fun to see what’s possible?"),
        reminder(218, "Good form uses the full body to accomplish the task"),
        reminder(223, "Walk and move in a way that keeps the whole body loose"),
        reminder(23432, "Cold Shower (morning)"),
    ]

    static let morning: [TaskDTO] = [
        reminder(2226, "Check GitHub issues", priority: 2),
        reminder(126, "Do my mobility"),
        reminder(183, "Mixed Nuts + Pumpkin Seeds"),
        reminder(197, "Eye rest (Relax into it, hold it steady — good for presence)"),
        reminder(215, "Wall pushups"),
    ]

    static let midday: [TaskDTO] = [
        reminder(2247, "Check all public profile pages", priority: 2),
        reminder(38, "Is the vinegar rinse still working"),
        reminder(146, "Chess puzzle training"),
        reminder(23393, "Stretch break (optional)"),
    ]

    static let afternoon: [TaskDTO] = [
        reminder(12, "Being patient is a much happier way to live/be"),
        reminder(127, "Remember to enjoy the day (“am I enjoying my day?”, “what am I going to do to enjoy my day?”)"),
        reminder(150, "Make sure there is a team sport or a hand-eye coordination activity on the calendar"),
        reminder(222, "“Do the small things well, and the big things take care of themselves.”"),
    ]

    static let evening: [TaskDTO] = [
        reminder(41, "Laundry fold"),
        reminder(44, "Journaling before bed might help clear the mind at night"),
        reminder(70, "Timed breathing to slow down (use app)"),
        reminder(94, "Neck stretch (posture)"),
        reminder(136, "Surround myself with good books and thoughtful people. Read books, listen to podcasts, play strategy games — whatever it takes. Provides learning + mindset reinforcement"),
        reminder(273, "Evening stretch routine (after mobility) (finish with a long hold)"),
        reminder(3093, "Ask myself: “What went well today?”"),
    ]

    private static func prompt(
        _ taskId: Int, _ number: Int?, _ title: String, _ current: Int, _ target: Int,
        _ period: String?, _ stripe: String?
    ) -> QuotaPromptDTO {
        QuotaPromptDTO(
            promptKey: "q:\(taskId):\(number ?? 0):2026-09-24", taskId: taskId, number: number,
            title: title, current: current, target: target, period: period, stripeColor: stripe
        )
    }

    /// His REAL quota prompts (quota reminders, 2026-09-24 — read-only from
    /// the dev server, his prod snapshot with PR #79 on): every unmet quota
    /// prompts in Early morning there; Daily Walks (daily, target 2) has its
    /// #1 here and its #2 in Morning.
    static let earlyMorningPrompts: [QuotaPromptDTO] = [
        prompt(116, nil, "Broccoli Avocado", 1, 3, "WEEKLY", nil),
        prompt(3307, nil, "Check for new certifications — vendor academies, platform certs, automation credentials", 0, 1, "WEEKLY", "pink"),
        prompt(276, nil, "Clean the car seats", 0, 1, "MONTHLY", "purple"),
        prompt(255, nil, "Cook daily vegetables (incl. black beans)", 0, 5, "WEEKLY", "blue"),
        prompt(83, 1, "Daily Walks", 0, 2, "DAILY", "blue"),
        prompt(193, nil, "Eggs", 1, 2, "WEEKLY", nil),
        prompt(129, nil, "Fiber food (ie bran cereal)", 1, 3, "WEEKLY", nil),
        prompt(192, nil, "Empty the dishwasher (chore)", 0, 5, "WEEKLY", "purple"),
        prompt(21400, nil, "Iron-Rich Meal (e.g. lentils, spinach)", 0, 2, "WEEKLY", nil),
        prompt(163, nil, "Balloon breathing practice (slow exhale, relaxed shoulders, breathe into the upper back, seated)", 0, 4, "WEEKLY", "blue"),
        prompt(239, nil, "High-fiber cereal (ie bran flakes)", 0, 2, "WEEKLY", nil),
        prompt(258, nil, "Fruit smoothie (+omega-3)", 0, 2, "WEEKLY", "blue"),
        prompt(132, nil, "Daily supplements ( Vitamin D, Omega-3 )", 1, 3, "WEEKLY", "blue"),
        prompt(13, nil, "Park trip (+friends)", 1, 4, "WEEKLY", nil),
        prompt(118, nil, "Swim lessons", 1, 2, "WEEKLY", nil),
        prompt(160, nil, "Trail mix bites", 1, 3, "WEEKLY", nil),
    ]

    /// His soonest-due open tasks (not reminders, not quotas).
    static let tasks: [TaskDTO] = [
        TaskDTO(id: 23533, title: "Check if anyone is waiting on me", priority: 3, dueAt: "2026-09-24T14:00:00.000Z"),
        TaskDTO(id: 22067, title: "Email the club leader about the youth program before the Oct 1 meeting", priority: 3, dueAt: "2026-09-24T22:00:00.000Z"),
        TaskDTO(id: 22793, title: "Dark chocolate", priority: 2, dueAt: "2026-09-25T01:30:00.000Z"),
        TaskDTO(id: 292, title: "Weekly allowance ($8)", priority: 2, dueAt: "2026-09-25T21:00:00.000Z"),
    ]

    /// Today's groups with the first `considered[slotId]` reminders of each
    /// slot already checked off — how the day looks at a given moment.
    ///
    /// `promptsHandled`: every quota prompt already considered — for the
    /// states whose story predates prompts (caught up, overdue).
    static func groups(considered: [Int: Int] = [:], promptsHandled: Bool = false) -> [ReminderGroupDTO] {
        let bySlot: [(TimeSlotDTO, [TaskDTO])] = [
            (slots[0], earlyMorning), (slots[1], morning), (slots[2], midday),
            (slots[3], afternoon), (slots[4], evening),
        ]
        let prompts: [Int: [QuotaPromptDTO]] = [
            11: earlyMorningPrompts,
            12: [prompt(83, 2, "Daily Walks", 0, 2, "DAILY", "blue")],
        ]
        return bySlot.map { slot, all in
            let done = min(considered[slot.id] ?? 0, all.count)
            return ReminderGroupDTO(
                slot: slot, reminders: Array(all.dropFirst(done)),
                considered: done, consideredItems: Array(all.prefix(done)),
                prompts: (prompts[slot.id] ?? []).map { promptsHandled ? $0.handled(did: false) : $0 }
            )
        } + [ReminderGroupDTO(slot: nil, reminders: [], prompts: [])]
    }

    /// 2026-09-24 at `hour:minute`, device-local (the previews assume the
    /// Mac is on Trent's Central time, as the snapshot was).
    static func at(_ hour: Int, _ minute: Int = 0) -> Date {
        Calendar.current.date(from: DateComponents(year: 2026, month: 9, day: 24, hour: hour, minute: minute))
            ?? Date()
    }

    static func entry(
        _ groups: [ReminderGroupDTO], tasks: [TaskDTO] = [], at date: Date,
        skipped: Set<String> = [], snooze: WatchWidgetState.SnoozeResult? = nil
    ) -> WatchWidgetEntry {
        ReminderStackTimeline.entry(
            groups: groups, tasks: tasks, skipped: { _ in skipped }, pendingDone: [],
            snoozeResult: snooze, slots: slots, at: date
        )
    }

    // MARK: The states

    /// Trent's exact complaint screenshot, redone: Early morning, one
    /// considered, "Supplements ( Vitamin C, Zinc, Magnesium )" next.
    static let supplements = entry(groups(considered: [11: 1]), at: at(8, 47))
    /// The very long one ("Learning a physical skill needs…") after ✓ on
    /// Supplements.
    static let longReminder = entry(groups(considered: [11: 2]), at: at(8, 50))
    /// The same long one as the slot's LAST item (no ⏭) — every other Early
    /// morning reminder considered, as if the rest were ✓'d or skipped past.
    static let longLast = entry(
        [ReminderGroupDTO(
            slot: slots[0], reminders: [earlyMorning[2]], considered: 7,
            consideredItems: earlyMorning.enumerated().filter { $0.offset != 2 }.map(\.element),
            prompts: []
        )] + groups(considered: [11: 8]).dropFirst(),
        at: at(8, 58)
    )
    /// Quota prompts (2026-09-24). Every Early morning reminder considered,
    /// so the slot's prompts take the card in turn: the first, a short one.
    static let promptShort = entry(groups(considered: [11: 8]), at: at(8, 52))
    /// Skipped along to his longest quota title ("Check for new
    /// certifications — …"), the text-fit stress case with the ☐ column.
    static let promptLong = entry(
        groups(considered: [11: 8]), at: at(8, 52), skipped: ["q:116:0:2026-09-24"]
    )
    /// Skipped to "Cook daily vegetables (incl. black beans) · 0/5".
    static let promptVegetables = entry(
        groups(considered: [11: 8]), at: at(8, 52),
        skipped: ["q:116:0:2026-09-24", "q:3307:0:2026-09-24", "q:276:0:2026-09-24"]
    )
    /// Skipped to "Clean the car seats" — a MONTHLY count ("0/1 mo").
    static let promptMonthly = entry(
        groups(considered: [11: 8]), at: at(8, 52),
        skipped: ["q:116:0:2026-09-24", "q:3307:0:2026-09-24"]
    )
    /// Skipped to "Daily Walks" #1 — a DAILY count ("0/2 today").
    static let promptDaily = entry(
        groups(considered: [11: 8]), at: at(8, 52),
        skipped: ["q:116:0:2026-09-24", "q:3307:0:2026-09-24", "q:276:0:2026-09-24", "q:255:0:2026-09-24"]
    )
    /// A short one: Morning just opened.
    static let shortReminder = entry(groups(considered: [11: 8]), at: at(9, 2))
    /// Last item in a slot: Midday with three of four considered.
    static let lastInSlot = entry(groups(considered: [11: 8, 12: 5, 13: 3]), at: at(12, 40))
    /// Everything started is done; Afternoon is next.
    static let caughtUp = entry(groups(considered: [11: 8, 12: 5, 13: 4], promptsHandled: true), at: at(13, 15))
    /// 5:30 PM: both of today's High tasks are overdue — the card takes over.
    static let overdue = entry(groups(considered: [11: 8, 12: 5, 13: 4, 14: 1]), tasks: tasks, at: at(17, 30))
    /// Right after "Snooze all → Evening": the server's real counts for that
    /// set (both High, nothing lower overdue, so both move — High is swept
    /// once nothing lower is left).
    static let snoozed = entry(
        groups(considered: [11: 8, 12: 5, 13: 4, 14: 1]), tasks: tasks, at: at(17, 31),
        snooze: .init(at: at(17, 31), tasksAffected: 2, snoozedHigh: 2, skippedHigh: 0, skippedUrgent: 0, targetLabel: "Evening")
    )
}

#Preview("Supplements (the complaint)", as: .accessoryRectangular) {
    ReminderStackWidget()
} timeline: {
    ReminderStackPreviewData.supplements
}

#Preview("Very long reminder", as: .accessoryRectangular) {
    ReminderStackWidget()
} timeline: {
    ReminderStackPreviewData.longReminder
}

#Preview("Very long, last in slot", as: .accessoryRectangular) {
    ReminderStackWidget()
} timeline: {
    ReminderStackPreviewData.longLast
}

#Preview("Prompt — short", as: .accessoryRectangular) {
    ReminderStackWidget()
} timeline: {
    ReminderStackPreviewData.promptShort
}

#Preview("Prompt — longest title", as: .accessoryRectangular) {
    ReminderStackWidget()
} timeline: {
    ReminderStackPreviewData.promptLong
}

#Preview("Prompt — vegetables", as: .accessoryRectangular) {
    ReminderStackWidget()
} timeline: {
    ReminderStackPreviewData.promptVegetables
}

#Preview("Prompt — monthly", as: .accessoryRectangular) {
    ReminderStackWidget()
} timeline: {
    ReminderStackPreviewData.promptMonthly
}

#Preview("Prompt — daily", as: .accessoryRectangular) {
    ReminderStackWidget()
} timeline: {
    ReminderStackPreviewData.promptDaily
}

#Preview("Short reminder", as: .accessoryRectangular) {
    ReminderStackWidget()
} timeline: {
    ReminderStackPreviewData.shortReminder
}

#Preview("Last in slot", as: .accessoryRectangular) {
    ReminderStackWidget()
} timeline: {
    ReminderStackPreviewData.lastInSlot
}

#Preview("All caught up", as: .accessoryRectangular) {
    ReminderStackWidget()
} timeline: {
    ReminderStackPreviewData.caughtUp
}

#Preview("Overdue", as: .accessoryRectangular) {
    ReminderStackWidget()
} timeline: {
    ReminderStackPreviewData.overdue
}

#Preview("Snoozed", as: .accessoryRectangular) {
    ReminderStackWidget()
} timeline: {
    ReminderStackPreviewData.snoozed
}

#Preview("Signed out", as: .accessoryRectangular) {
    ReminderStackWidget()
} timeline: {
    WatchWidgetEntry.signedOut
}

#Preview("Circular", as: .accessoryCircular) {
    ReminderStackWidget()
} timeline: {
    ReminderStackPreviewData.supplements
    ReminderStackPreviewData.overdue
}

#Preview("Corner", as: .accessoryCorner) {
    ReminderStackWidget()
} timeline: {
    ReminderStackPreviewData.supplements
    ReminderStackPreviewData.overdue
}
#endif
