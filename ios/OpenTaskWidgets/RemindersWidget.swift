import SwiftUI
import WidgetKit

// MARK: - Entry

struct RemindersEntry: TimelineEntry {
    let date: Date
    let groups: [ReminderGroupDTO]
    /// Index into `groups`. Never out of range — the provider clamps.
    let slotIndex: Int
    /// Non-nil when this entry was rendered from the App Group cache because a
    /// fetch failed. Drives the "as of HH:MM" note.
    let staleSince: Date?
    /// No server URL / token in the Keychain — the app has not been set up.
    let isSignedOut: Bool
    /// Whether the header's Undo/Redo buttons should be enabled at THIS
    /// entry's `date` — see `WidgetStore.canUndo`/`canRedo` and
    /// `UndoRedoButtons`. Not time-windowed (2026-09-23): these simply carry
    /// forward whatever the server's own counts were when the entry was
    /// built, the same limitation `staleSince` already accepts for a
    /// pre-scheduled future entry.
    let canUndo: Bool
    let canRedo: Bool
    /// The header subtitle's "Undid: …" / "Redid: …" indication, live for
    /// `WidgetStore.lastActionWindow` seconds after an undo/redo — see
    /// `WidgetStore.lastActionDescription(at:)`. `nil` shows the ordinary
    /// count subtitle instead.
    let actionDescription: String?

    var group: ReminderGroupDTO? {
        guard groups.indices.contains(slotIndex) else { return nil }
        return groups[slotIndex]
    }
}

// MARK: - Slot resolution

/// Where "which time slot am I looking at" is decided.
///
/// Split out of the provider because `ShiftReminderSlotIntent` has to answer
/// the same question from a completely different process entry point, and two
/// implementations of this rule would drift.
enum RemindersTimeline {

    /// The group the clock is in right now: latest slot whose `start_time` is
    /// at or before the current local time.
    ///
    /// Before the first boundary of the day (the small hours) no slot has
    /// started yet. That falls back to the first slot rather than to the
    /// trailing "Anytime" group — at 5am the useful answer is "here's what's
    /// coming", not "here's the bucket for items with no time".
    static func naturalSlotIndex(in groups: [ReminderGroupDTO], now: Date = Date()) -> Int {
        guard !groups.isEmpty else { return 0 }

        let comps = Calendar.current.dateComponents([.hour, .minute], from: now)
        let minutes = (comps.hour ?? 0) * 60 + (comps.minute ?? 0)

        var best: Int?
        var bestStart = -1
        for (index, group) in groups.enumerated() {
            guard let start = group.slot?.startMinutes, start <= minutes, start > bestStart else {
                continue
            }
            bestStart = start
            best = index
        }
        if let best { return best }

        return groups.firstIndex(where: { $0.slot != nil }) ?? 0
    }

    /// The group actually shown: the user's chevron override while it is still
    /// valid, otherwise the natural slot.
    ///
    /// SIDE EFFECT: a stale override is deleted here. An override is stale once
    /// real time has moved into a different slot than the one the user was
    /// standing in when they navigated — that is the "reset the override when
    /// the timeline refreshes into a new slot" rule, expressed as data rather
    /// than as a timer.
    static func displayedSlotIndex(in groups: [ReminderGroupDTO], now: Date = Date()) -> Int {
        let natural = naturalSlotIndex(in: groups, now: now)
        guard !groups.isEmpty, let override = WidgetStore.slotOverride() else { return natural }

        guard groups.indices.contains(natural),
              groups[natural].slotKey == override.naturalSlotKey,
              let index = groups.firstIndex(where: { $0.slotKey == override.slotKey })
        else {
            WidgetStore.clearSlotOverride()
            return natural
        }
        return index
    }

