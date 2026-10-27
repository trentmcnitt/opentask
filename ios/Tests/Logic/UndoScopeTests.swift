import XCTest

/// Scoped native Undo (2026-10-26, `UndoScope`): a surface's Undo reverses
/// only its OWN last action. Pure — no store, no network.
final class UndoScopeTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_768_492_800)

    private func scoped(own ids: [Int], at date: Date? = nil) -> UndoScope {
        var scope = UndoScope()
        for id in ids { scope.recordOwn(id, at: date ?? t0) }
        return scope
    }

    func testAFreshScopeIsTheOlderServersCounts() {
        let scope = UndoScope()
        XCTAssertFalse(scope.scoped)
        XCTAssertTrue(scope.canUndo(legacyUndoable: -1), "never fetched reads as enabled, as before")
        XCTAssertTrue(scope.canUndo(legacyUndoable: 3))
        XCTAssertFalse(scope.canUndo(legacyUndoable: 0))
        XCTAssertFalse(scope.canRedo(legacyRedoable: 0))
        XCTAssertNil(scope.undoTarget)
    }

    func testAnOwnIdIsTheNewestAndClearsRedo() {
        var scope = scoped(own: [10, 11])
        XCTAssertTrue(scope.scoped)
        XCTAssertEqual(scope.own, [10, 11])
        XCTAssertEqual(scope.undoTarget, 11)
        XCTAssertTrue(scope.canUndo(legacyUndoable: 0), "the counts no longer decide")
        scope.undid(11, at: t0.addingTimeInterval(1))
        XCTAssertEqual(scope.redoTarget, 11)
        scope.recordOwn(12, at: t0.addingTimeInterval(2))
        XCTAssertNil(scope.redoTarget, "a new action clears the redo stack")
        XCTAssertEqual(scope.own, [10, 12])
    }

    /// "Repeated Undo walks back the surface's own taps": after each undo the
    /// next status names the own id below as newest.
    func testRepeatedUndoWalksBackOwnTaps() {
        var scope = scoped(own: [10, 11, 12])
        scope.undid(12, at: t0.addingTimeInterval(1))
        XCTAssertNil(scope.undoTarget, "unknown until the server says what is newest now")
        scope.apply(newestUndoable: 11, nextRedoable: 12, scoped: true, requestedAt: t0.addingTimeInterval(2))
        XCTAssertEqual(scope.undoTarget, 11)
        scope.undid(11, at: t0.addingTimeInterval(3))
        scope.apply(newestUndoable: 10, nextRedoable: 11, scoped: true, requestedAt: t0.addingTimeInterval(4))
        XCTAssertEqual(scope.undoTarget, 10)
        XCTAssertEqual(scope.ownRedo, [12, 11])
        XCTAssertEqual(scope.redoTarget, 11, "redo the last one undone first")
        scope.redid(11, at: t0.addingTimeInterval(5))
        XCTAssertEqual(scope.undoTarget, 11)
        XCTAssertEqual(scope.own, [10, 11])
    }

    func testAnotherDevicesActionDisablesUndoAndItComesBackIfThatIsUndone() {
        var scope = scoped(own: [10])
        scope.apply(newestUndoable: 15, nextRedoable: nil, scoped: true, requestedAt: t0.addingTimeInterval(1))
        XCTAssertNil(scope.undoTarget)
        XCTAssertFalse(scope.canUndo(legacyUndoable: 9))
        XCTAssertEqual(scope.own, [10], "kept")
        // The web undid its 15: ours is the newest again.
        scope.apply(newestUndoable: 10, nextRedoable: 15, scoped: true, requestedAt: t0.addingTimeInterval(2))
        XCTAssertEqual(scope.undoTarget, 10)
        XCTAssertNil(scope.redoTarget, "15 was not ours to redo")
    }

    func testAnOwnIdUndoneElsewhereLeavesTheStack() {
        var scope = scoped(own: [10, 12])
        // The web undid 12 (ours) and stopped: 11 (another device's) is newest.
        scope.apply(newestUndoable: 11, nextRedoable: 12, scoped: true, requestedAt: t0.addingTimeInterval(1))
        XCTAssertEqual(scope.own, [10], "12 is no longer undoable")
        XCTAssertNil(scope.undoTarget, "11 is not ours")
        // Nothing undoable at all: every own id goes.
        scope.apply(newestUndoable: nil, nextRedoable: nil, scoped: true, requestedAt: t0.addingTimeInterval(2))
        XCTAssertEqual(scope.own, [])
    }

    /// A status SENT before a tap must not dim the Undo the tap lit.
    func testAStatusOlderThanTheLastTapIsIgnored() {
        var scope = scoped(own: [20], at: t0)
        scope.apply(newestUndoable: 19, nextRedoable: nil, scoped: true, requestedAt: t0.addingTimeInterval(-1))
        XCTAssertEqual(scope.undoTarget, 20)
        XCTAssertEqual(scope.own, [20], "not pruned by the stale status")
        scope.apply(newestUndoable: 21, nextRedoable: nil, scoped: true, requestedAt: t0)
        XCTAssertNil(scope.undoTarget, "a status sent at or after the tap applies")
    }

    func testAConflictDisables() {
        var scope = scoped(own: [10, 11])
        scope.undoConflict(id: 11, reason: .notLatest, newest: 14, at: t0.addingTimeInterval(1))
        XCTAssertNil(scope.undoTarget)
        XCTAssertEqual(scope.own, [10, 11], "not_latest keeps it")
        scope.undoConflict(id: 11, reason: .alreadyUndone, newest: 10, at: t0.addingTimeInterval(2))
        XCTAssertEqual(scope.own, [10])
        XCTAssertEqual(scope.undoTarget, 10, "the newest is ours again")
        scope.undoConflict(id: 10, reason: .gone, newest: nil, at: t0.addingTimeInterval(3))
        XCTAssertEqual(scope.own, [])
        XCTAssertFalse(scope.canUndo(legacyUndoable: 5))
    }

    func testARedoConflictDisablesRedo() {
        var scope = scoped(own: [10])
        scope.undid(10, at: t0.addingTimeInterval(1))
        XCTAssertEqual(scope.redoTarget, 10)
        scope.redoConflict(id: 10, reason: .notNext, next: 13, at: t0.addingTimeInterval(2))
        XCTAssertNil(scope.redoTarget)
        XCTAssertEqual(scope.ownRedo, [10])
        scope.redoConflict(id: 10, reason: .gone, next: nil, at: t0.addingTimeInterval(3))
        XCTAssertEqual(scope.ownRedo, [])
    }

    func testQueuedTapsAlwaysEnableUndo() {
        let scope = scoped(own: [10])
        var stale = scope
        stale.apply(newestUndoable: 99, nextRedoable: nil, scoped: true, requestedAt: t0.addingTimeInterval(1))
        XCTAssertFalse(stale.canUndo(legacyUndoable: 9))
        XCTAssertTrue(stale.canUndo(queuedTaps: true, legacyUndoable: 0))
    }

    func testTheStackIsCapped() {
        let scope = scoped(own: Array(1...30))
        XCTAssertEqual(scope.own.count, UndoScope.cap)
        XCTAssertEqual(scope.own.first, 11)
        XCTAssertEqual(scope.undoTarget, 30)
    }

    func testAnOlderServerStatusTurnsScopingOff() {
        var scope = scoped(own: [10])
        scope.apply(newestUndoable: nil, nextRedoable: nil, scoped: false, requestedAt: t0.addingTimeInterval(1))
        XCTAssertFalse(scope.scoped)
        XCTAssertTrue(scope.canUndo(legacyUndoable: 2))
    }

    func testTheScopeRoundTripsThroughItsStore() {
        let suite = "test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)
        defer { defaults?.removePersistentDomain(forName: suite) }
        let store = UndoScopeStore(key: "k") { defaults }
        store.update { $0.recordOwn(7, at: self.t0) }
        store.update { $0.recordOwn(8, at: self.t0) }
        XCTAssertEqual(store.load().own, [7, 8])
        XCTAssertEqual(store.load().undoTarget, 8)
    }

    // MARK: The recorder

    /// `APIClient.undoId(in:)`: the answer's own entry; null (nothing
    /// logged) and absent (an older server) both read as none, so the
    /// previous own id is kept.
    func testTheRecorderReadsOnlyANonNullUndoId() {
        XCTAssertEqual(APIClient.undoId(in: Data(#"{"data":{"considered":1,"undo_id":4213}}"#.utf8)), 4213)
        XCTAssertNil(APIClient.undoId(in: Data(#"{"data":{"considered":false,"undo_id":null}}"#.utf8)))
        XCTAssertNil(APIClient.undoId(in: Data(#"{"data":{"considered":1}}"#.utf8)))
        XCTAssertNil(APIClient.undoId(in: Data(#"{"data":{"undone_id":4213}}"#.utf8)), "an undo's answer is not an own action")
    }

    func testTheChangedElsewhereWords() {
        XCTAssertEqual(UndoScope.changedElsewhere, "Changed elsewhere \u{2014} can\u{2019}t undo")
    }
}
