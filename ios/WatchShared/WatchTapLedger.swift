import Foundation

/// The watch app's taps that have not reached a payload yet (2026-11-20, Trent:
/// "if I'm going through very quickly, sometimes it won't register, and ones I
/// already tapped will reappear").
///
/// Every tap on a list row (a reminder, a quota prompt, a task segment row, a
/// Tasks-page task) is drawn at once, and most taps then run a full `load()`.
/// A run of N fast taps starts N overlapping loads; before this, each one
/// replaced the lists wholesale, so a load that reached the server before tap k
/// was applied — and landed after tap k had taken its row off — put row k back,
/// and loads finishing out of order made it worse.
///
/// THE RULES — the web's (`src/lib/pending-overlay.ts`), so the two can't
/// drift:
/// 1. A load that STARTED before the newest tap is dropped when it lands
///    (`admit`); the load that started after the last tap is the one that
///    shows. A dropped load leaves `owesLoad` set, so a tap that runs no load
///    of its own (a segment consider) runs one once nothing is in flight. So
///    is a load older than one already applied (the web's
///    `LatestRequestGuard`): it can only be staler.
/// 2. A tap is drawn over every payload until a payload whose load BEGAN AFTER
///    ITS WRITE ANSWERED has been applied (`entries` → `landed`). Only that one
///    is known to include the write: a load that began while the write was out
///    may or may not. Rule 1 alone leaves that gap — a load started after the
///    newest tap but while an earlier tap's request was still out.
/// 3. A failed write drops its entry at once (`drop`): the row comes back, as
///    the server still has it.
///
/// Each entry carries the token of the tap that made it, so a later tap on the
/// same key replaces it and an earlier answer can neither settle nor drop it.
/// Foundation-only, so `OpenTaskLogicTests` covers it (`WatchTapLedgerTests`).
struct WatchTapLedger {
    /// What a tap did to its row, as drawn until the payload has it.
    enum Effect: Equatable {
        /// A reminder considered: out of `reminders`, into `consideredItems`.
        case reminderConsidered
        /// A quota prompt handled; `did` also logs one.
        case prompt(did: Bool)
        /// A task segment row considered (`consideredByTap`).
        case segmentConsidered
        /// A task segment row left handled (`leaving`): done or Today.
        case segmentLeft(SegmentLeft)
        /// A task completed from the Tasks page: off the list.
        case taskDone
    }

    /// One tap's mark.
    private struct Entry {
        let effect: Effect
        let token: Int
        /// `loadsBegun` when its write answered; nil while it is out.
        var settledAt: Int?
    }

    /// When a load began, as `beginLoad` hands it out.
    struct LoadTicket: Equatable {
        /// The loads begun before it, itself included.
        let load: Int
        /// The taps made before it began.
        let taps: Int
    }

    private var entries: [String: Entry] = [:]
    private var taps = 0
    private var loadsBegun = 0
    private var tokens = 0
    /// A load was dropped (rule 1) and none has landed since.
    private(set) var owesLoad = false
    /// The newest load applied (`landed`); an older one landing later is dropped.
    private var newestLanded = 0

    static func reminderKey(_ id: Int) -> String { "r:\(id)" }
    static func promptKey(_ key: String) -> String { "p:\(key)" }
    static func segmentKey(_ id: Int) -> String { "s:\(id)" }
    static func taskKey(_ id: Int) -> String { "t:\(id)" }

    /// A tap: `key` is drawn with `effect` from now on. Returns its token.
    mutating func tap(_ key: String, _ effect: Effect) -> Int {
        taps += 1
        tokens += 1
        entries[key] = Entry(effect: effect, token: tokens, settledAt: nil)
        return tokens
    }

    /// The tap's write answered: drawn until a load begun from now on lands.
    mutating func settle(_ key: String, token: Int) {
        guard entries[key]?.token == token else { return }
        entries[key]?.settledAt = loadsBegun
    }

    /// The tap's write failed: its row goes back at once.
    mutating func drop(_ key: String, token: Int) {
        guard entries[key]?.token == token else { return }
        entries[key] = nil
    }

    /// Whether a tap on `key` is still waiting for its write to answer.
    func isInFlight(_ key: String) -> Bool {
        entries[key].map { $0.settledAt == nil } ?? false
    }

    /// Whether any tap's write is still out.
    var anyInFlight: Bool { entries.values.contains { $0.settledAt == nil } }

    /// A load is starting.
    mutating func beginLoad() -> LoadTicket {
        loadsBegun += 1
        return LoadTicket(load: loadsBegun, taps: taps)
    }

    /// Whether a load may be applied: no tap came after it began (rule 1).
    /// A stale one is noted (`owesLoad`), so the last tap is sure to get a
    /// load of its own.
    mutating func admit(_ ticket: LoadTicket) -> Bool {
        guard ticket.load > newestLanded else { return false }
        guard ticket.taps == taps else {
            owesLoad = true
            return false
        }
        return true
    }

    /// The load `ticket` was applied: every tap it is known to include
    /// retires (rule 2).
    mutating func landed(_ ticket: LoadTicket) {
        owesLoad = false
        newestLanded = max(newestLanded, ticket.load)
        entries = entries.filter { _, entry in
            guard let settledAt = entry.settledAt else { return true }
            return settledAt >= ticket.load
        }
    }

    /// The marks to draw now, by key.
    var effects: [String: Effect] { entries.mapValues(\.effect) }

    // MARK: - Drawing the marks over a payload

    /// `groups` with every considered reminder and handled prompt drawn so.
    func overlay(groups: [ReminderGroupDTO]) -> [ReminderGroupDTO] {
        guard !entries.isEmpty else { return groups }
        return groups.map { group in
            let leaving = group.reminders.filter { entries[Self.reminderKey($0.id)] != nil }
            let prompts = group.prompts.map { prompt -> QuotaPromptDTO in
                guard prompt.isWaiting, case let .prompt(did) = entries[Self.promptKey(prompt.promptKey)]?.effect
                else { return prompt }
                return prompt.handled(did: did)
            }
            guard !leaving.isEmpty else { return group.replacingPrompts(prompts) }
            let ids = Set(leaving.map(\.id))
            return ReminderGroupDTO(
                slot: group.slot,
                reminders: group.reminders.filter { !ids.contains($0.id) },
                considered: group.considered + leaving.count,
                consideredItems: leaving + group.consideredItems.filter { !ids.contains($0.id) },
                prompts: prompts
            )
        }
    }

    /// `segments` with every tapped row drawn as the tap left it.
    func overlay(segments: [TaskSegmentDTO]) -> [TaskSegmentDTO] {
        guard !entries.isEmpty else { return segments }
        return segments.map { segment in
            segment.replacingTasks(segment.tasks.map { row in
                switch entries[Self.segmentKey(row.id)]?.effect {
                case .segmentConsidered: return row.isConsiderable ? row.consideredByTap() : row
                case let .segmentLeft(how): return row.left == nil ? row.leaving(how) : row
                default: return row
                }
            })
        }
    }

    /// `tasks` without the ones completed from the Tasks page.
    func overlay(tasks: [TaskDTO]) -> [TaskDTO] {
        guard !entries.isEmpty else { return tasks }
        return tasks.filter { entries[Self.taskKey($0.id)] == nil }
    }
}
