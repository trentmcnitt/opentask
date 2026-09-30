import XCTest

/// The widget outbox (2026-09-30, instant check-off): check-off taps are
/// queued in the App Group and sent after `perform()` returns
/// (`WidgetOutboxDrainer`, `WidgetStore`'s "Outbox" section). These pin the
/// rules that keep a tap from being lost, sent twice, or left hidden after
/// the server refused it — against a stub transport, never the network.
final class WidgetOutboxTests: WidgetStoreTestCase {

    private let t0 = Date(timeIntervalSince1970: 1_768_492_800) // 2026-01-15T16:00:00Z
    private let occurrence = Fixtures.pinnedTimestamp

    // MARK: Helpers

    private func makeDrainer(
        _ transport: StubOutboxTransport, now: Date? = nil, reports: ReportLog = ReportLog()
    ) -> WidgetOutboxDrainer {
        let clockNow = now ?? t0
        return WidgetOutboxDrainer(transport: transport, clock: { clockNow }) { report in
            reports.append(report)
        }
    }

    /// What `CompleteTaskIntent.perform` does before returning.
    @discardableResult
    private func tapComplete(
        _ id: Int, dueAt: String? = Fixtures.pinnedTimestamp, kind: String = RemindersWidget.kind, at date: Date? = nil
    ) -> WidgetStore.OutboxEntry {
        let when = date ?? t0
        WidgetStore.stagePendingCompletion(id, now: when)
        let entry = WidgetStore.OutboxEntry(
            mutation: .complete(taskId: id, dueAt: dueAt), widgetKind: kind, createdAt: when, title: "Task \(id)"
        )
        WidgetStore.enqueueOutbox(entry)
        return entry
    }

    @discardableResult
    private func tapPrompt(_ key: String, did: Bool, at date: Date? = nil) -> WidgetStore.OutboxEntry {
        let when = date ?? t0
        WidgetStore.stagePendingPromptAction(key, did: did, now: when)
        let entry = WidgetStore.OutboxEntry(
            mutation: .prompt(key: key, did: did), widgetKind: RemindersWidget.kind, createdAt: when, title: nil
        )
        WidgetStore.enqueueOutbox(entry)
        return entry
    }

    @discardableResult
    private func tapProgress(_ id: Int, delta: Int = 1, at date: Date? = nil) -> WidgetStore.OutboxEntry {
        let when = date ?? t0
        WidgetStore.stagePendingProgress(id, delta: delta, now: when)
        let entry = WidgetStore.OutboxEntry(
            mutation: .progress(taskId: id, delta: delta), widgetKind: TrackWidget.kind, createdAt: when, title: nil
        )
        WidgetStore.enqueueOutbox(entry)
        return entry
    }

    private func seedReminders() throws {
        WidgetStore.saveReminders(try Fixtures.reminders("reminders-initial"), fetchStartedAt: t0)
    }

    private func cachedReminderIds() -> Set<Int> {
        Set((WidgetStore.loadReminders()?.value.groups ?? []).flatMap(\.reminders).map(\.id))
    }

    private func dailyQuota(current: Int) -> TaskDTO {
        TaskDTO(
            id: Fixtures.daily, title: "Drink water", rrule: "FREQ=DAILY", progressTarget: 2,
            progressCurrent: current, trackedFlag: true
        )
    }

    // MARK: Persistence and display

    /// A queued check-off stays hidden for as long as it is queued — an
    /// offline tap must not reappear when its 90s tombstone expires — but it
    /// doesn't keep the fast path alive: the widget still fetches later.
    func testQueuedCompletionStaysHiddenPastTheTombstoneTTL() {
        tapComplete(Fixtures.stretch)
        let later = t0.addingTimeInterval(600)
        XCTAssertEqual(WidgetStore.pendingCompletions(now: later), [Fixtures.stretch])
        XCTAssertFalse(WidgetStore.hasRecentInteraction(now: later))
        XCTAssertEqual(WidgetStore.outboxEntries().count, 1)
    }

