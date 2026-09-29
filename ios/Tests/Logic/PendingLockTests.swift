import XCTest

/// Concurrent taps on a widget arrive as concurrent `perform()` calls in one
/// process. Every read-modify-write of a pending map must hold the store's
/// lock, or two stages that race lose one of the entries (a check-off whose
/// row comes back) and two claims can both succeed (a double tap that fires
/// twice).
final class WidgetStorePendingLockTests: WidgetStoreTestCase {

    private let now = Date(timeIntervalSince1970: 1_768_492_800) // 2026-01-15T16:00:00Z
    private let count = 400

    func testConcurrentCompletionStagesAreAllKept() {
        DispatchQueue.concurrentPerform(iterations: count) { i in
            WidgetStore.stagePendingCompletion(i, now: now)
        }
        XCTAssertEqual(WidgetStore.pendingCompletions(now: now), Set(0..<count))
    }

    func testConcurrentRestoreStagesAreAllKept() {
        DispatchQueue.concurrentPerform(iterations: count) { i in
            WidgetStore.stagePendingRestore(i, now: now)
        }
        XCTAssertEqual(WidgetStore.pendingRestores(now: now), Set(0..<count))
    }

    /// Clears racing each other must each remove only their own entry.
    func testConcurrentClearsRemoveOnlyTheirOwn() {
        for i in 0..<count { WidgetStore.stagePendingCompletion(i, now: now) }
        DispatchQueue.concurrentPerform(iterations: count / 2) { i in
            WidgetStore.clearPendingCompletion(i * 2)
        }
        XCTAssertEqual(WidgetStore.pendingCompletions(now: now), Set(stride(from: 1, to: count, by: 2)))
    }

    /// `confirmCompletion` and `confirmRestore` hold the lock and clear each
    /// other's tombstone through the `…Locked` variants; calling the public
    /// ones there would deadlock (`NSLock` is not recursive).
    func testConfirmsCrossClearTombstonesWithoutDeadlock() {
        WidgetStore.stagePendingRestore(7, now: now)
        WidgetStore.stagePendingCompletion(8, now: now)
        WidgetStore.confirmCompletion(7)
        WidgetStore.confirmRestore(8, kind: TasksWidget.kind)
        XCTAssertTrue(WidgetStore.pendingRestores(now: now).isEmpty)
        XCTAssertTrue(WidgetStore.pendingCompletions(now: now).isEmpty)
    }
}

/// The watch Smart Stack card's twin (`WatchWidgetState`), on a throwaway
/// suite (`WatchWidgetState.suiteOverride`).
final class WatchWidgetStatePendingLockTests: XCTestCase {

    private let now = Date(timeIntervalSince1970: 1_768_492_800)
    private let count = 400
    private var suiteName = ""

    override func setUp() {
        super.setUp()
        suiteName = "test.\(UUID().uuidString)"
        WatchWidgetState.suiteOverride = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        WatchWidgetState.suiteOverride?.removePersistentDomain(forName: suiteName)
        WatchWidgetState.suiteOverride = nil
        super.tearDown()
    }

    func testConcurrentDoneStagesAreAllKept() {
        DispatchQueue.concurrentPerform(iterations: count) { i in
            WatchWidgetState.stagePendingDone(taskId: i, now: now)
        }
        XCTAssertEqual(WatchWidgetState.pendingDoneIds(now: now), Set(0..<count))
    }

    func testConcurrentPromptStagesAreAllKept() {
        DispatchQueue.concurrentPerform(iterations: count) { i in
            WatchWidgetState.stagePendingPrompt(key: "q:\(i)", did: i.isMultiple(of: 2), now: now)
        }
        XCTAssertEqual(WatchWidgetState.pendingPrompts(now: now).count, count)
    }

    /// Many simultaneous taps on one action: exactly one wins the claim.
    func testConcurrentClaimsAdmitOne() {
        let wins = WinCounter()
        DispatchQueue.concurrentPerform(iterations: count) { _ in
            if WatchWidgetState.tryClaim("consider", now: now) { wins.increment() }
        }
        XCTAssertEqual(wins.value, 1)
    }

    /// Claims on DIFFERENT actions must not overwrite each other.
    func testConcurrentClaimsOnDifferentActionsAllHold() {
        DispatchQueue.concurrentPerform(iterations: count) { i in
            _ = WatchWidgetState.tryClaim("action-\(i)", now: now)
        }
        let lost = (0..<count).filter { WatchWidgetState.tryClaim("action-\($0)", now: now) }
        XCTAssertEqual(lost, [], "these claims were overwritten by a concurrent one")
    }
}

private final class WinCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }

    func increment() {
        lock.lock()
        count += 1
        lock.unlock()
    }
}