    /// Remaining slot boundaries today, as (fire date, group index).
    ///
    /// Scheduling an entry at each one makes the widget flip to the next slot
    /// at exactly the right minute without spending any of the refresh budget —
    /// the entries are all delivered by the single timeline WidgetKit already
    /// asked for.
    static func upcomingBoundaries(
        in groups: [ReminderGroupDTO],
        now: Date = Date()
    ) -> [(date: Date, index: Int)] {
        let calendar = Calendar.current
        let startOfDay = calendar.startOfDay(for: now)

        return groups.enumerated().compactMap { index, group in
            guard let minutes = group.slot?.startMinutes,
                  let fire = calendar.date(byAdding: .minute, value: minutes, to: startOfDay),
                  fire > now
            else {
                return nil
            }
            return (fire, index)
        }
    }

    /// Has this slot's time arrived? Mirrors the web's `ReminderSlotBar.
    /// hasStarted` (`src/components/ReminderSlotBar.tsx`) — the un-slotted
    /// "Anytime" group has no start time and is always available, so it
    /// counts as started rather than "coming up later".
    static func hasStarted(_ group: ReminderGroupDTO, now: Date = Date()) -> Bool {
        guard let minutes = group.slot?.startMinutes else { return true }
        let comps = Calendar.current.dateComponents([.hour, .minute], from: now)
        let nowMinutes = (comps.hour ?? 0) * 60 + (comps.minute ?? 0)
        return nowMinutes >= minutes
    }

    /// After completing an item that leaves the ON-SCREEN slot with nothing
    /// waiting, jump to the EARLIEST slot that still has something — Trent,
    /// 2026-09-23: "once I finish morning it should take me automatically
    /// back to early morning ... so I can keep checking things off and
    /// automatically switch." Also the fix for his other complaint that
    /// prompted this: "I finished everything for the morning ... I didn't
    /// even realize I actually did not finish the things for early
    /// morning" — an already-passed slot with leftovers should not go
    /// unnoticed just because a later one is on screen.
    ///
    /// Searches index 0 through the NATURAL slot (the clock's own position)
    /// inclusive — never a slot whose time hasn't come, and never forward of
    /// "now" even if the on-screen slot was itself ahead of natural. A no-op
    /// (stays put) when the on-screen slot still has something, or when
    /// nothing earlier does either. Writes through the EXISTING slot-override
    /// mechanism (`WidgetStore.setSlotOverride`), so this reads to
    /// `displayedSlotIndex` exactly like a manual chevron tap — including
    /// self-expiring once the real clock moves into a new natural slot.
    ///
    /// `groups` should be the CACHED payload as of the moment of the tap
    /// (`WidgetStore.loadReminders()`); this filters it with
    /// `WidgetStore.filterPending` itself, so the just-tapped item (already
    /// staged as a tombstone by the caller) reads as gone here too.
    static func autoAdvanceSlot(after taskId: Int, in groups: [ReminderGroupDTO], now: Date = Date()) {
        let filtered = WidgetStore.filterPending(groups, now: now)
        guard !filtered.isEmpty else { return }

        let displayed = displayedSlotIndex(in: filtered, now: now)
        guard filtered.indices.contains(displayed), filtered[displayed].reminders.isEmpty else {
            return // the on-screen slot still has something waiting
        }

        let natural = naturalSlotIndex(in: filtered, now: now)
        guard filtered.indices.contains(natural) else { return }
        guard let target = filtered[0...natural].firstIndex(where: { !$0.reminders.isEmpty }) else {
            return // nothing from the day's first slot through now is waiting either — stay
        }

        setSlotOverride(slotKey: filtered[target].slotKey, naturalSlotKey: filtered[natural].slotKey)
    }

    /// Thin wrapper so `autoAdvanceSlot` reads as plainly as the intents that
    /// call the same store function directly.
    private static func setSlotOverride(slotKey: Int, naturalSlotKey: Int) {
        WidgetStore.setSlotOverride(slotKey: slotKey, naturalSlotKey: naturalSlotKey)
        WidgetStore.markInteraction()
    }
}

// MARK: - Provider

struct RemindersProvider: TimelineProvider {

