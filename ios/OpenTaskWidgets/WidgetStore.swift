import Foundation

/// The widget extension's slice of App Group `UserDefaults`.
///
/// Two jobs:
///
/// 1. **Payload cache.** A widget timeline is built on the system's schedule,
///    not the user's, so a failed fetch must never blank the widget. The last
///    successful payload is written here and re-rendered with an "as of HH:MM"
///    note until a fetch succeeds again.
/// 2. **Chevron navigation state.** Widgets are stateless between timeline
///    builds, so "which slot / which project is the user looking at" has to
///    live outside the view. The chevron `AppIntent`s write here and then ask
///    WidgetKit to reload; `getTimeline` reads it back.
///
/// Everything is best-effort: if the App Group suite is unavailable the widget
/// still renders, it just loses cache and navigation state.
enum WidgetStore {
    static let appGroup = "group.io.mcnitt.opentask"

    private static var defaults: UserDefaults? {
        UserDefaults(suiteName: appGroup)
    }

    // MARK: - Cached payloads

    /// A fetched payload plus the moment it was fetched, so a stale render can
    /// say *how* stale it is instead of silently lying.
    struct Cached<T: Codable>: Codable {
        let value: T
        let fetchedAt: Date
    }

    struct RemindersCache: Codable {
        let groups: [ReminderGroupDTO]
    }

    struct TasksCache: Codable {
        let tasks: [TaskDTO]
        let projects: [ProjectDTO]
    }

    private static let remindersKey = "widget.cache.reminders"
    private static let tasksKey = "widget.cache.tasks"

    static func save<T: Codable>(_ value: T, forKey key: String, at date: Date = Date()) {
        guard let data = try? JSONEncoder().encode(Cached(value: value, fetchedAt: date)) else {
            return
        }
        defaults?.set(data, forKey: key)
    }

    static func load<T: Codable>(_ type: T.Type, forKey key: String) -> Cached<T>? {
        guard let data = defaults?.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(Cached<T>.self, from: data)
    }

    static func saveReminders(_ groups: [ReminderGroupDTO]) {
        save(RemindersCache(groups: groups), forKey: remindersKey)
    }

    static func loadReminders() -> Cached<RemindersCache>? {
        load(RemindersCache.self, forKey: remindersKey)
    }

    static func saveTasks(_ tasks: [TaskDTO], projects: [ProjectDTO]) {
        save(TasksCache(tasks: tasks, projects: projects), forKey: tasksKey)
    }

    static func loadTasks() -> Cached<TasksCache>? {
        load(TasksCache.self, forKey: tasksKey)
    }

    // MARK: - Optimistic interactions (§8: check-off must be instant)
    //
    // A check-off's server round trip takes seconds; waiting for it before
    // repainting reads as a dead button. So intents stage their effect here as
    // a tombstone, repaint immediately from cache, and let the server call
    // reconcile behind the paint. TTL semantics:
    //
    // - While a tombstone is live, providers hide the item no matter what a
    //   fetch returns (covers the window where the server hasn't committed yet).
    // - A FAILED call clears its tombstone, so the item honestly reappears.
    // - Expiry (90s) is the backstop for a crashed intent — by then the next
    //   real fetch reflects server truth anyway.

    private static let pendingCompletionsKey = "widget.pendingCompletions"
    private static let pendingProgressKey = "widget.pendingProgress"
    private static let pendingTTL: TimeInterval = 90

    /// "An interaction happened seconds ago" — providers use this to skip the
    /// network fetch and repaint straight from cache, which is what makes the
    /// tap feel instant. Scheduled reloads fall outside the window and fetch.
    static func hasRecentInteraction(within seconds: TimeInterval = 10, now: Date = Date()) -> Bool {
        let cutoff = now.timeIntervalSince1970 - seconds
        let stamps = Array(pendingMap(pendingCompletionsKey).values)
            + Array(pendingMap(pendingProgressKey).values)
        return stamps.contains { $0 >= cutoff }
    }

    static func stagePendingCompletion(_ id: Int, now: Date = Date()) {
        var map = pendingMap(pendingCompletionsKey)
        map[String(id)] = now.timeIntervalSince1970
        defaults?.set(map, forKey: pendingCompletionsKey)
    }

    static func clearPendingCompletion(_ id: Int) {
        var map = pendingMap(pendingCompletionsKey)
        map.removeValue(forKey: String(id))
        defaults?.set(map, forKey: pendingCompletionsKey)
    }

