import SwiftUI
import WidgetKit

// MARK: - Entry

struct TrackEntry: TimelineEntry {
    let date: Date
    /// Every tracked item (§5, `progress_target > 1`), most behind pace first.
    let items: [TrackItem]
    /// Task id the small and accessory families render, or
    /// `WidgetStore.noTrackSelection` when there is nothing tracked.
    let selectedId: Int
    /// Task id the LIST families' (4×2/4×4) window starts from. Independent
    /// of `selectedId` (2026-09-22, "Eggs moves to the top") — see
    /// `WidgetStore.trackPageStart`'s doc for why these are two values, not
    /// one, and `TrackTimeline.pageStartId(in:)`'s for why its fallback
    /// deliberately differs from `selectedId`'s.
    let pageStartId: Int
    let staleSince: Date?
    let isSignedOut: Bool
    /// Whether the header's Undo/Redo buttons should be enabled at THIS
    /// entry's `date` — see `WidgetStore.canUndo`/`canRedo` and
    /// `UndoRedoButtons`. Not time-windowed (2026-09-23) — see
    /// `RemindersEntry`'s identical doc.
    let canUndo: Bool
    let canRedo: Bool
    /// The header subtitle's "Undid: …" / "Redid: …" indication — see
    /// `RemindersEntry.actionDescription`'s doc.
    let actionDescription: String?

    var selected: TrackItem? {
        items.first { $0.id == selectedId } ?? items.first
    }

    /// Where the list window starts. NOT `selectedIndex` — see `pageStartId`.
    var pageStartIndex: Int? {
        items.firstIndex { $0.id == pageStartId }
    }
}

/// A tracked task paired with the §5 pace maths, resolved once in the provider
/// so every family draws the same numbers.
struct TrackItem: Identifiable {
    let task: TaskDTO
    /// How much of the current period has gone by, 0...1. Nil when the item has
    /// no period (see `TrackTimeline.elapsedFraction`).
    let elapsedFraction: Double?

    var id: Int { task.id }

    /// Progress against target, clamped for drawing. The *count* is never
    /// clamped — §5 keeps overflow (3/2) observable, this only stops a ring
    /// from winding past full.
    var doneFraction: Double {
        guard task.progressTarget > 0 else { return 0 }
        return min(Double(task.progressCurrent) / Double(task.progressTarget), 1)
    }

    /// Signed pace: 0 exactly on schedule, negative behind, positive ahead.
    var pace: Double? {
        elapsedFraction.map { doneFraction - $0 }
    }

    var isMet: Bool { task.isProgressMet }
}

// MARK: - Track selection and pace

/// Which quotas exist, how they are ordered, and which one the 2×2 shows.
///
/// Split out of the provider for the same reason as `RemindersTimeline`:
/// `ShiftTrackItemIntent` has to answer "which item is selected" from a
/// different process entry point, and two implementations of that rule would
/// drift apart.
enum TrackTimeline {

