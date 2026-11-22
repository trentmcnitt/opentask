import XCTest

/// The watch app's list taps against out-of-order loads (`WatchTapLedger`,
/// 2026-11-20, Trent: "ones I already tapped will reappear"). A fake server
/// records each write when it is applied; a load is that server's state at
/// the moment the load began, and lands whenever the test says. After every
/// load that lands, no tapped row may be drawn waiting.
final class WatchTapLedgerTests: XCTestCase {

    // MARK: A fake server and its payloads

    private struct Server {
        var considered: Set<Int> = []
        var handledPrompts: Set<String> = []
        var done: Set<Int> = []
    }

    private struct Payload {
        let groups: [ReminderGroupDTO]
        let tasks: [TaskDTO]
        let segments: [TaskSegmentDTO]
    }

    private let reminderIds = [1, 2, 3]
    private let promptKeys = ["q:10:0:2026-01-15", "q:11:0:2026-01-15"]
    private let taskIds = [20, 21]
    private let segmentIds = [30, 31]

    private func prompt(_ key: String) -> QuotaPromptDTO {
        QuotaPromptDTO(
            promptKey: key, taskId: 10, number: nil, numbers: nil, slotId: nil,
            title: "Synthetic fern voucher", current: 0, target: 3, period: "WEEKLY", stripeColor: nil,
            considered: false, done: false, hasNotes: false
        )
    }

    private func payload(_ server: Server) -> Payload {
        let reminders = reminderIds.map { TaskDTO(id: $0, title: "Reminder \($0)", priority: 0, isReminder: true) }
        let group = ReminderGroupDTO(
            slot: nil,
            reminders: reminders.filter { !server.considered.contains($0.id) },
            considered: server.considered.count,
            consideredItems: reminders.filter { server.considered.contains($0.id) },
            prompts: promptKeys.map { server.handledPrompts.contains($0) ? prompt($0).handled(did: false) : prompt($0) }
        )
        let tasks = taskIds.filter { !server.done.contains($0) }.map { TaskDTO(id: $0, title: "Task \($0)") }
        let segment = TaskSegmentDTO(horizon: "days", tasks: segmentIds.map {
            SegmentTaskDTO(task: TaskDTO(id: $0, title: "Row \($0)"), state: server.considered.contains($0) ? .considered : .waiting)
        })
        return Payload(groups: [group], tasks: tasks, segments: [segment])
    }

    /// What the watch draws from `payload` with the ledger's marks over it.
    private func drawn(_ payload: Payload, _ ledger: WatchTapLedger) -> Payload {
        Payload(
            groups: ledger.overlay(groups: payload.groups),
            tasks: ledger.overlay(tasks: payload.tasks),
            segments: ledger.overlay(segments: payload.segments)
        )
    }

    private func assertNoneBack(
        _ shown: Payload, reminders: Set<Int> = [], prompts: Set<String> = [], tasks: Set<Int> = [],
        segments: Set<Int> = [], file: StaticString = #filePath, line: UInt = #line
    ) {
        let waitingReminders = Set(shown.groups.flatMap(\.reminders).map(\.id))
        XCTAssertTrue(waitingReminders.isDisjoint(with: reminders), "a reminder came back", file: file, line: line)
        let waitingPrompts = Set(shown.groups.flatMap(\.prompts).filter(\.isWaiting).map(\.promptKey))
        XCTAssertTrue(waitingPrompts.isDisjoint(with: prompts), "a prompt came back", file: file, line: line)
        XCTAssertTrue(Set(shown.tasks.map(\.id)).isDisjoint(with: tasks), "a task came back", file: file, line: line)
        let waitingRows = Set(shown.segments.flatMap(\.tasks).filter { $0.state == .waiting }.map(\.id))
        XCTAssertTrue(waitingRows.isDisjoint(with: segments), "a segment row came back", file: file, line: line)
    }

    // MARK: Out of order