    /// Live (un-expired) tombstones, pruning expired ones as a side effect.
    static func pendingCompletions(now: Date = Date()) -> Set<Int> {
        var map = pendingMap(pendingCompletionsKey)
        let cutoff = now.timeIntervalSince1970 - pendingTTL
        var live = Set<Int>()
        for (key, stamp) in map {
            if stamp >= cutoff, let id = Int(key) {
                live.insert(id)
            } else {
                map.removeValue(forKey: key)
            }
        }
        defaults?.set(map, forKey: pendingCompletionsKey)
        return live
    }

    /// Optimistic +1s for the Track widget: id -> most recent stage time.
    /// Deltas are applied on top of whatever payload renders; the count is
    /// intentionally NOT stored (the next fetch carries the server's number,
    /// and stacking a stale local delta on top of it would double-count).
    static func stagePendingProgress(_ id: Int, now: Date = Date()) {
        var map = pendingMap(pendingProgressKey)
        map[String(id)] = now.timeIntervalSince1970
        defaults?.set(map, forKey: pendingProgressKey)
    }

    static func clearPendingProgress(_ id: Int) {
        var map = pendingMap(pendingProgressKey)
        map.removeValue(forKey: String(id))
        defaults?.set(map, forKey: pendingProgressKey)
    }

    private static func pendingMap(_ key: String) -> [String: Double] {
        (defaults?.dictionary(forKey: key) as? [String: Double]) ?? [:]
    }

    /// Remove tombstoned items from a fetched or cached payload.
    static func filterPending(_ tasks: [TaskDTO], now: Date = Date()) -> [TaskDTO] {
        let pending = pendingCompletions(now: now)
        guard !pending.isEmpty else { return tasks }
        return tasks.filter { !pending.contains($0.id) }
    }

    static func filterPending(_ groups: [ReminderGroupDTO], now: Date = Date()) -> [ReminderGroupDTO] {
        let pending = pendingCompletions(now: now)
        guard !pending.isEmpty else { return groups }
        return groups.map { group in
            ReminderGroupDTO(
                slot: group.slot,
                reminders: group.reminders.filter { !pending.contains($0.id) }
            )
        }
    }

    // MARK: - Reminders slot override

    private static let slotOverrideKey = "widget.reminders.slotKey"
    private static let slotOverrideAnchorKey = "widget.reminders.naturalSlotKey"

    /// The slot the user chevroned to, paired with the slot the clock was in
    /// when they did it.
    ///
    /// The pairing is what makes the override self-expiring: as soon as real
    /// time crosses into a different slot, the anchor no longer matches and the
    /// override is dropped, so the widget returns to "the slot you're actually
    /// in" without any timer or explicit reset.
    struct SlotOverride {
        let slotKey: Int
        let naturalSlotKey: Int
    }

    static func slotOverride() -> SlotOverride? {
        guard let defaults,
              defaults.object(forKey: slotOverrideKey) != nil,
              defaults.object(forKey: slotOverrideAnchorKey) != nil
        else {
            return nil
        }
        return SlotOverride(
            slotKey: defaults.integer(forKey: slotOverrideKey),
            naturalSlotKey: defaults.integer(forKey: slotOverrideAnchorKey)
        )
    }

    static func setSlotOverride(slotKey: Int, naturalSlotKey: Int) {
        defaults?.set(slotKey, forKey: slotOverrideKey)
        defaults?.set(naturalSlotKey, forKey: slotOverrideAnchorKey)
    }

    static func clearSlotOverride() {
        defaults?.removeObject(forKey: slotOverrideKey)
        defaults?.removeObject(forKey: slotOverrideAnchorKey)
    }

    // MARK: - Tasks project scope

    private static let projectScopeKey = "widget.tasks.projectId"

    /// Project id the Tasks widget is scoped to, or `allProjects` for no scope.
    /// Persisted as an id rather than an index so renaming or reordering
    /// projects doesn't silently move the user to a different one.
    static let allProjects = -1

    static var projectScope: Int {
        get {
            guard let defaults, defaults.object(forKey: projectScopeKey) != nil else {
                return allProjects
            }
            return defaults.integer(forKey: projectScopeKey)
        }
        set { defaults?.set(newValue, forKey: projectScopeKey) }
    }
}
