import XCTest

/// `DeepLinkRouter` — every `opentask://` widget link and the web path both
/// apps load for it. Literal URLs on purpose (not built through `WidgetLink`),
/// so a change to the link format and a change to the routing can't cancel
/// each other out.
final class DeepLinkRouterTests: XCTestCase {

    func testEveryWidgetLinkResolvesToItsWebPath() throws {
        let table: [(link: String, path: String)] = [
            // Dashboard
            ("opentask://today", "/"),
            ("opentask://task/42", "/?task=42&highlight=1"),
            ("opentask://task", "/"),
            ("opentask://task/abc", "/"),
            ("opentask://project/7", "/?project=7"),
            ("opentask://project", "/"),
            ("opentask://overdue", "/?filter=overdue"),
            // Reminders
            ("opentask://reminder/12", "/reminders?reminder=12"),
            ("opentask://reminder", "/reminders"),
            ("opentask://reminders", "/reminders"),
            ("opentask://reminders/slot/3", "/reminders?slot=3"),
            ("opentask://reminders/slot/-1", "/reminders?slot=-1"),
            ("opentask://reminders/slot/x", "/reminders"),
            ("opentask://reminders/prompt/q:7:2:2026-01-15", "/reminders?prompt=q:7:2:2026-01-15"),
            // Quotas
            ("opentask://quota/9", "/quotas?quota=9"),
            ("opentask://quota", "/quotas"),
            ("opentask://quotas", "/quotas"),
            // Unknown host falls through to the dashboard
            ("opentask://nowhere/1", "/"),
        ]
        for row in table {
            let url = try XCTUnwrap(URL(string: row.link), row.link)
            XCTAssertEqual(DeepLinkRouter.webPath(for: url), row.path, row.link)
        }
    }

    /// A prompt link built by the widget round-trips through the router.
    func testPromptLinkFromTheWidgetRoutesToItsRow() throws {
        let url = try XCTUnwrap(PromptDeepLink.url(promptKey: "q:7:1:2026-01-15"))
        XCTAssertEqual(DeepLinkRouter.webPath(for: url), "/reminders?prompt=q:7:1:2026-01-15")
    }

    /// Anything that isn't `opentask://` is not a widget link: the app does
    /// nothing rather than navigating to the dashboard.
    func testOtherSchemesAreIgnored() throws {
        for link in ["https://example.com/task/1", "http://opentask/task/1", "file:///task/1"] {
            let url = try XCTUnwrap(URL(string: link), link)
            XCTAssertNil(DeepLinkRouter.webPath(for: url), link)
        }
    }
}
