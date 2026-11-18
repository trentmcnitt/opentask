import Foundation

/// THE ACTION ROWS OF A TASK NOTIFICATION (`TASK_REMINDER`), as data — which
/// identifiers, in which order, under which titles — so the registered
/// category, the iPhone's long-press and the tests all read one list.
///
/// Trent, 2026-11-18: "I have no way to move a single item to the next
/// period", then: "it starts in single, then it can show up in all mode.
/// Maybe the only all on there by all the time is one that says all to next
/// period, and the rest of them are just for the single task unless all is
/// selected."
///
/// - **Where no custom view runs** (a banner's buttons, the Watch, the Mac):
///   `registered` — Done, Next period (this task), +1hr (this task),
///   All → Next period. Fixed, and worked out long before it is pressed, so
///   it names no period and no time.
/// - **The iPhone's long-press** has a switch above its grid
///   (`SnoozeScope`): `thisTask` — Done, the next period by name, +1 hour,
///   the next three periods after it, each for THIS task alone, then the one
///   standing bulk row, All → Next period — or `allOverdue`, the bulk rows
///   (no Done). With a time picked in the grid: `picked`.
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

    /// The long-press switch: this task alone, or every overdue task.
    enum SnoozeScope: Equatable {
        case thisTask
        case allOverdue
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

    /// The periods in the order they next start after the task's base time,
    /// each with that start.
    private static func upcoming(
        dueAtISO: String?, now: Date, slots: [TimeSlotDTO], calendar: Calendar
    ) -> [(slot: TimeSlotDTO, at: Date)] {
        let base = DateHelpers.snoozeBase(dueAt: dueAtISO.flatMap(DateHelpers.parseISO), now: now)
        return TimeSlotStore.slotsByNextStart(slots: slots, after: base, calendar: calendar).compactMap { slot in
            TimeSlotStore.nextPeriodStart(slots: [slot], after: base, calendar: calendar).map { (slot, $0) }
        }
    }

    private static func named(_ label: String, _ at: Date) -> String {
        "\(label) \u{00B7} \(DateHelpers.formatShortTime(at))"
    }

    /// The long-press list for this task alone (nothing picked in the grid).
    static func thisTask(
        dueAtISO: String?, now: Date, slots: [TimeSlotDTO], calendar: Calendar = .current
    ) -> [Row] {
        let periods = upcoming(dueAtISO: dueAtISO, now: now, slots: slots, calendar: calendar)
        var rows = [done]
        if let next = periods.first {
            rows.append(Row(identifier: NotificationAction.snoozeNextPeriod, title: named(next.slot.label, next.at)))
        }
        rows.append(Row(
            identifier: NotificationAction.snooze1hr,
            title: named("+1 hour", DateHelpers.snapToNextHour(now: now))
        ))
        rows += periods.dropFirst().prefix(TimeSlotStore.namedNotificationSlots).map { period in
            Row(
                identifier: NotificationAction.snoozeSlotIdentifier(startTime: period.slot.startTime),
                title: named(period.slot.label, period.at)
            )
        }
        if !periods.isEmpty { rows.append(allNextPeriod) }
        return rows
    }

    /// The bulk rows (the long-press's All mode, and a summary's list): every
    /// overdue task +1 hour, to the next period, to each of the three after.
    static func allOverdue(now: Date, slots: [TimeSlotDTO], calendar: Calendar = .current) -> [Row] {
        var rows = [Row(
            identifier: NotificationAction.snoozeAll1hr,
            // Says it is the +1 hour row, as the single one does.
            title: "All \u{2192} \(named("+1 hour", DateHelpers.snapToNextHour(now: now)))"
        )]
        guard !slots.isEmpty else { return rows }
        rows.append(allNextPeriod)
        rows += TimeSlotStore.notificationChoices(slots: slots, after: now, calendar: calendar).map { slot in
            Row(
                identifier: NotificationAction.snoozeAllSlotIdentifier(startTime: slot.startTime),
                title: "All \u{2192} \(slot.label)"
            )
        }
        return rows
    }

    /// The list once a time is picked in the grid: that time, for the scope.
    static func picked(_ time: Date, scope: SnoozeScope) -> [Row] {
        let label = DateHelpers.formatShortTime(time)
        switch scope {
        case .thisTask:
            return [done, Row(identifier: NotificationAction.snoozeCustom, title: label)]
        case .allOverdue:
            return [Row(identifier: NotificationAction.snoozeAllCustom, title: "All \u{2192} \(label)")]
        }
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