    /// Every tracked item, most behind pace first.
    ///
    /// **Pace (§5)** is `fraction of target done − fraction of period elapsed`,
    /// both clamped to 0...1: 0 is exactly on pace, negative behind, positive
    /// ahead. The period is the window `[progress_period_start, that + one
    /// period]`: the server anchors every quota to the local calendar boundary
    /// its period began on and advances that anchor as each period closes, and
    /// the length comes from the rule's `FREQ` × `INTERVAL`. Everything else in
    /// an rrule (`BYDAY`, `BYMONTHDAY`) narrows *when* inside the period, never
    /// how long it is, so it is ignored here on purpose.
    ///
    /// The anchor replaced `due_at`, which used to stand in for the period's
    /// end. A quota is dateless as of §5 — `due_at` is always null on one now —
    /// so that window had silently collapsed: every pace read nil, every quota
    /// tied, and the ranking below quietly degraded to id order.
    ///
    /// Items with no rrule or no anchor have no clock to be behind: they get
    /// no pace, no tick, and sort last. Inventing a period for them would put a
    /// moving marker on a bar where it means nothing.
    ///
    /// This is the whole of "behind pace" — arithmetic, deliberately not AI
    /// (§5) — and all it may do is set the default selection, the *initial* row
    /// order, and one small tick's position. It never colors anything (§5: pace
    /// renders, never alarms).
    ///
    /// Pure: no stored order, no side effects. `orderedItems` is what the list
    /// families render; this is the raw ranking they and the 2×2's default
    /// selection are both derived from, and what sample data uses so a gallery
    /// render can never touch the user's persisted order.
    static func pacedItems(from tasks: [TaskDTO], now: Date = Date()) -> [TrackItem] {
        tasks
            .filter(\.isTracked)
            .map { TrackItem(task: $0, elapsedFraction: elapsedFraction(for: $0, now: now)) }
            .sorted(by: isMoreBehind)
    }

    /// The one "most behind pace first" comparator, so the row order and the
    /// default 2×2 selection can never disagree about who is furthest behind.
    ///
    /// No pace sorts last; `.infinity` reads as "infinitely ahead", which is
    /// exactly how a periodless item should be ranked here.
    static func isMoreBehind(_ lhs: TrackItem, _ rhs: TrackItem) -> Bool {
        let l = lhs.pace ?? .infinity
        let r = rhs.pace ?? .infinity
        if l != r { return l < r }
        return lhs.id < rhs.id
    }

    /// The rows as the list families draw them: a STABLE order that is re-sorted
    /// by pace only when the set of quotas changes.
    ///
    /// Pace order is live, and `+1` moves an item's pace — so sorting by it on
    /// every reload meant the list rearranged itself the instant the user used
    /// it, sliding the row out from under the finger that had just tapped it.
    /// The order is therefore frozen at the last membership change: add or stop
    /// tracking a quota and the list re-ranks (there is a genuinely new list to
    /// present), tap `+1` a hundred times and nothing moves. Nothing is lost —
    /// pace is still fully expressed by each row's bar and tick, which is where
    /// §5 says it belongs.
    ///
    /// A frozen order also has to be thrown away once when the pace maths
    /// itself changes, or a wrong order outlives the fix that corrected it —
    /// `WidgetStore.trackOrder` reads as empty when it was frozen under an
    /// older `trackOrderVersion`, which lands on the re-rank branch below.
    static func orderedItems(from tasks: [TaskDTO], now: Date = Date()) -> [TrackItem] {
        let paced = pacedItems(from: tasks, now: now)
        let stored = WidgetStore.trackOrder

        guard !stored.isEmpty, Set(stored) == Set(paced.map(\.id)) else {
            // Only an order that some item's pace actually shaped may retire the
            // version marker — see `WidgetStore.setTrackOrder`.
            WidgetStore.setTrackOrder(
                paced.map(\.id),
                pacedByPeriod: paced.contains { $0.pace != nil }
            )
            return paced
        }

        var rank: [Int: Int] = [:]
        for (index, id) in stored.enumerated() { rank[id] = index }
        // The sets match on this branch, so an unranked id cannot occur;
        // `.max` appends rather than crashes if that ever stops being true.
        return paced.sorted { (rank[$0.id] ?? .max, $0.id) < (rank[$1.id] ?? .max, $1.id) }
    }

