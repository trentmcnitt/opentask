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
    /// macOS App Group IDs need the team-ID prefix in the entitlement itself
    /// (unlike iOS's bare form) — see `KeychainHelper.swift` for the same
    /// split, confirmed empirically there (2026-09-22): a `UserDefaults`
    /// suite name has to match one of the entitlement's strings exactly, and
    /// this project's macOS entitlement lists only the prefixed form.
    #if os(macOS)
    static let appGroup = "GEL3VGTUJX.group.io.mcnitt.opentask"
    #else
    static let appGroup = "group.io.mcnitt.opentask"
    #endif

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
        /// Today's completions (2026-09-23, "show completed") — see this
        /// file's "Show completed" section. A CUSTOM `init(from:)` (not the
        /// synthesized memberwise one `Codable` would otherwise generate) is
        /// required here, not merely a default value on the property: a
        /// stored property's default only applies when the MEMBERWISE init
        /// is used, and a synthesized `Decodable.init(from:)` still requires
        /// every key to be present. Without this, an on-device cache written
        /// by a build before this field existed would fail to decode on
        /// first load after this update — losing the WHOLE cache (tasks and
        /// projects too), not just the new field.
        let completions: [CompletionDTO]

        enum CodingKeys: String, CodingKey {
            case tasks, projects, completions
        }

        init(tasks: [TaskDTO], projects: [ProjectDTO], completions: [CompletionDTO] = []) {
            self.tasks = tasks
            self.projects = projects
            self.completions = completions
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            tasks = try c.decodeIfPresent([TaskDTO].self, forKey: .tasks) ?? []
            projects = try c.decodeIfPresent([ProjectDTO].self, forKey: .projects) ?? []
            completions = try c.decodeIfPresent([CompletionDTO].self, forKey: .completions) ?? []
        }
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

    /// `completions` has NO default (2026-09-23): every call site must now
    /// say explicitly what it knows about today's completions rather than
    /// silently wiping the DONE list cache to empty. `UndoLastActionIntent`/
    /// `RedoLastActionIntent`'s full refetch is the one place that would
    /// otherwise have compiled clean while quietly blanking it.
    static func saveTasks(_ tasks: [TaskDTO], projects: [ProjectDTO], completions: [CompletionDTO]) {
        save(TasksCache(tasks: tasks, projects: projects, completions: completions), forKey: tasksKey)
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

    private static let lastInteractionKey = "widget.lastInteraction"

    /// Serializes the read-modify-write of the progress map.
    ///
    /// Rapid taps arrive as CONCURRENT `perform()` calls in the widget
    /// extension process, and "read the map, add one, write it back" without a
    /// lock loses updates — which is exactly the bug the net count below exists
    /// to fix, reintroduced one layer down. It guards the taps that actually
    /// race (all in one process); it is not, and does not need to be, a
    /// cross-process barrier.
    private static let pendingLock = NSLock()

    /// "An interaction happened seconds ago" — providers use this to skip the
    /// network fetch and repaint straight from cache, which is what makes the
    /// tap feel instant. Scheduled reloads fall outside the window and fetch.
    ///
    /// Three sources: completion tombstones, +1 stamps, and the plain
    /// interaction stamp below. The last exists for CHEVRONS — pure view-state
    /// changes that stage no data at all, but still must not pay a network
    /// round trip to flip to a page that is already in the cache.
    static func hasRecentInteraction(within seconds: TimeInterval = 10, now: Date = Date()) -> Bool {
        let cutoff = now.timeIntervalSince1970 - seconds
        if let stamp = defaults?.object(forKey: lastInteractionKey) as? Double, stamp >= cutoff {
            return true
        }
        let stamps = Array(pendingMap(pendingCompletionsKey).values)
            + progressMap().values.map { $0[stampIndex] }
        return stamps.contains { $0 >= cutoff }
    }

    /// Record that a non-mutating interaction (a chevron) just happened, so the
    /// next provider pass takes the cache-only fast path.
    /// Forget the last interaction, so the next provider pass fetches from
    /// the server instead of repainting from cache.
    static func clearInteraction() {
        defaults?.removeObject(forKey: lastInteractionKey)
    }

    static func markInteraction(now: Date = Date()) {
        defaults?.set(now.timeIntervalSince1970, forKey: lastInteractionKey)
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
        liveIds(pendingCompletionsKey, now: now)
    }

    private static func liveIds(_ key: String, now: Date) -> Set<Int> {
        var map = pendingMap(key)
        let cutoff = now.timeIntervalSince1970 - pendingTTL
        var live = Set<Int>()
        for (mapKey, stamp) in map {
            if stamp >= cutoff, let id = Int(mapKey) {
                live.insert(id)
            } else {
                map.removeValue(forKey: mapKey)
            }
        }
        defaults?.set(map, forKey: key)
        return live
    }

    // MARK: Staged progress (§5 `+1` / `−1`)
    //
    // Stored as `id -> [most recent stage time, net delta]`, a COUNT and not a
    // bare stamp. One stamp per task could only ever draw a single `+1` however
    // many taps landed, so four quick taps on a 4× quota read as 1/4 until the
    // fetch reconciled: the widget looked like it was dropping taps (it wasn't),
    // and a correction had no way to render at all.
    //
    // `[String: [Double]]` because that is what round-trips through UserDefaults
    // unaided — a struct would need encoding, and the stamp and the count have
    // to move together or expiry can prune one without the other. A map written
    // by the older `[String: Double]` build fails the per-entry parse and reads
    // as empty, which is a one-time loss of in-flight stamps at upgrade: the
    // same thing the 90s expiry does to them anyway.

    private static let stampIndex = 0
    private static let deltaIndex = 1

    private static func progressMap() -> [String: [Double]] {
        guard let raw = defaults?.dictionary(forKey: pendingProgressKey) else { return [:] }
        var map: [String: [Double]] = [:]
        for (key, value) in raw {
            guard let pair = value as? [Double], pair.count == 2 else { continue }
            map[key] = pair
        }
        return map
    }

    /// Stage a signed progress delta, accumulating with whatever is already in
    /// flight for that task and refreshing the recency stamp.
    ///
    /// The entry survives a net of 0 (a `+1` immediately corrected by a `−1`):
    /// the stamp is also what tells `hasRecentInteraction()` to repaint from
    /// cache, and dropping it mid-gesture would send the very next tap through a
    /// network round trip.
    static func stagePendingProgress(_ id: Int, delta: Int = 1, now: Date = Date()) {
        pendingLock.lock()
        defer { pendingLock.unlock() }

        var map = progressMap()
        let key = String(id)
        // An EXPIRED entry restarts at zero rather than accumulating: past the
        // TTL the server's number is authoritative, so a crashed intent's
        // orphaned count must not resurrect on the next tap.
        let cutoff = now.timeIntervalSince1970 - pendingTTL
        let live = map[key].map { $0[stampIndex] >= cutoff } ?? false
        let net = live ? Int(map[key]?[deltaIndex] ?? 0) : 0
        map[key] = [now.timeIntervalSince1970, Double(net + delta)]
        defaults?.set(map, forKey: pendingProgressKey)
    }

    /// Reconcile ONE staged delta — subtract it, don't drop the entry.
    ///
    /// Two taps in flight: the first response must not erase the second tap's
    /// pending `+1`, or the count visibly falls back while a second increment is
    /// still on the wire. Subtracting leaves exactly what is still unreconciled;
    /// once the net reaches 0 the entry goes and the next provider pass fetches
    /// server truth.
    ///
    /// Called on BOTH outcomes, and it is the same subtraction either way: on
    /// success the server now carries the delta, on failure the optimistic draw
    /// has to honestly revert.
    ///
    /// The one visible seam is a `+1` and a `−1` in flight together (net 0,
    /// drawn C): whichever response lands first subtracts its own delta, so the
    /// count flickers one step the wrong way for the couple of seconds until the
    /// second lands, zeroes the net, and the fetch restores C. Self-healing, and
    /// the alternative — holding reconciliation until every request returns —
    /// would need in-flight bookkeeping this map deliberately doesn't have.
    static func clearPendingProgress(_ id: Int, delta: Int = 1, now: Date = Date()) {
        pendingLock.lock()
        defer { pendingLock.unlock() }

        var map = progressMap()
        let key = String(id)
        // No live entry means nothing to reconcile. Without this guard an
        // expired (or already-cleared) entry would be written back as its own
        // inverse — a phantom `−1` drawn over an untouched count.
        guard let entry = map[key], entry[stampIndex] >= now.timeIntervalSince1970 - pendingTTL else {
            guard map.removeValue(forKey: key) != nil else { return }
            defaults?.set(map, forKey: pendingProgressKey)
            return
        }

        let net = Int(entry[deltaIndex]) - delta
        if net == 0 {
            map.removeValue(forKey: key)
        } else {
            map[key] = [entry[stampIndex], Double(net)]
        }
        defaults?.set(map, forKey: pendingProgressKey)
    }

    /// Live (un-expired) net deltas, `id -> delta`, pruning expired entries as a
    /// side effect. Same pruning semantics as `pendingCompletions()`, exposed
    /// because staged progress has to be *drawn* (the ring moves, the count
    /// changes) rather than merely hiding a row the way a tombstone does.
    static func pendingProgressDeltas(now: Date = Date()) -> [Int: Int] {
        pendingLock.lock()
        defer { pendingLock.unlock() }

        var map = progressMap()
        let cutoff = now.timeIntervalSince1970 - pendingTTL
        var live: [Int: Int] = [:]
        for (key, entry) in map {
            if entry[stampIndex] >= cutoff, let id = Int(key) {
                live[id] = Int(entry[deltaIndex])
            } else {
                map.removeValue(forKey: key)
            }
        }
        defaults?.set(map, forKey: pendingProgressKey)
        return live
    }

    private static func pendingMap(_ key: String) -> [String: Double] {
        (defaults?.dictionary(forKey: key) as? [String: Double]) ?? [:]
    }

    // MARK: - Confirmed completions (the check-off that came back, 2026-09-23)
    //
    // The tombstone above lives 90s and was the ONLY thing hiding a completed
    // item, while the cached payload it filters kept that item forever. Tapping
    // through a slot keeps `hasRecentInteraction()` true, so every repaint came
    // from that stale cache — and 90s after a tap its tombstone expired and the
    // item was drawn again. Trent, 2026-09-23: "the reminders started popping
    // back up. When I'd complete one, one would replace it."
    //
    // So a completion the SERVER CONFIRMED is taken out of the cached payload
    // itself — the cache stops claiming the item is waiting, and nothing else
    // has to remember it. A fresh fetch then replaces the cache wholesale and
    // is always believed.
    //
    // The first version kept a separate 15-minute "hide this occurrence" list
    // instead, and it outranked the server: un-checking a reminder in the app
    // brings it back with the SAME due_at, so the widget went on hiding it
    // (Trent, the same afternoon: "I unchecked… but they're not showing on my
    // widget"). Editing the cache has no such case — there is nothing left to
    // disagree with the next fetch.

    /// The server confirmed `id`'s completion: drop it from both cached
    /// payloads' OPEN side. In Reminders it moves to its slot's `considered`
    /// count AND `consideredItems` (2026-09-23, "show completed" — the DONE
    /// list needs the item itself, not just the count, and this is the
    /// EARLIEST point a just-completed item can be shown as done: waiting
    /// for the next network fetch would miss it entirely, since
    /// `CompleteTaskIntent`'s round-2 reload fast-paths from cache on
    /// success). Tasks has no DTO with full task data to fall back on for its
    /// DONE list, so it synthesizes a `CompletionDTO` from the `TaskDTO`
    /// being removed — see the block below.
    ///
    /// Also clears any live `pendingRestore` for `id` (re-completing within
    /// 90s of restoring it, or restoring within 90s of completing it, are
    /// both real sequences a fast tapper can produce — see
    /// `confirmRestore`'s matching clear for the mirror case): without this,
    /// a stale restore tombstone would keep hiding `id` from the DONE list
    /// this very function just put it back into.
    static func confirmCompletion(_ id: Int) {
        pendingLock.lock()
        defer { pendingLock.unlock() }
        if let cached = loadReminders() {
            let groups = cached.value.groups.map { group -> ReminderGroupDTO in
                let completed = group.reminders.filter { $0.id == id }
                let remaining = group.reminders.filter { $0.id != id }
                return ReminderGroupDTO(
                    slot: group.slot,
                    reminders: remaining,
                    considered: group.considered + completed.count,
                    consideredItems: completed + group.consideredItems
                )
            }
            save(RemindersCache(groups: groups), forKey: remindersKey, at: cached.fetchedAt)
        }
        if let cached = loadTasks() {
            let completedTask = cached.value.tasks.first(where: { $0.id == id })
            let tasks = cached.value.tasks.filter { $0.id != id }
            var completions = cached.value.completions
            // Reminders and tracked items ride the same raw `tasks` cache
            // (TaskFeed fetches ALL open tasks, not just Tasks-widget-
            // eligible ones) — excluded here exactly like `TasksTimeline.
            // eligibleTasks` excludes them from the OPEN list, so a
            // Reminders completion (which also flows through THIS function)
            // can never pollute the Tasks widget's DONE list.
            if let completedTask, !completedTask.isReminder, !completedTask.isTracked {
                // Synthetic negative id, purely for Identifiable/ForEach —
                // silently replaced by the real, server-confirmed row
                // (positive id) on the next full TaskFeed fetch, which
                // always re-fetches completions now (see TaskFeed.snapshot).
                let synthetic = CompletionDTO(
                    id: -completedTask.id,
                    taskId: completedTask.id,
                    completedAt: DateHelpers.formatISO(Date()),
                    taskTitle: completedTask.title,
                    projectId: completedTask.projectId,
                    isReminder: false,
                    isTracked: false,
                    progressTarget: completedTask.progressTarget
                )
                completions = [synthetic] + completions
            }
            save(
                TasksCache(tasks: tasks, projects: cached.value.projects, completions: completions),
                forKey: tasksKey, at: cached.fetchedAt)
        }
        clearPendingRestore(id)
    }

    /// Remove tombstoned (in-flight) completions from a fetched or cached
    /// payload. Every widget draws through this.
    static func filterPending(_ tasks: [TaskDTO], now: Date = Date()) -> [TaskDTO] {
        let pending = pendingCompletions(now: now)
        guard !pending.isEmpty else { return tasks }
        return tasks.filter { !pending.contains($0.id) }
    }

    // MARK: - Show completed (2026-09-23, "show completed" — the eye toggle
    // left of Undo, Reminders and Tasks systemLarge only)
    //
    // Trent picked mockup option A: completed items sit at the bottom, under
    // a "DONE · N" divider. Deliberately NOT plumbed through `RemindersEntry`/
    // `TasksEntry` — the toggle is pure local UI state, and threading it
    // through would mean touching every `getTimeline`/`SampleData`
    // construction site for a flag those types don't otherwise need. Read
    // live instead, straight from here, by the LIST VIEWS themselves
    // (`RemindersListView`/`TasksListView`) — the same division of labor
    // `remindersPage(for:)`/`tasksPage(for:)` already use for paging state.
    //
    // Keyed by an arbitrary `kind` STRING, not a fixed enum case, so a
    // parallel branch building the Track widget's own eye toggle
    // (`feat/quotas-widget`) can share this exact function without either
    // branch's change colliding with the other's in this file.

    private static func showCompletedKey(for kind: String) -> String {
        "widget.showCompleted.\(kind)"
    }

    static func showCompleted(for kind: String) -> Bool {
        defaults?.bool(forKey: showCompletedKey(for: kind)) ?? false
    }

    static func setShowCompleted(_ value: Bool, for kind: String) {
        defaults?.set(value, forKey: showCompletedKey(for: kind))
    }

    // MARK: - Pending restores (2026-09-23, "show completed" — tap a DONE row)
    //
    // The mirror image of the completion tombstone above: this one hides an
    // item from the DONE list instead of from OPEN, the instant
    // `UncompleteTaskIntent` taps it, while `POST /api/tasks/:id/undone` is
    // still on the wire. Same TTL/liveIds mechanics as `pendingCompletions`
    // — see that section's doc for the reasoning, not repeated here.
    //
    // Addressed by TASK id, not by a `CompletionDTO`'s own row `id` (which,
    // for an optimistically-synthesized row, is a negative placeholder that
    // never appears server-side) — Reminders' `consideredItems` and Tasks'
    // `completions` both carry an honest task id (`TaskDTO.id` /
    // `CompletionDTO.taskId`) that survives the swap from synthetic to
    // server-confirmed.

    private static let pendingRestoresKey = "widget.pendingRestores"

    static func stagePendingRestore(_ id: Int, now: Date = Date()) {
        var map = pendingMap(pendingRestoresKey)
        map[String(id)] = now.timeIntervalSince1970
        defaults?.set(map, forKey: pendingRestoresKey)
    }

    static func clearPendingRestore(_ id: Int) {
        var map = pendingMap(pendingRestoresKey)
        map.removeValue(forKey: String(id))
        defaults?.set(map, forKey: pendingRestoresKey)
    }

    /// Live (un-expired) tombstones, pruning expired ones as a side effect —
    /// consulted by `filterPending(_ groups:)` (Reminders) and
    /// `TaskFeed.staged` (Tasks, via `filterPendingRestoresFromCompletions`)
    /// so a just-tapped restore vanishes from DONE immediately.
    static func pendingRestores(now: Date = Date()) -> Set<Int> {
        liveIds(pendingRestoresKey, now: now)
    }

    /// Remove tombstoned (in-flight) restores from Tasks' DONE list
    /// (`CompletionDTO`, keyed by `taskId`) — the Tasks twin of
    /// `filterPending(_ groups:)`'s Reminders-side handling, called from
    /// `TaskFeed.staged` (the ONE choke point every Tasks render path goes
    /// through, matching that function's own "single choke point" doc).
    static func filterPendingRestoresFromCompletions(
        _ completions: [CompletionDTO], now: Date = Date()
    ) -> [CompletionDTO] {
        let restoring = pendingRestores(now: now)
        guard !restoring.isEmpty else { return completions }
        return completions.filter { !restoring.contains($0.taskId) }
    }

    /// The server confirmed `id`'s restore (`POST /api/tasks/:id/undone`
    /// succeeded): permanently drop it from the cached DONE list. Unlike a
    /// completion tombstone, there is nowhere honest to put the item back
    /// into OPEN from here — Tasks' `CompletionDTO` carries no due date,
    /// priority, or labels to reconstruct a `TaskDTO` from — so
    /// `UncompleteTaskIntent` also clears the interaction stamp
    /// (`clearInteraction()`) so the NEXT reload takes the network path and
    /// fetches the real restored `TaskDTO` into OPEN. Net effect: the item
    /// leaves DONE instantly, and reappears in OPEN within one round trip
    /// rather than in the same paint — an accepted asymmetry with the
    /// completion side, not a bug (see `UncompleteTaskIntent`'s doc).
    ///
    /// Also clears any live `pendingCompletion` for `id` — the mirror of
    /// `confirmCompletion`'s clear of `pendingRestore` above, for the same
    /// fast-tapper reason (restoring, then re-completing within 90s, must
    /// not leave a stale completion tombstone hiding it from the OPEN list
    /// this function's caller just asked the server to restore it to).
    static func confirmRestore(_ id: Int, kind: String) {
        pendingLock.lock()
        defer { pendingLock.unlock() }
        if kind == RemindersWidget.kind, let cached = loadReminders() {
            let groups = cached.value.groups.map { group -> ReminderGroupDTO in
                let remainingConsidered = group.consideredItems.filter { $0.id != id }
                let removed = group.consideredItems.count - remainingConsidered.count
                return ReminderGroupDTO(
                    slot: group.slot,
                    reminders: group.reminders,
                    considered: max(0, group.considered - removed),
                    consideredItems: remainingConsidered
                )
            }
            save(RemindersCache(groups: groups), forKey: remindersKey, at: cached.fetchedAt)
        }
        if kind == TasksWidget.kind, let cached = loadTasks() {
            let completions = cached.value.completions.filter { $0.taskId != id }
            save(
                TasksCache(tasks: cached.value.tasks, projects: cached.value.projects, completions: completions),
                forKey: tasksKey, at: cached.fetchedAt)
        }
        clearPendingCompletion(id)
    }

    // MARK: - Undo/redo counts (2026-09-23, replaces the 60s Undo window)
    //
    // Trent: "The undo button on the segment I was working on disappeared
    // and then it said 'Morning done.' The undo should not disappear like
    // that... undoing it should still be allowed with some indication about
    // what was undone." and "For undo and redo I think we want undo and
    // redo, ideally with an icon."
    //
    // The old design showed a single "Undo" button for 60s after THIS
    // widget extension's own last mutation, gated by a local clock
    // (`recordMutation`/`canUndo(at:)`/`undoWindow`, now removed). That
    // meant the button vanished the moment the window closed even though
    // the server still had the action queued, and it never existed for
    // Redo at all. The replacement is the SERVER's own undoable/redoable
    // counts (`GET /api/undo/status`, `POST /api/undo`/`/api/redo`'s own
    // response) — `undoableCount`/`redoableCount` below — so the buttons
    // are always present and reflect the real, un-windowed state: enabled
    // whenever there is genuinely something to undo/redo, dimmed when
    // there isn't, exactly like every other affordance in this file.

    private static let undoableCountKey = "widget.undoRedo.undoableCount"
    private static let redoableCountKey = "widget.undoRedo.redoableCount"

    /// Cached from the last successful `GET /api/undo/status` (piggybacked
    /// on every widget fetch — see `RemindersProvider`/`TaskFeed`) or the
    /// last mutating `/api/undo`/`/api/redo`/completion/progress response,
    /// whichever is freshest. `-1` (never set) reads as "enabled" via
    /// `canUndo`/`canRedo` below — before the first fetch ever lands there
    /// is no reason to start the buttons dimmed on a guess.
    static var undoableCount: Int {
        get { defaults?.object(forKey: undoableCountKey) as? Int ?? -1 }
        set { defaults?.set(newValue, forKey: undoableCountKey) }
    }

    static var redoableCount: Int {
        get { defaults?.object(forKey: redoableCountKey) as? Int ?? -1 }
        set { defaults?.set(newValue, forKey: redoableCountKey) }
    }

    /// Whether the header's Undo/Redo icon buttons should be enabled RIGHT
    /// NOW. Read live at entry-build time by every provider — unlike the
    /// old design there is no time window to expire, so a pre-scheduled
    /// FUTURE timeline entry simply carries forward whatever was true when
    /// it was built (same limitation `staleSince` already accepts).
    static var canUndo: Bool { undoableCount != 0 }
    static var canRedo: Bool { redoableCount != 0 }

    /// Overwrite both counts with server truth — from `GET /api/undo/status`
    /// or an `/api/undo`/`/api/redo` response, both exact.
    static func setUndoRedoCounts(undoable: Int, redoable: Int) {
        undoableCount = undoable
        redoableCount = redoable
    }

    /// Optimistically reflect a just-SUCCEEDED local mutation
    /// (`CompleteTaskIntent`, `IncrementProgressIntent`) in the cached
    /// counts, without waiting for the next piggybacked `GET
    /// /api/undo/status`. Exact, not a guess: every mutation calls
    /// `logAction()` server-side (AGENTS.md's "every mutation must be
    /// atomic and logged for undo"), which adds exactly one new undoable
    /// entry AND clears the redo stack (`logAction`'s own "new action
    /// clears redo" comment, `src/core/undo/log-action.ts`) — so this is
    /// what the next fetch will confirm anyway, just shown immediately so
    /// Undo doesn't sit dimmed for up to 30 minutes after the very first
    /// action a fresh install ever makes.
    static func recordLocalMutationForUndoCount() {
        undoableCount = max(undoableCount, 0) + 1
        redoableCount = 0
    }

    // MARK: - Undo/redo in-flight claim
    //
    // The buttons are now ALWAYS tappable (no window to naturally throttle
    // a double-tap), so a genuine double-tap — or a second `perform()`
    // invoked while the first's network call is still in flight — could
    // fire two server calls for what the user meant as one undo/redo.
    // `/api/undo` and `/api/redo` each walk back/forward exactly ONE
    // action, so a second concurrent call would act on the WRONG action.
    // Undo and redo share one claim: firing both at once is meaningless
    // (and racy — whichever lands second would act on a stack the first
    // already changed), so at most one of either fires at a time.

    private static let undoRedoInFlightKey = "widget.undoRedo.inFlightAt"
    /// Crash backstop only, matching this file's existing TTL idiom
    /// (`pendingTTL`, the old `undoWindow`): the widget extension process
    /// can be suspended mid-network-call, which would otherwise leave a
    /// claim permanently stuck and the buttons permanently inert. Generous
    /// relative to `APIClient`'s own 15s request timeout so a real in-flight
    /// call is never pre-empted by its own backstop.
    private static let undoRedoInFlightTTL: TimeInterval = 20

    static func tryClaimUndoRedo(now: Date = Date()) -> Bool {
        pendingLock.lock()
        defer { pendingLock.unlock() }
        if let stamp = defaults?.object(forKey: undoRedoInFlightKey) as? Double,
            now.timeIntervalSince1970 - stamp < undoRedoInFlightTTL {
            return false
        }
        defaults?.set(now.timeIntervalSince1970, forKey: undoRedoInFlightKey)
        return true
    }

    static func releaseUndoRedoClaim() {
        defaults?.removeObject(forKey: undoRedoInFlightKey)
    }

    // MARK: - Last-action indication (2026-09-23)
    //
    // "Even if you're not on that segment, undoing it should still be
    // allowed with some indication about what was undone." The header
    // subtitle shows `description` from the `/api/undo`/`/api/redo`
    // response ("Undid: Marked 'X' done") for `lastActionWindow` seconds —
    // see `RemindersEntry`/`TasksEntry`/`TrackEntry`'s `actionDescription`
    // and each provider's `getTimeline` for the explicit expiry entry
    // (WidgetKit has no "expire after N seconds" primitive). Deliberately
    // NOT scoped to a slot/project/quota: undo/redo act on "whatever
    // changed last" server-wide (see `UndoLastActionIntent`'s doc), so the
    // indication has to read the same "whichever slot/page is on screen" —
    // it is header-level state, not per-row.

    private static let lastActionDescriptionKey = "widget.undoRedo.lastDescription"
    private static let lastActionAtKey = "widget.undoRedo.lastAt"
    static let lastActionWindow: TimeInterval = 60

    static func recordLastAction(description: String, at now: Date = Date()) {
        defaults?.set(description, forKey: lastActionDescriptionKey)
        defaults?.set(now.timeIntervalSince1970, forKey: lastActionAtKey)
    }

    /// The indication text to show at `date`, or `nil` once
    /// `lastActionWindow` has passed. Used both for "right now" and for a
    /// scheduled future entry, exactly like the old `canUndo(at:)`.
    static func lastActionDescription(at date: Date = Date()) -> String? {
        guard let stamp = defaults?.object(forKey: lastActionAtKey) as? Double else { return nil }
        let elapsed = date.timeIntervalSince1970 - stamp
        guard elapsed >= 0, elapsed < lastActionWindow else { return nil }
        return defaults?.string(forKey: lastActionDescriptionKey)
    }

    /// The exact moment the indication should turn back off, for scheduling
    /// the explicit expiry timeline entry. `nil` when there is no live
    /// indication to expire.
    static func lastActionExpiry() -> Date? {
        guard let stamp = defaults?.object(forKey: lastActionAtKey) as? Double else { return nil }
        return Date(timeIntervalSince1970: stamp).addingTimeInterval(lastActionWindow)
    }

    // MARK: - Last mutation instant (auto-advance correlation only)
    //
    // Narrowed 2026-09-23: this used to ALSO gate the old Undo button's 60s
    // visibility window (any mutation, including a Track `+1`/`−1`, stamped
    // it). Now it exists for exactly one thing — telling
    // `UndoLastActionIntent` whether the action `/api/undo` just reversed
    // is LIKELY the same Reminders completion that triggered
    // `RemindersTimeline.autoAdvanceSlot`, so it knows whether to restore
    // the pre-advance slot override (see "Auto-advance's own undo" below).
    // Only `CompleteTaskIntent` stamps it now — a progress `+1`/`−1` never
    // triggers auto-advance, so it has nothing here to correlate.

    private static let lastMutationAtKey = "widget.lastMutationAt"

    /// Stamp "this device just completed a task, at this instant" — passed
    /// through to `snapshotSlotOverrideBeforeAutoAdvance(at:)` by the SAME
    /// `Date` value, so the two are tagged with bit-identical timestamps.
    static func recordMutation(now: Date = Date()) {
        defaults?.set(now.timeIntervalSince1970, forKey: lastMutationAtKey)
    }

    /// Claim (and clear) the last recorded mutation instant. Consumed only
    /// on a SUCCESSFUL undo (see `UndoLastActionIntent`) so a later,
    /// unrelated undo can't reuse a stale value, but left untouched on
    /// failure so a retry can still correlate correctly. No TTL: unlike the
    /// old design this is not a visibility window, and the auto-advance
    /// snapshot it pairs with (`restoreSlotOverrideBeforeAutoAdvance`) is
    /// itself the thing that actually validates the match, by exact
    /// timestamp equality — a stale value here just fails that match and
    /// restores nothing, which is the correct behavior for an unrelated
    /// undo anyway.
    static func consumeLastMutation() -> Date? {
        pendingLock.lock()
        defer { pendingLock.unlock() }
        guard let stamp = defaults?.object(forKey: lastMutationAtKey) as? Double else { return nil }
        defaults?.removeObject(forKey: lastMutationAtKey)
        return Date(timeIntervalSince1970: stamp)
    }

    /// Wipe every optimistic/confirmed marker this store holds. Called after
    /// a successful `/api/undo` or `/api/redo` (`UndoLastActionIntent`,
    /// `RedoLastActionIntent`): the response carries no task id
    /// (`{undone_action/redone_action, description, tasks_affected}` — see
    /// `src/app/api/undo/route.ts` / `redo/route.ts`), so there is no way to
    /// know which ONE entry — a completion tombstone, a confirmed completion
    /// (see the 2026-09-23 note above), or a staged progress delta —
    /// belongs to the action that was just reversed/replayed. Clearing all
    /// three maps is the honest alternative: an undone completion must not
    /// stay hidden behind either the 90s tombstone OR the 15-minute
    /// confirmed-completion window, and a staged progress delta must not
    /// double-count against a server value the call just changed. The
    /// reload that follows re-fetches server truth for whatever the
    /// acted-on widgets show, so nothing genuinely in flight is lost — only
    /// the brief optimistic guess is, which the call itself already
    /// invalidated.
    static func clearAllPendingState() {
        defaults?.removeObject(forKey: pendingCompletionsKey)
        defaults?.removeObject(forKey: pendingProgressKey)
        // 2026-09-23, "show completed": a pending restore is just as much an
        // in-flight optimistic marker as the other two, and an undo/redo
        // response carries no task id to single one out — see this
        // function's own doc for why clearing all three is the honest
        // choice rather than guessing which one belongs to the reversed
        // action.
        defaults?.removeObject(forKey: pendingRestoresKey)
    }

    /// Draw staged progress: while an entry is live the item reads
    /// `progress_current + net delta`, floored at 0 to match the server.
    ///
    /// Every tap counts, in both directions — four rapid `+1`s draw +4 and a
    /// `−1` draws −1 (see the storage note above). The number is only ever as
    /// wrong as the taps the user actually made, and it converges the moment the
    /// reconciling fetch lands.
    static func applyPendingProgress(_ tasks: [TaskDTO], now: Date = Date()) -> [TaskDTO] {
        let deltas = pendingProgressDeltas(now: now)
        guard !deltas.isEmpty else { return tasks }
        return tasks.map { task in
            guard let delta = deltas[task.id], delta != 0 else { return task }
            return task.withOptimisticIncrement(delta)
        }
    }

    /// Every filtered-out reminder is credited to `considered` — otherwise a
    /// slot's `total` (`waiting + considered`, what `ReminderSlotStrip` and
    /// `RemindersListView.allCaughtUp` are built on, 2026-09-23) would shrink
    /// every time an item is hidden here, instead of staying fixed while only
    /// the split between waiting and done moves — the same invariant the
    /// web's `ReminderSlotBar` comment insists on ("checking things off
    /// moves the fill but never resizes it"). Without this, `considered`
    /// silently read 0 forever: this function is the ONE place that ever
    /// constructs a `ReminderGroupDTO` from a decoded/cached payload once
    /// tombstones or confirmed completions are in play, and the memberwise
    /// init defaults `considered` to 0 when it isn't passed explicitly — a
    /// default that made the bug compile clean and the sample-data gallery
    /// (which never calls this) look fine while every real render showed
    /// "Nothing left here" instead of "All caught up" / "<Slot> done".
    ///
    /// Safe against double-counting a SERVER-confirmed completion on a fresh
    /// fetch: the server's own payload already omits it from `reminders`
    /// there (a recurring task's next occurrence carries a different
    /// `due_at` and is a different entry, not a re-inclusion of this one),
    /// so this only ever adds what THIS pass actually removed.
    ///
    /// Also strips any live `pendingRestores` entries out of
    /// `consideredItems` (2026-09-23, "show completed") — this is the ONE
    /// place that reconstructs a `ReminderGroupDTO` from every reminders
    /// render path (the interaction fast path, the fresh fetch, and the
    /// error fallback all call this), so it is also the one place a
    /// just-tapped restore needs to disappear from the DONE list
    /// immediately, mirroring how `pendingCompletions` already hides a
    /// just-tapped completion from `reminders` in the same pass.
    static func filterPending(_ groups: [ReminderGroupDTO], now: Date = Date()) -> [ReminderGroupDTO] {
        let restoring = pendingRestores(now: now)
        return groups.map { group in
            let remaining = filterPending(group.reminders, now: now)
            let consideredItems = restoring.isEmpty
                ? group.consideredItems
                : group.consideredItems.filter { !restoring.contains($0.id) }
            return ReminderGroupDTO(
                slot: group.slot,
                reminders: remaining,
                considered: group.considered + (group.reminders.count - remaining.count),
                consideredItems: consideredItems
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

    // MARK: - Auto-advance's own undo (2026-09-23)
    //
    // `RemindersTimeline.autoAdvanceSlot` writes a slot override as a SIDE
    // EFFECT of completing a reminder — moving the display to wherever the
    // day's earliest still-waiting slot is. That side effect needs its own
    // undo path, separate from the completion it rode in on, for two
    // distinct reasons:
    //
    // 1. **A completion that fails.** `autoAdvanceSlot` runs OPTIMISTICALLY,
    //    before the server confirms anything (same reasoning as the
    //    completion tombstone itself — waiting for the network read as a
    //    dead button). If `markDone` then fails, `clearPendingCompletion`
    //    un-hides the item, but nothing else reverted the slot the display
    //    jumped to — the widget was left parked on a slot chosen for a
    //    completion that never actually happened.
    // 2. **A completion that succeeds, then gets Undone.** The reminder
    //    reappears (via the server's own state once `/api/undo` runs), but
    //    it reappears in the slot it was ORIGINALLY in — which is exactly
    //    the slot `autoAdvanceSlot` moved the display AWAY from. Undo that
    //    doesn't also revert the display leaves the user looking at a slot
    //    the item they just restored isn't even in.
    //
    // Both share one mechanism: snapshot whatever the override was
    // immediately before `autoAdvanceSlot` runs, tagged with the SAME
    // instant `recordMutation(now:)` stamps if the completion goes on to
    // succeed. Only a `restoreSlotOverrideBeforeAutoAdvance` call whose
    // `mutatedAt` matches that tag actually restores anything — an
    // unrelated action (a Track `+1`, a later Reminders completion) leaves
    // an intervening but non-matching snapshot alone rather than
    // misapplying an older side effect to the wrong undo.

    private static let autoAdvanceSnapshotKey = "widget.reminders.autoAdvanceSnapshot"

    private struct SlotOverrideSnapshot: Codable {
        let at: Double
        let hadOverride: Bool
        let slotKey: Int
        let naturalSlotKey: Int
    }

    /// Record the override as it stood immediately before `autoAdvanceSlot`
    /// is about to (possibly) change it. `at` should be the SAME `Date`
    /// instance the caller will also pass to `recordMutation(now:)` if the
    /// action succeeds, so the two are tagged with bit-identical timestamps.
    /// Overwrites any earlier snapshot — only the most recent auto-advance's
    /// prior state is ever worth restoring, matching "undo reverses the last
    /// action" semantics.
    static func snapshotSlotOverrideBeforeAutoAdvance(at now: Date) {
        let existing = slotOverride()
        let snapshot = SlotOverrideSnapshot(
            at: now.timeIntervalSince1970,
            hadOverride: existing != nil,
            slotKey: existing?.slotKey ?? 0,
            naturalSlotKey: existing?.naturalSlotKey ?? 0
        )
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        defaults?.set(data, forKey: autoAdvanceSnapshotKey)
    }

    /// Undo the auto-advance side effect — but ONLY if the snapshot on file
    /// was tagged for exactly `mutatedAt` (see this section's header
    /// comment). Consumes the snapshot either way once it matches, so a
    /// second call for the same `mutatedAt` (there is none in practice —
    /// each of the two call sites reaches at most one outcome per action —
    /// but nothing here relies on that) is a safe no-op.
    static func restoreSlotOverrideBeforeAutoAdvance(ifMatches mutatedAt: Date) {
        guard let data = defaults?.data(forKey: autoAdvanceSnapshotKey),
              let snapshot = try? JSONDecoder().decode(SlotOverrideSnapshot.self, from: data),
              abs(snapshot.at - mutatedAt.timeIntervalSince1970) < 0.001
        else { return }
        if snapshot.hadOverride {
            setSlotOverride(slotKey: snapshot.slotKey, naturalSlotKey: snapshot.naturalSlotKey)
        } else {
            clearSlotOverride()
        }
        defaults?.removeObject(forKey: autoAdvanceSnapshotKey)
    }

    // MARK: - Reminders list paging (2026-09-23, "page through things that
    // are too long to fit")
    //
    // Trent: "It'd be nice to be able to page through things that are too
    // long to fit on the widget screen." Replaces the old "+N more" Link
    // (which just opened the app) with a `‹ 1/3 ›` pager — see
    // `RemindersListView.card`/`ListPager` in `RemindersWidgetViews.swift`.
    //
    // Paired with the slot it was paged within, the same "pair a value with
    // the state it was set against" trick `slotOverride()` above uses to
    // self-expire: reading with a DIFFERENT slot than the one last written
    // returns page 0. That covers "reset to 0 whenever the slot on screen
    // changes" for every way the slot can change — a chevron tap, a jump, an
    // auto-advance, AND simply the clock crossing into a new natural
    // slot — without any of those call sites needing to remember to call a
    // separate reset function, because none of them are really "the same
    // list" any more once the slot has moved.
    //
    // NOT bounded to the list's actual page count here: the list itself is
    // the only thing that knows how many rows currently fit (`ViewThatFits`'s
    // winning candidate, which nothing outside that view's own body can
    // observe — see `RemindersListView`'s doc), so it clamps this value live
    // on every render instead ("clamp it when the list shrinks"). This store
    // only ever needs to move it.

    private static let remindersPageKey = "widget.reminders.page"
    private static let remindersPageSlotKey = "widget.reminders.page.slotKey"

    static func remindersPage(for slotKey: Int) -> Int {
        guard let defaults, defaults.object(forKey: remindersPageSlotKey) != nil,
            defaults.integer(forKey: remindersPageSlotKey) == slotKey
        else {
            return 0
        }
        return defaults.integer(forKey: remindersPageKey)
    }

    static func setRemindersPage(_ page: Int, for slotKey: Int) {
        defaults?.set(max(0, page), forKey: remindersPageKey)
        defaults?.set(slotKey, forKey: remindersPageSlotKey)
    }

    // MARK: - Tasks project scope

    private static let projectScopeKey = "widget.tasks.projectId"

    /// Project id the Tasks widget is scoped to, or `allProjects`/`upNextScope`
    /// for one of the two unified pages. Persisted as an id rather than an
    /// index so renaming or reordering projects doesn't silently move the
    /// user to a different one.
    static let allProjects = -1

    /// The "Up next" unified page (2026-09-23, item 4) — see
    /// `TasksTimeline.upNextTasks`'s doc. `allProjects` above is the OTHER
    /// unified page ("Today"), kept at its original value/name since that is
    /// exactly what it always meant (`TasksTimeline.todaysTasks` was always
    /// the `allProjects` scope's content). Both are project-less; only this
    /// sentinel additionally drops `todaysTasks`' end-of-day cutoff.
    static let upNextScope = -2

    static var projectScope: Int {
        get {
            guard let defaults, defaults.object(forKey: projectScopeKey) != nil else {
                return allProjects
            }
            return defaults.integer(forKey: projectScopeKey)
        }
        set { defaults?.set(newValue, forKey: projectScopeKey) }
    }

    // MARK: - Tasks list paging
    //
    // The Tasks twin of "Reminders list paging" above — same pairing trick,
    // scoped to the project (or `allProjects`) on screen instead of a slot
    // key, so paging resets whenever `ShiftProjectScopeIntent` moves the
    // scope.

    private static let tasksPageKey = "widget.tasks.page"
    private static let tasksPageScopeKey = "widget.tasks.page.scope"

    static func tasksPage(for scope: Int) -> Int {
        guard let defaults, defaults.object(forKey: tasksPageScopeKey) != nil,
            defaults.integer(forKey: tasksPageScopeKey) == scope
        else {
            return 0
        }
        return defaults.integer(forKey: tasksPageKey)
    }

    static func setTasksPage(_ page: Int, for scope: Int) {
        defaults?.set(max(0, page), forKey: tasksPageKey)
        defaults?.set(scope, forKey: tasksPageScopeKey)
    }

    // MARK: - Tasks snooze mode / bulk select (2026-09-23, Phase 2)
    //
    // Tasks-only (Reminders has no equivalent — §6 reminders are
    // bucket-locked and never snoozed, `filterForBulkSnooze`'s own doc), so
    // unlike `showCompleted(for kind:)` these are NOT keyed by an arbitrary
    // kind string; there is only ever one Tasks widget kind to key against.
    //
    // A row's trailing control can only be ONE thing at a time — the
    // ordinary checkbox, snooze mode's ⏭/+1h pair, or select mode's
    // selection circle — so `tasksSnoozeMode` and `tasksSelectMode` are
    // mutually exclusive by convention: every intent that turns one on
    // explicitly turns the other off (see `ToggleTasksSnoozeModeIntent`/
    // `EnterTasksSelectModeIntent`), rather than this store enforcing it
    // structurally. `systemLarge` only — call sites gate it, mirroring
    // `ShowCompletedToggle`'s identical `isLarge` gating (no row/header
    // budget on systemMedium for a third control cluster).

    private static let tasksSnoozeModeKey = "widget.tasks.snoozeMode"
    private static let tasksSelectModeKey = "widget.tasks.selectMode"

    static var tasksSnoozeMode: Bool {
        get { defaults?.bool(forKey: tasksSnoozeModeKey) ?? false }
        set { defaults?.set(newValue, forKey: tasksSnoozeModeKey) }
    }

    static var tasksSelectMode: Bool {
        get { defaults?.bool(forKey: tasksSelectModeKey) ?? false }
        set { defaults?.set(newValue, forKey: tasksSelectModeKey) }
    }

    /// Thin setter FUNCTIONS over the two vars above, for `#Preview`
    /// timeline closures — `let _ = WidgetStore.tasksSnoozeMode = true`
    /// does not compile (a bare property assignment is a statement, not an
    /// expression `let _ =` can bind), the same reason every other
    /// `#Preview` reset in this codebase calls a FUNCTION
    /// (`setShowCompleted`, `setTasksPage`) rather than assigning a `var`
    /// directly. Intents still use the `var`s themselves — these exist
    /// purely for preview call sites.
    static func setTasksSnoozeMode(_ value: Bool) { tasksSnoozeMode = value }
    static func setTasksSelectMode(_ value: Bool) { tasksSelectMode = value }

    private static let tasksSelectedIdsKey = "widget.tasks.selectedIds"
    private static let tasksSelectedIdsScopeKey = "widget.tasks.selectedIds.scope"

    /// Bulk-select picks, paired with the SCOPE they were made in — the same
    /// "pair a value with the state it was set against" self-reset trick
    /// `remindersPage(for:)`/`tasksPage(for:)` already use (see either's
    /// doc): reading against a DIFFERENT scope than the one last written
    /// returns empty, so switching from "Up next" to a project mid-selection
    /// can never leave stale, invisible ids selected underneath the bar's
    /// "N selected" count. WITHIN one scope, picks persist across PAGES —
    /// mockup: "Tap rows to pick them (pages keep your picks)" — which falls
    /// out for free here since this is keyed by scope, not by scope+page.
    static func selectedTaskIds(for scope: Int) -> Set<Int> {
        guard let defaults, defaults.object(forKey: tasksSelectedIdsScopeKey) != nil,
            defaults.integer(forKey: tasksSelectedIdsScopeKey) == scope
        else {
            return []
        }
        let ids = (defaults.array(forKey: tasksSelectedIdsKey) as? [Int]) ?? []
        return Set(ids)
    }

    static func setSelectedTaskIds(_ ids: Set<Int>, for scope: Int) {
        defaults?.set(Array(ids), forKey: tasksSelectedIdsKey)
        defaults?.set(scope, forKey: tasksSelectedIdsScopeKey)
    }

    static func clearTasksSelection() {
        defaults?.removeObject(forKey: tasksSelectedIdsKey)
        defaults?.removeObject(forKey: tasksSelectedIdsScopeKey)
    }

    // MARK: - Track selection

    private static let trackSelectionKey = "widget.track.taskId"

    /// "The user has not chosen a quota" — the provider then shows the most
    /// behind-pace one, which is the useful default (§8).
    static let noTrackSelection = -1

    /// Which quota the Track widget's small and accessory families render,
    /// stored as a task id.
    ///
    /// An id rather than an index, for a sharper version of `projectScope`'s
    /// reason: the Track list is re-sorted by pace on every refresh, so an
    /// index would silently slide the user onto a *different* quota the moment
    /// something else fell behind — the one navigation bug a chevron user
    /// could never explain to themselves.
    static var trackSelection: Int {
        get {
            guard let defaults, defaults.object(forKey: trackSelectionKey) != nil else {
                return noTrackSelection
            }
            return defaults.integer(forKey: trackSelectionKey)
        }
        set { defaults?.set(newValue, forKey: trackSelectionKey) }
    }

    private static let trackPageStartKey = "widget.track.pageStartTaskId"

    /// Which quota the LIST families' (4×2/4×4) window starts from — the same
    /// KIND of value as `trackSelection`, stored separately (2026-09-22, "Eggs
    /// moves to the top"). The two used to share `trackSelection`: `+1` pins
    /// the 2×2 to the tapped quota, and because the window also started from
    /// that same pin, every `+1` on a row that wasn't already first rotated
    /// the whole list under the user's finger. The pin itself is correct and
    /// load-bearing — without it a `+1` can swap the 2×2 to a DIFFERENT quota
    /// mid-tap as pace shifts (see `IncrementProgressIntent`'s comment) — so
    /// the fix is a second sticky value, not removing the first.
    ///
    /// `ShiftTrackItemIntent` (paging) writes BOTH this and `trackSelection`
    /// together, because the small family's own chevrons page through
    /// `trackSelection` directly (there is no "window" at 2×2, just "the
    /// current quota") — so paging has to keep moving that one too, or the
    /// 2×2's chevrons would stop doing anything. `IncrementProgressIntent`
    /// writes only `trackSelection`, never this.
    static var trackPageStart: Int {
        get {
            guard let defaults, defaults.object(forKey: trackPageStartKey) != nil else {
                return noTrackSelection
            }
            return defaults.integer(forKey: trackPageStartKey)
        }
        set { defaults?.set(newValue, forKey: trackPageStartKey) }
    }

    // MARK: - Track row order

    private static let trackOrderKey = "widget.track.order"
    private static let trackOrderVersionKey = "widget.track.orderVersion"

    /// The pace algorithm the stored order was ranked under.
    ///
    /// Freezing an order (below) means a WRONG one survives the fix that
    /// corrects it: pace used to be measured from a quota's `due_at`, §5 then
    /// made quotas dateless, and every pace silently became nil — so the frozen
    /// order on an existing install is the tie-break, plain id order. Bumping
    /// this discards such an order exactly once. Version 1 never wrote the key,
    /// so it reads back as 0 and mismatches on the first pass after the upgrade.
    ///
    /// Bump it whenever a change to `TrackTimeline`'s maths would rank the same
    /// quotas differently. Not for anything else — this is a one-time reset, and
    /// the freeze it interrupts exists so a `+1` never slides a row out from
    /// under the finger that tapped it.
    static let trackOrderVersion = 2

    /// The quota id order the list families last rendered, or empty when it was
    /// frozen under a different `trackOrderVersion`.
    ///
    /// Persisted because pace is a MOVING target and pace was the sort key:
    /// logging progress changes pace, so re-sorting every reload rearranged the
    /// list as a *consequence of using it* — the row the user had just tapped
    /// slid out from under their finger, and a second tap landed on a different
    /// quota. `TrackTimeline.orderedItems` re-sorts only when the set of quotas
    /// changes; who is behind is already visible in every row's bar and tick, so
    /// nothing is lost by holding the order still.
    static var trackOrder: [Int] {
        guard let defaults, defaults.integer(forKey: trackOrderVersionKey) == trackOrderVersion
        else {
            return []
        }
        return (defaults.array(forKey: trackOrderKey) as? [Int]) ?? []
    }

    /// Freeze a row order, stamping the version only if pace actually shaped it.
    ///
    /// `pacedByPeriod` is the whole point of the parameter, and it is why the
    /// stamp is not simply part of the setter. The first timeline pass after an
    /// upgrade can easily render from the OLD build's cached payload — a failed
    /// fetch, or the cache-only fast path a recent tap takes — and those encoded
    /// tasks carry no `progress_period_start` at all, so every pace reads nil
    /// and the ranking degrades to id order. Stamping THAT would retire the
    /// version marker against a list the new maths never touched, re-freezing
    /// the exact order the bump exists to discard. Withholding the stamp costs
    /// one extra re-rank per pass until a fetch with real anchors lands, and
    /// re-ranking an all-nil list changes nothing on screen.
    static func setTrackOrder(_ ids: [Int], pacedByPeriod: Bool) {
        defaults?.set(ids, forKey: trackOrderKey)
        if pacedByPeriod {
            defaults?.set(trackOrderVersion, forKey: trackOrderVersionKey)
        }
    }

    // MARK: - Quotas (the Track → Quotas rebuild, `feat/quotas-widget`)
    //
    // Namespaced `quotas*`, deliberately not sharing a name/shape with the
    // Reminders/Tasks "show completed"/paging state another agent is adding
    // in parallel (`feat/widget-days-show-completed`) — see that branch's own
    // additions to this file for the twin, kind-specific keys.

    private static let quotasShowMetKey = "widget.quotas.showMet"

    /// Whether ALREADY-MET quotas are shown, or put away in their clusters —
    /// the same "met quotas are put away at load, never under a finger" rule
    /// as the web Track panel (`TrackPanel.tsx`'s `useShowMet`), but simpler
    /// here: the widget has no live session to "put away at load and hold for
    /// the rest of it" — every tap rebuilds the timeline fresh, so this is
    /// read straight at render time (see `quotaMutationIsRecent` below for
    /// the one exception: a `+1` that crosses the target must not vanish out
    /// from under the tap that just made it). Default `false` — met hidden,
    /// matching the web panel's own default.
    static var quotasShowMet: Bool {
        get { defaults?.bool(forKey: quotasShowMetKey) ?? false }
        set { defaults?.set(newValue, forKey: quotasShowMetKey) }
    }

    private static let quotasPageKey = "widget.quotas.page"

    /// Which page of the flowed chip layout is on screen. ONE flat sequence,
    /// unlike Reminders'/Tasks' paging (`remindersPage(for:)`/`tasksPage(for:)`)
    /// — Quotas has no slot/project axis to key against, so there is nothing
    /// to pair this with for a self-reset; a `showMet` flip or the corpus
    /// changing size is instead handled by the VIEW clamping against the live
    /// page count on every render (same "store only ever needs to move it,
    /// view clamps" idiom as `remindersPage`'s own doc), not by this store
    /// detecting the change.
    static var quotasPage: Int {
        get { defaults?.integer(forKey: quotasPageKey) ?? 0 }
        set { defaults?.set(max(0, newValue), forKey: quotasPageKey) }
    }

    private static let quotaLabelConfigKey = "widget.cache.quotaLabelConfig"

    /// The cluster color source (`label_config`), cached the same way every
    /// other fetched payload here is: a failed refetch draws the last-known
    /// colors rather than falling back to neutral for everything.
    static func saveQuotaLabelConfig(_ config: [LabelConfigDTO]) {
        save(config, forKey: quotaLabelConfigKey)
    }

    static func loadQuotaLabelConfig() -> Cached<[LabelConfigDTO]>? {
        load([LabelConfigDTO].self, forKey: quotaLabelConfigKey)
    }

    private static let quotaMutationAtKey = "widget.quotas.lastMutationAt"
    /// How long a quota that just crossed its target stays visible with
    /// `quotasShowMet` off, matching `pendingTTL`'s idiom (a generous crash
    /// backstop, not a tuned window).
    private static let quotaMutationTTL: TimeInterval = 90

    /// Stamp "a quota's progress was just logged from this widget" — see
    /// `quotaMutationIsRecent(now:)` for what this buys.
    static func recordQuotaMutation(now: Date = Date()) {
        defaults?.set(now.timeIntervalSince1970, forKey: quotaMutationAtKey)
    }

    /// Whether SOME quota's progress was logged recently enough that a
    /// just-met one must not be filtered out from under the tap that met it.
    ///
    /// Deliberately a single GLOBAL stamp, not a persisted `Set<Int>` of
    /// "which quota id to keep showing" — met-ness is recomputed fresh from
    /// the server/cache on every build (there is no snapshot to invalidate),
    /// so the only thing that can go wrong is a `+1` that crosses the target
    /// making its own chip disappear before the tap's optimistic repaint is
    /// even on screen. A short global grace window after ANY `+1`/`−1`
    /// covers that without inventing new per-id state: the cost is that a
    /// DIFFERENT quota which happened to already be met also stays visible
    /// for the same ~90s if the user taps a completely unrelated chip right
    /// after, which is a harmless false-negative (an extra chip shown, never
    /// a hidden one) and cheaper than tracking which id actually crossed.
    static func quotaMutationIsRecent(now: Date = Date()) -> Bool {
        guard let stamp = defaults?.object(forKey: quotaMutationAtKey) as? Double else { return false }
        return now.timeIntervalSince1970 - stamp < quotaMutationTTL
    }
}