    func testQueuedPromptStaysDrawnHandledPastTheTombstoneTTL() {
        let key = Fixtures.promptKey(Fixtures.daily, 1)
        tapPrompt(key, did: true)
        XCTAssertEqual(WidgetStore.pendingPromptActions(now: t0.addingTimeInterval(600)), [key: true])
    }

    func testEntriesRoundTripThroughTheStore() {
        let entry = tapComplete(Fixtures.stretch)
        let stored = WidgetStore.outboxEntries()
        XCTAssertEqual(stored, [entry])
        XCTAssertEqual(stored.first?.createdDate.timeIntervalSince1970, t0.timeIntervalSince1970)
    }

    // MARK: Completions

    /// Four rapid taps: four requests (one undo entry each), oldest first,
    /// each confirmed into the cache.
    func testRapidTapsAreSentOneRequestEachInOrder() async throws {
        try seedReminders()
        let ids = [Fixtures.stretch, Fixtures.planTomorrow, Fixtures.plants, 107]
        ids.forEach { tapComplete($0) }
        let transport = StubOutboxTransport()
        let reports = ReportLog()
        await makeDrainer(transport, reports: reports).drain()

        XCTAssertEqual(transport.calls, ids.map { .markDone($0) })
        XCTAssertTrue(WidgetStore.outboxEntries().isEmpty)
        XCTAssertFalse(cachedReminderIds().contains(Fixtures.stretch))
        XCTAssertFalse(cachedReminderIds().contains(Fixtures.planTomorrow))
        XCTAssertEqual(reports.all, [OutboxDrainReport(confirmedKinds: [RemindersWidget.kind])])
        // The tombstones stay (harmless, 90s) — nothing flickers back.
        XCTAssertTrue(WidgetStore.pendingCompletions(now: t0).isSuperset(of: ids))
    }

    /// A send that timed out may have landed. The task is read back; it moved
    /// to its next occurrence, so it is confirmed — and never sent again,
    /// which would complete a recurring task a SECOND time.
    func testTimedOutCompletionThatLandedIsConfirmedNotResent() async throws {
        try seedReminders()
        tapComplete(Fixtures.stretch)
        let transport = StubOutboxTransport()
        transport.markDoneResults = [.failure(URLError(.timedOut))]
        transport.taskStates[Fixtures.stretch] = [
            .success(APIClient.TaskState(done: false, dueAt: "2026-01-16T16:00:00.000Z", deleted: false)),
        ]
        await makeDrainer(transport).drain()

        XCTAssertEqual(transport.calls, [.markDone(Fixtures.stretch), .fetchState(Fixtures.stretch)])
        XCTAssertTrue(WidgetStore.outboxEntries().isEmpty)
        XCTAssertFalse(cachedReminderIds().contains(Fixtures.stretch))
        XCTAssertTrue(WidgetStore.pendingCompletions(now: t0).contains(Fixtures.stretch))
    }

    /// "Task is already done" (400) after an earlier cut-off attempt: the
    /// read-back says done, so it's a success, not an honest failure.
    func testAlreadyDoneRejectionIsASuccess() async throws {
        tapComplete(Fixtures.plants)
        let transport = StubOutboxTransport()
        transport.markDoneResults = [.failure(APIError.serverError(statusCode: 400))]
        transport.taskStates[Fixtures.plants] = [.success(APIClient.TaskState(done: true, dueAt: nil, deleted: false))]
        let reports = ReportLog()
        await makeDrainer(transport, reports: reports).drain()

        XCTAssertTrue(WidgetStore.outboxEntries().isEmpty)
        XCTAssertTrue(WidgetStore.pendingCompletions(now: t0).contains(Fixtures.plants))
        XCTAssertEqual(reports.all.first?.failedKinds, [])
    }