    /// Fraction of the current period already gone, 0...1.
    ///
    /// The window is `[progress_period_start, that + one period]`. The anchor is
    /// the server's (`src/core/tasks/period-rollover.ts`): the UTC instant the
    /// current period began by the user's local calendar — Monday 00:00 for a
    /// week, the 1st for a month, midnight for a day — moved forward one period
    /// at a time by the rollover job, which is the same moment it zeroes
    /// `progress_current`. So the tick and the count always describe the same
    /// period.
    ///
    /// No anchor means no pace, and there is deliberately NO fallback to
    /// `due_at`: a quota is dateless (§5), so any date still sitting on one is a
    /// leftover from before that rule, and pacing from it is precisely the bug
    /// this replaced.
    static func elapsedFraction(for task: TaskDTO, now: Date = Date()) -> Double? {
        guard let start = task.periodStartDate,
              let end = periodEnd(rrule: task.rrule, from: start)
        else {
            return nil
        }
        let length = end.timeIntervalSince(start)
        guard length > 0 else { return nil }
        return min(max(now.timeIntervalSince(start) / length, 0), 1)
    }

    /// The instant the period that began at `start` ends.
    ///
    /// Calendar arithmetic rather than `start + periodLength`, now that a real
    /// anchor makes exactness free: the flat 30-day month is visibly wrong at
    /// the short end — a monthly quota in February would divide 28 days by 30
    /// and its tick would stop at 93%, never reaching the end of a period that
    /// had already ended. It also matches the server, which advances this very
    /// anchor in calendar units in the user's timezone, and it keeps a
    /// daily/weekly period honest across a DST change. `periodLength` stays as
    /// the fallback for the case where the calendar cannot answer.
    static func periodEnd(rrule: String?, from start: Date) -> Date? {
        guard let period = periodComponents(rrule: rrule) else { return nil }
        if let end = Calendar.current.date(byAdding: period.unit, value: period.count, to: start) {
            return end
        }
        guard let length = periodLength(rrule: rrule), length > 0 else { return nil }
        return start.addingTimeInterval(length)
    }

    /// The period as calendar units — `.day × 7` for a week, so a `WEEKLY`
    /// rule never depends on where the locale puts the start of its week.
    static func periodComponents(rrule: String?) -> (unit: Calendar.Component, count: Int)? {
        guard let rule = parseFrequency(rrule) else { return nil }
        switch rule.freq {
        case "HOURLY": return (.hour, rule.interval)
        case "DAILY": return (.day, rule.interval)
        case "WEEKLY": return (.day, 7 * rule.interval)
        case "MONTHLY": return (.month, rule.interval)
        case "YEARLY": return (.year, rule.interval)
        default: return nil
        }
    }

    /// Period length implied by an rrule's `FREQ` and `INTERVAL`, as a flat
    /// interval — the fallback path of `periodEnd` and nothing else.
    ///
    /// Months and years are approximated here (30 / 365 days), which is why it
    /// is the fallback and not the measure.
    static func periodLength(rrule: String?) -> TimeInterval? {
        guard let rule = parseFrequency(rrule) else { return nil }
        let day: TimeInterval = 86_400
        switch rule.freq {
        case "HOURLY": return 3_600 * Double(rule.interval)
        case "DAILY": return day * Double(rule.interval)
        case "WEEKLY": return day * 7 * Double(rule.interval)
        case "MONTHLY": return day * 30 * Double(rule.interval)
        case "YEARLY": return day * 365 * Double(rule.interval)
        default: return nil
        }
    }

    /// `FREQ` and `INTERVAL` out of an rrule; everything else is ignored.
    private static func parseFrequency(_ rrule: String?) -> (freq: String, interval: Int)? {
        guard let rrule, !rrule.isEmpty else { return nil }

        // The server writes bare `FREQ=WEEKLY;BYDAY=MO` (see
        // `src/core/recurrence/rrule-builder.ts`); the `RRULE:` prefix is
        // stripped defensively in case a payload ever carries the iCal form.
        var freq: String?
        var interval = 1
        let body = rrule.uppercased().replacingOccurrences(of: "RRULE:", with: "")
        for part in body.split(separator: ";") {
            let pair = part.split(separator: "=", maxSplits: 1)
            guard pair.count == 2 else { continue }
            switch pair[0].trimmingCharacters(in: .whitespaces) {
            case "FREQ": freq = String(pair[1])
            case "INTERVAL": interval = max(Int(pair[1]) ?? 1, 1)
            default: break
            }
        }

        guard let freq else { return nil }
        return (freq, interval)
    }

