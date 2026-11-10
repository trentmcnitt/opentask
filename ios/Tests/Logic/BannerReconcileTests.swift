import XCTest

/// The banner reconcile's pure half (`BannerReconcile`, 2026-11-10): what a
/// delivered banner tells the server, and what the device removes.
final class BannerReconcileTests: XCTestCase {
    func testEachKindSendsWhatTheServerJudgesItBy() {
        let reminder = BannerReconcile.descriptor(
            identifier: "reminder-7", userInfo: ["taskId": 7, "reminder_day": "2026-11-10", "icon": "reminder"])
        XCTAssertEqual(reminder?["id"] as? String, "reminder-7")
        XCTAssertEqual(reminder?["task_id"] as? Int, 7)
        XCTAssertEqual(reminder?["icon"] as? String, "reminder")

        let prompt = BannerReconcile.descriptor(
            identifier: "prompt-q", userInfo: ["taskId": 9, "prompt_key": "q:9:0:2026-11-10", "icon": "quota"])
        XCTAssertEqual(prompt?["prompt_key"] as? String, "q:9:0:2026-11-10")

        let period = BannerReconcile.descriptor(
            identifier: "slot-3", userInfo: ["slot_id": 3, "slot_label": "Morning", "icon": "period"])
        XCTAssertEqual(period?["slot_id"] as? Int, 3)

        let deadlines = BannerReconcile.descriptor(
            identifier: "deadlines-nag", userInfo: ["kind": "deadlines", "icon": "deadline"])
        XCTAssertEqual(deadlines?["kind"] as? String, "deadlines")
    }

    func testABannerAboutNothingIsNotAsked() {
        XCTAssertNil(BannerReconcile.descriptor(identifier: "summary", userInfo: ["category": "x"]))
    }

    func testOnlyAskedBannersAreRemoved() {
        let asked: [[String: Any]] = [["id": "a"], ["id": "b"]]
        XCTAssertEqual(BannerReconcile.removable(["b", "zzz"], asked: asked), ["b"])
    }

    func testTheRequestIsCapped() {
        let many = (0..<150).map { (identifier: "t-\($0)", userInfo: ["taskId": $0] as [AnyHashable: Any]) }
        XCTAssertEqual(BannerReconcile.descriptors(many).count, BannerReconcile.maxBanners)
    }
}
