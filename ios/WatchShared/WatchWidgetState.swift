import Foundation

/// App Group state owned by the watch Smart Stack widget (`ReminderStackWidget`)
/// and written by its interactive buttons (`WatchWidgetIntents.swift`).
///
/// Lives in `WatchShared/` rather than the widget target because the intents
/// that write it are compiled into BOTH watch targets — Apple's guidance for
/// `Button(intent:)` is to add the intent to the widget extension AND the app
/// ("Adding interactivity to widgets and Live Activities") — and both copies
/// have to agree on keys.
///
/// Same App Group suite as `WatchCache`, same disjoint `watch.*` namespace
/// (never `WidgetStore`'s phone keys). Everything here is small, local,
/// disposable UI state: a lost write degrades to "the widget shows the item
/// it would have shown anyway", never to wrong server data.
enum WatchWidgetState {
    /// The widget kind string — shared so the intents (which live outside
    /// the widget target) can reload/invalidate the right kind without a
    /// second hard-coded copy. `ReminderStackWidget.kind` reads this.
    static let kind = "OpenTaskWatchReminders"

    private static let appGroup = "group.io.mcnitt.opentask"
    private static var defaults: UserDefaults? { UserDefaults(suiteName: appGroup) }

    private static let skipKey = "watch.widget.skip.v2"
    private static let pendingDoneKey = "watch.widget.pendingDone.v1"
    private static let pendingPromptKey = "watch.widget.pendingPrompts.v1"
    private static let snoozeResultKey = "watch.widget.snoozeResult.v1"
    private static let claimKey = "watch.widget.claim.v1"

    // MARK: - Skip (⏭)

    /// "Show me the next one without checking this one off." Stored as the
    /// set of reminder ids skipped within ONE slot on ONE local day — the
    /// pairing is what makes it self-resetting: `skippedKeys(slotKey:now:)`
    /// returns empty the moment either differs, so the clock crossing into a
    /// new slot (or midnight) clears skips without anyone having to remember
    /// a reset call. Same shape as the phone widget's `tasksPage(for:)`
    /// paging-within-a-scope trick, re-derived here (that file is off limits
    /// to watch targets).
    ///
    /// Items are identified by STRING key since quota prompts joined the card
    /// (2026-09-24): `itemKey(reminderId:)` for a reminder, the `prompt_key`
    /// for a prompt (a daily quota's prompts share one task id, so an Int id
    /// can't name them). The key changed from `v1` (Int ids) so an old list
    /// simply reads as empty — skips reset daily anyway.
    private struct SkipState: Codable {
        let slotKey: Int
        let day: String
        var ids: [String]
    }

    /// A reminder's card key — prefixed so it can never collide with a
    /// prompt key (`q:…`).
    static func itemKey(reminderId: Int) -> String { "r:\(reminderId)" }

    private static func dayStamp(_ date: Date) -> String {
        let comps = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return "\(comps.year ?? 0)-\(comps.month ?? 0)-\(comps.day ?? 0)"
    }

    static func skippedKeys(slotKey: Int, now: Date = Date()) -> Set<String> {
        guard let data = defaults?.data(forKey: skipKey),
              let state = try? JSONDecoder().decode(SkipState.self, from: data),
              state.slotKey == slotKey, state.day == dayStamp(now)
        else { return [] }
        return Set(state.ids)
    }

    /// Adds `itemKey` to the slot's skip list — or, when that would leave
    /// nothing unskipped (`remainingKeys` all skipped), clears the list so
    /// the card wraps back to the first item instead of going blank.
    /// Skipping is "not now", never "gone": a slot can't be emptied by ⏭.
    static func skip(itemKey: String, slotKey: Int, remainingKeys: [String], now: Date = Date()) {
        var keys = skippedKeys(slotKey: slotKey, now: now)
        keys.insert(itemKey)
        if remainingKeys.allSatisfy({ keys.contains($0) }) {
            keys = []
        }
        let state = SkipState(slotKey: slotKey, day: dayStamp(now), ids: Array(keys))
        guard let data = try? JSONEncoder().encode(state) else { return }
        defaults?.set(data, forKey: skipKey)
    }

    // MARK: - Pending prompt actions (optimistic ✓ / ☐ on a quota prompt)

    /// The prompt twin of `pendingDone` (quota reminders, 2026-09-24):
    /// `prompt_key -> (at, did)`, same TTL. A prompt with a live entry is
    /// drawn handled (`QuotaPromptDTO.handled(did:)`), so the card advances
    /// before the round trip.
    private struct PendingPromptAction: Codable {
        let at: Date
        let did: Bool
    }

    private static func loadPendingPrompts() -> [String: PendingPromptAction] {
        guard let data = defaults?.data(forKey: pendingPromptKey),
              let map = try? JSONDecoder().decode([String: PendingPromptAction].self, from: data)
        else { return [:] }
        return map
    }

    private static func savePendingPrompts(_ map: [String: PendingPromptAction]) {
        guard let data = try? JSONEncoder().encode(map) else { return }
        defaults?.set(data, forKey: pendingPromptKey)
    }

    static func stagePendingPrompt(key: String, did: Bool, now: Date = Date()) {
        var map = loadPendingPrompts().filter { now.timeIntervalSince($0.value.at) < pendingDoneTTL }
        map[key] = PendingPromptAction(at: now, did: did)
        savePendingPrompts(map)
    }

    static func clearPendingPrompt(key: String) {
        var map = loadPendingPrompts()
        map.removeValue(forKey: key)
        savePendingPrompts(map)
    }

