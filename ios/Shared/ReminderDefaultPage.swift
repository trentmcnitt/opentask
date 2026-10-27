import Foundation

/// Which page the Reminders surfaces open to by default — the ONE rule the
/// phone and Mac Reminders widget (`RemindersTimeline.naturalPageKey`) and
/// the watch's Reminders page (`WatchViewModel.displayedSlotIndex`) share,
/// tested by `ReminderDefaultPageTests` (`OpenTaskLogicTests`).
///
/// TRENT'S RULING (2026-10-27, "Go with it"): one rule — the leftmost
/// unfinished page in the strip, except Deadlines goes first while it has
/// unseen rows:
/// 1. **Deadlines**, while it has ANY row not yet considered or seen today.
///    A safety-net row waits until seen; a SEEN safety-net row still waits
///    (the web's rule) but no longer counts here.
/// 2. Otherwise the **earliest unfinished period that has opened**.
/// 3. When every opened period is done: the **first unfinished task-queue
///    segment in strip order** — Today's pulls, Previous pulls, Daily,
///    Upcoming, Weekly, Monthly, Quarterly, exactly as the strip draws them
///    (the server's order). Deadlines is not in this list: once its rows
///    are all seen, step 1 is the only way it is the default.
/// 4. When the next period opens, the default goes back to that period
///    (periods sit left of the queue): the rule is re-evaluated, never
///    latched. The widget's pre-scheduled boundary entries re-run it at each
///    period's opening.
/// 5. Everything done — TRENT (2026-10-27): "When everything's complete,
///    the widget should, unless the user overrides it, automatically jump to
///    the latest reminder period." So with nothing unfinished (every opened
///    period done, no queue segment waiting, Deadlines empty or only SEEN
///    rows) the default is the **latest opened period that had anything in
///    it today**, drawn in its completed state — "Complete", or
///    "Congratulations · Day complete" when every period is done — never a
///    separate page and never Deadlines (`finishedSlotIndex`). A period with
///    nothing in it today is skipped: the server sends every slot, and an
///    empty one has no strip bar and nothing to show completed. Before the
///    first period opens nothing has opened, and the payload is TODAY'S
///    groups — yesterday's last period isn't in it (today's last period is
///    there, but not started, with its rows waiting) — so the default is the
///    next period to open that has anything in it.
///
/// A manual page flip still sticks as it always has: the widget's override
/// is anchored to the default page it was made against and lapses when this
/// rule's answer changes (`RemindersTimeline.displayedPage`); the watch's
/// stays until the user pages again.
///
/// "Opened" is `ReminderDayProgress.hasStarted` — within the OpenTask day,
/// with the un-slotted "Anytime" group always open (the web's
/// `slotHasStarted`). So an Anytime group with something waiting comes
/// before the queue (it sits left of it in the strip), and between the day
/// start and the first period nothing has opened, so a waiting queue
/// segment is the default until the first period opens.
///
/// Foundation-only: no `WidgetStore`, no clock default — the caller passes
/// `now` and the day boundary (`DayStartStore.current`).
enum ReminderDefaultPage {

    /// The default page's key — a period's `slotKey` or a segment's
    /// `pageKey` (the one Int space of `RemindersTimeline`'s page ring) — or
    /// nil when there are no pages at all.
    ///
    /// `segments` are the LISTED segments the surface draws, in the
    /// server's order, with any optimistic marker already applied (a
    /// just-considered safety-net row reads `seen`).
    static func key(
        groups: [ReminderGroupDTO], segments: [TaskSegmentDTO], now: Date, day: OpenTaskDay
    ) -> Int? {
        // 1. Deadlines while a row is unseen.
        if let deadlines = segments.first(where: { $0.kind == .deadlines }), hasUnseenRow(deadlines) {
            return deadlines.pageKey
        }
        // 2. The earliest opened period with something waiting.
        if let period = groups.first(where: {
            !$0.hasNothingWaiting && ReminderDayProgress.hasStarted($0, now: now, day: day)
        }) {
            return period.slotKey
        }
        // 3. The first queue segment with a row waiting, in strip order.
        if let segment = segments.first(where: { $0.kind != .deadlines && $0.hasWaiting }) {
            return segment.pageKey
        }
        // 5. Everything done: the latest opened period, in its completed
        // state; with no periods at all, the first segment.
        guard !groups.isEmpty else { return segments.first?.pageKey }
        return groups[finishedSlotIndex(in: groups, now: now, day: day)].slotKey
    }

    /// Step 5's period, when nothing is unfinished. Only TIMED periods with
    /// anything in them today (waiting or handled) count — "Anytime" has no
    /// place in the day, and an empty period has no bar and nothing to show
    /// completed:
    /// 1. the latest that has opened (`ReminderDayProgress.hasStarted`'s
    ///    test, within the OpenTask day) — Trent's "latest reminder period";
    /// 2. none has opened (between the day start and the first period): the
    ///    next to open — the payload holds today's groups only, so yesterday's
    ///    last period can't be drawn, and today's would draw not started;
    /// 3. no timed period has anything today: the clock's (`clockSlotIndex`).
    static func finishedSlotIndex(in groups: [ReminderGroupDTO], now: Date, day: OpenTaskDay) -> Int {
        let timed = groups.indices.compactMap { index -> (index: Int, start: Int)? in
            let group = groups[index]
            guard let raw = group.slot?.startMinutes, group.waitingCount + group.consideredCount > 0 else { return nil }
            return (index, day.minutesIntoDay(raw))
        }
        let minutes = day.minutesIntoDay(of: now)
        if let latest = timed.filter({ $0.start <= minutes }).max(by: { $0.start < $1.start }) {
            return latest.index
        }
        if let next = timed.min(by: { $0.start < $1.start }) {
            return next.index
        }
        return clockSlotIndex(in: groups, now: now, day: day)
    }

    /// Step 1's test: a deadlines-page row still waiting that is not a seen
    /// safety-net row (`SegmentTaskDTO.isSeenInSafetyNet`). An empty page,
    /// or one whose rows are all considered or seen, doesn't count.
    static func hasUnseenRow(_ segment: TaskSegmentDTO) -> Bool {
        segment.tasks.contains { $0.state == .waiting && !$0.isSeenInSafetyNet }
    }

    /// The group the clock is in: the latest slot whose start is at or
    /// before now within today's OpenTask day (`minutesIntoDay`, the web's
    /// `naturalSlotIndex`: with the day starting at 3:00, at 00:30 the
    /// evening's slot is still the latest started). From the day start until
    /// the first slot, the first real slot — never the trailing "Anytime".
    /// 0 for empty `groups`; callers check `isEmpty` before indexing.
    ///
    /// The one implementation of what `RemindersTimeline.naturalSlotIndex`
    /// and `WatchSlotLogic.naturalSlotIndex` answer (both forward here).
    static func clockSlotIndex(in groups: [ReminderGroupDTO], now: Date, day: OpenTaskDay) -> Int {
        guard !groups.isEmpty else { return 0 }
        let minutes = day.minutesIntoDay(of: now)
        var best: Int?
        var bestStart = -1
        for (index, group) in groups.enumerated() {
            guard let raw = group.slot?.startMinutes else { continue }
            let start = day.minutesIntoDay(raw)
            guard start <= minutes, start > bestStart else { continue }
            bestStart = start
            best = index
        }
        if let best { return best }
        return groups.firstIndex(where: { $0.slot != nil }) ?? 0
    }
}
