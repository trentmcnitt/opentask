import Foundation

// Foundation-only on purpose (2026-10-10, task segments): the page ring is
// logic worth testing, and `OpenTaskLogicTests` compiles only Foundation
// files — `TasksTimeline.swift`'s split, for the same reason.

// MARK: - Slot resolution

/// Where "which time slot am I looking at" is decided.
///
/// Split out of the provider because `ShiftReminderSlotIntent` has to answer
/// the same question from a completely different process entry point, and two
/// implementations of this rule would drift.
enum RemindersTimeline {

    /// The group the clock is in right now: latest slot whose `start_time` is
    /// at or before the current local time.
    ///
    /// Before the first boundary of the day (the small hours) no slot has
    /// started yet. That falls back to the first slot rather than to the
    /// trailing "Anytime" group — at 5am the useful answer is "here's what's
    /// coming", not "here's the bucket for items with no time".
    ///
    /// Within the OpenTask day ("Day starts at" PR 3, the web's
    /// `naturalSlotIndex`): every start is counted from the day start
    /// (`minutesIntoDay`), so at 00:30 with the day starting at 3:00 the
    /// evening's slot is still the latest started, and from the day start
    /// until the first slot it is the first.
    static func naturalSlotIndex(
        in groups: [ReminderGroupDTO], now: Date = Date(), day: OpenTaskDay = DayStartStore.current
    ) -> Int {
        guard !groups.isEmpty else { return 0 }

        let minutes = day.minutesIntoDay(of: now)

        var best: Int?
        var bestStart = -1
        for (index, group) in groups.enumerated() {
            guard let raw = group.slot?.startMinutes else { continue }
            let start = day.minutesIntoDay(raw)
            guard start <= minutes, start > bestStart else {
                continue
            }
            bestStart = start
            best = index
        }
        if let best { return best }

        return groups.firstIndex(where: { $0.slot != nil }) ?? 0
    }

    // MARK: The page ring (2026-10-10, task segments)
    //
    // The widget's period ring is `[time slots…] + [task segments…]`: the
    // segments come AFTER the slots, as they sit under them on the reminders
    // screen (Trent, 10-11: "Tasks should go underneath Reminders" — it
    // replaced 10-10's segments-first).
    // Every page has an Int key in ONE space — a slot's `slotKey` (its id,
    // or -1 for Anytime) and a segment's `pageKey` (-10…-13, -14 Upcoming) — so the
    // existing slot override, its natural-page anchor, the bottom pager's
    // per-page index and the chevrons all address a segment page with no
    // new storage.
    //
    // The NATURAL page treats the task segments as periods AFTER the slots
    // (2026-10-11, "segments as slots"): it is the clock's slot — unless every
    // slot from the day's first through the clock's own has nothing waiting,
    // in which case it is the first task segment with a row waiting. An
    // earlier unfinished slot always wins (auto-advance's "earliest undone"
    // rule, extended past the last started slot). Segments never enter
    // `groups`; the strip draws them as their own bars after the slots
    // (`ReminderDayProgress.stripBars`), and day complete asks them
    // separately.

    /// What is on screen: a slot (`segmentIndex == nil`) or a segment.
    struct DisplayedPage: Equatable {
        /// Index into `groups` — the displayed slot, or on a segment page the
        /// natural slot (what the slot-only families draw).
        let slotIndex: Int
        /// Index into the listed segments, or nil on a slot page.
        let segmentIndex: Int?
    }

    /// Every page's key, in ring order. `segments` must already be listed.
    static func pageKeys(groups: [ReminderGroupDTO], segments: [TaskSegmentDTO]) -> [Int] {
        groups.map(\.slotKey) + segments.map(\.pageKey)
    }

    /// The natural page's key, or nil when there are no pages at all:
    /// - the first task segment with a row waiting, once every slot up to and
    ///   including the clock's has nothing waiting (2026-10-11 — finishing
    ///   the day so far carries the widget on to the tasks, as finishing a
    ///   slot carries it to the earliest undone one);
    /// - otherwise the clock's slot (an earlier unfinished slot is reached by
    ///   auto-advance, never skipped for a segment);
    /// - with no slots, the first segment still waiting, else the first.
    ///
    /// Slots AFTER the clock's — not started yet, plus a trailing "Anytime"
    /// — don't hold the segment back: they aren't "earlier", and
    /// `naturalSlotIndex` never picks Anytime as the day's current period
    /// while a timed slot exists.
    static func naturalPageKey(
        groups: [ReminderGroupDTO], segments: [TaskSegmentDTO], now: Date = Date()
    ) -> Int? {
        guard !groups.isEmpty else {
            return (segments.first(where: \.hasWaiting) ?? segments.first)?.pageKey
        }
        let natural = naturalSlotIndex(in: groups, now: now)
        if groups[0...natural].allSatisfy(\.hasNothingWaiting),
           let waiting = segments.first(where: \.hasWaiting) {
            return waiting.pageKey
        }
        return groups[natural].slotKey
    }

