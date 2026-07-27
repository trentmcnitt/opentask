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
    let staleSince: Date?
    let isSignedOut: Bool

    var selected: TrackItem? {
        items.first { $0.id == selectedId } ?? items.first
    }

    /// Position in the chevron ring, for naming the adjacent quotas.
    var selectedIndex: Int? {
        items.firstIndex { $0.id == selectedId }
    }

    func neighborTitle(offset: Int) -> String? {
        guard items.count > 1, let index = selectedIndex else { return nil }
        let count = items.count
        return items[((index + offset) % count + count) % count].task.title
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
    /// ahead. §5 anchors a quota to its rrule period and `due_at` is that
    /// period's boundary, so the window is `[due − periodLength, due]` and
    /// `periodLength` comes from the rule's `FREQ` × `INTERVAL`. Everything
    /// else in an rrule (`BYDAY`, `BYMONTHDAY`) narrows *when* inside the
    /// period, never how long it is, so it is ignored here on purpose.
    ///
    /// Items with no rrule or no due date have no clock to be behind: they get
    /// no pace, no tick, and sort last. Inventing a period for them would put a
    /// moving marker on a bar where it means nothing.
    ///
    /// This is the whole of "behind pace" — arithmetic, deliberately not AI
    /// (§5) — and all it may do is set the default selection, the row order,
    /// and one small tick's position. It never colors anything (§5: pace
    /// renders, never alarms).
    static func trackedItems(from tasks: [TaskDTO], now: Date = Date()) -> [TrackItem] {
        tasks
            .filter(\.isTracked)
            .map { TrackItem(task: $0, elapsedFraction: elapsedFraction(for: $0, now: now)) }
            .sorted { lhs, rhs in
                // No pace sorts last; `.infinity` reads as "infinitely ahead",
                // which is exactly how a periodless item should be ranked by a
                // "most behind first" comparator.
                let l = lhs.pace ?? .infinity
                let r = rhs.pace ?? .infinity
                if l != r { return l < r }
                return lhs.id < rhs.id
            }
    }

    /// Fraction of the current period already gone, 0...1.
    static func elapsedFraction(for task: TaskDTO, now: Date = Date()) -> Double? {
        guard let end = task.dueDate, let length = periodLength(rrule: task.rrule), length > 0 else {
            return nil
        }
        let start = end.addingTimeInterval(-length)
        return min(max(now.timeIntervalSince(start) / length, 0), 1)
    }

    /// Period length implied by an rrule's `FREQ` and `INTERVAL`.
    ///
    /// Months and years are approximated (30 / 365 days). Over a period that
    /// long the tick moves by a fraction of a percent per day, so calendar
    /// exactness would buy nothing an eye could resolve.
    static func periodLength(rrule: String?) -> TimeInterval? {
        guard let rrule, !rrule.isEmpty else { return nil }

        // The server writes bare `FREQ=WEEKLY;BYDAY=MO` (see
        // `src/core/recurrence/rrule-builder.ts`); the `RRULE:` prefix is
        // stripped defensively in case a payload ever carries the iCal form.
        var freq: Substring?
        var interval = 1
        let body = rrule.uppercased().replacingOccurrences(of: "RRULE:", with: "")
        for part in body.split(separator: ";") {
            let pair = part.split(separator: "=", maxSplits: 1)
            guard pair.count == 2 else { continue }
            switch pair[0].trimmingCharacters(in: .whitespaces) {
            case "FREQ": freq = pair[1]
            case "INTERVAL": interval = max(Int(pair[1]) ?? 1, 1)
            default: break
            }
        }

        let day: TimeInterval = 86_400
        switch freq {
        case "HOURLY": return 3_600 * Double(interval)
        case "DAILY": return day * Double(interval)
        case "WEEKLY": return day * 7 * Double(interval)
        case "MONTHLY": return day * 30 * Double(interval)
        case "YEARLY": return day * 365 * Double(interval)
        default: return nil
        }
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
            // to pre-schedule and the 30-minute refresh carries it.
            let entry = await currentEntry()
            let next = Date().addingTimeInterval(Self.refreshInterval)
            completion(Timeline(entries: [entry], policy: .after(next)))
        }
    }

    /// Shares `TaskFeed` with the Tasks widget — same endpoint, same cache,
    /// same §8 optimistic staging, different slice.
    private func currentEntry() async -> TrackEntry {
        let now = Date()
        let snapshot = await TaskFeed.snapshot(now: now)

        guard !snapshot.isSignedOut else {
            return TrackEntry(
                date: now, items: [], selectedId: WidgetStore.noTrackSelection,
                staleSince: nil, isSignedOut: true
            )
        }

        let items = TrackTimeline.trackedItems(from: snapshot.tasks, now: now)
        return TrackEntry(
            date: now,
            items: items,
            selectedId: TrackTimeline.selectedId(in: items),
            staleSince: snapshot.staleSince,
            isSignedOut: false
        )
    }
}

// MARK: - Widget

struct TrackWidget: Widget {
    static let kind = "OpenTaskTrack"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: TrackProvider()) { entry in
            TrackWidgetView(entry: entry)
        }
        .configurationDisplayName("Track")
        .description("Your quotas, with +1 to log one. The 2×2 shows a single ring.")
        // systemSmall FIRST here, alone among the three kinds: §8 calls the 2×2
        // the flagship Track layout — a quota compresses to a ring and a
        // fraction perfectly, which a list of them does not. (Observed on iOS
        // 26 the gallery orders its cards small→large regardless of this array,
        // so the ordering is a statement of intent, not a lever.)
        .supportedFamilies([
            .systemSmall,
            .systemLarge,
            .systemMedium,
            .accessoryRectangular,
            .accessoryCircular,
        ])
    }
}