    /// Reminder, prompt, task and segment taps in a burst; writes answering
    /// and loads landing out of order. No load that lands draws a tapped
    /// row waiting, a load from before the burst is dropped, and once the
    /// last load lands the marks are gone and the lists are the server's.
    func testOutOfOrderLoadsAcrossReminderPromptTaskAndSegmentTaps() {
        var ledger = WatchTapLedger()
        var server = Server()
        let pKey = promptKeys[0]

        // A load from before the burst (a wrist raise).
        let l0 = ledger.beginLoad(); let s0 = payload(server)

        let r = ledger.tap(WatchTapLedger.reminderKey(1), .reminderConsidered)
        let p = ledger.tap(WatchTapLedger.promptKey(pKey), .prompt(did: false))
        let t = ledger.tap(WatchTapLedger.taskKey(20), .taskDone)
        let s = ledger.tap(WatchTapLedger.segmentKey(30), .segmentConsidered)
        let all: (Set<Int>, Set<String>, Set<Int>, Set<Int>) = ([1], [pKey], [20], [30])

        // The reminder's write answers first; its load begins.
        server.considered.insert(1); ledger.settle(WatchTapLedger.reminderKey(1), token: r)
        let l1 = ledger.beginLoad(); let s1 = payload(server)
        // The segment row's answers; its load begins.
        server.considered.insert(30); ledger.settle(WatchTapLedger.segmentKey(30), token: s)
        let l2 = ledger.beginLoad(); let s2 = payload(server)

        // l2 lands first: the prompt and task writes are still out.
        XCTAssertTrue(ledger.admit(l2))
        assertNoneBack(drawn(s2, ledger), reminders: all.0, prompts: all.1, tasks: all.2, segments: all.3)
        ledger.landed(l2)
        // l1 lands after it: older than one already applied, so it is
        // dropped (it predates the segment's answer and would draw that row
        // waiting again).
        XCTAssertFalse(ledger.admit(l1))
        _ = s1
        // The pre-burst load lands last of all: dropped. No load is owed —
        // one that began after every tap has already landed.
        XCTAssertFalse(ledger.admit(l0))
        _ = s0
        XCTAssertFalse(ledger.owesLoad)

        // The task's write answers, then the prompt's; a load begins between them.
        server.done.insert(20); ledger.settle(WatchTapLedger.taskKey(20), token: t)
        let l3 = ledger.beginLoad(); let s3 = payload(server)
        server.handledPrompts.insert(pKey); ledger.settle(WatchTapLedger.promptKey(pKey), token: p)
        XCTAssertTrue(ledger.admit(l3))
        assertNoneBack(drawn(s3, ledger), reminders: all.0, prompts: all.1, tasks: all.2, segments: all.3)
        ledger.landed(l3)
        XCTAssertFalse(ledger.effects.isEmpty, "the prompt's answer came after l3 began: still drawn")

        // The load after the last answer: everything retires, the lists are the server's.
        let l4 = ledger.beginLoad(); let s4 = payload(server)
        XCTAssertTrue(ledger.admit(l4))
        assertNoneBack(drawn(s4, ledger), reminders: all.0, prompts: all.1, tasks: all.2, segments: all.3)
        ledger.landed(l4)
        XCTAssertTrue(ledger.effects.isEmpty)
        XCTAssertFalse(ledger.owesLoad)
        XCTAssertFalse(ledger.anyInFlight)
    }

    /// A load that began before a tap is dropped even when its answer is
    /// the newest to land — the load after the last tap is the one shown.
    func testALoadFromBeforeTheNewestTapIsDropped() {
        var ledger = WatchTapLedger()
        let before = ledger.beginLoad()
        _ = ledger.tap(WatchTapLedger.reminderKey(2), .reminderConsidered)
        XCTAssertFalse(ledger.admit(before))
        XCTAssertTrue(ledger.owesLoad)
        let after = ledger.beginLoad()
        XCTAssertTrue(ledger.admit(after))
    }

    /// A failed write puts its row back on the next payload.
    func testAFailedTapComesBack() {
        var ledger = WatchTapLedger()
        let key = WatchTapLedger.reminderKey(3)
        let token = ledger.tap(key, .reminderConsidered)
        ledger.drop(key, token: token)
        let shown = drawn(payload(Server()), ledger)
        XCTAssertTrue(shown.groups[0].reminders.contains { $0.id == 3 })
        XCTAssertFalse(ledger.anyInFlight)
    }

