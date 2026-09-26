#if DEBUG
import SwiftUI
import WidgetKit

/// Realistic sample data, for `#Preview`s only (DEBUG — never in a shipped
/// binary, never in the widget gallery, which uses `ReminderStackPlaceholder`).
///
/// Invented titles with the shape of a real account at 2026-09-24 ~08:55
/// CDT: five time slots, the day's reminders grouped the way
/// `GET /api/reminders` groups them (`getRemindersBySlot`: by slot, priority
/// desc then id) with the same counts and title lengths, and the soonest-due
/// open tasks. The overdue states use the two High tasks due that day
/// (23533 at 9:00 AM, 22067 at 5:00 PM CDT) viewed from 5:30 PM, when both
/// are. With `ios/Previews.local/` present (`PreviewLocalData`, gitignored)
/// the slots, groups and tasks come from that account data instead; the
/// fixed clock and skip keys then only approximate the stories below.
///
/// Each state is the REAL builder (`ReminderStackTimeline.entry`) run at a
/// fixed instant, so a preview exercises the same slot/overdue/position logic
/// the live widget does — not a hand-built entry that could drift from it.
enum ReminderStackPreviewData {
    static let slots: [TimeSlotDTO] = PreviewLocalData.timeSlots ?? [
        TimeSlotDTO(id: 11, label: "Early morning", startTime: "07:00"),
        TimeSlotDTO(id: 12, label: "Morning", startTime: "09:00"),
        TimeSlotDTO(id: 13, label: "Midday", startTime: "12:00"),
        TimeSlotDTO(id: 14, label: "Afternoon", startTime: "16:00"),
        TimeSlotDTO(id: 15, label: "Evening", startTime: "20:30"),
    ]

    private static func reminder(_ id: Int, _ title: String, priority: Int = 0) -> TaskDTO {
        TaskDTO(id: id, title: title, priority: priority, isReminder: true)
    }

    /// Leads with 24, already considered at the sample's moment — the
    /// `considered:` counts below take reminders off the FRONT of each list.
    static let earlyMorning: [TaskDTO] = [
        reminder(24, "Morning = Focus, Afternoon = Meetings, Evening = Rest"),
        reminder(604, "Breakfast ( Oatmeal, Berries, Walnuts )", priority: 2),
        reminder(64, "Practice the new song slowly, one phrase at a time, noticing where the breath runs short and marking it on the sheet before trying the whole verse again. Then play it once through without stopping, record it, and listen back with fresh ears. (Small daily corrections add up faster than one long weekend session.)"),
        reminder(168, "Plant care (Water, Mist, Turn to sun)"),
        reminder(208, "Treat each mistake as a clue to what’s worth learning?"),
        reminder(218, "A calm start to the morning sets up the rest of it"),
        reminder(223, "Sit tall at the desk and let the shoulders drop and relax"),
        reminder(23432, "Open blinds (morning)"),
    ]

    static let morning: [TaskDTO] = [
        reminder(2226, "Check the team inbox", priority: 2),
        reminder(126, "Do my stretches"),
        reminder(183, "Carrot Sticks + Hummus Cup"),
        reminder(197, "Deep breath (Slow in, hold it gently — good for steady focus)"),
        reminder(215, "Calf raises"),
    ]

    static let midday: [TaskDTO] = [
        reminder(2247, "Check the community board posts", priority: 2),
        reminder(38, "Is the new plant food still working"),
        reminder(146, "Crossword puzzle time"),
        reminder(23393, "Refill water (optional)"),
    ]

    static let afternoon: [TaskDTO] = [
        reminder(12, "Listening fully is a much kinder way to talk/be"),
        reminder(127, "Remember to notice the day (“what did I notice today?”, “what am I going to look for tomorrow?”)"),
        reminder(150, "Make sure there is a group hike or an outdoor weekend activity on the family calendar"),
        reminder(222, "“Take care of the minutes, and the hours will take care of themselves.”"),
    ]

