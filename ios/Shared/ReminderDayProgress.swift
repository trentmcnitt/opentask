import Foundation

/// "Day complete" and the per-period counts (2026-09-29) — the pure half of
/// the Reminders widget's finished states, shared by the phone/Mac widget and
/// the watch, and covered by `ReminderDayProgressTests` (`OpenTaskLogicTests`).
///
/// Foundation-only on purpose: every rule a render depends on lives here, and
/// the views only pick fonts.
///
/// The vocabulary (approved from mockups r3, "remove the word considered"):
/// - **Mid-period**: the list, and "4 of 7" at the bottom left (`countText`).
/// - **A finished period** (nothing waiting, something handled): a seal and
///   "Complete" — no count line; the bottom-left "7 of 7" carries the count
///   (Trent, 2026-09-29 follow-up). No tint.
/// - **Day complete** (`isDayComplete`): every period has nothing waiting —
///   including the ones that haven't started — and at least one item was
///   handled today. A faint green wash over the whole card, and EVERY period
///   reads "Congratulations / Day complete" — not only the clock's (it was
///   the clock's period alone in #191; Trent: congratulations on every
///   segment).
///
/// It replaced "All caught up", which fired once every STARTED period was
/// finished — at 9 pm with Night's reminders still to come, it was a false
/// finish line.
///
/// Quota prompts count exactly like reminders here, as in every other count
/// the Reminders surfaces show (`ReminderGroupDTO.waitingCount`/
/// `consideredCount`).
///
/// Task segments (2026-10-11, "segments as slots"): a task segment with a
/// row still waiting keeps the day open — Trent, on the widget: "there is no
/// indication that it's there or how complete it is." They sit AFTER the
/// periods in the strip (`stripBars`), carry their own "X of Y"
/// (`PeriodCount(segment)`), and `isDayComplete` asks them too. They still
/// count toward no PERIOD's number: a period's "N of M", "N left" and
/// `handledTotal` are reminders and prompts only.
enum ReminderDayProgress {

    // MARK: Day complete

    /// Everything handled today, across every period: considered reminders
    /// plus handled quota prompts.
    static func handledTotal(_ groups: [ReminderGroupDTO]) -> Int {
        groups.reduce(0) { $0 + $1.consideredCount }
    }

    /// Every period of today — started or not — has nothing waiting, no task
    /// segment shown today has a row waiting, and at least one item (a
    /// reminder, a prompt, or a segment row considered or deferred) was
    /// handled. A day with nothing configured (or nothing in any period) is
    /// never "complete": there was no work to finish, so it keeps its
    /// ordinary empty state rather than a celebration.
    ///
    /// `segments` is required, not defaulted, so every caller says whether it
    /// knows them (2026-10-11): a waiting task segment means the day isn't
    /// done — the strip shows its bar unfinished, so "Congratulations" above
    /// it would contradict the card. Pass the LISTED, pending-filtered
    /// segments the surface draws.
    static func isDayComplete(_ groups: [ReminderGroupDTO], segments: [TaskSegmentDTO]) -> Bool {
        let handled = handledTotal(groups) + segments.reduce(0) { $0 + $1.handledCount }
        return handled > 0 && groups.allSatisfy(\.hasNothingWaiting) && !segments.contains(where: \.hasWaiting)
    }

    // MARK: Per-period counts

    /// One period's "handled of total" — the bottom-left "4 of 7". The total
    /// is the period's whole day (waiting plus handled), so it never shrinks
    /// as things are checked off.
    struct PeriodCount: Equatable {
        let handled: Int
        let total: Int

        init(handled: Int, total: Int) {
            self.handled = handled
            self.total = total
        }

        init(_ group: ReminderGroupDTO) {
            handled = group.consideredCount
            total = group.waitingCount + group.consideredCount
        }

        /// A task segment's "X of Y" (2026-10-11): considered or deferred
        /// today over every row it holds today (`TaskSegmentDTO.handledCount`).
        init(_ segment: TaskSegmentDTO) {
            handled = segment.handledCount
            total = segment.tasks.count
        }

        /// "4 of 7". The caller hides it when `total == 0` — "0 of 0" reports
        /// nothing.
        var text: String { "\(handled) of \(total)" }
    }

    // MARK: What the body shows when the on-screen period has no rows

    /// The Reminders widget's body when the list for the on-screen period is
    /// empty (nothing waiting, and — with "show completed" on — nothing done
    /// either). `displayedIndex` is the period on screen.
    enum EmptyBody: Equatable {
        /// No periods at all today.
        case noReminders
        /// The whole day is done — shown on whichever period is on screen.
        case dayComplete
        /// This period is finished ("Complete"): something was handled in
        /// it and nothing is waiting.
        case periodDone
        /// This period never had anything.
        case nothingHere
    }