    /// How often to refresh when nothing else forces it. Well inside the
    /// ~40-70 reloads/day the system allows, and every check-off reloads for
    /// free on top of this.
    private static let refreshInterval: TimeInterval = 30 * 60

    func placeholder(in context: Context) -> RemindersEntry {
        SampleData.remindersEntry
    }

    func getSnapshot(in context: Context, completion: @escaping (RemindersEntry) -> Void) {
        // The widget gallery must never show an empty or half-loaded card, and
        // it gets no chance to await a network call.
        if context.isPreview {
            completion(SampleData.remindersEntry)
            return
        }
        Task { completion(await currentEntry()) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<RemindersEntry>) -> Void) {
        Task {
            // A widget push token the server never confirmed — see
            // `WidgetPushRegistration` in WidgetPushHandler.swift.
            await WidgetPushRegistration.retryIfNeeded()
            let entry = await currentEntry()

            var entries = [entry]
            if !entry.isSignedOut {
                // Boundary entries always show the *natural* slot for their
                // moment, so crossing into a new slot visibly overrides
                // whatever the user had chevroned to.
                for boundary in RemindersTimeline.upcomingBoundaries(in: entry.groups).prefix(8) {
                    entries.append(
                        RemindersEntry(
                            date: boundary.date,
                            groups: entry.groups,
                            slotIndex: boundary.index,
                            staleSince: entry.staleSince,
                            isSignedOut: false,
                            canUndo: entry.canUndo,
                            canRedo: entry.canRedo,
                            actionDescription: WidgetStore.lastActionDescription(at: boundary.date)
                        )
                    )
                }
                // The explicit "Undid: …" expiry (2026-09-23) — WidgetKit has
                // no "expire after N seconds" primitive, only entries dated
                // for a specific moment, so the guaranteed-off state needs
                // its own entry rather than something inferred between
                // reloads. Guarded by `expiry > entry.date`: a live
                // `actionDescription` on the primary entry already implies
                // this, but stated explicitly so a future reordering of
                // these blocks can't schedule an entry dated at or before
                // `now`.
                if entry.actionDescription != nil, let expiry = WidgetStore.lastActionExpiry(),
                    expiry > entry.date {
                    // Which slot should still be on screen once the
                    // indication turns off: whichever entry built above is
                    // dated latest at or before `expiry` — almost always
                    // `entry` itself, but if a slot boundary happens to fall
                    // inside this 60s window, that boundary's NATURAL slot is
                    // what should still be showing at expiry. Deliberately
                    // NOT `RemindersTimeline.displayedSlotIndex(now: expiry)`
                    // — that has the side effect of clearing a stale
                    // override, which must only happen against the REAL
                    // clock, not a hypothetical future timestamp being
                    // pre-computed here.
                    let slotAtExpiry =
                        entries.filter { $0.date <= expiry }.max { $0.date < $1.date }?.slotIndex
                        ?? entry.slotIndex
                    entries.append(
                        RemindersEntry(
                            date: expiry,
                            groups: entry.groups,
                            slotIndex: slotAtExpiry,
                            staleSince: entry.staleSince,
                            isSignedOut: false,
                            canUndo: entry.canUndo,
                            canRedo: entry.canRedo,
                            actionDescription: nil
                        )
                    )
                }
            }
            entries.sort { $0.date < $1.date }

            let next = Date().addingTimeInterval(Self.refreshInterval)
            completion(Timeline(entries: entries, policy: .after(next)))
        }
    }