    /// A real refusal: the task is untouched on the server, so the row comes
    /// back — tombstone gone, payload fetch-required, tapped kind repainted.
    func testRejectedCompletionRevertsAndRepaints() async throws {
        try seedReminders()
        tapComplete(Fixtures.stretch)
        let transport = StubOutboxTransport()
        transport.markDoneResults = [.failure(APIError.serverError(statusCode: 400))]
        transport.taskStates[Fixtures.stretch] = [
            .success(APIClient.TaskState(done: false, dueAt: occurrence, deleted: false)),
        ]
        let reports = ReportLog()
        await makeDrainer(transport, reports: reports).drain()

        XCTAssertTrue(WidgetStore.outboxEntries().isEmpty)
        XCTAssertFalse(WidgetStore.pendingCompletions(now: t0).contains(Fixtures.stretch))
        XCTAssertTrue(cachedReminderIds().contains(Fixtures.stretch))
        XCTAssertFalse(WidgetStore.canRepaintRemindersFromCache(now: t0))
        XCTAssertEqual(reports.all, [OutboxDrainReport(failedKinds: [RemindersWidget.kind])])
    }

    /// A timeout with the task unchanged: the request never landed. Stays
    /// queued (and hidden); the next drain verifies FIRST, then sends.
    func testUnlandedTimeoutIsVerifiedThenResentOnce() async throws {
        tapComplete(Fixtures.stretch)
        let transport = StubOutboxTransport()
        transport.markDoneResults = [.failure(URLError(.timedOut)), .success(())]
        let unchanged = APIClient.TaskState(done: false, dueAt: occurrence, deleted: false)
        transport.taskStates[Fixtures.stretch] = [.success(unchanged), .success(unchanged)]
        let drainer = makeDrainer(transport)

        await drainer.drain()
        XCTAssertEqual(WidgetStore.outboxEntries().first?.attempts, 1)
        XCTAssertNil(WidgetStore.outboxEntries().first?.sendingSince)
        XCTAssertTrue(WidgetStore.pendingCompletions(now: t0.addingTimeInterval(600)).contains(Fixtures.stretch))

        await drainer.drain()
        XCTAssertEqual(transport.calls, [
            .markDone(Fixtures.stretch), .fetchState(Fixtures.stretch),
            .fetchState(Fixtures.stretch), .markDone(Fixtures.stretch),
        ])
        XCTAssertTrue(WidgetStore.outboxEntries().isEmpty)
    }

    /// The process died mid-send (the entry still says `sendingSince`): the
    /// next process verifies before anything is resent.
    func testCutOffSendIsVerifiedBeforeResending() async throws {
        let entry = tapComplete(Fixtures.stretch)
        _ = WidgetStore.beginSendingOutboxEntry(entry.id, now: t0)
        let transport = StubOutboxTransport()
        transport.taskStates[Fixtures.stretch] = [.success(APIClient.TaskState(done: true, dueAt: nil, deleted: false))]
        await makeDrainer(transport).drain()

        XCTAssertEqual(transport.calls, [.fetchState(Fixtures.stretch)])
        XCTAssertTrue(WidgetStore.outboxEntries().isEmpty)
    }

    /// An old unsent completion is checked first too: done elsewhere (the
    /// web app, the watch) meanwhile → nothing to send.
    func testOldUnsentCompletionIsVerifiedFirst() async throws {
        tapComplete(Fixtures.stretch)
        let transport = StubOutboxTransport()
        transport.taskStates[Fixtures.stretch] = [.success(APIClient.TaskState(done: true, dueAt: nil, deleted: false))]
        await makeDrainer(transport, now: t0.addingTimeInterval(WidgetOutboxDrainer.verifyAfter + 1)).drain()
        XCTAssertEqual(transport.calls, [.fetchState(Fixtures.stretch)])
    }

    /// Gone (404) while queued: dropped, and the payload fetches.
    func testDeletedTaskIsDropped() async throws {
        tapComplete(Fixtures.stretch)
        let transport = StubOutboxTransport()
        transport.markDoneResults = [.failure(APIError.serverError(statusCode: 404))]
        transport.taskStates[Fixtures.stretch] = [.success(nil)]
        await makeDrainer(transport).drain()
        XCTAssertTrue(WidgetStore.outboxEntries().isEmpty)
        XCTAssertFalse(WidgetStore.pendingCompletions(now: t0).contains(Fixtures.stretch))
    }

