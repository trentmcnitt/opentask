import WidgetKit
import SwiftUI

/// One entry's worth of Smart Stack content — deliberately flat (no
/// `ReminderGroupDTO`/`TaskDTO` arrays) because the accessory families this
/// widget renders (`accessoryRectangular`, `accessoryCircular`,
/// `accessoryCorner`) only ever show a handful of numbers and up to two
/// titles; carrying the full payload into the entry would just be dead
/// weight the views never read.
struct WatchWidgetEntry: TimelineEntry {
    let date: Date
    let isConfigured: Bool
    /// Current slot's label ("Midday"), or "Reminders" when there are no
    /// slots configured at all.
    let slotLabel: String
    /// Reminders still pending in the current slot.
    let remindersLeft: Int
    /// `remindersLeft` + however many were already considered today in this
    /// slot — the ring's denominator. 0 when the slot has nothing at all
    /// (never started, or truly empty), which both ring views read as "no
    /// progress to show" rather than dividing by zero.
    let remindersTotal: Int
    /// Overdue task count (§ Tasks page's "Up next" scope), shown on the
    /// rectangular widget in place of an upcoming title when there's
    /// something more pressing than the current slot's reminders, and used
    /// by the ring views as a fallback subject once the current slot's own
    /// reminders are all done.
    let overdueCount: Int
    /// Up to 2 reminder titles from the current slot, earliest first — never
    /// truncated by this struct (Trent's "never truncate a reminder" rule);
    /// the VIEW is responsible for how much of a title actually fits.
    let upcomingTitles: [String]

    static let signedOut = WatchWidgetEntry(
        date: Date(), isConfigured: false, slotLabel: "OpenTask",
        remindersLeft: 0, remindersTotal: 0, overdueCount: 0, upcomingTitles: []
    )

    /// Non-identifying placeholder content for the widget gallery and
    /// redaction — same reasoning as the phone widgets' `SampleData`
    /// (`ios/OpenTaskWidgets/SampleData.swift`), independently written here
    /// since that file lives in a target this one may not import.
    static let sample = WatchWidgetEntry(
        date: Date(), isConfigured: true, slotLabel: "Midday",
        remindersLeft: 2, remindersTotal: 3, overdueCount: 1,
        upcomingTitles: ["Step away from the desk", "Drink water"]
    )
}

/// `TimelineProvider` (not the `AppIntent` variant — this widget has no
/// user-facing configuration) that fetches live data via the shared
/// `APIClient`, same Keychain credentials the watch app itself uses. Written
/// as completion-based `TimelineProvider` methods with an inner `Task` rather
/// than the newer async provider protocol, matching the plain,
/// widely-supported pattern and keeping this file readable independent of
/// which async provider variant a given watchOS SDK offers.
struct ReminderStackProvider: TimelineProvider {
    func placeholder(in context: Context) -> WatchWidgetEntry {
        .sample
    }

    func getSnapshot(in context: Context, completion: @escaping (WatchWidgetEntry) -> Void) {
        if context.isPreview {
            completion(.sample)
            return
        }
        completion(cachedOrSampleEntry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<WatchWidgetEntry>) -> Void) {
        guard APIClient.shared.isConfigured else {
            completion(Timeline(entries: [.signedOut], policy: .after(refreshDate())))
            return
        }

        Task {
            let entry = await fetchEntry() ?? cachedOrSampleEntry()
            completion(Timeline(entries: [entry], policy: .after(refreshDate())))
        }
    }

    /// ~15–30 min budgeted refresh (the task brief's range) — the watch app
    /// itself calls `WidgetCenter.shared.reloadAllTimelines()` after every
    /// mutation for the budget-free "acted just now" case, so this scheduled
    /// policy only has to cover the gap between explicit reloads: the clock
    /// crossing into a new slot, or a task becoming overdue, with nobody
    /// touching the app in between.
    private func refreshDate() -> Date {
        Date().addingTimeInterval(20 * 60)
    }

    /// Live fetch, on success writing through `WatchCache` so a later failed
    /// fetch (or the Reminders/Tasks app pages, if they ever want a fast
    /// first paint) has something recent to fall back to. `nil` on any
    /// failure — the caller falls back to the cache.
    private func fetchEntry() async -> WatchWidgetEntry? {
        async let remindersCall: RemindersPayload? = try? await APIClient.shared.fetchReminders()
        async let tasksCall: [TaskDTO]? = try? await APIClient.shared.fetchOpenTasks()
        let (reminders, tasks) = await (remindersCall, tasksCall)

        guard let reminders else { return nil }
        WatchCache.saveReminders(reminders.groups)
        if let tasks {
            // Projects aren't needed by any accessory-family view here, but
            // `WatchCache.saveTasks` is the one write path and takes both —
            // an empty project list just means the app's next read fills in
            // stale project names for one pass, never a crash.
            WatchCache.saveTasks(tasks, projects: [])
        }
        return buildEntry(groups: reminders.groups, tasks: tasks ?? [])
    }

    private func cachedOrSampleEntry() -> WatchWidgetEntry {
        guard let groups = WatchCache.loadReminders() else {
            return APIClient.shared.isConfigured ? .sample : .signedOut
        }
        let tasks = WatchCache.loadTasks()?.tasks ?? []
        return buildEntry(groups: groups, tasks: tasks)
    }

    private func buildEntry(groups: [ReminderGroupDTO], tasks: [TaskDTO]) -> WatchWidgetEntry {
        guard !groups.isEmpty else {
            return WatchWidgetEntry(
                date: Date(), isConfigured: true, slotLabel: "Reminders",
                remindersLeft: 0, remindersTotal: 0,
                overdueCount: WatchSlotLogic.overdueTasks(from: tasks).count,
                upcomingTitles: []
            )
        }
        let index = WatchSlotLogic.naturalSlotIndex(in: groups)
        let group = groups[index]
        return WatchWidgetEntry(
            date: Date(),
            isConfigured: true,
            slotLabel: group.label,
            remindersLeft: group.reminders.count,
            remindersTotal: group.reminders.count + group.considered,
            overdueCount: WatchSlotLogic.overdueTasks(from: tasks).count,
            upcomingTitles: group.reminders.prefix(2).map(\.title)
        )
    }
}

/// The Smart Stack widget itself. `accessoryRectangular` is the "master"
/// family the task brief calls for (slot + count + next items);
/// `accessoryCircular`/`accessoryCorner` are the compact ring families for
/// denser stack contexts. No `systemSmall`/`systemMedium`/`systemLarge` —
/// those families don't exist on watchOS.
struct ReminderStackWidget: Widget {
    static let kind = "OpenTaskWatchReminders"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: ReminderStackProvider()) { entry in
            ReminderStackWidgetView(entry: entry)
        }
        .configurationDisplayName("OpenTask")
        .description("Current slot's reminders and overdue tasks.")
        .supportedFamilies([.accessoryRectangular, .accessoryCircular, .accessoryCorner])
    }
}

#Preview("Rectangular", as: .accessoryRectangular) {
    ReminderStackWidget()
} timeline: {
    WatchWidgetEntry.sample
    WatchWidgetEntry.signedOut
}

#Preview("Circular", as: .accessoryCircular) {
    ReminderStackWidget()
} timeline: {
    WatchWidgetEntry.sample
}

#Preview("Corner", as: .accessoryCorner) {
    ReminderStackWidget()
} timeline: {
    WatchWidgetEntry.sample
}
