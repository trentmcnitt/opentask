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
        // No staleness note: this data is seconds old by construction. Also
        // gated on no intent having declared this cache stale since
        // (2026-09-24) — see `WidgetStore.canRepaintRemindersFromCache`.
        if WidgetStore.canRepaintRemindersFromCache(now: now), let cached = WidgetStore.loadReminders() {
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
            WidgetStore.saveReminders(payload.groups, fetchStartedAt: now)
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
// MARK: - Previews (2026-09-24, real-data snapshot)
//
// Trent's REAL reminders, read-only from production on 2026-09-24 at the
// moment he screenshotted the widget ("Early morning · 7 left", page 1/4
// showing only two rows — the list-fill bug this snapshot exists to
// reproduce). Titles are VERBATIM, including the very long "Learning a
// physical skill needs…" one: the fill bug only shows up with real
// title lengths, and a tidy generic corpus is exactly what let it ship.
// Deliberately NOT `SampleData.swift`, which ships in the app bundle and
// backs the real widget gallery/placeholder — these previews are
// `#if DEBUG`-only and never ship, and every title here already lives in
// Trent's own app.
//
// ONE #Preview BLOCK PER STORE STATE (page, "show completed"), not several
// timeline entries in one: the page index and the toggle are read live from
// the App Group at RENDER time, and a `timeline:` closure's entries are all
// built before any of them renders — so a store write made while building
// one shared timeline would apply to every entry in it.
private enum ReminderPreviewData {
    /// The snapshot's clock: 8:44 AM local today — inside Early morning
    /// (07:00-09:00), where Trent's screenshots were taken.
    static var now: Date {
        Calendar.current.date(bySettingHour: 8, minute: 44, second: 0, of: Date()) ?? Date()
    }

    private static func group(
        _ id: Int, _ label: String, _ start: String, _ reminders: [TaskDTO], considered: [TaskDTO]
    ) -> ReminderGroupDTO {
        ReminderGroupDTO(
            slot: TimeSlotDTO(id: id, label: label, startTime: start),
            reminders: reminders,
            considered: considered.count,
            consideredItems: considered
        )
    }

    /// Every slot of the day, as `GET /api/reminders` returned them at 8:44.
    static var groups: [ReminderGroupDTO] {
        [
            group(11, "Early morning", "07:00", [
                TaskDTO(id: 604, title: "Supplements ( Vitamin C, Zinc, Magnesium )", priority: 2, isReminder: true),
                TaskDTO(id: 64, title: "Learning a physical skill needs a feedback loop: watch, listen and adjust while doing it, so the thinking part of the brain can guide the body. Record, review, repeat, and notice what changed each time. (That is how practice turns into progress, one small correction at a time.) Keep sessions short and specific.", priority: 0, isReminder: true),
                TaskDTO(id: 168, title: "Skin care (Cleanse, Moisturize, SPF)", priority: 0, isReminder: true),
                TaskDTO(id: 208, title: "Think of improvement as fun to see what’s possible?", priority: 0, isReminder: true),
                TaskDTO(id: 218, title: "Good form uses the full body to accomplish the task", priority: 0, isReminder: true),
                TaskDTO(id: 223, title: "Walk and move in a way that keeps the whole body loose", priority: 0, isReminder: true),
                TaskDTO(id: 23432, title: "Cold Shower (morning)", priority: 0, isReminder: true),
            ], considered: [
                TaskDTO(id: 24, title: "Yesterday = Lesson, Tomorrow = Plan, Today = Practice", priority: 0, isReminder: true),
            ]),
            group(12, "Morning", "09:00", [
                TaskDTO(id: 2226, title: "Check GitHub issues", priority: 2, isReminder: true),
                TaskDTO(id: 126, title: "Do my mobility", priority: 0, isReminder: true),
                TaskDTO(id: 183, title: "Mixed Nuts + Pumpkin Seeds", priority: 0, isReminder: true),
                TaskDTO(id: 197, title: "Eye rest (Relax into it, hold it steady — good for presence)", priority: 0, isReminder: true),
                TaskDTO(id: 215, title: "Wall pushups", priority: 0, isReminder: true),
                TaskDTO(id: 18050, title: "How has the assistant voice been (pleasant and effective to talk with?)", priority: 0, isReminder: true),
            ], considered: [
            ]),
            group(13, "Midday", "12:00", [
                TaskDTO(id: 2247, title: "Check all public profile pages", priority: 2, isReminder: true),
                TaskDTO(id: 38, title: "Is the vinegar rinse still working", priority: 0, isReminder: true),
                TaskDTO(id: 146, title: "Chess puzzle training", priority: 0, isReminder: true),
                TaskDTO(id: 279, title: "Almonds", priority: 0, isReminder: true),
                TaskDTO(id: 23393, title: "Stretch break (optional)", priority: 0, isReminder: true),
            ], considered: [
            ]),
            group(14, "Afternoon", "16:00", [
                TaskDTO(id: 12, title: "Being patient is a much happier way to live/be", priority: 0, isReminder: true),
                TaskDTO(id: 127, title: "Remember to enjoy the day (“am I enjoying my day?”, “what am I going to do to enjoy my day?”)", priority: 0, isReminder: true),
                TaskDTO(id: 150, title: "Make sure there is a team sport or a hand-eye coordination activity on the calendar", priority: 0, isReminder: true),
                TaskDTO(id: 222, title: "“Do the small things well, and the big things take care of themselves.”", priority: 0, isReminder: true),
            ], considered: [
            ]),
            group(15, "Evening", "20:30", [
                TaskDTO(id: 41, title: "Laundry fold", priority: 0, isReminder: true),
                TaskDTO(id: 44, title: "Journaling before bed might help clear the mind at night", priority: 0, isReminder: true),
                TaskDTO(id: 70, title: "Timed breathing to slow down (use app)", priority: 0, isReminder: true),
                TaskDTO(id: 94, title: "Neck stretch (posture)", priority: 0, isReminder: true),
                TaskDTO(id: 136, title: "Surround myself with good books and thoughtful people. Read books, listen to podcasts, play strategy games — whatever it takes. Provides learning + mindset reinforcement", priority: 0, isReminder: true),
                TaskDTO(id: 273, title: "Evening stretch routine (after mobility) (finish with a long hold)", priority: 0, isReminder: true),
                TaskDTO(id: 3093, title: "Ask myself: “What went well today?”", priority: 0, isReminder: true),
            ], considered: [
            ]),
        ]
    }

    /// Early morning's slot key — the on-screen slot, and what the stored
    /// page index is paired with (`WidgetStore.remindersPage(for:)`).
    static let earlyMorningKey = 11

    static func entry(slotIndex: Int = 0) -> RemindersEntry {
        RemindersEntry(
            date: now,
            groups: groups,
            slotIndex: slotIndex,
            staleSince: nil,
            isSignedOut: false,
            canUndo: true,
            canRedo: false,
            actionDescription: nil
        )
    }

    /// Pins the page and the toggle — previews share the simulator's App
    /// Group UserDefaults, so whatever a prior preview (or a real widget)
    /// left there would otherwise bleed into this render.
    static func prepare(page: Int, showCompleted: Bool, slotKey: Int = earlyMorningKey) {
        WidgetStore.setShowCompleted(showCompleted, for: RemindersWidget.kind)
        WidgetStore.setRemindersPage(page, for: slotKey)
    }

    /// Evening — the slot with Trent's other paragraph-length reminder
    /// ("Surround myself with good books and thoughtful people…").
    static let eveningKey = 15
}

#Preview("Reminders Large — page 1", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 0, showCompleted: false)
    ReminderPreviewData.entry()
}

