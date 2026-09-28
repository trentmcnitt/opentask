import XCTest

/// `PromptDeepLink` — the Reminders widget's link for a quota PROMPT row, and
/// the web path the apps resolve it to (2026-09-27). A prompt tapped on the
/// Reminders widget opens the Reminders surface on that exact row (by
/// `prompt_key`), not the Quotas surface — the same destination a reminder
/// row's `opentask://reminder/<id>` → `/reminders?reminder=<id>` has.
final class PromptDeepLinkTests: XCTestCase {

    private let dailyTwo = "q:7:2:2026-01-15"
    private let dailyOne = "q:7:1:2026-01-15"

    func testPromptRowLinksToTheRemindersSurfaceByKey() throws {
        let url = try XCTUnwrap(PromptDeepLink.url(promptKey: dailyTwo))
        XCTAssertEqual(url.absoluteString, "opentask://reminders/prompt/q:7:2:2026-01-15")
        // Under the `reminders` host: an app that predates the prompt branch
        // still opens Reminders, and the watch's `WatchPage` reads it as Reminders.
        XCTAssertEqual(url.host, "reminders")
        XCTAssertNotEqual(url.host, "quota")
    }

    func testTheKeyRoundTripsAndResolvesToTheRemindersPage() throws {
        let url = try XCTUnwrap(PromptDeepLink.url(promptKey: dailyTwo))
        let key = try XCTUnwrap(PromptDeepLink.promptKey(from: url))
        XCTAssertEqual(key, dailyTwo)
        XCTAssertEqual(PromptDeepLink.webPath(promptKey: key), "/reminders?prompt=q:7:2:2026-01-15")
    }

    /// A daily quota's two rows share a task id; each link names its own row.
    func testSiblingRowsOfOneQuotaGetDistinctLinks() throws {
        let one = try XCTUnwrap(PromptDeepLink.url(promptKey: dailyOne))
        let two = try XCTUnwrap(PromptDeepLink.url(promptKey: dailyTwo))
        XCTAssertNotEqual(one, two)
        XCTAssertEqual(PromptDeepLink.promptKey(from: one), dailyOne)
    }

    /// Only a prompt link carries a key — the reminder row's, the bare
    /// Reminders link, the slot header's and the Quotas links all resolve as
    /// before.
    func testOtherLinksCarryNoPromptKey() {
        for raw in [
            "opentask://reminder/42",
            "opentask://reminders",
            "opentask://reminders/slot/3",
            "opentask://quota/7",
            "opentask://quotas",
            "opentask://reminders/prompt/",
            "https://reminders/prompt/q:7:2:2026-01-15",
        ] {
            XCTAssertNil(PromptDeepLink.promptKey(from: URL(string: raw)!), raw)
        }
    }

    /// Anything outside a real key's alphabet is encoded, so a key can never
    /// add a path segment or a query parameter.
    func testAKeyCannotEscapeItsSegmentOrParameter() throws {
        let odd = "q:7/x?y=1&z"
        let url = try XCTUnwrap(PromptDeepLink.url(promptKey: odd))
        XCTAssertEqual(PromptDeepLink.promptKey(from: url), odd)
        XCTAssertEqual(PromptDeepLink.webPath(promptKey: odd), "/reminders?prompt=q:7%2Fx%3Fy%3D1%26z")
        XCTAssertNil(PromptDeepLink.url(promptKey: ""))
    }
}
