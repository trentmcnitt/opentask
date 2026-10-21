import Foundation

/// App Group cache of the snooze pad's four preset times (`pad_presets` in
/// `GET /api/user/preferences`, 2026-10-21 — the same four buttons as the
/// web Quick panel's preset row, user-editable in Settings and optionally
/// linked to a reminder period).
///
/// Exists for the notification content extension's snooze grid
/// (`SnoozeGridView`), which draws its first row from this cache rather than
/// waiting on a network call when the user long-presses. The iPhone app
/// writes it in `refreshSlotActions()` on launch and foreground, so a change
/// made in Settings (or a linked period's new start time) reaches the grid
/// the next time the app is opened — the same staleness `TimeSlotStore`'s
/// slot actions already have. The extension only ever reads it.
///
/// Same App Group suite and macOS team-ID-prefix split as `TimeSlotStore`
/// (see its doc). The cache has no test seam on purpose: tests go through
/// the pure halves, `presets(from:)` and `data(for:)`, never the real suite
/// (on macOS that is the installed Mac app's group container).
enum PadPresetStore {
    #if os(macOS)
    private static let appGroup = "GEL3VGTUJX.group.io.mcnitt.opentask"
    #else
    private static let appGroup = "group.io.mcnitt.opentask"
    #endif

    private static var defaults: UserDefaults? {
        UserDefaults(suiteName: appGroup)
    }

    private static let cacheKey = "padPresets.cache"

    /// The pad always has exactly four buttons (one fixed row of the grid).
    static let count = 4

    /// The server's defaults (`DEFAULT_PAD_PRESETS`): what the grid showed
    /// when it was hardcoded, and what a fresh install shows until the first
    /// successful preferences fetch.
    static let defaultPresets: [PadPresetDTO] = [
        PadPresetDTO(time: "09:00"),
        PadPresetDTO(time: "12:00"),
        PadPresetDTO(time: "16:00"),
        PadPresetDTO(time: "20:30"),
    ]

    /// The cached presets, in the server's order, or the defaults.
    static var cachedPresets: [PadPresetDTO] {
        presets(from: defaults?.data(forKey: cacheKey))
    }

    /// Overwrite the cache. Best-effort, like every App Group cache here. A
    /// list the grid couldn't draw (not four valid times) is not written, so
    /// the last good list stays.
    static func save(_ presets: [PadPresetDTO]) {
        guard isUsable(presets), let data = data(for: presets) else { return }
        defaults?.set(data, forKey: cacheKey)
    }

    // MARK: - Pure halves (tested in `PadPresetStoreTests`)

    /// Decode a cached list. Missing data, undecodable data, a list that
    /// isn't exactly four long, or any malformed time → the four defaults:
    /// the grid is a fixed four-wide row, so a partial list is garbage, not
    /// something to pad out.
    static func presets(from data: Data?) -> [PadPresetDTO] {
        guard let data,
              let decoded = try? JSONDecoder().decode([PadPresetDTO].self, from: data),
              isUsable(decoded)
        else { return defaultPresets }
        return decoded
    }

    /// The encoded form `save(_:)` writes.
    static func data(for presets: [PadPresetDTO]) -> Data? {
        try? JSONEncoder().encode(presets)
    }

    static func isUsable(_ presets: [PadPresetDTO]) -> Bool {
        presets.count == count && presets.allSatisfy { $0.hourMinute != nil }
    }

    /// The button's words, "9:00 AM" / "12:00 PM" / "8:30 PM" — fixed English
    /// 12-hour, exactly what the hardcoded row drew, whatever the device's
    /// locale or 24-hour setting (a `DateFormatter` would follow those).
    /// Nil for a malformed time.
    static func label(for preset: PadPresetDTO) -> String? {
        guard let (hour, minute) = preset.hourMinute else { return nil }
        let hour12 = hour % 12 == 0 ? 12 : hour % 12
        let suffix = hour < 12 ? "AM" : "PM"
        return "\(hour12):\(String(format: "%02d", minute)) \(suffix)"
    }
}
