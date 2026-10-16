import XCTest

/// `progress_events.source` from the native clients (2026-10-16,
/// `ios/Shared/ProgressSource.swift`; the server's `src/lib/progress-source.ts`).
/// The outbox's `widget` is pinned in `WidgetOutboxTests`, the notification
/// runner's in `NotificationActionRunnerTests`.
final class ProgressSourceTests: XCTestCase {

    /// Every native value is one the server accepts (`CLIENT_PROGRESS_SOURCES`
    /// is web | widget | watch | mac | api; a value outside it is a 400).
    func testValuesAreTheServersWords() {
        let server: Set<String> = ["web", "widget", "watch", "mac", "api"]
        XCTAssertEqual(ProgressSource.allCases.map(\.rawValue), ["widget", "watch", "mac"])
        XCTAssertTrue(Set(ProgressSource.allCases.map(\.rawValue)).isSubset(of: server))
    }

    func testBodyCarriesTheSourceOnlyWhenThereIsOne() {
        let withSource = ProgressSource.adding(.watch, to: ["delta": 1])
        XCTAssertEqual(withSource["source"] as? String, "watch")
        XCTAssertEqual(withSource["delta"] as? Int, 1)
        let without = ProgressSource.adding(nil, to: ["keys": ["k"]])
        XCTAssertNil(without["source"], "nothing sent reads as `api` on the server")
        XCTAssertEqual(without["keys"] as? [String], ["k"])
    }

    /// The runner is shared by the phone, the Mac and the watch: the platform
    /// decides. This bundle is macOS.
    func testNotificationActionsSayTheirPlatform() {
        XCTAssertEqual(ProgressSource.forNotificationActions, .mac)
    }
}