    /// Fetch, falling back to the App Group cache. Never throws to the caller —
    /// a widget's only honest failure modes are "signed out" and "stale".
    private func currentEntry() async -> RemindersEntry {
        let now = Date()

        guard APIClient.shared.isConfigured else {
            return RemindersEntry(
                date: now, groups: [], slotIndex: 0, staleSince: nil, isSignedOut: true,
                canUndo: false, canRedo: false, actionDescription: nil
            )
        }

        // Interaction fast path (§8 optimistic check-off): a tap just happened,
        // so repaint from cache immediately — the tombstone filter is what makes
        // the checked item vanish NOW instead of after a seconds-long fetch.
        // No staleness note: this data is seconds old by construction.
        if WidgetStore.hasRecentInteraction(now: now), let cached = WidgetStore.loadReminders() {
            let groups = WidgetStore.filterPending(cached.value.groups, now: now)
            return RemindersEntry(
                date: now,
                groups: groups,
                slotIndex: RemindersTimeline.displayedSlotIndex(in: groups, now: now),
                staleSince: nil,
                isSignedOut: false,
                canUndo: WidgetStore.canUndo,
                canRedo: WidgetStore.canRedo,
                actionDescription: WidgetStore.lastActionDescription(at: now)
            )
        }

        do {
            // Concurrent with the reminders fetch — piggybacked undo/redo
            // counts (2026-09-23) so the always-present buttons reflect the
            // server even when the last change came from the web app or
            // another device. Best-effort: `try?` so a flaky
            // `/api/undo/status` never fails the reminders fetch it rides
            // along with.
            async let reminders = APIClient.shared.fetchReminders()
            async let undoStatus: APIClient.UndoStatus? = try? APIClient.shared.fetchUndoStatus()
            let (payload, status) = try await (reminders, undoStatus)
            WidgetStore.saveReminders(payload.groups)
            if let status {
                WidgetStore.setUndoRedoCounts(undoable: status.undoableCount, redoable: status.redoableCount)
            }
            // Filter even the fresh fetch: a tombstoned completion may not have
            // committed server-side yet, and resurrecting it for one refresh
            // cycle would look like the check-off didn't take.
            let groups = WidgetStore.filterPending(payload.groups, now: now)
            return RemindersEntry(
                date: now,
                groups: groups,
                slotIndex: RemindersTimeline.displayedSlotIndex(in: groups, now: now),
                staleSince: nil,
                isSignedOut: false,
                canUndo: WidgetStore.canUndo,
                canRedo: WidgetStore.canRedo,
                actionDescription: WidgetStore.lastActionDescription(at: now)
            )
        } catch {
            print("[OpenTaskWidgets] Reminders fetch failed: \(error)")
            let cached = WidgetStore.loadReminders()
            let groups = WidgetStore.filterPending(cached?.value.groups ?? [], now: now)
            return RemindersEntry(
                date: now,
                groups: groups,
                slotIndex: RemindersTimeline.displayedSlotIndex(in: groups, now: now),
                staleSince: cached?.fetchedAt,
                isSignedOut: false,
                canUndo: WidgetStore.canUndo,
                canRedo: WidgetStore.canRedo,
                actionDescription: WidgetStore.lastActionDescription(at: now)
            )
        }
    }
}

// MARK: - Widget

struct RemindersWidget: Widget {
    static let kind = "OpenTaskReminders"