    /// The quota the 2×2 shows: the user's chevron choice while that item still
    /// exists, otherwise the most behind-pace one.
    ///
    /// The choice is sticky — unlike the Reminders slot override (which expires
    /// when the clock moves on) a quota has no "wrong moment to be looking at
    /// it", so nothing here should second-guess an explicit tap. It resets only
    /// when the chosen item stops being tracked.
    static func selectedId(in items: [TrackItem]) -> Int {
        let stored = WidgetStore.trackSelection
        if stored != WidgetStore.noTrackSelection, items.contains(where: { $0.id == stored }) {
            return stored
        }
        // Live pace, deliberately not `items.first`: the list order is frozen
        // between membership changes (see `orderedItems`), but the 2×2 is a
        // single card with nothing to shuffle under a finger, so its default is
        // free to track pace exactly the way §8 defines it.
        return items.min(by: isMoreBehind)?.id ?? WidgetStore.noTrackSelection
    }

    /// The item the LIST families' window starts from: the user's chevron
    /// position while that item still exists, otherwise the FROZEN order's
    /// first item (2026-09-22, "Eggs moves to the top").
    ///
    /// NOT a twin of `selectedId(in:)` — the two have the same shape (a
    /// sticky pin over a fallback) but deliberately DIFFERENT fallbacks, for
    /// the same reason they're different values at all. `selectedId(in:)`
    /// falls back to live pace because its own comment says why: the 2×2 is
    /// "a single card with nothing to shuffle under a finger". A list window
    /// has plenty to shuffle — falling back to live pace here would mean a
    /// chevron-free user (only ever tapping `+1`, which never sets
    /// `trackPageStart`) gets a window that silently rotates on every
    /// unprompted 30-minute refresh as pace drifts, which is exactly the kind
    /// of unrequested movement this fix exists to remove. `items.first` is
    /// `orderedItems`' frozen position 0 — as stable as that order already
    /// is, re-anchoring only when membership genuinely changes.
    static func pageStartId(in items: [TrackItem]) -> Int {
        let stored = WidgetStore.trackPageStart
        if stored != WidgetStore.noTrackSelection, items.contains(where: { $0.id == stored }) {
            return stored
        }
        return items.first?.id ?? WidgetStore.noTrackSelection
    }
}

// MARK: - Provider

struct TrackProvider: TimelineProvider {

    private static let refreshInterval: TimeInterval = 30 * 60

    func placeholder(in context: Context) -> TrackEntry {
        SampleData.trackEntry
    }

    func getSnapshot(in context: Context, completion: @escaping (TrackEntry) -> Void) {
        if context.isPreview {
            completion(SampleData.trackEntry)
            return
        }
        Task { completion(await currentEntry()) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TrackEntry>) -> Void) {
        Task {
            // One entry, unlike the other two kinds: a quota has no moment in
            // the day that flips it. Pace drifts continuously and the period
            // boundary resets `progress_current` server-side, which no
            // pre-scheduled local entry could know about — so there is nothing
            // to pre-schedule and the 30-minute refresh carries it. The
            // The "Undid: …" indication expiry (2026-09-23) is the one
            // exception: still a real moment this provider has to know about
            // ahead of the 30-minute refresh — see RemindersProvider's
            // identical block.
            let entry = await currentEntry()
            var entries = [entry]
            if !entry.isSignedOut, entry.actionDescription != nil,
                let expiry = WidgetStore.lastActionExpiry(), expiry > entry.date {
                entries.append(
                    TrackEntry(
                        date: expiry,
                        items: entry.items,
                        selectedId: entry.selectedId,
                        pageStartId: entry.pageStartId,
                        staleSince: entry.staleSince,
                        isSignedOut: false,
                        canUndo: entry.canUndo,
                        canRedo: entry.canRedo,
                        actionDescription: nil
                    )
                )
            }
            let next = Date().addingTimeInterval(Self.refreshInterval)
            completion(Timeline(entries: entries, policy: .after(next)))
        }
    }