    static let evening: [TaskDTO] = [
        reminder(41, "Pack lunches"),
        reminder(44, "A short walk after dinner might help settle the mind at night"),
        reminder(70, "Box breathing to wind down (use timer)"),
        reminder(94, "Hip stretch (desk day)"),
        reminder(136, "Fill the house with good music and curious people. Borrow books, try new recipes, play board games — whatever keeps it lively. Provides learning + a steady source of calm"),
        reminder(273, "Evening wind-down routine (after dishes) (finish with a warm drink)"),
        reminder(3093, "Ask myself: “What can I let go of?”"),
    ]

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

    /// Sample quota prompts (quota reminders, 2026-09-24): every unmet quota
    /// prompts in Early morning, the default period; Piano Scales (daily, target 2) has its
    /// #1 here and its #2 in Morning.
    static let earlyMorningPrompts: [QuotaPromptDTO] = [
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

    /// The soonest-due open tasks (not reminders, not quotas).
    static let tasks: [TaskDTO] = PreviewLocalData.openTasks?.filter { $0.dueAt != nil && !$0.isReminder && !$0.isTracked } ?? [
        TaskDTO(id: 23533, title: "Reply to the pending team messages", priority: 3, dueAt: "2026-09-24T14:00:00.000Z"),
        TaskDTO(id: 22067, title: "Email the venue about the room booking before the Oct 1 planning meeting", priority: 3, dueAt: "2026-09-24T22:00:00.000Z"),
        TaskDTO(id: 22793, title: "Order birdseed", priority: 2, dueAt: "2026-09-25T01:30:00.000Z"),
        TaskDTO(id: 292, title: "Weekly plant food ($6)", priority: 2, dueAt: "2026-09-25T21:00:00.000Z"),
    ]

    /// Today's groups with the first `considered[slotId]` reminders of each
    /// slot already checked off — how the day looks at a given moment.
    ///
    /// `promptsHandled`: every quota prompt already considered — for the
    /// states whose story predates prompts (caught up, overdue).
    static func groups(considered: [Int: Int] = [:], promptsHandled: Bool = false) -> [ReminderGroupDTO] {
        if let local = PreviewLocalData.reminderGroups {
            return local.map { g in
                let done = min(considered[g.slot?.id ?? -1] ?? 0, g.reminders.count)
                return ReminderGroupDTO(
                    slot: g.slot, reminders: Array(g.reminders.dropFirst(done)),
                    considered: g.considered + done,
                    consideredItems: g.consideredItems + Array(g.reminders.prefix(done)),
                    prompts: g.prompts.map { promptsHandled ? $0.handled(did: false) : $0 }
                )
            }
        }
        let bySlot: [(TimeSlotDTO, [TaskDTO])] = [
            (slots[0], earlyMorning), (slots[1], morning), (slots[2], midday),
            (slots[3], afternoon), (slots[4], evening),
        ]
        let prompts: [Int: [QuotaPromptDTO]] = [
            11: earlyMorningPrompts,
            12: [prompt(83, 2, "Piano Scales", 0, 2, "DAILY", "blue")],
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
    /// Mac is on Central time, as the sample is).
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

    /// The complaint screenshot's state, redone: Early morning, one
    /// considered, "Breakfast ( Oatmeal, Berries, Walnuts )" next.
    static let supplements = entry(groups(considered: [11: 1]), at: at(8, 47))
    /// The very long one ("Practice the new song slowly…") after ✓ on
    /// Breakfast.
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
    /// Skipped along to the longest quota title ("Look for new evening
    /// courses — …"), the text-fit stress case with the ☐ column.
    static let promptLong = entry(
        groups(considered: [11: 8]), at: at(8, 52), skipped: ["q:116:0:2026-09-24"]
    )
    /// Skipped to "Bake bread from scratch (incl. sourdough) · 0/5".
    static let promptVegetables = entry(
        groups(considered: [11: 8]), at: at(8, 52),
        skipped: ["q:116:0:2026-09-24", "q:3307:0:2026-09-24", "q:276:0:2026-09-24"]
    )
    /// Skipped to "Vacuum the car mats" — a MONTHLY count ("0/1 mo").
    static let promptMonthly = entry(
        groups(considered: [11: 8]), at: at(8, 52),
        skipped: ["q:116:0:2026-09-24", "q:3307:0:2026-09-24"]
    )
    /// Skipped to "Piano Scales" #1 — a DAILY count ("0/2 today").
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

#Preview("Breakfast (the complaint)", as: .accessoryRectangular) {
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
