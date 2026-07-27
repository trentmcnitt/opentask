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
                            isSignedOut: false
                        )
                    )
                }
            }

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
                date: now, groups: [], slotIndex: 0, staleSince: nil, isSignedOut: true
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
                isSignedOut: false
            )
        }

        do {
            let payload = try await APIClient.shared.fetchReminders()
            WidgetStore.saveReminders(payload.groups)
            // Filter even the fresh fetch: a tombstoned completion may not have
            // committed server-side yet, and resurrecting it for one refresh
            // cycle would look like the check-off didn't take.
            let groups = WidgetStore.filterPending(payload.groups, now: now)
            return RemindersEntry(
                date: now,
                groups: groups,
                slotIndex: RemindersTimeline.displayedSlotIndex(in: groups, now: now),
                staleSince: nil,
                isSignedOut: false
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
                isSignedOut: false
            )
        }
    }
}

// MARK: - Widget

struct RemindersWidget: Widget {
    static let kind = "OpenTaskReminders"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: RemindersProvider()) { entry in
            RemindersWidgetView(entry: entry)
        }
        .configurationDisplayName("Reminders")
        .description("The current time slot's reminders, with tap-to-check-off.")
        // systemLarge first: it is the primary layout (§8 — the user pointed
        // at a 4x4 Weather widget), and the gallery leads with the first entry.
        .supportedFamilies([
            .systemLarge,
            .systemMedium,
            .accessoryRectangular,
            .accessoryCircular,
        ])
    }
}
