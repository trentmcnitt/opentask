import Foundation
import XCTest

/// The server contract fixtures (`tests/fixtures/contract/*.json`), bundled
/// as test resources. Written by `tests/integration/contract-fixtures.test.ts`
/// — see its header for the scenario. Ids and timestamps there are
/// normalised placeholders: tasks 100 (User B's seeded task), 101 Drink water
/// (daily 2/day), 102 Go for a run (weekly 3), 103 Call a friend (monthly 2),
/// 104 Stretch (08:00 reminder), 105 Plan tomorrow (19:00 reminder), 106
/// Water the plants (one-off); slots 11–15 in start order; every timestamp
/// `2026-01-15T16:00:00.000Z`, every date `2026-01-15`.
enum Fixtures {
    private final class Token {}

    static func data(_ name: String, file: StaticString = #filePath, line: UInt = #line) throws -> Data {
        let bundle = Bundle(for: Token.self)
        guard let url = bundle.url(forResource: name, withExtension: "json") else {
            XCTFail("missing fixture \(name).json in the test bundle", file: file, line: line)
            throw CocoaError(.fileNoSuchFile)
        }
        return try Data(contentsOf: url)
    }

    /// `{ "data": T }`, decoded exactly the way `APIClient.get` does.
    static func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONDecoder().decode(APIEnvelope<T>.self, from: data(name)).data
    }

    /// The raw `data` object, for the responses `APIClient` reads through
    /// `JSONSerialization` rather than a DTO (`bulk/complete`).
    static func object(_ name: String) throws -> [String: Any] {
        let json = try JSONSerialization.jsonObject(with: data(name)) as? [String: Any]
        return try XCTUnwrap(json?["data"] as? [String: Any])
    }

    static func reminders(_ name: String = "reminders") throws -> [ReminderGroupDTO] {
        try decode(RemindersPayload.self, name).groups
    }

    static func prompts(_ name: String = "reminders") throws -> [QuotaPromptDTO] {
        try reminders(name).flatMap(\.prompts)
    }

    static func prompt(_ key: String, in name: String = "reminders") throws -> QuotaPromptDTO {
        try XCTUnwrap(prompts(name).first { $0.promptKey == key }, "no prompt \(key) in \(name).json")
    }

    static let pinnedDate = "2026-01-15"
    static let pinnedTimestamp = "2026-01-15T16:00:00.000Z"

    /// Task placeholders, as the writer assigns them.
    static let daily = 101, weekly = 102, monthly = 103, stretch = 104, planTomorrow = 105, plants = 106

    static func promptKey(_ taskId: Int, _ k: Int) -> String { "q:\(taskId):\(k):\(pinnedDate)" }
}

/// Every test that touches `WidgetStore` subclasses this: a throwaway
/// UserDefaults suite per test, never the App Group (on macOS that is the
/// installed Mac app's real widget cache).
class WidgetStoreTestCase: XCTestCase {
    private var suiteName = ""

    override func setUp() {
        super.setUp()
        suiteName = "test.\(UUID().uuidString)"
        WidgetStore.suiteOverride = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        WidgetStore.suiteOverride?.removePersistentDomain(forName: suiteName)
        WidgetStore.suiteOverride = nil
        super.tearDown()
    }
}
