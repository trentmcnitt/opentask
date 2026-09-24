import Foundation
import RelevanceKit
import WidgetKit

// MARK: - Entry

/// One Smart Stack card's worth of content. The card is ONE thing at a time
/// (Trent's 2026-09-24 redesign, replacing "Early morning · 7 left" plus a
/// truncated title and no way to act): `content` says which, and the ring
/// families read the flatter `ring` summary instead.
struct WatchWidgetEntry: TimelineEntry {
    let date: Date
    let content: Content
    let ring: Ring
    /// Per-entry Smart Stack score (the watchOS 9 mechanism, still honored
    /// alongside the provider's `relevance()` — see `ReminderStackProvider`).
    let relevance: TimelineEntryRelevance?

    enum Content: Equatable {
        case signedOut
        /// The slot's next reminder, in full, with ✓ and ⏭.
        case reminder(ReminderCard)
        /// Nothing waiting in any slot that has started.
        case caughtUp(CaughtUpCard)
        /// Something bulk-snoozable is overdue — takes the card over.
        case overdue(OverdueCard)
        /// The last "Snooze all" result, for `WatchWidgetState.snoozeResultWindow`.
        case snoozed(WatchWidgetState.SnoozeResult)
    }

    struct ReminderCard: Equatable {
        let taskId: Int
        let title: String
        let slotLabel: String
        /// `ReminderGroupDTO.slotKey` — scopes the ⏭ skip list.
        let slotKey: Int
        /// "2 of 7": position through the slot's WHOLE day, not the remaining
        /// list — `considered + index-in-remaining + 1` over `considered +
        /// remaining`. So a ✓ moves "1 of 7" to "2 of 7" (progress you can
        /// feel), where a remaining-list count would sit at "1 of 6". A ⏭
        /// moves it forward too, since the shown item is further down.
        let position: Int
        let total: Int
        /// Every still-pending id in card order, for `SkipReminderIntent`'s
        /// wrap decision.
        let remainingIds: [Int]
        /// Overdue Urgent (P4) tasks — never bulk-snoozable, so they don't
        /// take the card over (see `ReminderStackTimeline.content`), but they
        /// must not vanish either: a small red line under the header.
        let urgentOverdue: Int

        var isLast: Bool { remainingIds.count == 1 }
    }

    struct CaughtUpCard: Equatable {
        /// The next slot today that still has reminders waiting, if any.
        let nextSlotLabel: String?
        let nextSlotStart: Date?
        let nextSlotCount: Int
        let urgentOverdue: Int
    }

    struct OverdueCard: Equatable {
        let count: Int
        /// Of `count`, how many the sweep may move (P0-P3; P4 never). Only
        /// ever > 0 here — a zero would be the Urgent-only case, which stays
        /// in reminder mode instead.
        let snoozable: Int
        let urgent: Int
        /// The earliest-due overdue title, one line of context.
        let firstTitle: String?
        /// Where "next period" lands ("Midday"), and when.
        let targetLabel: String?
        let targetDate: Date?
    }

    /// Summary for `accessoryCircular`/`accessoryCorner`.
    struct Ring: Equatable {
        let count: Int
        /// Filled share of the ring, 0...1.
        let fraction: Double
        let isOverdue: Bool
        let label: String
    }

    static let signedOut = WatchWidgetEntry(
        date: Date(), content: .signedOut,
        ring: Ring(count: 0, fraction: 0, isOverdue: false, label: "OpenTask"),
        relevance: nil
    )

    /// Watch-app page a whole-card tap opens: Reminders for reminder and
    /// caught-up cards, Tasks for the overdue ones (that's where the overdue
    /// list and its bulk sheet live). Resolved by `WatchRootView.onOpenURL`.
    var deepLink: URL? {
        switch content {
        case .overdue, .snoozed:
            return URL(string: "opentask://tasks")
        case .signedOut, .reminder, .caughtUp:
            return URL(string: "opentask://reminders")
        }
    }
}

// MARK: - Builder

/// Pure entry/relevance logic — no network, no WidgetKit context — so the
/// provider, the `#Preview`s (real data, `ReminderStackPreviewData`) and the
/// relevance hints all compute the card the same way.
enum ReminderStackTimeline {

