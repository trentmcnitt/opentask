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

    /// The next slot to start, as an absolute `Date` — mirrors the server's
    /// `nextPeriodStart` (`src/lib/time-slot-assign.ts`, used to resolve
    /// `slot: "next"` for `POST /api/tasks/bulk/snooze-overdue`): for EACH
    /// cached slot, its own next occurrence (today if it hasn't started yet,
    /// else tomorrow), earliest across all of them wins. `nil` with no
    /// cached slots — the Tasks widget's snooze mode (2026-09-23) needs this
    /// client-side because `POST /api/tasks/bulk/snooze` (the ids-based
    /// endpoint per-row/bulk-select snoozing uses) has no `slot` mode at
    /// all, only `until`/`delta_minutes` — unlike `bulk/snooze-overdue`,
    /// which resolves "next" server-side and is what the "All overdue" bar
    /// calls instead (see `APIClient.snoozeOverdue(slot:)`). Computed from
    /// the DEVICE's local timezone/calendar, same as every other on-device
    /// time computation in this file's siblings (`RemindersTimeline`,
    /// `DateHelpers`) — there is no per-request timezone to send here.
    ///
    /// `now` is really "after WHAT": the Tasks widget passes each task's own
    /// snooze base (`DateHelpers.snoozeBase` — its due time while upcoming,
    /// 2026-09-24), so an 8:30 PM task's "Next" is the first slot after
    /// 8:30 PM, tomorrow's first once none is left that evening.
    static func nextPeriodStart(now: Date = Date()) -> Date? {
        nextPeriodStart(slots: cachedSlots, after: now)
    }

    /// The pure half of `nextPeriodStart(now:)` — the first slot start
    /// STRICTLY after `base` (base's own day, else the day after), over the
    /// slots given rather than the App Group cache, so it can be tested
    /// without a suite. `nil` with no slots (or only malformed ones).
    static func nextPeriodStart(
        slots: [TimeSlotDTO], after base: Date, calendar: Calendar = .current
    ) -> Date? {
        let starts: [Date] = slots.compactMap { slot in
            guard let minutes = slot.startMinutes else { return nil }
            var comps = calendar.dateComponents([.year, .month, .day], from: base)
            comps.hour = minutes / 60
            comps.minute = minutes % 60
            comps.second = 0
            guard let sameDayAtSlot = calendar.date(from: comps) else { return nil }
            if sameDayAtSlot > base { return sameDayAtSlot }
            return calendar.date(byAdding: .day, value: 1, to: sameDayAtSlot)
        }
        return starts.min()
    }
}
