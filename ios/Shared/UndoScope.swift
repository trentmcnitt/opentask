import Foundation

/// SCOPED NATIVE UNDO (2026-10-26, plan 2, native half; the server half is PR
/// #390). Trent: the widget's Undo undid the newest undo entry from ANY
/// device, "whether it was undone or not". The rule now: a native surface's
/// Undo reverses only ITS OWN last action.
///
/// A SURFACE is one of:
/// - the phone (or Mac) widget extension — all three widget kinds together
///   (`WidgetStore`'s scope), and
/// - the watch — the watch app and its Smart Stack card together
///   (`WatchCache`'s scope): a Smart Stack tap feeds the watch's Undo.
/// The iPhone app, its notification extension and the Mac app record
/// nothing (no `APIClient.undoRecorder` there).
///
/// How it works, all against the server's own ids:
/// - Every native-called mutation answers `undo_id` (the entry it logged;
///   null when it logged nothing). `APIClient` hands a non-null one to the
///   process's recorder, which pushes it here (`recordOwn`). A tap that
///   logged nothing keeps the previous id. Capped at `cap` ids, so repeated
///   Undo walks back the surface's own taps.
/// - `GET /api/undo/status` says which entry a bare undo would take next
///   (`newest_undoable_id`) and a bare redo (`next_redoable_id`). Undo is
///   offered only while the top of this surface's stack IS that entry —
///   anything newer, from any device, disables it (never hides it: the
///   widgets' buttons are always present). Redo the same, with `ownRedo`.
/// - Undo sends `POST /api/undo { id }`; the server acts only if that id is
///   still the one a bare undo would take, else 409 (`undoConflict`): the
///   button disables and the subtitle says "Changed elsewhere — can't undo"
///   (`UndoScope.changedElsewhere`).
/// - An OLDER SERVER (status without `newest_undoable_id`, and no `undo_id`
///   on mutations) leaves `scoped` false: every surface keeps the older
///   count-based buttons and bare undo/redo.
///
/// THE RACE THE STAMPS PREVENT: a status fetch sent before a tap but answered
/// after it would say the entry before the tap's is newest, and disable the
/// Undo the tap just lit. So a status is applied only when its request
/// started at or after the last change this scope knows of (`changedAt`) —
/// the widgets' "a fetch that STARTED after" rule (`ios/AGENTS.md`).
///
/// Foundation-only and pure (`UndoScopeTests`); `UndoScopeStore` persists it.
struct UndoScope: Codable, Equatable {
    /// Ids kept per surface: enough to walk back a burst of taps, small
    /// enough that a stack never outlives its usefulness.
    static let cap = 20

    /// The subtitle after a stale Undo/Redo tap (approved wording).
    static let changedElsewhere = "Changed elsewhere \u{2014} can\u{2019}t undo"

    /// This surface's own undo entries, oldest first (the top is `last`).
    private(set) var own: [Int] = []
    /// Entries this surface undid, oldest first — what its Redo may replay.
    private(set) var ownRedo: [Int] = []
    /// The server's `newest_undoable_id` as last known (nil: none, or
    /// unknown right after an undo until the next status).
    private(set) var newestUndoable: Int?
    /// The server's `next_redoable_id` as last known.
    private(set) var nextRedoable: Int?
    /// The server answers by id (a status carried `newest_undoable_id`, or a
    /// mutation answered `undo_id`). False against an older server.
    private(set) var scoped = false
    /// When this scope last changed from the surface's own side (a recorded
    /// id, an undo, a redo, a 409) — see the race note above.
    private(set) var changedAt: Date?

    enum CodingKeys: String, CodingKey {
        case own, ownRedo = "own_redo", newestUndoable = "newest_undoable", nextRedoable = "next_redoable"
        case scoped, changedAt = "changed_at"
    }

    init() {}

    // MARK: What the buttons offer

    /// The id this surface's Undo would send, or nil (nothing of its own is
    /// the newest undoable entry).
    var undoTarget: Int? {
        guard scoped, let top = own.last, top == newestUndoable else { return nil }
        return top
    }

    /// The id this surface's Redo would send, or nil.
    var redoTarget: Int? {
        guard scoped, let top = ownRedo.last, top == nextRedoable else { return nil }
        return top
    }

    /// Whether Undo is enabled. `queuedTaps`: taps still waiting to be sent
    /// (the widget outbox) — Undo takes the newest of them back locally, as
    /// before. `legacyUndoable`: the server's undoable count, for an older
    /// server (`-1` = never fetched, read as enabled — the old rule).
    func canUndo(queuedTaps: Bool = false, legacyUndoable: Int) -> Bool {
        if queuedTaps { return true }
        guard scoped else { return legacyUndoable != 0 }
        return undoTarget != nil
    }

    func canRedo(legacyRedoable: Int) -> Bool {
        guard scoped else { return legacyRedoable != 0 }
        return redoTarget != nil
    }

    // MARK: Changes