    /// **How reminders and overdue share the card (the rule).**
    /// 1. A "Snooze all" result from the last `snoozeResultWindow` wins, so the
    ///    tap visibly lands.
    /// 2. Else, if any overdue task is bulk-SNOOZABLE (priority < 4), the card
    ///    is in overdue mode: one tap clears it, and until then it outranks a
    ///    reminder (tasks have debt, reminders never do — §6).
    /// 3. Else reminders: the active slot's next reminder, or "All caught up".
    ///    Overdue Urgent-only (P4) does NOT take over: the sweep never moves
    ///    P4, so an overdue card for it would be a button that does nothing,
    ///    forever. It shows as a red "N urgent overdue" line instead, and a
    ///    tap on the card body still opens the app.
    static func entry(
        groups: [ReminderGroupDTO],
        tasks: [TaskDTO],
        skipped: (Int) -> Set<Int>,
        pendingDone: Set<Int>,
        snoozeResult: WatchWidgetState.SnoozeResult?,
        slots: [TimeSlotDTO],
        at date: Date
    ) -> WatchWidgetEntry {
        let groups = applyingPendingDone(pendingDone, to: groups)
        let overdue = WatchSlotLogic.overdueTasks(from: tasks, now: date)
        let urgent = overdue.filter { $0.priority >= 4 }.count
        let snoozable = overdue.count - urgent
        let active = activeGroupIndex(in: groups, now: date).map { groups[$0] }
        let ring = ringSummary(active: active, groups: groups, overdue: snoozable, now: date)

        if let snoozeResult {
            return WatchWidgetEntry(
                date: date, content: .snoozed(snoozeResult), ring: ring,
                relevance: TimelineEntryRelevance(score: 60, duration: WatchWidgetState.snoozeResultWindow)
            )
        }

        if snoozable > 0 {
            let target = nextPeriod(slots: slots, now: date)
            let card = WatchWidgetEntry.OverdueCard(
                count: overdue.count, snoozable: snoozable, urgent: urgent,
                firstTitle: overdue.first?.title,
                targetLabel: target?.label, targetDate: target?.date
            )
            return WatchWidgetEntry(
                date: date, content: .overdue(card), ring: ring,
                relevance: TimelineEntryRelevance(score: 100)
            )
        }

        if let group = active {
            let skips = skipped(group.slotKey)
            let remaining = group.reminders
            // First reminder not skipped. `WatchWidgetState.skip` never lets
            // the skip list cover every remaining id, but a stale list (an
            // item finished elsewhere) could — fall back to the first then.
            let index = remaining.firstIndex { !skips.contains($0.id) } ?? 0
            let shown = remaining[index]
            let card = WatchWidgetEntry.ReminderCard(
                taskId: shown.id, title: shown.title,
                slotLabel: group.label, slotKey: group.slotKey,
                position: group.considered + index + 1,
                total: group.considered + remaining.count,
                remainingIds: remaining.map(\.id),
                urgentOverdue: urgent
            )
            return WatchWidgetEntry(
                date: date, content: .reminder(card), ring: ring,
                relevance: TimelineEntryRelevance(score: slotJustStarted(group, now: date) ? 90 : 50)
            )
        }

        let next = nextWaitingSlot(in: groups, now: date)
        let card = WatchWidgetEntry.CaughtUpCard(
            nextSlotLabel: next?.label, nextSlotStart: next.flatMap { startDate(of: $0, on: date) },
            nextSlotCount: next?.reminders.count ?? 0, urgentOverdue: urgent
        )
        return WatchWidgetEntry(
            date: date, content: .caughtUp(card), ring: ring,
            relevance: TimelineEntryRelevance(score: 0)
        )
    }

    // MARK: Slot selection

    /// The slot the card is about: the clock's current slot while it still
    /// has something waiting, else the EARLIEST started slot that still does
    /// (a missed morning surfaces before an empty "Midday · Done"), with
    /// "Anytime" counted as started. Never a slot that hasn't started — the
    /// same rule the phone widget's auto-advance follows — except the
    /// pre-dawn case `naturalSlotIndex` already defines (before the first
    /// slot, the first slot IS the current one). `nil` = all caught up.
    static func activeGroupIndex(in groups: [ReminderGroupDTO], now: Date) -> Int? {
        guard !groups.isEmpty else { return nil }
        let natural = WatchSlotLogic.naturalSlotIndex(in: groups, now: now)
        if !groups[natural].reminders.isEmpty { return natural }
        return groups.firstIndex { WatchSlotLogic.state(for: $0, now: now) == .waiting }
    }