    var body: some WidgetConfiguration {
        // Server-pushed reloads (iOS 26 / macOS 26 — see WidgetPushHandler.swift
        // and docs/NOTIFICATIONS.md § WidgetKit push) need `.pushHandler(...)`,
        // gated here rather than raising this extension's deployment target
        // (iOS 17 / macOS 14). See the doc comment in TasksWidget.swift for why
        // this needs an EXPLICIT `return` in each branch (implicit return, or
        // an `if` that isn't the body's sole statement, both fail to compile —
        // `Widget.body` has no result builder to reconcile the two branches'
        // different concrete types).
        if #available(iOS 26.0, macOS 26.0, *) {
            return StaticConfiguration(kind: Self.kind, provider: RemindersProvider()) { entry in
                RemindersWidgetView(entry: entry)
            }
            .configurationDisplayName("Reminders")
            .description("The current time slot's reminders, with tap-to-check-off.")
            // systemLarge first: it is the primary layout (§8 — the user pointed
            // at a 4x4 Weather widget), and the gallery leads with the first entry.
            // .accessoryRectangular / .accessoryCircular are Lock Screen families,
            // @available(macOS, unavailable) — hard compile errors on native macOS
            // (unlike the Designed-for-iPad build, which the plain iOS SDK compile
            // didn't reject). Lock Screen accessories simply don't exist on the Mac.
            //
            // Built with an immediately-invoked closure rather than #if inside the
            // array literal itself — the compiler rejects #if/#endif as array
            // *elements* ("expected expression in container literal"), even though
            // #if is fine as a statement inside a closure body.
            .supportedFamilies({
                var families: [WidgetFamily] = [.systemLarge, .systemMedium, .systemSmall]
                #if os(iOS)
                families += [.accessoryRectangular, .accessoryCircular]
                #endif
                return families
            }())
            .pushHandler(OpenTaskWidgetPushHandler.self)
        } else {
            return StaticConfiguration(kind: Self.kind, provider: RemindersProvider()) { entry in
                RemindersWidgetView(entry: entry)
            }
            .configurationDisplayName("Reminders")
            .description("The current time slot's reminders, with tap-to-check-off.")
            .supportedFamilies({
                var families: [WidgetFamily] = [.systemLarge, .systemMedium, .systemSmall]
                #if os(iOS)
                families += [.accessoryRectangular, .accessoryCircular]
                #endif
                return families
            }())
        }
    }
}

#if DEBUG
// MARK: - Previews (2026-09-23, day-naming + "show completed" verification)
//
// Realistic named sample data — deliberately NOT `SampleData.swift`, which
// stays generic/non-identifying on purpose (it ships in the app bundle and
// backs the real widget gallery/placeholder/redaction preview). These two
// previews are `#if DEBUG`-only and never ship, so real-looking personal
// content here is fine.
//
// TWO SEPARATE #Preview BLOCKS per toggle state, not two timeline entries
// inside ONE preview: `WidgetStore.showCompleted` is read live from the App
// Group at RENDER time (2026-09-23's design — see `WidgetStore`'s "Show
// completed" section), not carried on the entry, and a `timeline:` closure's
// entry array is built ONCE, before any entry in it is ever rendered — so a
// store mutation made while building ONE shared timeline would be in effect
// for every entry in it, not scoped to just one. Setting the toggle
// immediately before each SEPARATE preview's own (single-entry) timeline is
// what actually makes the two renders differ.
private enum ReminderPreviewData {
    static var eveningGroup: ReminderGroupDTO {
        ReminderGroupDTO(
            slot: TimeSlotDTO(id: 3, label: "Evening", startTime: "20:00"),
            reminders: [
                TaskDTO(
                    id: 901, title: "Journaling before bed might help clear the mind at night",
                    priority: 2, isReminder: true
                ),
                TaskDTO(
                    id: 902, title: "Timed breathing to slow down (use app)",
                    priority: 1, isReminder: true
                ),
                TaskDTO(id: 903, title: "Neck stretch (posture)", priority: 1, isReminder: true),
                TaskDTO(id: 904, title: "Evening stretch routine (after mobility)", priority: 1, isReminder: true),
            ],
            considered: 2,
            consideredItems: [
                TaskDTO(id: 905, title: "Laundry fold", isReminder: true),
                TaskDTO(id: 906, title: "Dark chocolate", isReminder: true),
            ]
        )
    }

    static func entry() -> RemindersEntry {
        RemindersEntry(
            date: Date(),
            groups: [eveningGroup],
            slotIndex: 0,
            staleSince: nil,
            isSignedOut: false,
            canUndo: true,
            canRedo: false,
            actionDescription: nil
        )
    }
}

#Preview("Reminders Large — Completed Off", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = WidgetStore.setShowCompleted(false, for: RemindersWidget.kind)
    ReminderPreviewData.entry()
}

#Preview("Reminders Large — Completed On", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = WidgetStore.setShowCompleted(true, for: RemindersWidget.kind)
    ReminderPreviewData.entry()
}
#endif