#Preview("Reminders Large — page 2", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 1, showCompleted: false)
    ReminderPreviewData.entry()
}

#Preview("Reminders Large — page 3", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 2, showCompleted: false)
    ReminderPreviewData.entry()
}

#Preview("Reminders Large — page 4", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 3, showCompleted: false)
    ReminderPreviewData.entry()
}

#Preview("Reminders Large — page 5", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 4, showCompleted: false)
    ReminderPreviewData.entry()
}

#Preview("Reminders Large — Evening page 1", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 0, showCompleted: false, slotKey: ReminderPreviewData.eveningKey)
    ReminderPreviewData.entry(slotIndex: 4)
}

#Preview("Reminders Large — Evening page 2", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 1, showCompleted: false, slotKey: ReminderPreviewData.eveningKey)
    ReminderPreviewData.entry(slotIndex: 4)
}

#Preview("Reminders Large — Evening page 3", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 2, showCompleted: false, slotKey: ReminderPreviewData.eveningKey)
    ReminderPreviewData.entry(slotIndex: 4)
}

#Preview("Reminders Large — completed on, last page", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    // Past the end on purpose — the list clamps to its last page.
    let _ = ReminderPreviewData.prepare(page: 99, showCompleted: true)
    ReminderPreviewData.entry()
}

#Preview("Reminders Medium", as: .systemMedium) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 0, showCompleted: false)
    ReminderPreviewData.entry()
}

#Preview("Reminders Medium — Evening", as: .systemMedium) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 0, showCompleted: false, slotKey: ReminderPreviewData.eveningKey)
    ReminderPreviewData.entry(slotIndex: 4)
}

#Preview("Reminders Small", as: .systemSmall) {
    RemindersWidget()
} timeline: {
    let _ = ReminderPreviewData.prepare(page: 0, showCompleted: false)
    ReminderPreviewData.entry()
}

#endif