    /// The next slot later today that has reminders waiting — the caught-up
    /// card's "Next: Midday at 12:00 PM".
    static func nextWaitingSlot(in groups: [ReminderGroupDTO], now: Date) -> ReminderGroupDTO? {
        groups.first { WatchSlotLogic.state(for: $0, now: now) == .notStarted && !$0.reminders.isEmpty }
    }

    /// Within the first 30 min of the slot's start — the Smart Stack should
    /// rank the card highest right as a slot opens.
    private static func slotJustStarted(_ group: ReminderGroupDTO, now: Date) -> Bool {
        guard let start = startDate(of: group, on: now) else { return false }
        return now >= start && now.timeIntervalSince(start) < 30 * 60
    }

    static func startDate(of group: ReminderGroupDTO, on day: Date) -> Date? {
        guard let minutes = group.slot?.startMinutes else { return nil }
        return date(minutes: minutes, on: day)
    }

    private static func date(minutes: Int, on day: Date) -> Date? {
        Calendar.current.date(bySettingHour: minutes / 60, minute: minutes % 60, second: 0, of: day)
    }

    /// Local twin of the server's `nextPeriodStart` (`src/lib/time-slot-assign.ts`)
    /// for LABELING the snooze button only — the sweep itself sends `slot:
    /// "next"` and the server resolves the time. Same computation as
    /// `TimeSlotStore.nextPeriodStart`, but keeps the slot's name.
    static func nextPeriod(slots: [TimeSlotDTO], now: Date) -> (label: String, date: Date)? {
        slots.compactMap { slot -> (label: String, date: Date)? in
            guard let minutes = slot.startMinutes, let today = date(minutes: minutes, on: now) else { return nil }
            if today > now { return (slot.label, today) }
            guard let tomorrow = Calendar.current.date(byAdding: .day, value: 1, to: today) else { return nil }
            return (slot.label, tomorrow)
        }
        .min { $0.date < $1.date }
    }

    // MARK: Optimistic

    /// Hide ✓'d-but-unconfirmed reminders (`WatchWidgetState.pendingDoneIds`)
    /// and count them as considered, so the card advances before the server
    /// round trip and never flashes the old item back on a stale reload.
    static func applyingPendingDone(_ ids: Set<Int>, to groups: [ReminderGroupDTO]) -> [ReminderGroupDTO] {
        guard !ids.isEmpty else { return groups }
        return groups.map { group in
            let hidden = group.reminders.filter { ids.contains($0.id) }
            guard !hidden.isEmpty else { return group }
            return ReminderGroupDTO(
                slot: group.slot,
                reminders: group.reminders.filter { !ids.contains($0.id) },
                considered: group.considered + hidden.count,
                consideredItems: hidden + group.consideredItems
            )
        }
    }

    // MARK: Ring

    private static func ringSummary(
        active: ReminderGroupDTO?, groups: [ReminderGroupDTO], overdue: Int, now: Date
    ) -> WatchWidgetEntry.Ring {
        if overdue > 0 {
            return .init(count: overdue, fraction: 0, isOverdue: true, label: "Overdue")
        }
        guard let active else {
            return .init(count: 0, fraction: groups.isEmpty ? 0 : 1, isOverdue: false, label: "Caught up")
        }
        let total = active.reminders.count + active.considered
        let fraction = total > 0 ? Double(active.considered) / Double(total) : 0
        return .init(count: active.reminders.count, fraction: fraction, isOverdue: false, label: active.label)
    }

    // MARK: Timeline dates

