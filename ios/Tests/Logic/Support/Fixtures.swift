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
    /// An interval quota's `period_label` ("by Oct 24"), pinned by the writer.
    static let pinnedPeriodLabel = "by Jan 15"

    /// Task placeholders, as the writer assigns them.
    static let daily = 101, weekly = 102, monthly = 103, stretch = 104, planTomorrow = 105, plants = 106
    /// The task-segment row in `reminders-segments.json` (2026-10-10): a
    /// one-off "days" task with a deadline and no target, considered today.
    static let squeakyDoor = 110
    /// The Upcoming rows in `reminders-upcoming.json` (2026-10-12): a one-off
    /// with a target and a deadline, and a repeating task (every 3 days) —
    /// distinct from 106, the one-off "Water the plants".
    static let passport = 111, plantsRecurring = 112
    /// The every-2-weeks quota in `task-interval-quota.json` and
    /// `reminders-interval.json` (2026-10-16), created after the badge tasks
    /// (113–115).
    static let fortnightly = 116
    /// The deadline-anchored repeat in `task-deadline-anchored.json`
    /// (2026-10-21), created last of all.
    static let deadlineRepeat = 123
    /// The deadlines page's rows in `reminders-deadlines.json` (2026-10-22),
    /// created after the repeat-ends task (124): a one-off in its window, a
    /// one-off past its deadline (the safety net), a target-less repeat.
    static let deadlineWindow = 125, deadlinePassed = 126, deadlineRepeatTargetless = 127
    /// Upcoming's two sections in `reminders-upcoming-sections.json`
    /// (2026-10-25; the considered one 2026-10-26): Later waiting, Tomorrow
    /// waiting, Later considered today. Tomorrow's other row is the passport
    /// (111).
    static let sectionLater = 128, sectionTomorrow = 129, sectionSeen = 130
    /// The one-time High reminder of `notification-action-considered.json` and
    /// `notification-action-not-waiting.json` (2026-10-26, the named reminder
    /// push's Considered button), created last of all.
    static let namedReminder = 131
    /// The Medium weekly quota of `quota-prompts-consider.json` (Push PR 4b,
    /// 2026-10-26, the named quota-prompt push's Considered), created after
    /// the named reminder.
    static let namedQuota = 132
    /// The task queue's rows (`reminders-queue.json`, `reminders-native.json`):
    /// "Previous pulls" — a stripped one-off and a waiting weekly task —
    /// then "Today's pulls" — a one-off (done in `reminders-native.json`, a
    /// left row) and a Try Tomorrow row; then the two decked tasks of
    /// `reminders-deck.json`, a one-off and a repeat, on deck tomorrow.
    static let queueOld = 117, queueWeekly = 118, queueNew = 119, queueTryTomorrow = 120
    static let decked = 121, deckedRepeating = 122

    static func promptKey(_ taskId: Int, _ k: Int) -> String { "q:\(taskId):\(k):\(pinnedDate)" }
}

/// Every test that touches `WidgetStore` subclasses this: a throwaway
/// UserDefaults suite per test, never the App Group (on macOS that is the
/// installed Mac app's real widget cache). `DayStartStore` reads the same
/// throwaway suite ("Day starts at" PR 3), so a surface that reads the
/// remembered day boundary sees nothing known — midnight — unless the test
/// saves one (`rememberDayStart`).
class WidgetStoreTestCase: XCTestCase {
    private var suiteName = ""

    override func setUp() {
        super.setUp()
        suiteName = "test.\(UUID().uuidString)"
        WidgetStore.suiteOverride = UserDefaults(suiteName: suiteName)
        DayStartStore.suiteOverride = WidgetStore.suiteOverride
    }

    override func tearDown() {
        WidgetStore.suiteOverride?.removePersistentDomain(forName: suiteName)
        WidgetStore.suiteOverride = nil
        DayStartStore.suiteOverride = nil
        APIClient.undoRecorder = nil
        super.tearDown()
    }

    /// Remember a day boundary, as a preferences fetch with the task queue
    /// on would.
    func rememberDayStart(_ dayStart: String) throws {
        let json = "{\"task_queue\":true,\"rollover_time\":\"\(dayStart)\"}"
        DayStartStore.save(from: try JSONDecoder().decode(UserPreferencesLabelConfigPage.self, from: Data(json.utf8)))
    }
}
