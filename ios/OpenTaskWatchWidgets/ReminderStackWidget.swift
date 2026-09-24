import WidgetKit
import SwiftUI

/// `TimelineProvider` (not the `AppIntent` variant — this widget has no
/// user-facing configuration) that fetches live data via the shared
/// `APIClient`, same Keychain credentials the watch app itself uses. Written
/// as completion-based `TimelineProvider` methods with an inner `Task`,
/// matching the plain, widely-supported pattern.
///
/// All card logic lives in `ReminderStackTimeline` (pure); this type only
/// gathers inputs — network, `WatchCache` fallback, and the widget's own App
/// Group state (`WatchWidgetState`: skips, ✓ tombstones, the last snooze
/// result) — and schedules entries.
struct ReminderStackProvider: TimelineProvider {
    func placeholder(in context: Context) -> WatchWidgetEntry {
        ReminderStackPlaceholder.entry
    }

    func getSnapshot(in context: Context, completion: @escaping (WatchWidgetEntry) -> Void) {
        if context.isPreview {
            completion(ReminderStackPlaceholder.entry)
            return
        }
        completion(cachedEntries(now: Date()).first ?? ReminderStackPlaceholder.entry)
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<WatchWidgetEntry>) -> Void) {
        guard APIClient.shared.isConfigured else {
            completion(Timeline(entries: [.signedOut], policy: .after(refreshDate())))
            return
        }

        Task {
            let now = Date()
            let fetched = await fetchInputs()
            let entries = fetched.map { buildEntries(groups: $0.groups, tasks: $0.tasks, now: now) }
                ?? cachedEntries(now: now)
            completion(Timeline(
                entries: entries.isEmpty ? [ReminderStackPlaceholder.entry] : entries,
                policy: .after(refreshDate())
            ))
        }
    }

    /// Smart Stack relevance (watchOS 11+ `TimelineProvider.relevance()`,
    /// kinded `RelevantContext.date(interval:kind:)` on watchOS 26 — see
    /// `ReminderStackTimeline.relevantIntervals` for the windows). Cache-only,
    /// no network: the system may ask at any time, and every fetch (widget or
    /// app) writes the cache and invalidates this. Deliberately NOT
    /// watchOS 26's `RelevanceConfiguration` — that is a separate,
    /// system-suggested widget type (its own `RelevanceEntriesProvider` and a
    /// configuration intent) for things you'd never add yourself; Trent adds
    /// this card to his stack, so the timeline widget carries the hints.
    @available(watchOS 11.0, *)
    func relevance() async -> WidgetRelevance<Void> {
        guard let groups = WatchCache.loadReminders() else { return WidgetRelevance([]) }
        let tasks = WatchCache.loadTasks()?.tasks ?? []
        return ReminderStackTimeline.widgetRelevance(groups: groups, tasks: tasks, now: Date())
    }

    /// ~20 min budgeted refresh. Everything that changes the card on a known
    /// clock (slot starts, due times, the snooze result's expiry) is already
    /// a pre-scheduled entry (`ReminderStackTimeline.changeDates`), and every
    /// ✓/Snooze tap gets a free post-intent reload, so this only has to catch
    /// changes made elsewhere (web, phone).
    private func refreshDate() -> Date {
        Date().addingTimeInterval(20 * 60)
    }

    private struct Inputs {
        let groups: [ReminderGroupDTO]
        let tasks: [TaskDTO]
    }

    /// Live fetch, writing through `WatchCache` on success (the watch app's
    /// pages and a later failed fetch both read it). `nil` if reminders
    /// failed — the caller falls back to the cache. Tasks failing alone falls
    /// back to cached tasks rather than reading as "nothing overdue".
    private func fetchInputs() async -> Inputs? {
        async let remindersCall: RemindersPayload? = try? await APIClient.shared.fetchReminders()
        async let tasksCall: [TaskDTO]? = try? await APIClient.shared.fetchOpenTasks()
        async let slotsCall: [TimeSlotDTO]? = try? await APIClient.shared.fetchTimeSlots()
        let (reminders, tasks, slots) = await (remindersCall, tasksCall, slotsCall)

        guard let reminders else { return nil }
        WatchCache.saveReminders(reminders.groups)
        if let slots, !slots.isEmpty {
            TimeSlotStore.save(slots)
        }
        if let tasks {
            // Keep whatever projects the app cached — `saveTasks` is the one
            // write path and takes both, and no widget view needs projects.
            WatchCache.saveTasks(tasks, projects: WatchCache.loadTasks()?.projects ?? [])
        }
        return Inputs(groups: reminders.groups, tasks: tasks ?? WatchCache.loadTasks()?.tasks ?? [])
    }

    private func cachedEntries(now: Date) -> [WatchWidgetEntry] {
        guard APIClient.shared.isConfigured else { return [.signedOut] }
        guard let groups = WatchCache.loadReminders() else { return [] }
        return buildEntries(groups: groups, tasks: WatchCache.loadTasks()?.tasks ?? [], now: now)
    }

    /// The entry for now plus one per `changeDates` instant. Skip state and
    /// ✓ tombstones are read per entry date (a future entry past a slot
    /// change must not inherit the old slot's skips — `skippedIds` pairs them
    /// with the slot key, which handles it).
    private func buildEntries(groups: [ReminderGroupDTO], tasks: [TaskDTO], now: Date) -> [WatchWidgetEntry] {
        let slots = slotList(groups: groups)
        let snooze = WatchWidgetState.snoozeResult(now: now)
        let dates = [now] + ReminderStackTimeline.changeDates(
            groups: groups, tasks: tasks, snoozeResult: snooze, now: now
        )
        return dates.map { date in
            ReminderStackTimeline.entry(
                groups: groups,
                tasks: tasks,
                skipped: { WatchWidgetState.skippedIds(slotKey: $0, now: date) },
                pendingDone: WatchWidgetState.pendingDoneIds(now: date),
                snoozeResult: WatchWidgetState.snoozeResult(now: date),
                slots: slots,
                at: date
            )
        }
    }

    /// Slots for labeling "next period": the reminders payload already names
    /// every slot, falling back to the app's `TimeSlotStore` cache.
    private func slotList(groups: [ReminderGroupDTO]) -> [TimeSlotDTO] {
        let fromGroups = groups.compactMap(\.slot)
        return fromGroups.isEmpty ? TimeSlotStore.cachedSlots : fromGroups
    }
}

