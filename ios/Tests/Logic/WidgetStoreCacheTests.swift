import XCTest

/// `WidgetStore`'s optimistic layer and cache write-throughs, on a throwaway
/// UserDefaults suite (`WidgetStoreTestCase`). Every scenario here is one a
/// real widget bug came from — see each test's note.
final class WidgetStoreCacheTests: WidgetStoreTestCase {

    private let now = Date(timeIntervalSince1970: 1_768_492_800) // 2026-01-15T16:00:00Z

    private func groups(_ name: String = "reminders-initial") throws -> [ReminderGroupDTO] {
        try Fixtures.reminders(name)
    }

    private func dailyQuota(current: Int) -> TaskDTO {
        TaskDTO(
            id: Fixtures.daily, title: "Drink water", rrule: "FREQ=DAILY", progressTarget: 2,
            progressCurrent: current, trackedFlag: true, labels: ["personal"], hasNotes: true
        )
    }

    // MARK: Prompt tombstones

    /// A tapped prompt is drawn HANDLED, not removed: a slot's day total
    /// (waiting + considered) never shrinks, only the split moves.
    func testStagedPromptActionDrawsHandled() throws {
        let initial = try groups()
        let key = Fixtures.promptKey(Fixtures.daily, 1)
        WidgetStore.stagePendingPromptAction(key, did: true, now: now)

        let drawn = WidgetStore.filterPending(initial, now: now)
        let row = try XCTUnwrap(drawn.flatMap(\.prompts).first { $0.promptKey == key })
        XCTAssertEqual(row.current, 1)
        XCTAssertTrue(row.done)
        XCTAssertTrue(row.considered)
        XCTAssertEqual(drawn[0].waitingCount, initial[0].waitingCount - 1)
        XCTAssertEqual(drawn[0].consideredCount, initial[0].consideredCount + 1)
        XCTAssertEqual(
            drawn.map { $0.waitingCount + $0.consideredCount },
            initial.map { $0.waitingCount + $0.consideredCount }
        )
        // `considered` itself stays reminder-only.
        XCTAssertEqual(drawn.map(\.considered), initial.map(\.considered))
        // The sibling row is untouched by the optimistic render.
        XCTAssertTrue(try XCTUnwrap(drawn[1].prompts.first).isWaiting)
    }

    func testConsiderTombstoneChangesNoCountAndClearingBringsItBack() throws {
        let initial = try groups()
        let key = Fixtures.promptKey(Fixtures.monthly, 0)
        WidgetStore.stagePendingPromptAction(key, did: false, now: now)
        let drawn = try XCTUnwrap(WidgetStore.filterPending(initial, now: now).flatMap(\.prompts).first { $0.promptKey == key })
        XCTAssertEqual(drawn.current, 0)
        XCTAssertTrue(drawn.considered)
        XCTAssertFalse(drawn.done)
        XCTAssertTrue(WidgetStore.hasRecentInteraction(now: now), "a prompt tap repaints from cache")

        // A failed call clears its tombstone: the prompt honestly comes back.
        WidgetStore.clearPendingPromptAction(key)
        XCTAssertEqual(WidgetStore.filterPending(initial, now: now), initial)
    }

    func testPromptTombstoneExpiresAfter90Seconds() throws {
        let initial = try groups()
        WidgetStore.stagePendingPromptAction(Fixtures.promptKey(Fixtures.monthly, 0), did: true, now: now)
        XCTAssertEqual(WidgetStore.pendingPromptActions(now: now.addingTimeInterval(89)).count, 1)
        XCTAssertEqual(WidgetStore.filterPending(initial, now: now.addingTimeInterval(91)), initial)
        XCTAssertTrue(WidgetStore.pendingPromptActions(now: now).isEmpty, "expired entries are pruned")
    }

    // MARK: Put back (2026-09-25)

    /// A tapped put-back draws the prompt WAITING at once — out of DONE —
    /// with its count left alone (only the server knows what a did-it added).
    func testStagedPutBackDrawsWaitingWithTheSameCount() throws {
        let afterDid = try groups("reminders-after-did")
        let key = Fixtures.promptKey(Fixtures.daily, 1)
        XCTAssertFalse(try Fixtures.prompt(key, in: "reminders-after-did").isWaiting)
        WidgetStore.stagePendingPromptRestore(key, now: now)

        let drawn = WidgetStore.filterPending(afterDid, now: now)
        let row = try XCTUnwrap(drawn.flatMap(\.prompts).first { $0.promptKey == key })
        XCTAssertTrue(row.isWaiting)
        XCTAssertEqual(row.current, 1)
        XCTAssertEqual(drawn[0].waitingCount, afterDid[0].waitingCount + 1)
        XCTAssertEqual(
            drawn.map { $0.waitingCount + $0.consideredCount },
            afterDid.map { $0.waitingCount + $0.consideredCount },
            "a slot's day total never moves, only the split"
        )
        XCTAssertTrue(WidgetStore.hasRecentInteraction(now: now), "a put-back repaints from cache")

        // A failed call clears it: the prompt is honestly handled again.
        WidgetStore.clearPendingPromptRestore(key)
        XCTAssertEqual(WidgetStore.filterPending(afterDid, now: now), afterDid)
    }