    /// An earlier tap's answer neither settles nor drops a later tap on the
    /// same key (the token).
    func testAnEarlierAnswerCannotSettleALaterTap() {
        var ledger = WatchTapLedger()
        let key = WatchTapLedger.segmentKey(31)
        let first = ledger.tap(key, .segmentConsidered)
        _ = ledger.tap(key, .segmentLeft(.done))
        ledger.drop(key, token: first)
        XCTAssertTrue(ledger.isInFlight(key))
        XCTAssertEqual(ledger.effects[key], .segmentLeft(.done))
        let shown = drawn(payload(Server()), ledger)
        XCTAssertEqual(shown.segments[0].tasks.first { $0.id == 31 }?.left, .done)
    }
}

/// The Smart Stack card's tap on a card that is already behind
/// (`WatchWidgetState.considerTarget`, 2026-11-20).
final class WatchWidgetConsiderTargetTests: XCTestCase {
    private let suiteName = "WatchWidgetConsiderTargetTests"
    private let now = Date(timeIntervalSince1970: 1_768_492_800)

    override func setUp() {
        super.setUp()
        UserDefaults().removePersistentDomain(forName: suiteName)
        WatchWidgetState.suiteOverride = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        WatchWidgetState.suiteOverride?.removePersistentDomain(forName: suiteName)
        WatchWidgetState.suiteOverride = nil
        super.tearDown()
    }

    /// A REPEATING reminder can't advance twice: the second ✓ on a card that
    /// still shows it (intents run one at a time; the card repaints after)
    /// resolves to the next item, never to the reminder again — so `markDone`
    /// is sent for it once.
    func testASecondTapOnAStaleCardNeverActsOnTheSameReminderAgain() {
        let order = ["r:1", "q:7:0:2026-01-15", "r:2"]
        XCTAssertEqual(WatchWidgetState.considerTarget(tapped: "r:1", remainingKeys: order, now: now), "r:1")
        // The first tap ran: its tombstone is live.
        WatchWidgetState.stagePendingDone(taskId: 1, now: now)
        let second = WatchWidgetState.considerTarget(tapped: "r:1", remainingKeys: order, now: now)
        XCTAssertNotEqual(second, "r:1")
        XCTAssertEqual(second, "q:7:0:2026-01-15", "the next item on the card")
        // That one taken too: a third tap goes on to the one after.
        WatchWidgetState.stagePendingPrompt(key: "q:7:0:2026-01-15", did: false, now: now)
        XCTAssertEqual(WatchWidgetState.considerTarget(tapped: "r:1", remainingKeys: order, now: now), "r:2")
        // Nothing left: the tap is dropped, never sent twice.
        WatchWidgetState.stagePendingDone(taskId: 2, now: now)
        XCTAssertNil(WatchWidgetState.considerTarget(tapped: "r:1", remainingKeys: order, now: now))
    }

    /// A card drawn before this build passes no order: a repeat is dropped.
    func testWithoutTheCardsOrderARepeatIsDropped() {
        WatchWidgetState.stagePendingDone(taskId: 1, now: now)
        XCTAssertNil(WatchWidgetState.considerTarget(tapped: "r:1", remainingKeys: [], now: now))
    }

    /// Segment rows: considered or done, a row's own tap is pending.
    func testASegmentRowsTapIsPendingEitherWay() {
        let order = ["s:5", "s:6", "s:7"]
        WatchWidgetState.stagePendingPrompt(key: "s:5", did: false, now: now)
        XCTAssertEqual(WatchWidgetState.considerTarget(tapped: "s:5", remainingKeys: order, now: now), "s:6")
        WatchWidgetState.stagePendingDone(taskId: 6, now: now)
        XCTAssertTrue(WatchWidgetState.isPending(itemKey: "s:6", now: now))
        XCTAssertEqual(WatchWidgetState.considerTarget(tapped: "s:5", remainingKeys: order, now: now), "s:7")
        // A tombstone past its 90s is no longer pending.
        XCTAssertFalse(WatchWidgetState.isPending(itemKey: "s:5", now: now.addingTimeInterval(91)))
    }
}