    /// A mutation from this surface answered `undo_id`: it is now the newest
    /// undoable entry (the response is authoritative), and a new action
    /// clears the redo stack, server-side and here.
    mutating func recordOwn(_ id: Int, at now: Date = Date()) {
        if own.last != id {
            own.removeAll { $0 == id }
            own.append(id)
            if own.count > Self.cap { own.removeFirst(own.count - Self.cap) }
        }
        ownRedo = []
        newestUndoable = id
        nextRedoable = nil
        scoped = true
        changedAt = now
    }

    /// `GET /api/undo/status`, whose request was sent at `requestedAt`.
    /// `scoped` false (an older server): the ids are ignored and the
    /// buttons go back to the counts. A status older than this scope's last
    /// change is ignored (the race note above). An own id ABOVE the newest
    /// undoable entry was undone elsewhere (or purged): it leaves the stack,
    /// so the next own one below can be offered. Nothing redoable clears
    /// `ownRedo`.
    mutating func apply(newestUndoable newest: Int?, nextRedoable next: Int?, scoped: Bool, requestedAt: Date) {
        guard scoped else {
            self.scoped = false
            return
        }
        self.scoped = true
        if let changedAt, requestedAt < changedAt { return }
        newestUndoable = newest
        nextRedoable = next
        while let top = own.last, newest.map({ top > $0 }) ?? true { own.removeLast() }
        if next == nil { ownRedo = [] }
    }

    /// `POST /api/undo { id }` succeeded: the entry moves to `ownRedo`, it is
    /// the next redo, and the newest undoable entry is unknown until the next
    /// status (the caller fetches one).
    mutating func undid(_ id: Int, at now: Date = Date()) {
        own.removeAll { $0 == id }
        ownRedo.removeAll { $0 == id }
        ownRedo.append(id)
        if ownRedo.count > Self.cap { ownRedo.removeFirst(ownRedo.count - Self.cap) }
        newestUndoable = nil
        nextRedoable = id
        changedAt = now
    }

    /// `POST /api/redo { id }` succeeded: the entry is this surface's newest
    /// undoable one again; the next redo is unknown until the next status.
    mutating func redid(_ id: Int, at now: Date = Date()) {
        ownRedo.removeAll { $0 == id }
        own.removeAll { $0 == id }
        own.append(id)
        if own.count > Self.cap { own.removeFirst(own.count - Self.cap) }
        newestUndoable = id
        nextRedoable = nil
        changedAt = now
    }

    /// `POST /api/undo { id }` answered 409. `newest` is the server's
    /// `details.newest_undoable_id`. `not_latest` keeps the id (it can be
    /// the newest again if what came after it is undone elsewhere); an id
    /// already undone or gone leaves the stack.
    mutating func undoConflict(id: Int, reason: UndoConflictReason, newest: Int?, at now: Date = Date()) {
        newestUndoable = newest
        if reason != .notLatest { own.removeAll { $0 == id } }
        changedAt = now
    }

    /// `POST /api/redo { id }` answered 409: `next` is `details.next_redoable_id`.
    mutating func redoConflict(id: Int, reason: UndoConflictReason, next: Int?, at now: Date = Date()) {
        nextRedoable = next
        if reason != .notNext { ownRedo.removeAll { $0 == id } }
        changedAt = now
    }
}

/// The 409 `details.reason` of `POST /api/undo { id }` / `POST /api/redo { id }`.
enum UndoConflictReason: String, Equatable {
    /// Undo: something newer was logged since.
    case notLatest = "not_latest"
    /// Undo: that entry was already undone.
    case alreadyUndone = "already_undone"
    /// Undo or redo: purged, or not this user's.
    case gone
    /// Redo: it isn't the next redo.
    case notNext = "not_next"
    /// Redo: it isn't undone.
    case notUndone = "not_undone"
    /// A reason this build doesn't know.
    case unknown
}

/// A persisted `UndoScope` in one `UserDefaults` key — the widget
/// extension's (`WidgetStore.undoScope`) or the watch's (`WatchCache`). The
/// lock serializes read-modify-writes within one process (rapid taps run
/// concurrent `perform()`s); the two processes that share the watch's scope
/// (the app and its Smart Stack) write it on taps the user makes one at a
/// time.
final class UndoScopeStore {
    private let key: String
    private let defaults: () -> UserDefaults?
    private let lock = NSLock()

    init(key: String, defaults: @escaping () -> UserDefaults?) {
        self.key = key
        self.defaults = defaults
    }

    func load() -> UndoScope {
        lock.lock()
        defer { lock.unlock() }
        return loadLocked()
    }

    @discardableResult
    func update<T>(_ body: (inout UndoScope) -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        var scope = loadLocked()
        let result = body(&scope)
        if let data = try? JSONEncoder().encode(scope) { defaults()?.set(data, forKey: key) }
        return result
    }

    private func loadLocked() -> UndoScope {
        guard let data = defaults()?.data(forKey: key),
              let scope = try? JSONDecoder().decode(UndoScope.self, from: data)
        else { return UndoScope() }
        return scope
    }
}