    /// The latest tap on a key wins — a put-back and an action never both
    /// draw, whichever order they came in.
    func testPutBackAndActionCrossClear() {
        let key = Fixtures.promptKey(Fixtures.monthly, 0)
        WidgetStore.stagePendingPromptAction(key, did: true, now: now)
        WidgetStore.stagePendingPromptRestore(key, now: now)
        XCTAssertTrue(WidgetStore.pendingPromptActions(now: now).isEmpty)
        XCTAssertEqual(WidgetStore.pendingPromptRestores(now: now), [key])

        WidgetStore.stagePendingPromptAction(key, did: false, now: now)
        XCTAssertTrue(WidgetStore.pendingPromptRestores(now: now).isEmpty)
        XCTAssertEqual(WidgetStore.pendingPromptActions(now: now), [key: false])
    }

    func testPutBackTombstoneExpiresAndUndoClearsIt() throws {
        let key = Fixtures.promptKey(Fixtures.daily, 1)
        WidgetStore.stagePendingPromptRestore(key, now: now)
        XCTAssertEqual(WidgetStore.pendingPromptRestores(now: now.addingTimeInterval(89)).count, 1)
        XCTAssertTrue(WidgetStore.pendingPromptRestores(now: now.addingTimeInterval(91)).isEmpty)

        WidgetStore.stagePendingPromptRestore(key, now: now)
        WidgetStore.clearAllPendingState()
        XCTAssertTrue(WidgetStore.pendingPromptRestores(now: now).isEmpty, "an Undo must show it handled again")
    }

    /// The server lowered a daily 2/day quota from 2 to 0: BOTH rows take the
    /// count, neither is done any more, the put-back row is un-considered,
    /// and the tombstone retires (the cache is the truth now).
    func testConfirmPromptRestoreRecountsDownAndRetiresTheTombstone() throws {
        WidgetStore.saveReminders(try groups())
        let one = Fixtures.promptKey(Fixtures.daily, 1)
        WidgetStore.confirmPromptAction(one, did: true, tasks: [dailyQuota(current: 2)])
        WidgetStore.stagePendingPromptRestore(one, now: now)

        WidgetStore.confirmPromptRestore(one, tasks: [dailyQuota(current: 0)])
        let rows = try XCTUnwrap(WidgetStore.loadReminders()).value.groups.flatMap(\.prompts)
            .filter { $0.taskId == Fixtures.daily }
        XCTAssertEqual(rows.map(\.current), [0, 0])
        XCTAssertEqual(rows.map(\.done), [false, false])
        XCTAssertEqual(rows.map(\.considered), [false, false])
        XCTAssertTrue(WidgetStore.pendingPromptRestores(now: now).isEmpty)
    }

    /// A daily row whose count still reaches it stays done — the server
    /// takes back only what a did-it added — and the cache says so rather
    /// than keep drawing the optimistic "waiting".
    func testConfirmPromptRestoreKeepsADailyRowTheCountStillReaches() throws {
        WidgetStore.saveReminders(try groups("reminders-after-did"))
        let one = Fixtures.promptKey(Fixtures.daily, 1)
        WidgetStore.stagePendingPromptRestore(one, now: now)
        WidgetStore.confirmPromptRestore(one, tasks: [dailyQuota(current: 1)])
        let row = try XCTUnwrap(WidgetStore.loadReminders()).value.groups.flatMap(\.prompts)
            .first { $0.promptKey == one }
        XCTAssertEqual(row?.done, true)
        XCTAssertEqual(row?.considered, false)
        let drawn = WidgetStore.filterPending(try XCTUnwrap(WidgetStore.loadReminders()).value.groups, now: now)
        XCTAssertEqual(drawn.flatMap(\.prompts).first { $0.promptKey == one }?.isWaiting, false)
    }

