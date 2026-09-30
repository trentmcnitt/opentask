import OSLog
import XCTest

/// `WidgetPushRegistration`, the widget push token state machine shared by the
/// phone/Mac and watch widget extensions: save before send, retry until the
/// server confirms, every delivery sent again, an empty widget list ignored.
/// Uses a throwaway `test.<UUID>` suite and a stub sender — never the real
/// App Group, never `APIClient`.
final class WidgetPushRegistrationTests: XCTestCase {

    /// Records every registration the state machine tries to send; fails
    /// while `failing` is true, the way a lost request or a missing Bearer
    /// token would.
    private final class StubSender: @unchecked Sendable {
        struct Call: Equatable {
            let token: String
            let bundleId: String
            let platform: String
            let widgetKind: String
        }

        private let lock = NSLock()
        private var _calls: [Call] = []
        private var _failing = false

        var calls: [Call] { lock.withLock { _calls } }
        var failing: Bool {
            get { lock.withLock { _failing } }
            set { lock.withLock { _failing = newValue } }
        }

        func send(_ call: Call) throws {
            let fail = lock.withLock { () -> Bool in
                _calls.append(call)
                return _failing
            }
            if fail { throw APIError.notConfigured }
        }
    }

    private var suiteName = ""
    private var stub = StubSender()

    override func setUp() {
        super.setUp()
        suiteName = "test.\(UUID().uuidString)"
        stub = StubSender()
    }

    override func tearDown() {
        UserDefaults().removePersistentDomain(forName: suiteName)
        super.tearDown()
    }

    private func registration(keyPrefix: String = "widgetPush") -> WidgetPushRegistration {
        let stub = self.stub
        return WidgetPushRegistration(
            keyPrefix: keyPrefix,
            bundleId: "io.example.app",
            platform: "ios",
            suiteName: suiteName,
            log: Logger(subsystem: "io.mcnitt.opentask.logictests", category: "push"),
            send: { token, bundleId, platform, widgetKind in
                try stub.send(.init(token: token, bundleId: bundleId, platform: platform, widgetKind: widgetKind))
            }
        )
    }

    private var defaults: UserDefaults { UserDefaults(suiteName: suiteName)! }

    func testDeliverySendsHexTokenWithSortedDistinctKinds() async {
        let reg = registration()
        await reg.tokenDelivered(Data([0x0a, 0xff, 0x01]), widgetKinds: ["Tasks", "Reminders", "Tasks"])?.value

        XCTAssertEqual(stub.calls, [.init(token: "0aff01", bundleId: "io.example.app", platform: "ios", widgetKind: "Reminders,Tasks")])
        XCTAssertEqual(defaults.string(forKey: "widgetPush.registeredToken"), "0aff01")
    }

    func testEmptyWidgetListSavesAndSendsNothing() async {
        let reg = registration()
        XCTAssertNil(reg.tokenDelivered(Data([0x01]), widgetKinds: []))
        await reg.retryIfNeeded()

        XCTAssertTrue(stub.calls.isEmpty)
        XCTAssertNil(defaults.string(forKey: "widgetPush.pendingToken"))
    }

    func testEmptyWidgetListKeepsAnExistingRegistration() async {
        let reg = registration()
        await reg.tokenDelivered(Data([0x01]), widgetKinds: ["Tasks"])?.value
        XCTAssertNil(reg.tokenDelivered(Data([0x01]), widgetKinds: []))

        XCTAssertEqual(defaults.string(forKey: "widgetPush.pendingToken"), "01")
        XCTAssertEqual(defaults.string(forKey: "widgetPush.registeredToken"), "01")
        XCTAssertEqual(stub.calls.count, 1)
    }

    func testTokenIsSavedBeforeTheSendAndRetriedUntilConfirmed() async {
        let reg = registration()
        stub.failing = true
        await reg.tokenDelivered(Data([0xab]), widgetKinds: ["Tasks"])?.value

        // Failed, but saved: pending and not confirmed.
        XCTAssertEqual(defaults.string(forKey: "widgetPush.pendingToken"), "ab")
        XCTAssertNil(defaults.string(forKey: "widgetPush.registeredToken"))

        // The next reload tries again, still failing.
        await reg.retryIfNeeded()
        XCTAssertEqual(stub.calls.count, 2)

        // Then succeeds, and later reloads send nothing.
        stub.failing = false
        await reg.retryIfNeeded()
        XCTAssertEqual(defaults.string(forKey: "widgetPush.registeredToken"), "ab")
        await reg.retryIfNeeded()
        XCTAssertEqual(stub.calls.count, 3)
    }

    func testRedeliveryOfAConfirmedTokenIsSentAgain() async {
        let reg = registration()
        await reg.tokenDelivered(Data([0x80, 0x38]), widgetKinds: ["Tasks"])?.value
        XCTAssertEqual(stub.calls.count, 1)

        // Same token after a reinstall: the server may have dropped the row.
        await reg.tokenDelivered(Data([0x80, 0x38]), widgetKinds: ["Tasks"])?.value
        XCTAssertEqual(stub.calls.count, 2)
    }

    func testNothingPendingSendsNothing() async {
        await registration().retryIfNeeded()
        XCTAssertTrue(stub.calls.isEmpty)
    }

    func testKeyPrefixesStayDisjoint() async {
        let phone = registration(keyPrefix: "widgetPush")
        let watch = registration(keyPrefix: "watch.widgetPush")
        await watch.tokenDelivered(Data([0x02]), widgetKinds: ["ReminderStack"])?.value

        XCTAssertEqual(defaults.string(forKey: "watch.widgetPush.pendingToken"), "02")
        XCTAssertEqual(defaults.string(forKey: "watch.widgetPush.registeredToken"), "02")
        XCTAssertNil(defaults.string(forKey: "widgetPush.pendingToken"))
        await phone.retryIfNeeded()
        XCTAssertEqual(stub.calls.count, 1)
    }
}