    /// Offline: the pass stops at the first entry (the rest would fail the
    /// same way), everything stays queued, in order.
    func testOfflineStopsThePassAndKeepsEverythingQueued() async throws {
        let first = tapComplete(Fixtures.stretch)
        let second = tapComplete(Fixtures.planTomorrow)
        let transport = StubOutboxTransport()
        transport.markDoneResults = [.failure(URLError(.notConnectedToInternet))]
        let reports = ReportLog()
        await makeDrainer(transport, reports: reports).drain()

        XCTAssertEqual(transport.calls, [.markDone(Fixtures.stretch)])
        XCTAssertEqual(WidgetStore.outboxEntries().map(\.id), [first.id, second.id])
        XCTAssertTrue(reports.all.isEmpty, "nothing changed — no reload spent")
    }

    func testGivesUpAfterMaxAttempts() async throws {
        let entry = tapComplete(Fixtures.stretch)
        for _ in 0..<WidgetOutboxDrainer.maxAttempts { WidgetStore.requeueOutboxEntry(entry.id) }
        let transport = StubOutboxTransport()
        await makeDrainer(transport).drain()
        XCTAssertTrue(transport.calls.isEmpty)
        XCTAssertTrue(WidgetStore.outboxEntries().isEmpty)
        XCTAssertFalse(WidgetStore.pendingCompletions(now: t0).contains(Fixtures.stretch))
    }

    /// A failed Reminders check-off puts back the auto-advance it caused.
    func testFailureRestoresTheAutoAdvance() async throws {
        WidgetStore.setSlotOverride(slotKey: 11, naturalSlotKey: 12)
        WidgetStore.snapshotSlotOverrideBeforeAutoAdvance(at: t0)
        WidgetStore.setSlotOverride(slotKey: 14, naturalSlotKey: 12)
        tapComplete(Fixtures.stretch)
        let transport = StubOutboxTransport()
        transport.markDoneResults = [.failure(APIError.serverError(statusCode: 400))]
        transport.taskStates[Fixtures.stretch] = [
            .success(APIClient.TaskState(done: false, dueAt: occurrence, deleted: false)),
        ]
        await makeDrainer(transport).drain()
        XCTAssertEqual(WidgetStore.slotOverride()?.slotKey, 11)
    }

    // MARK: Prompts

    func testPromptActionsConfirmBothCachesAndAskForQuotasOncePerPass() async throws {
        try seedReminders()
        WidgetStore.saveTasks([dailyQuota(current: 0)], projects: [], completions: [], fetchStartedAt: t0)
        let did = Fixtures.promptKey(Fixtures.daily, 1)
        let consider = Fixtures.promptKey(Fixtures.monthly, 0)
        tapPrompt(did, did: true)
        tapPrompt(consider, did: false)
        let transport = StubOutboxTransport()
        transport.promptResults = [
            .success(APIClient.PromptActionResult(considered: 1, did: 1, tasks: [dailyQuota(current: 1)])),
            .success(APIClient.PromptActionResult(considered: 1, did: 0, tasks: [])),
        ]
        let reports = ReportLog()
        await makeDrainer(transport, reports: reports).drain()

        XCTAssertEqual(transport.calls, [.did([did]), .consider([consider])])
        XCTAssertTrue(WidgetStore.outboxEntries().isEmpty)
        XCTAssertEqual(WidgetStore.loadTasks()?.value.tasks.first?.progressCurrent, 1)
        let cached = try XCTUnwrap(WidgetStore.loadReminders()?.value.groups.flatMap(\.prompts).first { $0.promptKey == did })
        XCTAssertTrue(cached.considered)
        XCTAssertEqual(reports.all, [
            OutboxDrainReport(confirmedKinds: [RemindersWidget.kind], dependentKinds: [TrackWidget.kind]),
        ])
    }

    /// A key from before midnight: 400, the prompt comes back and Reminders
    /// fetches today's prompts.
    func testRejectedPromptClearsItsTombstone() async throws {
        let key = Fixtures.promptKey(Fixtures.daily, 1)
        tapPrompt(key, did: false)
        let transport = StubOutboxTransport()
        transport.promptResults = [.failure(APIError.serverError(statusCode: 400))]
        await makeDrainer(transport).drain()
        XCTAssertTrue(WidgetStore.pendingPromptActions(now: t0).isEmpty)
        XCTAssertTrue(WidgetStore.outboxEntries().isEmpty)
        XCTAssertFalse(WidgetStore.canRepaintRemindersFromCache(now: t0))
    }

