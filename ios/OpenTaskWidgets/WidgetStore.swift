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
    // back up. When I'd complete one, one would replace it." He re-tapped
    // "Check GitHub issues" and, the server having already advanced it, that
    // second completion skipped tomorrow's occurrence.
    //
    // So a completion the SERVER CONFIRMED is remembered for 15 minutes, keyed
    // to the occurrence that was done — its `due_at` when it was tapped. An item
    // is hidden only while it still shows THAT occurrence: the next occurrence
    // of a recurring task (same id, later `due_at`) is real and still drawn.
    // When the item was not in any cache at tap time there is no occurrence to
    // match, so the id alone is hidden for the window.

    private static let confirmedCompletionsKey = "widget.confirmedCompletions"
    private static let confirmedTTL: TimeInterval = 15 * 60

    private struct ConfirmedCompletion: Codable {
        let at: Double
        /// The occurrence completed. nil with `matchAny` when it was unknown.
        let dueAt: String?
        let matchAny: Bool
    }

    /// The `due_at` the widget is currently showing for `id`, from whichever
    /// cache holds it. Read at TAP time, before any fetch replaces the cache
    /// with the advanced occurrence. `.none` when no cache has the item.
    static func cachedOccurrence(of id: Int) -> String?? {
        let reminders = loadReminders()?.value.groups.flatMap(\.reminders) ?? []
        let tasks = loadTasks()?.value.tasks ?? []
        if let hit = (reminders + tasks).first(where: { $0.id == id }) { return .some(hit.dueAt) }
        return .none
    }

    /// The server confirmed `id`'s completion of `occurrence` (from
    /// `cachedOccurrence(of:)`); hide that occurrence for `confirmedTTL`.
    static func confirmCompletion(_ id: Int, occurrence: String??, now: Date = Date()) {
        pendingLock.lock()
        defer { pendingLock.unlock() }
        var map = confirmedMap(now: now)
        switch occurrence {
        case .some(let dueAt):
            map[String(id)] = ConfirmedCompletion(
                at: now.timeIntervalSince1970, dueAt: dueAt, matchAny: false)
        case .none:
            map[String(id)] = ConfirmedCompletion(
                at: now.timeIntervalSince1970, dueAt: nil, matchAny: true)
        }
        if let data = try? JSONEncoder().encode(map) {
            defaults?.set(data, forKey: confirmedCompletionsKey)
        }
    }

    /// Live entries only; expired ones are dropped on read.
    private static func confirmedMap(now: Date) -> [String: ConfirmedCompletion] {
        guard let data = defaults?.data(forKey: confirmedCompletionsKey),
              let map = try? JSONDecoder().decode([String: ConfirmedCompletion].self, from: data)
        else { return [:] }
        let cutoff = now.timeIntervalSince1970 - confirmedTTL
        return map.filter { $0.value.at >= cutoff }
    }

    private static func isConfirmedDone(
        _ task: TaskDTO, in map: [String: ConfirmedCompletion]
    ) -> Bool {
        guard let done = map[String(task.id)] else { return false }
        return done.matchAny || done.dueAt == task.dueAt
    }

    /// Remove tombstoned items, and confirmed completions of the occurrence
    /// shown, from a fetched or cached payload. Every widget draws through
    /// this, so it is the one place both rules live.
    static func filterPending(_ tasks: [TaskDTO], now: Date = Date()) -> [TaskDTO] {
        let pending = pendingCompletions(now: now)
        let confirmed = confirmedMap(now: now)
        guard !pending.isEmpty || !confirmed.isEmpty else { return tasks }
        return tasks.filter { !pending.contains($0.id) && !isConfirmedDone($0, in: confirmed) }
    }

    // MARK: - Undo window (2026-09-23, the accidental-tap fix)
    //
    // Trent: "I need some way to ... undo the accidental tap." Every
    // successful check-off / `+1` / `−1` (`CompleteTaskIntent`,
    // `IncrementProgressIntent`) stamps `recordMutation()`. Whichever kind's
    // header next reloads within `undoWindow` seconds of that stamp shows
    // "Undo" (`UndoButton`, `canUndo(at:)`) — see `RemindersProvider`/
    // `TasksProvider`/`TrackProvider`'s `getTimeline` for the explicit
    // expiry entry that turns it back off (WidgetKit has no "expire after N
    // seconds" primitive, only entries dated for a specific moment).

    private static let lastMutationAtKey = "widget.lastMutationAt"
    static let undoWindow: TimeInterval = 60

    /// Stamp "a mutation just happened, undo-able from right now."
    static func recordMutation(now: Date = Date()) {
        defaults?.set(now.timeIntervalSince1970, forKey: lastMutationAtKey)
    }

    private static func lastMutationAt() -> Date? {
        guard let stamp = defaults?.object(forKey: lastMutationAtKey) as? Double else { return nil }
        return Date(timeIntervalSince1970: stamp)
    }

    /// Whether a header shown AT `date` should carry the Undo button. Used
    /// both for "right now" (the entry a provider builds live) and for a
    /// scheduled FUTURE entry (a Reminders/Tasks boundary that happens to
    /// fall inside the window) — see the providers' `getTimeline`.
    static func canUndo(at date: Date = Date()) -> Bool {
        guard let at = lastMutationAt() else { return false }
        let elapsed = date.timeIntervalSince(at)
        return elapsed >= 0 && elapsed < undoWindow
    }

    /// The exact moment the window closes, for scheduling the explicit
    /// "turn Undo back off" timeline entry. `nil` when there is no live
    /// mutation to expire.
    static func undoExpiry() -> Date? {
        lastMutationAt().map { $0.addingTimeInterval(undoWindow) }
    }

    /// Atomically consume the undo window: returns the mutation's original
    /// timestamp (still live, now cleared) or `nil` (already expired, or a
    /// concurrent tap already claimed it). `UndoLastActionIntent` uses this
    /// instead of a plain `canUndo` check plus a separate clear so two
    /// overlapping taps — a real double-tap, or a second `perform()` invoked
    /// while the first's network call is still in flight — cannot both fire
    /// a server undo: `/api/undo` walks back ONE action at a time, and a
    /// second call would undo the action BEFORE the one the user meant to
    /// reverse. The returned timestamp lets a FAILED undo put the window
    /// back (`restoreMutation(at:)`) without extending it past its original
    /// deadline.
    static func consumeUndo(now: Date = Date()) -> Date? {
        pendingLock.lock()
        defer { pendingLock.unlock() }
        guard let at = lastMutationAt(), now.timeIntervalSince(at) < undoWindow else { return nil }
        defaults?.removeObject(forKey: lastMutationAtKey)
        return at
    }

    /// Restore the window after a FAILED `/api/undo` call, so a retry is
    /// still possible — otherwise a network blip silently leaves the item
    /// done with no way back short of reopening the app. Re-stamped at the
    /// ORIGINAL mutation instant (from `consumeUndo`'s return value), not
    /// "now", so a failed attempt doesn't extend the total window the user
    /// gets.
    static func restoreMutation(at date: Date) {
        pendingLock.lock()
        defer { pendingLock.unlock() }
        defaults?.set(date.timeIntervalSince1970, forKey: lastMutationAtKey)
    }

    /// Wipe every optimistic/confirmed marker this store holds. Called after
    /// a successful `/api/undo` (`UndoLastActionIntent`): the response
    /// carries no task id (`{undone_action, description, tasks_affected}` —
    /// see `src/app/api/undo/route.ts`), so there is no way to know which
    /// ONE entry — a completion tombstone, a confirmed completion (see the
    /// 2026-09-23 note above), or a staged progress delta — belongs to the
    /// action that was just reversed. Clearing all three maps is the honest
    /// alternative: an undone completion must not stay hidden behind either
    /// the 90s tombstone OR the 15-minute confirmed-completion window, and a
    /// staged progress delta must not double-count against a server value
    /// the undo just changed. The reload that follows re-fetches server
    /// truth for whatever the acted-on widgets show, so nothing genuinely in
    /// flight is lost — only the brief optimistic guess is, which the undo
    /// itself already invalidated.
    static func clearAllPendingState() {
        defaults?.removeObject(forKey: pendingCompletionsKey)
        defaults?.removeObject(forKey: pendingProgressKey)
        defaults?.removeObject(forKey: confirmedCompletionsKey)
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

    static func filterPending(_ groups: [ReminderGroupDTO], now: Date = Date()) -> [ReminderGroupDTO] {
        groups.map { group in
            ReminderGroupDTO(slot: group.slot, reminders: filterPending(group.reminders, now: now))
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
}