    /// Live entries, `prompt_key -> did`.
    static func pendingPrompts(now: Date = Date()) -> [String: Bool] {
        loadPendingPrompts()
            .filter { now.timeIntervalSince($0.value.at) < pendingDoneTTL }
            .mapValues(\.did)
    }

    // MARK: - Pending check-offs (optimistic ✓)

    /// How long a ✓'d reminder stays hidden locally regardless of what a
    /// fetch says. Covers the window where a timeline reload races the
    /// server write (or a stale `WatchCache` read after a failed fetch) and
    /// would otherwise redraw the reminder the user just checked off.
    static let pendingDoneTTL: TimeInterval = 90

    private static func loadPendingDone() -> [String: Date] {
        guard let data = defaults?.data(forKey: pendingDoneKey),
              let map = try? JSONDecoder().decode([String: Date].self, from: data)
        else { return [:] }
        return map
    }

    private static func savePendingDone(_ map: [String: Date]) {
        guard let data = try? JSONEncoder().encode(map) else { return }
        defaults?.set(data, forKey: pendingDoneKey)
    }

    static func stagePendingDone(taskId: Int, now: Date = Date()) {
        var map = loadPendingDone().filter { now.timeIntervalSince($0.value) < pendingDoneTTL }
        map[String(taskId)] = now
        savePendingDone(map)
    }

    /// Server call failed — drop the tombstone so the reminder honestly
    /// reappears (the widget has no alert surface to report the failure).
    static func clearPendingDone(taskId: Int) {
        var map = loadPendingDone()
        map.removeValue(forKey: String(taskId))
        savePendingDone(map)
    }

    /// Live (unexpired) tombstones. Expired entries are just ignored here, and
    /// pruned on the next `stagePendingDone` write via the TTL filter below —
    /// the map is at most a handful of entries, so no separate sweep.
    static func pendingDoneIds(now: Date = Date()) -> Set<Int> {
        let live = loadPendingDone().filter { now.timeIntervalSince($0.value) < pendingDoneTTL }
        return Set(live.keys.compactMap(Int.init))
    }

    // MARK: - Last bulk-snooze result

    /// What the card's overdue mode shows right after "Snooze all": the
    /// server's REAL counts (same reasoning as `BulkSnoozeSheetView` — the
    /// sweep can legitimately move fewer than the overdue count implied), so
    /// the tap never feels like it vanished into nothing.
    struct SnoozeResult: Codable, Equatable {
        let at: Date
        let tasksAffected: Int
        let snoozedHigh: Int
        /// High (P3) left overdue because something lower was swept this
        /// round — a second tap takes them (docs/TASK-MODEL.md). Said out
        /// loud so the card flipping back to "N overdue" after the result
        /// window reads as expected, not as a snooze that didn't work.
        let skippedHigh: Int
        let skippedUrgent: Int
        /// The period the sweep targeted, as the card labeled it at tap time
        /// ("Midday"), so the result can say where things went.
        let targetLabel: String?
    }

    /// How long the result replaces the card before it reverts to whatever
    /// mode the data calls for. Long enough to read on a wrist glance after
    /// the tap; the provider schedules an explicit entry at the expiry,
    /// since WidgetKit has no "expire after N seconds" primitive.
    static let snoozeResultWindow: TimeInterval = 120

    static func recordSnoozeResult(_ result: SnoozeResult) {
        guard let data = try? JSONEncoder().encode(result) else { return }
        defaults?.set(data, forKey: snoozeResultKey)
    }

    /// The result, only while it's still inside `snoozeResultWindow` of `now`.
    static func snoozeResult(now: Date = Date()) -> SnoozeResult? {
        guard let data = defaults?.data(forKey: snoozeResultKey),
              let result = try? JSONDecoder().decode(SnoozeResult.self, from: data),
              now >= result.at, now.timeIntervalSince(result.at) < snoozeResultWindow
        else { return nil }
        return result
    }

    // MARK: - In-flight claim

    /// Double-tap guard. A second tap on ✓ (or Snooze all) while the first
    /// is still in flight — the button stays on screen until the post-perform
    /// reload lands — must not fire a second server call: a second `done` on
    /// a recurring reminder would consider the NEXT occurrence, and a second
    /// sweep could pull in High tasks the first round deliberately skipped.
    /// TTL-backstopped so a crashed/killed intent can't wedge the buttons.
    private static let claimTTL: TimeInterval = 15

    static func tryClaim(_ action: String, now: Date = Date()) -> Bool {
        if let data = defaults?.data(forKey: claimKey),
           let map = try? JSONDecoder().decode([String: Date].self, from: data),
           let at = map[action], now.timeIntervalSince(at) < claimTTL {
            return false
        }
        var map: [String: Date] = [:]
        if let data = defaults?.data(forKey: claimKey),
           let existing = try? JSONDecoder().decode([String: Date].self, from: data) {
            map = existing.filter { now.timeIntervalSince($0.value) < claimTTL }
        }
        map[action] = now
        if let data = try? JSONEncoder().encode(map) {
            defaults?.set(data, forKey: claimKey)
        }
        return true
    }

    static func releaseClaim(_ action: String) {
        guard let data = defaults?.data(forKey: claimKey),
              var map = try? JSONDecoder().decode([String: Date].self, from: data)
        else { return }
        map.removeValue(forKey: action)
        if let data = try? JSONEncoder().encode(map) {
            defaults?.set(data, forKey: claimKey)
        }
    }
}