/// Non-identifying placeholder content for the widget gallery and
/// redaction — deliberately NOT Trent's real data (that is DEBUG preview
/// data only, `ReminderStackPreviewData`), since the gallery ships.
enum ReminderStackPlaceholder {
    static let entry = WatchWidgetEntry(
        date: Date(),
        content: .reminder(.init(
            taskId: 0, title: "Step away from the desk", slotLabel: "Midday", slotKey: 0,
            position: 2, total: 3, remainingIds: [0, 1], urgentOverdue: 0
        )),
        ring: .init(count: 2, fraction: 1.0 / 3.0, isOverdue: false, label: "Midday"),
        relevance: nil
    )
}

/// The Smart Stack widget. `accessoryRectangular` is the card (one reminder
/// with ✓/⏭, or the overdue sweep); `accessoryCircular`/`accessoryCorner` are
/// glanceable rings for watch-face slots. No `systemSmall`/`Medium`/`Large` —
/// those families don't exist on watchOS.
struct ReminderStackWidget: Widget {
    static let kind = WatchWidgetState.kind

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: ReminderStackProvider()) { entry in
            ReminderStackWidgetView(entry: entry)
        }
        .configurationDisplayName("OpenTask")
        .description("Check off the current slot's reminders, or snooze what's overdue.")
        .supportedFamilies([.accessoryRectangular, .accessoryCircular, .accessoryCorner])
    }
}