    /// The page `key` names, with `naturalSlot` standing in for the slot on
    /// a segment page (and for a key that names nothing).
    static func page(
        forKey key: Int?, groups: [ReminderGroupDTO], segments: [TaskSegmentDTO], naturalSlot: Int
    ) -> DisplayedPage {
        if let key, let index = segments.firstIndex(where: { $0.pageKey == key }) {
            return DisplayedPage(slotIndex: naturalSlot, segmentIndex: index)
        }
        if let key, let index = groups.firstIndex(where: { $0.slotKey == key }) {
            return DisplayedPage(slotIndex: index, segmentIndex: nil)
        }
        return DisplayedPage(slotIndex: naturalSlot, segmentIndex: nil)
    }

    /// The natural page at `now`, ignoring any override — what a pre-
    /// scheduled boundary entry shows.
    static func naturalPage(
        groups: [ReminderGroupDTO], segments: [TaskSegmentDTO], now: Date = Date()
    ) -> DisplayedPage {
        page(
            forKey: naturalPageKey(groups: groups, segments: segments, now: now),
            groups: groups, segments: segments, naturalSlot: naturalSlotIndex(in: groups, now: now)
        )
    }

    /// The page actually shown: the user's chevron override while it is still
    /// valid, otherwise the natural page.
    ///
    /// SIDE EFFECT: a stale override is deleted here. An override is stale once
    /// the natural page has moved off the one the user was standing on when
    /// they navigated — real time moved into a new slot, or a waiting segment
    /// was finished — the "reset the override when the timeline refreshes
    /// into a new slot" rule, expressed as data rather than as a timer.
    static func displayedPage(
        groups: [ReminderGroupDTO], segments: [TaskSegmentDTO], now: Date = Date()
    ) -> DisplayedPage {
        let naturalSlot = naturalSlotIndex(in: groups, now: now)
        let naturalKey = naturalPageKey(groups: groups, segments: segments, now: now)
        var key = naturalKey
        if let override = WidgetStore.slotOverride() {
            if let naturalKey, override.naturalSlotKey == naturalKey,
               pageKeys(groups: groups, segments: segments).contains(override.slotKey) {
                key = override.slotKey
            } else {
                WidgetStore.clearSlotOverride()
            }
        }
        return page(forKey: key, groups: groups, segments: segments, naturalSlot: naturalSlot)
    }

    /// The key of the page `displayedPage` resolves to.
    static func displayedPageKey(
        groups: [ReminderGroupDTO], segments: [TaskSegmentDTO], now: Date = Date()
    ) -> Int? {
        let shown = displayedPage(groups: groups, segments: segments, now: now)
        if let index = shown.segmentIndex { return segments[index].pageKey }
        return groups.indices.contains(shown.slotIndex) ? groups[shown.slotIndex].slotKey : nil
    }

    /// The cached payload with every optimistic marker applied — what the
    /// provider's fast path draws, and what the paging intents navigate.
    static func cachedPages(now: Date = Date()) -> (groups: [ReminderGroupDTO], segments: [TaskSegmentDTO]) {
        let cached = WidgetStore.loadReminders()?.value
        return (
            WidgetStore.filterPending(cached?.groups ?? [], now: now),
            TaskSegmentDTO.listed(WidgetStore.filterPendingSegments(cached?.taskSegments ?? [], now: now))
        )
    }

    /// Remaining slot boundaries today, as (fire date, group index).
    ///
    /// Scheduling an entry at each one makes the widget flip to the next slot
    /// at exactly the right minute without spending any of the refresh budget —
    /// the entries are all delivered by the single timeline WidgetKit already
    /// asked for.
    ///
    /// Each slot opens at the one moment of its time inside TODAY's OpenTask
    /// day (`periodOpensAt`, "Day starts at" PR 3): with the day starting at
    /// 3:00, a 1:00 AM slot is tonight's, after the evening's. The day
    /// start itself is the provider's own entry (`nextRollover`).
    static func upcomingBoundaries(
        in groups: [ReminderGroupDTO],
        now: Date = Date(),
        day: OpenTaskDay = DayStartStore.current
    ) -> [(date: Date, index: Int)] {
        let today = day.openTaskDay(of: now)
        return groups.enumerated().compactMap { index, group in
            guard let minutes = group.slot?.startMinutes else { return nil }
            let fire = day.periodOpensAt(today, startMinutes: minutes)
            return fire > now ? (fire, index) : nil
        }
        .sorted { $0.date < $1.date }
    }

