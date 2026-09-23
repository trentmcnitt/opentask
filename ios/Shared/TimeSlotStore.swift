import Foundation

/// App Group cache of the user's time slots (`GET /api/time-slots`).
///
/// Exists so the notification content extension — which cannot make its own
/// setup network calls before the user long-presses, and which
/// `ios/CLAUDE.md` documents as unverifiable in the simulator — and
/// launch-time notification category registration can both build the
/// slot-snooze action list (`slotSnoozeActions()` in `NotificationConstants.swift`)
/// without a network round trip. The main app, watch app and Mac app write
/// this cache via `refreshSlotActions()` on launch and on foreground; the
/// extension only ever reads it.
///
/// Same App Group suite `WidgetStore` and `KeychainHelper` use, and the same
/// macOS team-ID-prefix split documented on both of those: a macOS
/// `UserDefaults(suiteName:)` has to match one of the entitlement's App Group
/// strings exactly, and this project's macOS entitlements only list the
/// prefixed form.
enum TimeSlotStore {
    #if os(macOS)
    private static let appGroup = "GEL3VGTUJX.group.io.mcnitt.opentask"
    #else
    private static let appGroup = "group.io.mcnitt.opentask"
    #endif

    private static var defaults: UserDefaults? {
        UserDefaults(suiteName: appGroup)
    }

    private static let cacheKey = "timeSlots.cache"

    /// Cached slots, earliest start first, or empty if nothing has been
    /// fetched yet (fresh install) or the App Group suite is unavailable.
    /// Malformed `start_time` sorts last rather than crashing or dropping the
    /// slot — the server is the source of truth for the value shape, this is
    /// just a display/ordering nicety.
    static var cachedSlots: [TimeSlotDTO] {
        guard let data = defaults?.data(forKey: cacheKey),
              let slots = try? JSONDecoder().decode([TimeSlotDTO].self, from: data)
        else {
            return []
        }
        return slots.sorted { ($0.startMinutes ?? .max) < ($1.startMinutes ?? .max) }
    }

    /// Overwrite the cache with a freshly fetched list. Best-effort — if the
    /// App Group suite can't be reached the write is silently dropped, same
    /// as every other App Group cache in this codebase.
    static func save(_ slots: [TimeSlotDTO]) {
        guard let data = try? JSONEncoder().encode(slots) else { return }
        defaults?.set(data, forKey: cacheKey)
    }
}
