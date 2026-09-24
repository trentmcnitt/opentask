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
        reminder(24, "Depressed = Past, Anxious = Future, Present = Peace"),
        reminder(604, "Supplements ( Creatine, Vitamin D, L-Theanine )", priority: 2),
        reminder(64, "Singing and many other body things require a feedback loop, where I hear/see/sense/assess what I'm doing while I do it. Allows leveraging of IQ/executive/conscious processing. (that’s how you connect the smart, thinking part of your brain to your body.) Able to mentally acknowledge what I’m seeing, or hearing/sensing."),
        reminder(168, "Face (Cleanse, Treatment, Lotion, SPF)"),
        reminder(208, "Think of improvement as cool to see what’s possible?"),
        reminder(218, "Athleticism uses the full body to accomplish the task"),
        reminder(223, "Walk and move in a way that pumps blood to the pelvis"),
        reminder(23432, "Cold Shower (Naval)"),
    ]

    static let morning: [TaskDTO] = [
        reminder(2226, "Check GitHub issues", priority: 2),
        reminder(126, "Do my PRI"),
        reminder(183, "Mixed Nuts + Pumpkin and Sunflower Seeds"),
        reminder(197, "Vision therapy (Relax into it, hold it steady — good for presence)"),
        reminder(215, "Stair pushups"),
    ]

    static let midday: [TaskDTO] = [
        reminder(2247, "Check all public visibility places", priority: 2),
        reminder(38, "Is Kelly using vinegar softener"),
        reminder(146, "Kel game training"),
        reminder(23393, "Teeth whitening (optional)"),
    ]

    static let afternoon: [TaskDTO] = [
        reminder(12, "Being loving is a much happier way to live/be"),
        reminder(127, "Reinforce to the kids that they should be enjoying themselves (“are you enjoying your day?”, “what are you going to do to enjoy your day?”)"),
        reminder(150, "Make sure both kids are in a ball sport or hand eye coordination sport"),
        reminder(222, "“It’s Dad and Moms job to take care of me, and my job to listen (to them).”"),
    ]

    static let evening: [TaskDTO] = [
        reminder(41, "Hair treatment"),
        reminder(44, "Owen may need to get his thoughts out at night time"),
        reminder(70, "Timed breathing to connect with breath+body (use app)"),
        reminder(94, "Head massage (proprioception)"),
        reminder(136, "Surround myself with advanced/business/thinking people and books. Read books, listen to people, play games-whatever it takes. Provides learning + mindset reinforcement"),
        reminder(273, "Evening Kegel App (after PRI) (finish with long reverse kegel)"),
        reminder(3093, "Ask myself: “How did I perform today?”"),
    ]

    /// His soonest-due open tasks (not reminders, not quotas).
    static let tasks: [TaskDTO] = [
        TaskDTO(id: 23533, title: "Check if clients are waiting on me", priority: 3, dueAt: "2026-09-24T14:00:00.000Z"),
        TaskDTO(id: 22067, title: "Email Gayle Nicoll about 4-H Brookfield Blazers before the Oct 1 meeting", priority: 3, dueAt: "2026-09-24T22:00:00.000Z"),
        TaskDTO(id: 22793, title: "Kelly chocolate", priority: 2, dueAt: "2026-09-25T01:30:00.000Z"),
        TaskDTO(id: 292, title: "Josie Allowance ($8)", priority: 2, dueAt: "2026-09-25T21:00:00.000Z"),
    ]

    /// Today's groups with the first `considered[slotId]` reminders of each
    /// slot already checked off — how the day looks at a given moment.
    static func groups(considered: [Int: Int] = [:]) -> [ReminderGroupDTO] {
        let bySlot: [(TimeSlotDTO, [TaskDTO])] = [
            (slots[0], earlyMorning), (slots[1], morning), (slots[2], midday),
            (slots[3], afternoon), (slots[4], evening),
        ]
        return bySlot.map { slot, all in
            let done = min(considered[slot.id] ?? 0, all.count)
            return ReminderGroupDTO(
                slot: slot, reminders: Array(all.dropFirst(done)),
                considered: done, consideredItems: Array(all.prefix(done))
            )
        } + [ReminderGroupDTO(slot: nil, reminders: [])]
    }

    /// 2026-09-24 at `hour:minute`, device-local (the previews assume the
    /// Mac is on Trent's Central time, as the snapshot was).
    static func at(_ hour: Int, _ minute: Int = 0) -> Date {
        Calendar.current.date(from: DateComponents(year: 2026, month: 9, day: 24, hour: hour, minute: minute))
            ?? Date()
    }

    static func entry(
        _ groups: [ReminderGroupDTO], tasks: [TaskDTO] = [], at date: Date,
        skipped: Set<Int> = [], snooze: WatchWidgetState.SnoozeResult? = nil
    ) -> WatchWidgetEntry {
        ReminderStackTimeline.entry(
            groups: groups, tasks: tasks, skipped: { _ in skipped }, pendingDone: [],
            snoozeResult: snooze, slots: slots, at: date
        )
    }

    // MARK: The states

    /// Trent's exact complaint screenshot, redone: Early morning, one
    /// considered, "Supplements ( Creatine, Vitamin D, L-Theanine )" next.
    static let supplements = entry(groups(considered: [11: 1]), at: at(8, 47))
    /// The very long one ("Singing and many other body things…") after ✓ on
    /// Supplements.
    static let longReminder = entry(groups(considered: [11: 2]), at: at(8, 50))
    /// The same long one as the slot's LAST item (no ⏭) — every other Early
    /// morning reminder considered, as if the rest were ✓'d or skipped past.
    static let longLast = entry(
        [ReminderGroupDTO(
            slot: slots[0], reminders: [earlyMorning[2]], considered: 7,
            consideredItems: earlyMorning.enumerated().filter { $0.offset != 2 }.map(\.element)
        )] + groups(considered: [11: 8]).dropFirst(),
        at: at(8, 58)
    )
    /// A short one: Morning just opened.
    static let shortReminder = entry(groups(considered: [11: 8]), at: at(9, 2))
    /// Last item in a slot: Midday with three of four considered.
    static let lastInSlot = entry(groups(considered: [11: 8, 12: 5, 13: 3]), at: at(12, 40))
    /// Everything started is done; Afternoon is next.
    static let caughtUp = entry(groups(considered: [11: 8, 12: 5, 13: 4]), at: at(13, 15))
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