    /// Consider/did-it are idempotent per key, so a timeout is simply resent.
    func testTimedOutPromptIsResent() async throws {
        let key = Fixtures.promptKey(Fixtures.daily, 1)
        tapPrompt(key, did: true)
        let transport = StubOutboxTransport()
        transport.promptResults = [
            .failure(URLError(.timedOut)),
            .success(APIClient.PromptActionResult(considered: 1, did: 1, tasks: [])),
        ]
        let drainer = makeDrainer(transport)
        await drainer.drain()
        XCTAssertEqual(WidgetStore.outboxEntries().count, 1)
        await drainer.drain()
        XCTAssertEqual(transport.calls, [.did([key]), .did([key])])
        XCTAssertTrue(WidgetStore.outboxEntries().isEmpty)
    }

    // MARK: Progress

    func testProgressConfirmWritesTheServerCountAndRetiresTheDelta() async throws {
        WidgetStore.saveTasks([dailyQuota(current: 0)], projects: [], completions: [], fetchStartedAt: t0)
        tapProgress(Fixtures.daily)
        let transport = StubOutboxTransport()
        transport.progressResults = [.success(dailyQuota(current: 1))]
        let reports = ReportLog()
        await makeDrainer(transport, reports: reports).drain()
        XCTAssertEqual(WidgetStore.loadTasks()?.value.tasks.first?.progressCurrent, 1)
        XCTAssertTrue(WidgetStore.pendingProgressDeltas(now: t0).isEmpty)
        XCTAssertEqual(reports.all, [
            OutboxDrainReport(confirmedKinds: [TrackWidget.kind], dependentKinds: [RemindersWidget.kind]),
        ])
    }

    /// A `+1` can't be verified, so one that may have landed is never sent
    /// again: the delta goes and both payloads fetch the truth.
    func testIndeterminateProgressIsRetiredNotResent() async throws {
        tapProgress(Fixtures.daily)
        let transport = StubOutboxTransport()
        transport.progressResults = [.failure(URLError(.networkConnectionLost))]
        await makeDrainer(transport).drain()
        XCTAssertEqual(transport.calls, [.progress(Fixtures.daily, 1)])
        XCTAssertTrue(WidgetStore.outboxEntries().isEmpty)
        XCTAssertTrue(WidgetStore.pendingProgressDeltas(now: t0).isEmpty)
        XCTAssertFalse(WidgetStore.canRepaintTasksFromCache(now: t0))
        XCTAssertFalse(WidgetStore.canRepaintRemindersFromCache(now: t0))
    }

    /// Provably unsent → retried; cut off mid-send → dropped unsent.
    func testProgressRetriesOnlyWhatNeverLeftTheDevice() async throws {
        let entry = tapProgress(Fixtures.daily)
        let transport = StubOutboxTransport()
        transport.progressResults = [.failure(URLError(.cannotConnectToHost))]
        await makeDrainer(transport).drain()
        XCTAssertEqual(WidgetStore.outboxEntries().first?.attempts, 1)

        _ = WidgetStore.beginSendingOutboxEntry(entry.id, now: t0)
        await makeDrainer(StubOutboxTransport()).drain()
        XCTAssertTrue(WidgetStore.outboxEntries().isEmpty)
        XCTAssertEqual(transport.calls, [.progress(Fixtures.daily, 1)])
    }

    func testUnsentProgressExpiresWithItsStagedCount() async throws {
        tapProgress(Fixtures.daily)
        let transport = StubOutboxTransport()
        await makeDrainer(transport, now: t0.addingTimeInterval(WidgetOutboxDrainer.progressLifetime + 1)).drain()
        XCTAssertTrue(transport.calls.isEmpty)
        XCTAssertTrue(WidgetStore.outboxEntries().isEmpty)
    }

    // MARK: Undo and take-backs

