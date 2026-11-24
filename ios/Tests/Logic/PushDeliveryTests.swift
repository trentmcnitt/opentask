import XCTest

/// The service extension's delivery (`PushDelivery`, 2026-11-23): the
/// cleanup first, then the banner, exactly once; out of time, the push as
/// sent at once and nothing more after.
final class PushDeliveryTests: XCTestCase {

    /// A cleanup the test lets finish when it chooses.
    private actor Gate {
        private var waiter: CheckedContinuation<Void, Never>?
        private var opened = false
        private(set) var started = false
        func wait() async {
            started = true
            if opened { return }
            await withCheckedContinuation { waiter = $0 }
        }
        func open() {
            opened = true
            waiter?.resume()
            waiter = nil
        }
    }

    private final class Box: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [String] = []
        func add(_ s: String) { lock.lock(); items.append(s); lock.unlock() }
        var all: [String] { lock.lock(); defer { lock.unlock() }; return items }
    }

    private func waitUntil(_ condition: @escaping () async -> Bool) async {
        for _ in 0..<500 where !(await condition()) { await Task.yield() }
    }

    func testTheBannerWaitsForTheCleanupThenGoesOnce() async {
        let log = Box()
        let gate = Gate()
        let delivery = PushDelivery(original: "as sent") { log.add("shown: \($0)") }
        delivery.deliver("decorated") {
            await gate.wait()
            log.add("cleaned")
        }
        await waitUntil { await gate.started }
        XCTAssertEqual(log.all, [], "nothing shows while the cleanup runs")
        XCTAssertFalse(delivery.delivered)
        await gate.open()
        await waitUntil { delivery.delivered }
        XCTAssertEqual(log.all, ["cleaned", "shown: decorated"])
        delivery.expire()
        XCTAssertEqual(log.all, ["cleaned", "shown: decorated"], "an expiry after delivery does nothing")
    }

    func testOutOfTimeShowsThePushAsSentAndTheLateCleanupShowsNothing() async {
        let log = Box()
        let gate = Gate()
        let delivery = PushDelivery(original: "as sent") { log.add("shown: \($0)") }
        delivery.deliver("decorated") {
            await gate.wait()
            log.add("cleaned")
        }
        await waitUntil { await gate.started }
        delivery.expire()
        XCTAssertEqual(log.all, ["shown: as sent"])
        await gate.open()
        await waitUntil { log.all.count == 2 }
        XCTAssertEqual(log.all, ["shown: as sent", "cleaned"], "the late cleanup shows nothing more")
    }

    func testACleanupThatRemovesNothingStillShowsTheBanner() async {
        let log = Box()
        let delivery = PushDelivery(original: "as sent") { log.add("shown: \($0)") }
        delivery.deliver("decorated") {}
        await waitUntil { delivery.delivered }
        XCTAssertEqual(log.all, ["shown: decorated"])
    }
}