    /// A once-a-day prompt is done while anything was logged today — only
    /// the server knows that — so its put-back makes the next pass fetch.
    func testConfirmPromptRestoreOfAWeeklyPromptRequiresAFetch() throws {
        WidgetStore.saveReminders(try groups("reminders"))
        WidgetStore.markInteraction(now: now)
        XCTAssertTrue(WidgetStore.canRepaintRemindersFromCache(now: now))
        let weekly = try Fixtures.decode(TaskDTO.self, "task-progress")
        WidgetStore.confirmPromptRestore(Fixtures.promptKey(Fixtures.weekly, 0), tasks: [weekly])
        XCTAssertFalse(WidgetStore.canRepaintRemindersFromCache(now: now))
    }

    /// Daily rows re-count WITHOUT a fetch when nothing is left in doubt.
    func testConfirmPromptRestoreOfADailyPromptRepaintsFromCache() throws {
        WidgetStore.saveReminders(try groups("reminders-after-did"))
        WidgetStore.markInteraction(now: now)
        WidgetStore.confirmPromptRestore(Fixtures.promptKey(Fixtures.daily, 1), tasks: [dailyQuota(current: 0)])
        XCTAssertTrue(WidgetStore.canRepaintRemindersFromCache(now: now))
    }

    // MARK: confirmPromptAction

    /// A did-it that the server answered with count 2 finishes BOTH of a
    /// daily 2/day quota's rows — the sibling in another slot too — without
    /// a fetch (the server's `getQuotaPromptsBySlot` rule: done once the
    /// count reaches the row's number).
    func testConfirmPromptActionRecountsSiblingRows() throws {
        WidgetStore.saveReminders(try groups())
        WidgetStore.confirmPromptAction(
            Fixtures.promptKey(Fixtures.daily, 1), did: true, tasks: [dailyQuota(current: 2)]
        )
        let rows = try XCTUnwrap(WidgetStore.loadReminders()).value.groups.flatMap(\.prompts)
            .filter { $0.taskId == Fixtures.daily }
        XCTAssertEqual(rows.map(\.current), [2, 2])
        XCTAssertEqual(rows.map(\.done), [true, true])
        // Only the acted row is considered; the sibling was done elsewhere.
        XCTAssertEqual(rows.map(\.considered), [true, false])
        // Other quotas are left alone.
        let others = try XCTUnwrap(WidgetStore.loadReminders()).value.groups.flatMap(\.prompts)
            .filter { $0.taskId != Fixtures.daily }
        XCTAssertTrue(others.allSatisfy(\.isWaiting))
    }

    func testConfirmPromptActionKeepsFetchedAt() throws {
        let fetched = now.addingTimeInterval(-600)
        WidgetStore.save(WidgetStore.RemindersCache(groups: try groups()), forKey: "widget.cache.reminders", at: fetched)
        WidgetStore.confirmPromptAction(Fixtures.promptKey(Fixtures.monthly, 0), did: false, tasks: [])
        XCTAssertEqual(WidgetStore.loadReminders()?.fetchedAt, fetched, "an 'as of' note the cache earned survives")
    }

    // MARK: confirmProgress (the 2026-09-24 stale-count bug)

    /// Success used to only subtract the staged delta, so a fast-path
    /// repaint drew the PRE-tap cache. Now the server's count lands in the
    /// cache and the delta retires — the next repaint draws the same number.
    func testConfirmProgressWritesTheServerCount() throws {
        let tasks = try Fixtures.decode(TasksPage.self, "tasks").tasks
        WidgetStore.saveTasks(tasks, projects: [], completions: [])
        WidgetStore.stagePendingProgress(Fixtures.weekly, delta: 1, now: now)

        let serverSays = try Fixtures.decode(TaskDTO.self, "task-progress").withOptimisticIncrement(1) // 2/3
        WidgetStore.confirmProgress(serverSays, delta: 1, now: now)

        let cached = try XCTUnwrap(WidgetStore.loadTasks()).value.tasks
        XCTAssertEqual(cached.first { $0.id == Fixtures.weekly }?.progressCurrent, 2)
        XCTAssertTrue(WidgetStore.pendingProgressDeltas(now: now).isEmpty)
        let drawn = WidgetStore.applyPendingProgress(cached, now: now)
        XCTAssertEqual(drawn.first { $0.id == Fixtures.weekly }?.progressCurrent, 2, "never counted twice")
    }

    /// Two taps in flight: the first response must not erase the second.
    func testConfirmProgressLeavesASiblingTapStaged() throws {
        let tasks = try Fixtures.decode(TasksPage.self, "tasks").tasks
        WidgetStore.saveTasks(tasks, projects: [], completions: [])
        WidgetStore.stagePendingProgress(Fixtures.weekly, delta: 1, now: now)
        WidgetStore.stagePendingProgress(Fixtures.weekly, delta: 1, now: now)
        XCTAssertEqual(WidgetStore.pendingProgressDeltas(now: now)[Fixtures.weekly], 2)

        let first = try Fixtures.decode(TaskDTO.self, "task-progress").withOptimisticIncrement(1) // 2/3
        WidgetStore.confirmProgress(first, delta: 1, now: now)
        XCTAssertEqual(WidgetStore.pendingProgressDeltas(now: now)[Fixtures.weekly], 1)
        let drawn = WidgetStore.applyPendingProgress(try XCTUnwrap(WidgetStore.loadTasks()).value.tasks, now: now)
        XCTAssertEqual(drawn.first { $0.id == Fixtures.weekly }?.progressCurrent, 3)
    }