    /// Undo with taps still queued (offline): the newest one that never left
    /// the device is taken back locally; one mid-send never is.
    func testCancelNewestQueuedTakesBackTheLastUnsentTap() {
        let first = tapComplete(Fixtures.stretch)
        let second = tapComplete(Fixtures.planTomorrow)
        let third = tapComplete(Fixtures.plants)
        _ = WidgetStore.beginSendingOutboxEntry(third.id, now: t0)

        let cancelled = WidgetStore.cancelNewestQueuedOutboxEntry()
        XCTAssertEqual(cancelled?.id, second.id)
        WidgetStore.revertOptimisticState(of: try! XCTUnwrap(cancelled))
        XCTAssertEqual(WidgetStore.outboxEntries().map(\.id), [first.id, third.id])
        XCTAssertEqual(WidgetStore.pendingCompletions(now: t0), [Fixtures.stretch, Fixtures.plants])
    }

    func testCancelQueuedMatchingTakesBackOnlyThatEntry() {
        tapComplete(Fixtures.stretch)
        let key = Fixtures.promptKey(Fixtures.daily, 1)
        tapPrompt(key, did: true)
        let cancelled = WidgetStore.cancelQueuedOutboxEntry {
            if case .prompt(let k, _) = $0 { return k == key }
            return false
        }
        XCTAssertNotNil(cancelled)
        XCTAssertEqual(WidgetStore.outboxEntries().count, 1)
        XCTAssertNil(WidgetStore.cancelQueuedOutboxEntry { _ in false })
    }

    func testLocalTakeBackForgetsTheOptimisticUndoCount() {
        WidgetStore.setUndoRedoCounts(undoable: 2, redoable: 0)
        WidgetStore.recordLocalMutationForUndoCount()
        WidgetStore.forgetLocalMutationForUndoCount()
        XCTAssertEqual(WidgetStore.undoableCount, 2)
    }

    // MARK: Concurrency

    /// Taps arrive as concurrent drains; each entry is still sent once, in
    /// order.
    func testConcurrentDrainsSendEachEntryOnce() async throws {
        let ids = Array(200..<210)
        ids.forEach { tapComplete($0) }
        let transport = StubOutboxTransport()
        transport.yieldsInMarkDone = true
        let drainer = makeDrainer(transport)
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<12 { group.addTask { await drainer.drain() } }
        }
        XCTAssertEqual(transport.calls, ids.map { .markDone($0) })
        XCTAssertTrue(WidgetStore.outboxEntries().isEmpty)
    }

    /// A tap queued while a pass is mid-request is still sent by the drain
    /// its intent kicks — not stranded because a pass was already running.
    func testEntryQueuedDuringARunningPassIsSent() async throws {
        tapComplete(Fixtures.stretch)
        let transport = StubOutboxTransport()
        let gate = Gate()
        transport.markDoneGate = gate
        let drainer = makeDrainer(transport)

        let firstDrain = Task { await drainer.drain() }
        await gate.waitUntilEntered()
        tapComplete(Fixtures.planTomorrow)
        let secondDrain = Task { await drainer.drain() }
        await gate.open()
        await firstDrain.value
        await secondDrain.value

        XCTAssertEqual(transport.calls, [.markDone(Fixtures.stretch), .markDone(Fixtures.planTomorrow)])
        XCTAssertTrue(WidgetStore.outboxEntries().isEmpty)
    }

    // MARK: Error classification

    func testFailureClassification() {
        XCTAssertEqual(OutboxFailure(APIError.serverError(statusCode: 400)), .rejected)
        XCTAssertEqual(OutboxFailure(APIError.serverError(statusCode: 404)), .rejected)
        XCTAssertEqual(OutboxFailure(APIError.serverError(statusCode: 401)), .notSent)
        XCTAssertEqual(OutboxFailure(APIError.serverError(statusCode: 429)), .notSent)
        XCTAssertEqual(OutboxFailure(APIError.serverError(statusCode: 502)), .indeterminate)
        XCTAssertEqual(OutboxFailure(APIError.notConfigured), .notSent)
        XCTAssertEqual(OutboxFailure(URLError(.notConnectedToInternet)), .notSent)
        XCTAssertEqual(OutboxFailure(URLError(.timedOut)), .indeterminate)
        XCTAssertEqual(OutboxFailure(URLError(.networkConnectionLost)), .indeterminate)
    }
}

