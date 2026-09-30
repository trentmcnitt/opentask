import Foundation

/// Sends the widget outbox (`WidgetStore`'s "Outbox" section) — the
/// check-off-style taps whose `perform()` returned without waiting for the
/// server (2026-09-30, instant check-off).
///
/// WHY: on iOS a widget tap repaints exactly once for free, when WidgetKit
/// reloads the tapped kind AFTER `perform()` returns (`reloadTappedWidget`'s
/// doc), and WidgetKit runs one extension's intents serially. With the
/// request awaited inside `perform()`, a tap's first visible change was a
/// network round trip plus a timeline pass, and the owner's fourth rapid tap
/// waited for the first three's round trips. Now `perform()` stages, enqueues
/// and returns; this drains the queue behind the paint.
///
/// ONE REQUEST PER TAP, NOT `bulk/complete` — two reasons:
/// 1. Undo. The server logs one undo entry per request; a batch is one entry
///    for the whole burst, so Undo after four rapid taps would take back all
///    four. Undo is for "the accidental tap", which is the LAST one.
/// 2. Retries. `bulk/complete` refuses the whole batch when any id is
///    already done (`validateBulkTasks`), so a batch that half-landed could
///    never be resent. Per-tap requests fail and recover one at a time.
/// Batching would buy only server throughput; the latency win is from not
/// waiting inside `perform()`, and four sequential sends finish off-screen.
///
/// WHEN IT RUNS: kicked (not awaited) by each mutating intent right before
/// `perform()` returns, and by every provider's `getTimeline` AFTER it has
/// handed WidgetKit its timeline — so any reload, scheduled or pushed, is a
/// retry. Undo/Redo await it before calling the server, so they act on the
/// tap the user just made, not an older one. One pass at a time per process
/// (`drain()`), oldest entry first.
///
/// IDEMPOTENCY — a send can be cut off (timeout, lost connection, process
/// suspended mid-request) after the server acted. Per mutation:
/// - Completion: NOT idempotent — completing a recurring task twice advances
///   it two occurrences, and a done one-off answers 400. So before RESENDING
///   (a prior attempt, a cut-off send, or an entry older than
///   `verifyAfter`), and after any failure, the task is read back
///   (`fetchTaskState`): done, or `due_at` moved off the occurrence recorded
///   at the tap → it landed (or was done elsewhere) → confirmed, never sent
///   again. Gone (404/deleted) → dropped. Unchanged → safe to send.
/// - Prompt considered/did-it: idempotent per key server-side
///   (`/api/quota-prompts/*`), so a retry is just a resend. A 4xx — likeliest
///   a key from before midnight — is a definite failure.
/// - Progress `+1`/`−1`: can't be verified (the count moves for other
///   reasons too), so it is sent AT MOST ONCE, which is also what the widget
///   did before: an error that proves the request never left the device is
///   retried; anything else retires the staged delta and makes the next pass
///   fetch the truth. A `+1` still unsent after `progressLifetime` is dropped
///   — its staged count has expired from the display by then too.
///
/// FAILURE: a definite failure (or giving up — `maxAttempts`, `maxAge`)
/// removes the entry, clears its optimistic marker and auto-advance, marks
/// the payload fetch-required, and reports the tapped kind for a repaint —
/// the one reload this design adds, on failure only (on iOS it's budgeted:
/// the free interaction reload happened long before the failure was known).
/// A transient failure (offline, 5xx) leaves the entry queued and ends the
/// pass; the next trigger retries. While queued, the item stays hidden
/// (`WidgetStore.pendingCompletions`/`pendingPromptActions` include it).
actor WidgetOutboxDrainer {
    /// Sends before an entry is abandoned as undeliverable.
    static let maxAttempts = 8
    /// A queued completion or prompt older than this is abandoned.
    static let maxAge: TimeInterval = 6 * 60 * 60
    /// An unsent completion older than this is verified before sending, in
    /// case the task changed meanwhile (done elsewhere, or a new occurrence).
    static let verifyAfter: TimeInterval = 60
    /// An unsent `+1`/`−1` older than this is dropped — see the type doc.
    static let progressLifetime: TimeInterval = 90

    private let transport: WidgetOutboxTransport
    private let onPassFinished: @Sendable (OutboxDrainReport) async -> Void
    private let clock: @Sendable () -> Date

    private var pass: Task<Void, Never>?
    private var requested = 0
    private var completedThrough = 0

    init(
        transport: WidgetOutboxTransport,
        clock: @escaping @Sendable () -> Date = { Date() },
        onPassFinished: @escaping @Sendable (OutboxDrainReport) async -> Void
    ) {
        self.transport = transport
        self.clock = clock
        self.onPassFinished = onPassFinished
    }

    /// Send everything queued, returning once a pass that STARTED after this
    /// call has finished — so an entry enqueued before the call is covered,
    /// even when another pass was already running (it may have read the
    /// queue before the entry arrived). Concurrent callers share passes;
    /// never two passes at once, so no entry is sent twice by this process.
    func drain() async {
        requested += 1
        let mine = requested
        while completedThrough < mine {
            if let pass {
                await pass.value
            } else {
                let target = requested
                let task = Task { await self.runPass(through: target) }
                pass = task
                await task.value
            }
        }
    }

    private func runPass(through target: Int) async {
        var report = OutboxDrainReport()
        while let head = WidgetStore.outboxEntries().first {
            guard await process(head, into: &report) else { break }
        }
        // Before the reload callback, so a `drain()` arriving while reloads
        // are being requested starts a fresh pass rather than waiting on this
        // finished one.
        pass = nil
        completedThrough = target
        if !report.isEmpty { await onPassFinished(report) }
    }

    /// One entry. Returns false to end the pass (a transient failure — the
    /// rest would most likely fail the same way).
    private func process(_ entry: WidgetStore.OutboxEntry, into report: inout OutboxDrainReport) async -> Bool {
        let now = clock()
        let age = now.timeIntervalSince1970 - entry.createdAt
        if entry.attempts >= Self.maxAttempts || age > Self.maxAge {
            print("[OpenTaskWidgets] Outbox gave up on \(entry.mutation) after \(entry.attempts) attempts")
            fail(entry, into: &report)
            return true
        }
        switch entry.mutation {
        case .complete(let taskId, let dueAt):
            return await processCompletion(entry, taskId: taskId, dueAt: dueAt, age: age, into: &report)
        case .prompt(let key, let did):
            return await processPrompt(entry, key: key, did: did, into: &report)
        case .progress(let taskId, let delta):
            return await processProgress(entry, taskId: taskId, delta: delta, age: age, into: &report)
        }
    }

    // MARK: Completion

    private enum Verified { case landed, gone, unchanged }

    private func verify(taskId: Int, dueAt: String?) async throws -> Verified {
        guard let state = try await transport.fetchTaskState(taskId: taskId), !state.deleted else { return .gone }
        if state.done { return .landed }
        if let dueAt, state.dueAt != dueAt { return .landed }
        return .unchanged
    }

    private func processCompletion(
        _ entry: WidgetStore.OutboxEntry, taskId: Int, dueAt: String?, age: TimeInterval,
        into report: inout OutboxDrainReport
    ) async -> Bool {
        let mayHaveLanded = entry.sendingSince != nil || entry.attempts > 0
        if mayHaveLanded || age > Self.verifyAfter {
            do {
                switch try await verify(taskId: taskId, dueAt: dueAt) {
                case .landed: return confirmCompletion(entry, taskId: taskId, into: &report)
                case .gone: return drop(entry, into: &report)
                case .unchanged: break
                }
            } catch {
                WidgetStore.requeueOutboxEntry(entry.id)
                return false
            }
        }
        guard WidgetStore.beginSendingOutboxEntry(entry.id, now: clock()) != nil else { return true }
        do {
            try await transport.markDone(taskId: taskId)
            return confirmCompletion(entry, taskId: taskId, into: &report)
        } catch {
            let failure = OutboxFailure(error)
            print("[OpenTaskWidgets] Outbox complete \(taskId) failed (\(failure)): \(error)")
            if failure == .notSent {
                WidgetStore.requeueOutboxEntry(entry.id)
                return false
            }
            // Rejected or cut off: the server may have completed it anyway
            // (a timeout after the commit; "already done" from an earlier
            // cut-off attempt). Ask before deciding.
            let verified: Verified
            do {
                verified = try await verify(taskId: taskId, dueAt: dueAt)
            } catch {
                WidgetStore.requeueOutboxEntry(entry.id)
                return false
            }
            switch verified {
            case .landed: return confirmCompletion(entry, taskId: taskId, into: &report)
            case .gone: return drop(entry, into: &report)
            case .unchanged:
                if failure == .rejected {
                    fail(entry, into: &report)
                    return true
                }
                WidgetStore.requeueOutboxEntry(entry.id)
                return false
            }
        }
    }

    private func confirmCompletion(
        _ entry: WidgetStore.OutboxEntry, taskId: Int, into report: inout OutboxDrainReport
    ) -> Bool {
        WidgetStore.confirmCompletion(taskId)
        // Auto-advance correlation — see WidgetStore.recordMutation's doc.
        WidgetStore.recordMutation(now: entry.createdDate)
        WidgetStore.removeOutboxEntry(entry.id)
        report.confirmedKinds.insert(entry.widgetKind)
        return true
    }

    /// The task no longer exists for this user: nothing to send, nothing to
    /// put back. The payload must fetch so it stops drawing the row.
    private func drop(_ entry: WidgetStore.OutboxEntry, into report: inout OutboxDrainReport) -> Bool {
        WidgetStore.removeOutboxEntry(entry.id)
        WidgetStore.revertOptimisticState(of: entry)
        requireFetch(for: entry.widgetKind)
        report.failedKinds.insert(entry.widgetKind)
        return true
    }

    // MARK: Prompt

    private func processPrompt(
        _ entry: WidgetStore.OutboxEntry, key: String, did: Bool, into report: inout OutboxDrainReport
    ) async -> Bool {
        guard WidgetStore.beginSendingOutboxEntry(entry.id, now: clock()) != nil else { return true }
        do {
            let result = did
                ? try await transport.didPrompts(keys: [key])
                : try await transport.considerPrompts(keys: [key])
            // The server's truth into BOTH caches, so the next tap repaints
            // from cache at once: the quotas into Tasks/Quotas, and the
            // prompt handled plus every sibling prompt's count into Reminders.
            WidgetStore.confirmTasks(result.tasks)
            WidgetStore.confirmPromptAction(key, did: did, tasks: result.tasks)
            if !result.decoded {
                WidgetStore.requireRemindersFetch()
                WidgetStore.requireTasksFetch()
            }
            WidgetStore.recordMutation(now: entry.createdDate)
            WidgetStore.removeOutboxEntry(entry.id)
            report.confirmedKinds.insert(entry.widgetKind)
            // The quota's count is on the Quotas widget too — the one
            // cross-kind reload a prompt tap spends, once per pass.
            report.dependentKinds.insert(TrackWidget.kind)
            return true
        } catch {
            let failure = OutboxFailure(error)
            print("[OpenTaskWidgets] Outbox prompt \(key) \(did ? "did" : "consider") failed (\(failure)): \(error)")
            guard failure == .rejected else {
                // Idempotent per key: resend on the next trigger.
                WidgetStore.requeueOutboxEntry(entry.id)
                return false
            }
            fail(entry, into: &report)
            return true
        }
    }

    // MARK: Progress

    private func processProgress(
        _ entry: WidgetStore.OutboxEntry, taskId: Int, delta: Int, age: TimeInterval,
        into report: inout OutboxDrainReport
    ) async -> Bool {
        if entry.sendingSince != nil {
            // Cut off mid-send by a process that's gone: at most once.
            unknownProgress(entry, taskId: taskId, delta: delta, into: &report)
            return true
        }
        if age > Self.progressLifetime {
            fail(entry, into: &report)
            return true
        }
        guard WidgetStore.beginSendingOutboxEntry(entry.id, now: clock()) != nil else { return true }
        do {
            if let confirmed = try await transport.logProgress(taskId: taskId, delta: delta) {
                // The server's count into the cache in the same lock hold that
                // retires the delta (WidgetStore.confirmProgress's doc).
                WidgetStore.confirmProgress(confirmed, delta: delta)
            } else {
                // Logged, but the body didn't decode: retire the delta and
                // make the next pass fetch.
                WidgetStore.clearPendingProgress(taskId, delta: delta)
                WidgetStore.requireTasksFetch()
            }
            // This quota's prompts on the Reminders widget carry its count —
            // server-computed, so Reminders fetches rather than guessing.
            WidgetStore.requireRemindersFetch()
            WidgetStore.removeOutboxEntry(entry.id)
            report.confirmedKinds.insert(entry.widgetKind)
            report.dependentKinds.insert(RemindersWidget.kind)
            return true
        } catch {
            let failure = OutboxFailure(error)
            print("[OpenTaskWidgets] Outbox progress \(taskId) \(delta) failed (\(failure)): \(error)")
            switch failure {
            case .notSent:
                WidgetStore.requeueOutboxEntry(entry.id)
                return false
            case .rejected:
                fail(entry, into: &report)
                return true
            case .indeterminate:
                unknownProgress(entry, taskId: taskId, delta: delta, into: &report)
                return true
            }
        }
    }

    /// A `+1`/`−1` that may or may not have landed: never resent. The staged
    /// delta goes and both payloads that show the count fetch the truth.
    private func unknownProgress(
        _ entry: WidgetStore.OutboxEntry, taskId: Int, delta: Int, into report: inout OutboxDrainReport
    ) {
        WidgetStore.removeOutboxEntry(entry.id)
        WidgetStore.clearPendingProgress(taskId, delta: delta)
        WidgetStore.requireTasksFetch()
        WidgetStore.requireRemindersFetch()
        report.failedKinds.insert(entry.widgetKind)
        report.dependentKinds.insert(RemindersWidget.kind)
    }

    // MARK: Shared

    /// A definite failure: the tap didn't happen. Its marker goes so the item
    /// honestly reappears, and the tapped kind repaints.
    private func fail(_ entry: WidgetStore.OutboxEntry, into report: inout OutboxDrainReport) {
        WidgetStore.removeOutboxEntry(entry.id)
        WidgetStore.revertOptimisticState(of: entry)
        requireFetch(for: entry.widgetKind)
        report.failedKinds.insert(entry.widgetKind)
    }

    /// The payload `kind` draws from must fetch on its next pass. A failure
    /// usually means the cache is what's wrong (a key from before midnight, a
    /// task changed elsewhere), so the repaint shows the server, not a guess.
    private func requireFetch(for kind: String) {
        if kind == RemindersWidget.kind {
            WidgetStore.requireRemindersFetch()
        } else if kind.isEmpty {
            WidgetStore.requireRemindersFetch()
            WidgetStore.requireTasksFetch()
        } else {
            WidgetStore.requireTasksFetch()
        }
    }
}