    /// Has this slot's time arrived? Mirrors the web's `ReminderSlotBar.
    /// hasStarted` (`src/components/ReminderSlotBar.tsx`) — the un-slotted
    /// "Anytime" group has no start time and is always available, so it
    /// counts as started rather than "coming up later".
    static func hasStarted(_ group: ReminderGroupDTO, now: Date = Date(), day: OpenTaskDay = DayStartStore.current) -> Bool {
        ReminderDayProgress.hasStarted(group, now: now, day: day)
    }

    /// After completing an item that leaves the ON-SCREEN slot with nothing
    /// waiting, jump to the EARLIEST slot that still has something — Trent,
    /// 2026-09-23: "once I finish morning it should take me automatically
    /// back to early morning ... so I can keep checking things off and
    /// automatically switch." Also the fix for his other complaint that
    /// prompted this: "I finished everything for the morning ... I didn't
    /// even realize I actually did not finish the things for early
    /// morning" — an already-passed slot with leftovers should not go
    /// unnoticed just because a later one is on screen.
    ///
    /// Searches index 0 through the NATURAL slot (the clock's own position)
    /// inclusive — never a slot whose time hasn't come, and never forward of
    /// "now" even if the on-screen slot was itself ahead of natural. A no-op
    /// (stays put) when the on-screen slot still has something, or when
    /// nothing earlier does either. Writes through the EXISTING slot-override
    /// mechanism (`WidgetStore.setSlotOverride`), so this reads to
    /// `displayedSlotIndex` exactly like a manual chevron tap — including
    /// self-expiring once the real clock moves into a new natural slot.
    ///
    /// `groups` should be the CACHED payload as of the moment of the tap
    /// (`WidgetStore.loadReminders()`); this filters it with
    /// `WidgetStore.filterPending` itself, so the just-tapped item (already
    /// staged as a tombstone by the caller) reads as gone here too.
    ///
    /// Waiting quota prompts (2026-09-24) count as "something waiting" here,
    /// exactly like reminders: a slot whose reminders are done but whose
    /// prompts are not is not finished, and acting on a slot's last prompt
    /// advances just as checking off its last reminder does.
    ///
    /// Task segments come after the slots (2026-10-11, "segments as
    /// slots"): when nothing from the day's first slot through the clock's
    /// is waiting, the widget lands on the first task segment with a row
    /// waiting — the natural page by then (`naturalPageKey`). The override is
    /// anchored to that natural PAGE. A tap on a segment page does nothing
    /// here: finishing a segment moves the natural page on by itself (to the
    /// next waiting segment, else back to the clock's slot).
    static func autoAdvanceSlot(in groups: [ReminderGroupDTO], segments: [TaskSegmentDTO], now: Date = Date()) {
        let filtered = WidgetStore.filterPending(groups, now: now)
        let listed = TaskSegmentDTO.listed(WidgetStore.filterPendingSegments(segments, now: now))
        guard !filtered.isEmpty else { return }

        let shown = displayedPage(groups: filtered, segments: listed, now: now)
        guard shown.segmentIndex == nil else { return }
        let displayed = shown.slotIndex
        guard filtered.indices.contains(displayed), filtered[displayed].hasNothingWaiting else {
            return // the on-screen slot still has something waiting
        }

        let natural = naturalSlotIndex(in: filtered, now: now)
        guard filtered.indices.contains(natural),
              let naturalKey = naturalPageKey(groups: filtered, segments: listed, now: now)
        else { return }
        guard let target = filtered[0...natural].firstIndex(where: { !$0.hasNothingWaiting }) else {
            // Nothing from the day's first slot through now is waiting: on to
            // the first waiting task segment, the natural page by now. With
            // none waiting either, stay — the slot says it's done.
            if let segment = listed.first(where: \.hasWaiting) {
                setSlotOverride(slotKey: segment.pageKey, naturalSlotKey: naturalKey)
            }
            return
        }

        setSlotOverride(slotKey: filtered[target].slotKey, naturalSlotKey: naturalKey)
    }

    /// Thin wrapper so `autoAdvanceSlot` reads as plainly as the intents that
    /// call the same store function directly.
    private static func setSlotOverride(slotKey: Int, naturalSlotKey: Int) {
        WidgetStore.setSlotOverride(slotKey: slotKey, naturalSlotKey: naturalSlotKey)
        WidgetStore.markInteraction()
    }
}