    // MARK: Fetch-required stamps

    func testRequireRemindersFetchBlocksTheFastPathUntilANewerFetch() throws {
        WidgetStore.markInteraction(now: now)
        XCTAssertTrue(WidgetStore.canRepaintRemindersFromCache(now: now))

        WidgetStore.requireRemindersFetch(now: now)
        XCTAssertFalse(WidgetStore.canRepaintRemindersFromCache(now: now))
        XCTAssertTrue(WidgetStore.canRepaintTasksFromCache(now: now), "only the Reminders payload went stale")

        // A response already on the wire when the cache went stale can't
        // carry the change: it doesn't settle the stamp.
        WidgetStore.saveReminders(try groups(), fetchStartedAt: now.addingTimeInterval(-1))
        XCTAssertFalse(WidgetStore.canRepaintRemindersFromCache(now: now))

        WidgetStore.saveReminders(try groups(), fetchStartedAt: now.addingTimeInterval(1))
        XCTAssertTrue(WidgetStore.canRepaintRemindersFromCache(now: now.addingTimeInterval(1)))
    }

    /// Takeback mode's armed state rides the plain interaction stamp:
    /// `requireRemindersFetch` (a Quotas +1) must keep it; `clearInteraction`
    /// forgets it.
    func testTakebackStampSurvivesRequireRemindersFetchButNotClearInteraction() {
        WidgetStore.markInteraction(now: now)
        WidgetStore.requireRemindersFetch(now: now)
        XCTAssertTrue(WidgetStore.hasRecentInteraction(now: now))

        WidgetStore.clearInteraction(kind: RemindersWidget.kind, now: now)
        XCTAssertFalse(WidgetStore.hasRecentInteraction(now: now))
    }

    /// `clearInteraction(kind:)` marks only the payload that kind reads.
    func testClearInteractionIsScopedByKind() {
        // A staged completion keeps `hasRecentInteraction` true on its own.
        WidgetStore.stagePendingCompletion(Fixtures.plants, now: now)
        WidgetStore.clearInteraction(kind: TasksWidget.kind, now: now)
        XCTAssertFalse(WidgetStore.canRepaintTasksFromCache(now: now))
        XCTAssertTrue(WidgetStore.canRepaintRemindersFromCache(now: now))

        WidgetStore.clearInteraction(kind: nil, now: now)
        XCTAssertFalse(WidgetStore.canRepaintRemindersFromCache(now: now))
    }

    // MARK: confirmCompletion

    /// A confirmed check-off leaves the cache itself (not just a 90s
    /// tombstone), moving to its slot's `considered` and DONE list — the
    /// "reminders started popping back up" bug (2026-09-23).
    func testConfirmCompletionMovesAReminderToConsidered() throws {
        WidgetStore.saveReminders(try groups())
        WidgetStore.confirmCompletion(Fixtures.stretch)
        let early = try XCTUnwrap(WidgetStore.loadReminders()).value.groups[0]
        XCTAssertEqual(early.reminders.map(\.id), [])
        XCTAssertEqual(early.considered, 1)
        XCTAssertEqual(early.consideredItems.map(\.id), [Fixtures.stretch])
        XCTAssertEqual(early.prompts, try groups()[0].prompts, "prompts are carried through untouched")
        // The same shape the server sends once Stretch is done.
        let server = try Fixtures.reminders("reminders")[0]
        XCTAssertEqual(early.reminders, server.reminders)
        XCTAssertEqual(early.considered, server.considered)
    }

    /// The seam itself: nothing reaches the real App Group suite.
    func testSuiteOverrideIsolatesTheStore() throws {
        WidgetStore.saveReminders(try groups())
        XCTAssertNotNil(WidgetStore.loadReminders())
        let saved = WidgetStore.suiteOverride
        let other = "test.\(UUID().uuidString)"
        WidgetStore.suiteOverride = UserDefaults(suiteName: other)
        XCTAssertNil(WidgetStore.loadReminders(), "a fresh suite sees nothing the last one wrote")
        WidgetStore.suiteOverride?.removePersistentDomain(forName: other)
        WidgetStore.suiteOverride = saved
    }
}