    /// Future instants where the card's content changes WITHOUT new data, each
    /// pre-scheduled as a zero-cost timeline entry: every slot start later
    /// today (the card flips to the new slot on time), every upcoming due time
    /// in the next 12h (the card enters overdue mode the minute something goes
    /// overdue, no fetch spent), and the snooze result's expiry.
    static func changeDates(
        groups: [ReminderGroupDTO], tasks: [TaskDTO],
        snoozeResult: WatchWidgetState.SnoozeResult?, now: Date
    ) -> [Date] {
        let horizon = now.addingTimeInterval(12 * 3600)
        var dates = groups.compactMap { startDate(of: $0, on: now) }
        // Filter to the future BEFORE capping: `upNextTasks` is soonest-first,
        // so already-overdue tasks lead the list and would eat the cap.
        dates += WatchSlotLogic.upNextTasks(from: tasks).compactMap(\.dueDate).filter { $0 > now }.prefix(12)
        if let snoozeResult {
            dates.append(snoozeResult.at.addingTimeInterval(WatchWidgetState.snoozeResultWindow))
        }
        // +1s so an entry lands just AFTER a due instant, where
        // `isOverdue` (strict <) already reads true.
        return Array(Set(dates.map { $0.addingTimeInterval(1) }))
            .filter { $0 > now && $0 < horizon }
            .sorted()
    }

    // MARK: Relevance (Smart Stack)

    /// Windows in which the Smart Stack should surface the card on its own:
    /// each slot with reminders from its start to the next slot's start
    /// (today's remaining ones, plus tomorrow's — Trent's reminders are
    /// overwhelmingly daily, and relevance is only re-asked when something
    /// invalidates it, so tomorrow morning must already be on file tonight);
    /// right now for 3h while anything snoozable is overdue; and 2h from each
    /// upcoming due time in the next day, when it will be.
    static func relevantIntervals(
        groups: [ReminderGroupDTO], tasks: [TaskDTO], now: Date
    ) -> [DateInterval] {
        var intervals: [DateInterval] = []
        let slotted = groups.filter { $0.slot != nil && ($0.considered + $0.reminders.count) > 0 }
        let starts = groups.compactMap { $0.slot?.startMinutes }.sorted()

        for dayOffset in 0...1 {
            guard let day = Calendar.current.date(byAdding: .day, value: dayOffset, to: now) else { continue }
            for group in slotted {
                // Today: only slots still waiting (a finished slot isn't worth
                // surfacing). Tomorrow: every slot that had reminders today.
                if dayOffset == 0 && group.reminders.isEmpty { continue }
                guard let minutes = group.slot?.startMinutes,
                      let start = date(minutes: minutes, on: day) else { continue }
                let nextMinutes = starts.first { $0 > minutes }
                let end = nextMinutes.flatMap { date(minutes: $0, on: day) }
                    ?? Calendar.current.startOfDay(for: day).addingTimeInterval(24 * 3600)
                guard end > now, end > start else { continue }
                intervals.append(DateInterval(start: max(start, now), end: end))
            }
        }

        let overdueNow = WatchSlotLogic.overdueTasks(from: tasks, now: now).contains { $0.priority < 4 }
        if overdueNow {
            intervals.append(DateInterval(start: now, duration: 3 * 3600))
        }
        let upcomingDue = WatchSlotLogic.upNextTasks(from: tasks)
            .filter { $0.priority < 4 }
            .compactMap(\.dueDate)
            .filter { $0 > now && $0 < now.addingTimeInterval(24 * 3600) }
            .prefix(6)
        intervals += upcomingDue.map { DateInterval(start: $0, duration: 2 * 3600) }
        return intervals
    }

    @available(watchOS 11.0, *)
    static func widgetRelevance(groups: [ReminderGroupDTO], tasks: [TaskDTO], now: Date) -> WidgetRelevance<Void> {
        let attributes = relevantIntervals(groups: groups, tasks: tasks, now: now).map { interval in
            WidgetRelevanceAttribute(context: relevantContext(for: interval))
        }
        return WidgetRelevance(attributes)
    }

    /// watchOS 26's kinded form where available: `.scheduled` is Apple's "treat
    /// with increased priority because it displays important content or
    /// requires action" — both a waiting slot and an overdue sweep are an
    /// action. `date(from:to:)` (deprecated in 26, the only form on 11-25)
    /// otherwise.
    @available(watchOS 11.0, *)
    private static func relevantContext(for interval: DateInterval) -> RelevantContext {
        if #available(watchOS 26.0, *) {
            return .date(interval: interval, kind: .scheduled)
        }
        return .date(from: interval.start, to: interval.end)
    }
}