// MARK: - Test doubles

/// Scripted server. Each call pops its next scripted result (default:
/// success); every call is logged in order.
final class StubOutboxTransport: WidgetOutboxTransport, @unchecked Sendable {
    enum Call: Equatable {
        case markDone(Int)
        case consider([String])
        case did([String])
        case progress(Int, Int)
        case fetchState(Int)
    }

    private let lock = NSLock()
    private var log: [Call] = []
    var markDoneResults: [Result<Void, Error>] = []
    var promptResults: [Result<APIClient.PromptActionResult, Error>] = []
    var progressResults: [Result<TaskDTO?, Error>] = []
    var taskStates: [Int: [Result<APIClient.TaskState?, Error>]] = [:]
    /// Suspend inside `markDone`, so concurrent drains really interleave.
    var yieldsInMarkDone = false
    var markDoneGate: Gate?

    var calls: [Call] {
        lock.lock()
        defer { lock.unlock() }
        return log
    }

    private func record(_ call: Call) {
        lock.lock()
        log.append(call)
        lock.unlock()
    }

    private func pop<T>(_ list: inout [Result<T, Error>], default value: T) -> Result<T, Error> {
        lock.lock()
        defer { lock.unlock() }
        return list.isEmpty ? .success(value) : list.removeFirst()
    }

    func markDone(taskId: Int) async throws {
        record(.markDone(taskId))
        if let gate = markDoneGate {
            markDoneGate = nil
            await gate.enterAndWait()
        }
        if yieldsInMarkDone { await Task.yield() }
        try pop(&markDoneResults, default: ()).get()
    }

    func considerPrompts(keys: [String]) async throws -> APIClient.PromptActionResult {
        record(.consider(keys))
        return try pop(&promptResults, default: APIClient.PromptActionResult(considered: keys.count, did: 0, tasks: [])).get()
    }

    func didPrompts(keys: [String]) async throws -> APIClient.PromptActionResult {
        record(.did(keys))
        return try pop(&promptResults, default: APIClient.PromptActionResult(considered: 0, did: keys.count, tasks: [])).get()
    }

    func logProgress(taskId: Int, delta: Int) async throws -> TaskDTO? {
        record(.progress(taskId, delta))
        return try pop(&progressResults, default: nil).get()
    }

    func fetchTaskState(taskId: Int) async throws -> APIClient.TaskState? {
        record(.fetchState(taskId))
        lock.lock()
        var list = taskStates[taskId] ?? []
        let next: Result<APIClient.TaskState?, Error> = list.isEmpty
            ? .success(APIClient.TaskState(done: false, dueAt: Fixtures.pinnedTimestamp, deleted: false))
            : list.removeFirst()
        taskStates[taskId] = list
        lock.unlock()
        return try next.get()
    }
}

/// Holds a request open until the test lets it go.
actor Gate {
    private var entered = false
    private var isOpen = false
    private var enterWaiters: [CheckedContinuation<Void, Never>] = []
    private var openWaiters: [CheckedContinuation<Void, Never>] = []

    func enterAndWait() async {
        entered = true
        enterWaiters.forEach { $0.resume() }
        enterWaiters = []
        if isOpen { return }
        await withCheckedContinuation { openWaiters.append($0) }
    }

    func waitUntilEntered() async {
        if entered { return }
        await withCheckedContinuation { enterWaiters.append($0) }
    }

    func open() {
        isOpen = true
        openWaiters.forEach { $0.resume() }
        openWaiters = []
    }
}

/// Every report a drainer handed its reload callback.
final class ReportLog: @unchecked Sendable {
    private let lock = NSLock()
    private var reports: [OutboxDrainReport] = []

    func append(_ report: OutboxDrainReport) {
        lock.lock()
        reports.append(report)
        lock.unlock()
    }

    var all: [OutboxDrainReport] {
        lock.lock()
        defer { lock.unlock() }
        return reports
    }
}
