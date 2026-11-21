import Foundation

/// THE ACTION ROWS OF A TASK NOTIFICATION (`TASK_REMINDER`), as data — which
/// identifiers, in which order, under which titles — so the registered
/// category, the iPhone's long-press and the tests all read one list.
///
/// Trent, 2026-11-18: "I have no way to move a single item to the next
/// period". Then (2026-11-21) the long-press became an overdue checklist
/// (`OverdueChecklist`), and its action rows act on the checked set — that
/// list is `OverdueChecklist.actions`, built from the period helpers here.
///
/// - **Where no custom view runs** (a banner's buttons, the Watch, the Mac):
///   `registered` — Done, Next period (this task), +1hr (this task),
///   All → Next period. Fixed, and worked out long before it is pressed, so
///   it names no period and no time.
///
/// A single-task period row lands on that period's first start STRICTLY
/// after max(now, the task's own time) — `TaskSnoozePlan`'s next-period rule,
/// the widget's ⏭ — resolved again when it is pressed
/// (`singleTarget(for:…)`), so a list left open still does what it says.
enum TaskNotificationList {

    struct Row: Equatable {
        let identifier: String
        let title: String
    }

    static let done = Row(identifier: NotificationAction.done, title: "Done")
    static let allNextPeriod = Row(
        identifier: NotificationAction.snoozeAllSlotNext, title: "All \u{2192} Next period"
    )

    /// The registered category's rows. The two period rows need a cached
    /// period: with none there is nothing to move a task to.
    static func registered(hasSlots: Bool) -> [Row] {
        var rows = [done]
        if hasSlots { rows.append(Row(identifier: NotificationAction.snoozeNextPeriod, title: "Next period")) }
        rows.append(Row(identifier: NotificationAction.snooze1hr, title: "+1hr"))
        if hasSlots { rows.append(allNextPeriod) }
        return rows
    }

    /// The periods in the order they next start after the base time —
    /// max(now, `dueAtISO`), or now with no time — each with that start.
    static func upcoming(
        dueAtISO: String?, now: Date, slots: [TimeSlotDTO], calendar: Calendar = .current
    ) -> [(slot: TimeSlotDTO, at: Date)] {
        let base = DateHelpers.snoozeBase(dueAt: dueAtISO.flatMap(DateHelpers.parseISO), now: now)
        return TimeSlotStore.slotsByNextStart(slots: slots, after: base, calendar: calendar).compactMap { slot in
            TimeSlotStore.nextPeriodStart(slots: [slot], after: base, calendar: calendar).map { (slot, $0) }
        }
    }

    /// "Lunchtime · 11:00 AM".
    static func named(_ label: String, _ at: Date) -> String {
        "\(label) \u{00B7} \(DateHelpers.formatShortTime(at))"
    }

    /// Where a single-task period button sends its task, worked out when it
    /// is pressed: `SNOOZE_NEXT_PERIOD` → the next period; `SNOOZE_SLOT:<HH:MM>`
    /// → that period's next start. Nil for any other identifier, a period
    /// that is gone, or no cached period.
    static func singleTarget(
        for identifier: String, dueAtISO: String?, now: Date, slots: [TimeSlotDTO],
        calendar: Calendar = .current
    ) -> Date? {
        let periods = upcoming(dueAtISO: dueAtISO, now: now, slots: slots, calendar: calendar)
        if identifier == NotificationAction.snoozeNextPeriod { return periods.first?.at }
        guard let startTime = NotificationAction.parseSnoozeSlot(identifier) else { return nil }
        return periods.first { $0.slot.startTime == startTime }?.at
    }
}