/// What a drain pass changed, for the caller to turn into reloads (this file
/// stays Foundation-only; `WidgetIntents.swift` owns every WidgetKit call).
struct OutboxDrainReport: Equatable {
    /// Tapped kinds whose entries the server confirmed. They already show the
    /// confirmed state (the optimistic marker drew it), so only macOS — which
    /// has no interaction reload — repaints them.
    var confirmedKinds: Set<String> = []
    /// Tapped kinds that must repaint an honest revert. "" = unknown kind.
    var failedKinds: Set<String> = []
    /// OTHER kinds whose payload a change affected (a prompt's quota on
    /// Quotas; a `+1`'s prompts on Reminders).
    var dependentKinds: Set<String> = []

    var isEmpty: Bool { confirmedKinds.isEmpty && failedKinds.isEmpty && dependentKinds.isEmpty }
}

/// How a failed request ended, for the idempotency rules above.
enum OutboxFailure: Equatable, CustomStringConvertible {
    /// The server answered and refused (4xx): the mutation didn't happen.
    case rejected
    /// Provably never reached the server (no connection, not signed in, auth
    /// refused, rate-limited): resending is always safe.
    case notSent
    /// May or may not have been applied (timeout, dropped connection, 5xx,
    /// an unreadable answer).
    case indeterminate