    /// Shares `TaskFeed` with the Tasks widget — same endpoint, same cache,
    /// same §8 optimistic staging, different slice. `TaskFeed` also
    /// piggybacks the undo/redo counts fetch (2026-09-23) — see its doc.
    private func currentEntry() async -> TrackEntry {
        let now = Date()
        let snapshot = await TaskFeed.snapshot(now: now)

        guard !snapshot.isSignedOut else {
            return TrackEntry(
                date: now, items: [], selectedId: WidgetStore.noTrackSelection,
                pageStartId: WidgetStore.noTrackSelection,
                staleSince: nil, isSignedOut: true, canUndo: false, canRedo: false,
                actionDescription: nil
            )
        }

        let items = TrackTimeline.orderedItems(from: snapshot.tasks, now: now)
        return TrackEntry(
            date: now,
            items: items,
            selectedId: TrackTimeline.selectedId(in: items),
            pageStartId: TrackTimeline.pageStartId(in: items),
            staleSince: snapshot.staleSince,
            isSignedOut: false,
            canUndo: WidgetStore.canUndo,
            canRedo: WidgetStore.canRedo,
            actionDescription: WidgetStore.lastActionDescription(at: now)
        )
    }
}

// MARK: - Widget

struct TrackWidget: Widget {
    static let kind = "OpenTaskTrack"

    var body: some WidgetConfiguration {
        // Server-pushed reloads (iOS 26 / macOS 26 — see WidgetPushHandler.swift
        // and docs/NOTIFICATIONS.md § WidgetKit push) need `.pushHandler(...)`,
        // gated here rather than raising this extension's deployment target
        // (iOS 17 / macOS 14). See the doc comment in TasksWidget.swift for why
        // this needs an EXPLICIT `return` in each branch (implicit return, or
        // an `if` that isn't the body's sole statement, both fail to compile —
        // `Widget.body` has no result builder to reconcile the two branches'
        // different concrete types).
        if #available(iOS 26.0, macOS 26.0, *) {
            return StaticConfiguration(kind: Self.kind, provider: TrackProvider()) { entry in
                TrackWidgetView(entry: entry)
            }
            .configurationDisplayName("Track")
            .description("Your quotas, with +1 to log one. The 2×2 shows a single ring.")
            // systemSmall FIRST here, alone among the three kinds: §8 calls the 2×2
            // the flagship Track layout — a quota compresses to a ring and a
            // fraction perfectly, which a list of them does not. (Observed on iOS
            // 26 the gallery orders its cards small→large regardless of this array,
            // so the ordering is a statement of intent, not a lever.)
            // See RemindersWidget for why this is a closure rather than #if inside
            // the array literal (the compiler rejects the latter).
            .supportedFamilies({
                var families: [WidgetFamily] = [.systemSmall, .systemLarge, .systemMedium]
                #if os(iOS)
                families += [.accessoryRectangular, .accessoryCircular]
                #endif
                return families
            }())
            .pushHandler(OpenTaskWidgetPushHandler.self)
        } else {
            return StaticConfiguration(kind: Self.kind, provider: TrackProvider()) { entry in
                TrackWidgetView(entry: entry)
            }
            .configurationDisplayName("Track")
            .description("Your quotas, with +1 to log one. The 2×2 shows a single ring.")
            .supportedFamilies({
                var families: [WidgetFamily] = [.systemSmall, .systemLarge, .systemMedium]
                #if os(iOS)
                families += [.accessoryRectangular, .accessoryCircular]
                #endif
                return families
            }())
        }
    }
}
