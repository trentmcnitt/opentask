import Foundation

/// App Group cache of the user's DAY BOUNDARY ("Day starts at" PR 3,
/// 2026-10-24) — the day start every native "today" runs on
/// (`OpenTaskDay`), and the user's first day of the week for the Quotas
/// widget's periods.
///
/// THE RULE is the server's `dayBoundaryForUser` and the browser's
/// `browserDayStart` (src/lib/browser-day-start.ts): `rollover_time` (the
/// user's "Day starts at", 03:00 unless they changed it) with the server's
/// task-queue switch on (`task_queue`), midnight with it off. A server that
/// predates `task_queue` has no switch, so it reads as off: midnight, what
/// that server itself runs on.
///
/// REMEMBERED, like the browser's: written whenever `GET /api/user/
/// preferences` decodes (`APIClient.fetchPreferencesPage()` — every caller:
/// `refreshSlotActions()` on launch and foreground in the iPhone and Mac
/// apps, the watch app's every load (its label-config fetch), the Quotas
/// widget's reloads), read by every surface until the next one. The Tasks
/// and Reminders widgets don't fetch preferences (budget): they read what
/// the app or the Quotas widget last wrote. A change in Settings reaches a surface at its next preferences
/// fetch — the same staleness as `PadPresetStore`. MIDNIGHT ONLY WHEN
/// NOTHING IS KNOWN (a fresh install before its first fetch).
///
/// Same App Group suite and macOS team-ID-prefix split as `TimeSlotStore`.
/// The watch has its own App Group container (its own device), written by
/// the watch app and its Smart Stack widget's processes.
///
/// Tests never touch the real suite (on macOS it is the installed Mac app's
/// group container): `suiteOverride` (DEBUG-only) redirects every read and
/// write, and the pure halves (`resolvedDayStart`, `firstWeekday(for:)`)
/// need no suite at all.
enum DayStartStore {
    #if os(macOS)
    private static let appGroup = "GEL3VGTUJX.group.io.mcnitt.opentask"
    #else
    private static let appGroup = "group.io.mcnitt.opentask"
    #endif

    private static var defaults: UserDefaults? {
        #if DEBUG
        if let suiteOverride { return suiteOverride }
        #endif
        return UserDefaults(suiteName: appGroup)
    }

    #if DEBUG
    /// Test seam: when set, every read and write goes here instead of the
    /// App Group suite (see `WidgetStore.suiteOverride`).
    static var suiteOverride: UserDefaults?
    #endif

    private static let dayStartKey = "dayStart.boundary"
    private static let weekStartKey = "dayStart.firstWeekday"
    private static let taskQueueKey = "dayStart.taskQueue"

    // MARK: Reads

    /// The remembered day boundary ("HH:MM"), or nil when nothing is known.
    static var cachedDayStart: String? {
        guard let value = defaults?.string(forKey: dayStartKey),
              OpenTaskDay.parseHHMM(value) != nil
        else { return nil }
        return value
    }

    /// The OpenTask day every surface draws with: the remembered boundary
    /// in the device's zone (the zone every native date already uses),
    /// midnight only when nothing is known.
    static var current: OpenTaskDay {
        OpenTaskDay(dayStart: cachedDayStart ?? OpenTaskDay.calendarDayStart, timeZone: .current)
    }

    /// The user's first day of the week (`Calendar` numbering: 1 = Sunday,
    /// 2 = Monday) from `week_start`, or nil when it was never fetched.
    static var cachedFirstWeekday: Int? {
        let value = defaults?.integer(forKey: weekStartKey) ?? 0
        return value == 1 || value == 2 ? value : nil
    }

    /// Whether the server's task-queue switch was on at the last preferences
    /// fetch (`task_queue`, 2026-10-26): the overdue sweep's estimate moves
    /// one High per press with it on (`TaskLists.overdueSweepEligibleCount`).
    /// Its own flag, not read off the boundary: the switch on with a 00:00
    /// day start resolves to the same boundary as the switch off. False when
    /// nothing is known, or the server predates the field.
    static var cachedTaskQueue: Bool {
        defaults?.bool(forKey: taskQueueKey) ?? false
    }

    // MARK: Writes

    /// Remember what a decoded preferences page says. Best-effort, like every
    /// App Group cache here.
    static func save(from page: UserPreferencesLabelConfigPage) {
        defaults?.set(
            resolvedDayStart(taskQueue: page.taskQueue, rolloverTime: page.rolloverTime),
            forKey: dayStartKey
        )
        defaults?.set(page.taskQueue == true, forKey: taskQueueKey)
        if let weekday = firstWeekday(for: page.weekStart) {
            defaults?.set(weekday, forKey: weekStartKey)
        }
    }

    #if DEBUG
    /// `#Preview`s only: remember `dayStart` as the boundary, as a fetch with
    /// the task queue on would ("00:00" for the calendar day), so a preview
    /// can draw the night labels whatever its simulator last cached.
    static func seedForPreview(_ dayStart: String) {
        defaults?.set(dayStart, forKey: dayStartKey)
    }
    #endif

    // MARK: Pure halves (tested in `DayStartStoreTests`)

    /// The day boundary a preferences page means: `rollover_time` with the
    /// task queue on (and a valid time), else midnight.
    static func resolvedDayStart(taskQueue: Bool?, rolloverTime: String?) -> String {
        guard taskQueue == true, let rolloverTime, OpenTaskDay.parseHHMM(rolloverTime) != nil else {
            return OpenTaskDay.calendarDayStart
        }
        return rolloverTime
    }

    /// `week_start` ("sunday" / "monday") as a `Calendar` weekday, or nil.
    static func firstWeekday(for weekStart: String?) -> Int? {
        switch weekStart {
        case "sunday": return 1
        case "monday": return 2
        default: return nil
        }
    }
}