    init(_ error: Error) {
        if let api = error as? APIError {
            switch api {
            case .notConfigured:
                self = .notSent
            case .invalidResponse:
                self = .indeterminate
            case .serverError(let code):
                switch code {
                // Auth refused, request timeout and rate limit are answered
                // before anything is applied.
                case 401, 403, 408, 429: self = .notSent
                case 400..<500: self = .rejected
                default: self = .indeterminate
                }
            }
            return
        }
        if let url = error as? URLError {
            switch url.code {
            case .notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed,
                .internationalRoamingOff, .dataNotAllowed, .callIsActive, .secureConnectionFailed,
                .appTransportSecurityRequiresSecureConnection:
                self = .notSent
            default:
                self = .indeterminate
            }
            return
        }
        self = .indeterminate
    }

    var description: String {
        switch self {
        case .rejected: return "rejected"
        case .notSent: return "not sent"
        case .indeterminate: return "indeterminate"
        }
    }
}

/// The server calls the drainer makes — `APIClient` in the extension, a stub
/// in `OpenTaskLogicTests` (which can't reach the Keychain or the network).
protocol WidgetOutboxTransport: AnyObject {
    func markDone(taskId: Int) async throws
    func considerPrompts(keys: [String]) async throws -> APIClient.PromptActionResult
    func didPrompts(keys: [String]) async throws -> APIClient.PromptActionResult
    func logProgress(taskId: Int, delta: Int) async throws -> TaskDTO?
    /// `nil` = the task is gone (404).
    func fetchTaskState(taskId: Int) async throws -> APIClient.TaskState?
}

extension APIClient: WidgetOutboxTransport {}