    static func emptyBody(
        groups: [ReminderGroupDTO], segments: [TaskSegmentDTO], displayedIndex: Int
    ) -> EmptyBody {
        guard !groups.isEmpty else { return .noReminders }
        if isDayComplete(groups, segments: segments) { return .dayComplete }
        if groups.indices.contains(displayedIndex), groups[displayedIndex].consideredCount > 0 {
            return .periodDone
        }
        return .nothingHere
    }

    /// The same question on a task segment page (2026-10-11) — a segment
    /// with nothing waiting reads like a finished period: "Congratulations /
    /// Day complete" when the whole day is, else the seal and "Complete".
    /// (It used to say "All considered".) A listed segment always holds a
    /// row, so `.nothingHere` is only a guard.
    static func emptyBody(
        segment: TaskSegmentDTO, groups: [ReminderGroupDTO], segments: [TaskSegmentDTO]
    ) -> EmptyBody {
        if isDayComplete(groups, segments: segments) { return .dayComplete }
        return segment.handledCount > 0 ? .periodDone : .nothingHere
    }

    // MARK: The progress strip (2026-09-23; task segments 2026-10-11)

    /// Has this period's time arrived? The un-slotted "Anytime" group has no
    /// start time and is always available, so it counts as started — the
    /// web's `slotHasStarted` (src/lib/reminders-summary.ts) and the watch's
    /// `WatchSlotLogic.state` agree. `RemindersTimeline.hasStarted` calls this.
    ///
    /// Within the OpenTask day ("Day starts at" PR 3, `minutesIntoDay`): with
    /// the day starting at 3:00, at 00:30 every period of the evening's day
    /// has started — the roster is still that day's — and a 1:00 AM period
    /// starts at the END of its day.
    static func hasStarted(_ group: ReminderGroupDTO, now: Date, day: OpenTaskDay) -> Bool {
        guard let minutes = group.slot?.startMinutes else { return true }
        return day.minutesIntoDay(minutes) <= day.minutesIntoDay(of: now)
    }

    /// One bar of the Reminders widget's strip.
    struct StripBar: Equatable {
        enum Kind: Equatable { case period, taskSegment }
        /// indigo while something waits, green once nothing does, a faint
        /// track while the period's time hasn't come.
        enum State: Equatable { case behind, done, upcoming }

        /// The page this bar jumps to — a period's `slotKey` or a segment's
        /// `pageKey` (one Int space, `RemindersTimeline`'s page ring).
        let key: Int
        let kind: Kind
        /// For VoiceOver: "Morning", "Tasks · Days".
        let label: String
        let state: State
        let handled: Int
        /// The bar's width weight: the period's (or segment's) day total, so
        /// checking things off moves the fill but never resizes a bar.
        let total: Int
        /// A task segment's kind — its horizon or Upcoming, which picks its
        /// colour (`SegmentKind.colorHex`); nil for a period.
        var segment: SegmentKind? = nil

        /// How far it has filled.
        var fraction: Double { total > 0 ? Double(handled) / Double(total) : 0 }
    }

    /// The strip, left to right: one bar per period with anything in it
    /// today, then one per task segment shown today (`segments` LISTED, in
    /// ring order) — "segments as slots" (Trent, 2026-10-11: "it's really
    /// bizarre that it doesn't have segments for the tasks. you have to <-
    /// and -> to get to it and there is no indication that it's there or how
    /// complete it is").
    ///
    /// A segment's bar is weighed and filled by its "X of Y" (`PeriodCount(
    /// segment)`), and is always STARTED — it is shown today, so it is never
    /// the faint "not yet" track: indigo while a row waits, green once none
    /// does. A period that was finished early reads done whatever the clock
    /// says (the web `ReminderSlotBar`'s rule).
    static func stripBars(
        groups: [ReminderGroupDTO], segments: [TaskSegmentDTO], now: Date, day: OpenTaskDay
    ) -> [StripBar] {
        let periods = groups.compactMap { group -> StripBar? in
            let count = PeriodCount(group)
            guard count.total > 0 else { return nil }
            let state: StripBar.State
            if group.hasNothingWaiting {
                state = .done
            } else {
                state = hasStarted(group, now: now, day: day) ? .behind : .upcoming
            }
            return StripBar(
                key: group.slotKey, kind: .period, label: group.label, state: state,
                handled: count.handled, total: count.total
            )
        }
        let tasks = segments.compactMap { segment -> StripBar? in
            let count = PeriodCount(segment)
            guard segment.isListed, count.total > 0 else { return nil }
            return StripBar(
                key: segment.pageKey, kind: .taskSegment, label: "Tasks · \(segment.label)",
                state: segment.hasWaiting ? .behind : .done, handled: count.handled, total: count.total,
                segment: segment.kind
            )
        }
        return periods + tasks
    }
}
