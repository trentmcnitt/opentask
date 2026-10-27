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
    /// at or before the current local time, within the OpenTask day; before
    /// the first slot, the first slot (never the trailing "Anytime"). The
    /// one implementation is `ReminderDefaultPage.clockSlotIndex`
    /// (ios/Shared), shared with the watch.
    static func naturalSlotIndex(
        in groups: [ReminderGroupDTO], now: Date = Date(), day: OpenTaskDay = DayStartStore.current
    ) -> Int {
        ReminderDefaultPage.clockSlotIndex(in: groups, now: now, day: day)
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
    // The NATURAL page is the default page (Trent's ruling, 2026-10-27):
    // `ReminderDefaultPage.key` (ios/Shared, shared with the watch) — the
    // leftmost unfinished page in the strip, except Deadlines goes first
    // while it has unseen rows. Its doc has the five steps. Segments never
    // enter `groups`; the strip draws them as their own bars after the slots
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

    /// The natural page's key — `ReminderDefaultPage.key`, the default-page
    /// rule — or nil when there are no pages at all. `segments` must already
    /// be listed and pending-filtered.
    static func naturalPageKey(
        groups: [ReminderGroupDTO], segments: [TaskSegmentDTO], now: Date = Date(),
        day: OpenTaskDay = DayStartStore.current
    ) -> Int? {
        ReminderDefaultPage.key(groups: groups, segments: segments, now: now, day: day)
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

    /// The natural page at `now`, ignoring any override.
    static func naturalPage(
        groups: [ReminderGroupDTO], segments: [TaskSegmentDTO], now: Date = Date()
    ) -> DisplayedPage {
        page(
            forKey: naturalPageKey(groups: groups, segments: segments, now: now),
            groups: groups, segments: segments, naturalSlot: naturalSlotIndex(in: groups, now: now)
        )
    }

    /// The override's page key while `override` still holds at `now` — its
    /// anchor is the natural page there and its page is still in the ring —
    /// else nil. Pure: no side effect.
    static func honoredOverrideKey(
        _ override: WidgetStore.SlotOverride?, groups: [ReminderGroupDTO], segments: [TaskSegmentDTO], now: Date
    ) -> Int? {
        guard let override,
              let naturalKey = naturalPageKey(groups: groups, segments: segments, now: now),
              override.naturalSlotKey == naturalKey,
              pageKeys(groups: groups, segments: segments).contains(override.slotKey)
        else { return nil }
        return override.slotKey
    }

    /// What a PRE-SCHEDULED entry at `now` shows (a period's opening): the
    /// manual override while it would still hold at that moment, else the
    /// natural page there. No side effect — a stale override is only
    /// cleared against the real clock (`displayedPage`).
    ///
    /// 2026-10-27 (the default-page ruling): boundary entries used to show
    /// the natural page outright. With the clock's slot as the natural page,
    /// a period opening always moved it, so that was the same thing; now the
    /// natural page often stays put when a period opens (Deadlines still
    /// unseen, or the new period has nothing waiting), and showing it
    /// outright would yank a manual flip away until the next reload put it
    /// back. When the opening DOES move the default (rule 4: a period with
    /// something waiting opens), the anchor no longer matches and the
    /// default shows, as before.
    static func scheduledPage(
        groups: [ReminderGroupDTO], segments: [TaskSegmentDTO], now: Date, override: WidgetStore.SlotOverride?
    ) -> DisplayedPage {
        guard let key = honoredOverrideKey(override, groups: groups, segments: segments, now: now) else {
            return naturalPage(groups: groups, segments: segments, now: now)
        }
        return page(forKey: key, groups: groups, segments: segments, naturalSlot: naturalSlotIndex(in: groups, now: now))
    }

    /// The page actually shown: the user's chevron override while it is still
    /// valid, otherwise the natural page.
    ///
    /// SIDE EFFECT: a stale override is deleted here. An override is stale once
    /// the natural (default) page has moved off the one it was made against —
    /// a period with something waiting opened, the Deadlines page's last
    /// unseen row was seen, a page was finished — the "reset the override
    /// when the timeline refreshes into a new slot" rule, expressed as data
    /// rather than as a timer.
    static func displayedPage(
        groups: [ReminderGroupDTO], segments: [TaskSegmentDTO], now: Date = Date()
    ) -> DisplayedPage {
        let naturalSlot = naturalSlotIndex(in: groups, now: now)
        var key = naturalPageKey(groups: groups, segments: segments, now: now)
        if let override = WidgetStore.slotOverride() {
            if let honored = honoredOverrideKey(override, groups: groups, segments: segments, now: now) {
                key = honored
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
    /// waiting, move on — Trent, 2026-09-23: "once I finish morning it should
    /// take me automatically back to early morning ... so I can keep checking
    /// things off and automatically switch." Also the fix for his other
    /// complaint that prompted this: "I finished everything for the morning
    /// ... I didn't even realize I actually did not finish the things for
    /// early morning" — an already-passed slot with leftovers should not go
    /// unnoticed just because a later one is on screen.
    ///
    /// WHERE TO (2026-10-27, the default-page ruling): to the default page,
    /// `ReminderDefaultPage.key` — Deadlines while it has an unseen row, else
    /// the earliest opened period with something waiting, else the first
    /// waiting queue segment. That rule already IS "the earliest undone
    /// page", so auto-advance no longer picks a target of its own: it drops
    /// the manual override that kept the finished slot on screen, and the
    /// display follows the rule. With no override the display is already the
    /// rule's page, which moves on by itself as the tap finishes it, so there
    /// is nothing to do. (Before 10-27 the natural page was the clock's
    /// slot, so auto-advance wrote an override onto the earliest unfinished
    /// slot through the clock's, else the first waiting segment.)
    ///
    /// `groups` should be the CACHED payload as of the moment of the tap
    /// (`WidgetStore.loadReminders()`); this filters it with
    /// `WidgetStore.filterPending` itself, so the just-tapped item (already
    /// staged as a tombstone by the caller) reads as gone here too. The
    /// caller snapshots the override first
    /// (`snapshotSlotOverrideBeforeAutoAdvance`), so a failed completion or
    /// a later Undo puts the flip back.
    ///
    /// Waiting quota prompts (2026-09-24) count as "something waiting" here,
    /// exactly like reminders: a slot whose reminders are done but whose
    /// prompts are not is not finished, and acting on a slot's last prompt
    /// advances just as checking off its last reminder does.
    ///
    /// A tap on a SEGMENT page does nothing here (as before 10-27): its
    /// considered rows keep Done and Today, so a tap there can't tell
    /// "finished it" from "acted on a row of a page already finished"; an
    /// override parked on a finished segment page lapses when the default
    /// page next moves.
    static func autoAdvanceSlot(in groups: [ReminderGroupDTO], segments: [TaskSegmentDTO], now: Date = Date()) {
        guard WidgetStore.slotOverride() != nil else { return }
        let filtered = WidgetStore.filterPending(groups, now: now)
        let listed = TaskSegmentDTO.listed(WidgetStore.filterPendingSegments(segments, now: now))
        guard !filtered.isEmpty else { return }

        let shown = displayedPage(groups: filtered, segments: listed, now: now)
        guard shown.segmentIndex == nil else { return }
        guard filtered.indices.contains(shown.slotIndex), filtered[shown.slotIndex].hasNothingWaiting else {
            return // the on-screen slot still has something waiting
        }
        WidgetStore.clearSlotOverride()
        WidgetStore.markInteraction()
    }
}
