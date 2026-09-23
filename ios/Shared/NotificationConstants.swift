import UserNotifications

/// Shared notification category and action identifiers.
/// Used by AppDelegate (iOS), WatchAppDelegate (watchOS), and the content extension.
/// Must match the `category` field sent by the server in APNs payloads.
enum NotificationCategory {
    static let taskReminder = "TASK_REMINDER"
    static let taskSummary = "TASK_SUMMARY"
    /// REDESIGN-V03 §6: the time SLOT notifies, not the reminder. Long-pressing
    /// one of these expands into the batch checklist (§6.1).
    static let slotReminder = "SLOT_REMINDER"
}

enum NotificationAction {
    static let done = "DONE"
    static let snooze1hr = "SNOOZE_1HR"
    static let snoozeAll1hr = "SNOOZE_ALL_1HR"
    static let snoozeCustom = "SNOOZE_CUSTOM"
    static let snoozeAllCustom = "SNOOZE_ALL_CUSTOM"
    /// §6.1 batch checklist: commit the rows the user checked in the extension.
    /// Only ever offered by the content extension — from the lock screen there
    /// is nothing to check, so the registered category omits it.
    static let completeChecked = "COMPLETE_CHECKED"
    /// Complete every pending reminder in the slot. Meaningful with or without
    /// the expanded UI, so this one IS registered on the category.
    static let completeAll = "COMPLETE_ALL"

    /// Bulk-snooze-to-a-time-slot actions, one per cached `TimeSlotStore` entry
    /// plus a "next period" sentinel, dynamically built by `slotSnoozeActions()`
    /// below — there is no fixed case per slot because slots are user-configurable.
    ///
    /// Identifier shape: `SNOOZE_ALL_SLOT:<value>`, where `<value>` is either a
    /// slot's `start_time` ("07:00") or the literal `next`. That value is sent
    /// verbatim as the server's `slot` body field on
    /// `POST /api/tasks/bulk/snooze-overdue` — the device never computes a time,
    /// it only carries the slot's identity (or "next") to the server, which
    /// resolves it in the user's timezone.
    static let snoozeAllSlotPrefix = "SNOOZE_ALL_SLOT:"

    /// "All → Next period": the first slot whose start is after now, resolved
    /// server-side (wrapping to tomorrow's first slot past the last one today).
    static let snoozeAllSlotNext = snoozeAllSlotPrefix + "next"

    /// Build the identifier for a concrete slot's `start_time` ("07:00").
    static func snoozeAllSlotIdentifier(startTime: String) -> String {
        snoozeAllSlotPrefix + startTime
    }

    /// Parse a `SNOOZE_ALL_SLOT:` identifier back to the value to send as the
    /// `slot` body field — "next" or an "HH:MM" start time. Nil for any other
    /// (non-slot) action identifier.
    static func parseSnoozeAllSlot(_ identifier: String) -> String? {
        guard identifier.hasPrefix(snoozeAllSlotPrefix) else { return nil }
        let value = String(identifier.dropFirst(snoozeAllSlotPrefix.count))
        return value.isEmpty ? nil : value
    }
}

/// userInfo keys carried by a SLOT_REMINDER push (see `sendApnsSlotReminder`
/// in `src/core/notifications/apns.ts` — this is the whole contract).
enum SlotReminderKey {
    /// `time_slots.id`, or -1 for the un-slotted ("Anytime") group.
    static let slotId = "slot_id"
    static let slotLabel = "slot_label"
    /// Pending count at SEND time — a header fallback only. The expanded
    /// checklist always re-fetches, because by long-press time this is stale.
    static let reminderCount = "reminder_count"
}

/// Slot-snooze actions built from the cached `GET /api/time-slots` list
/// (`TimeSlotStore.cachedSlots`), appended after the existing bulk-snooze
/// action on every category that offers one — and reused verbatim by the
/// content extension's own action list (`NotificationViewController`), so the
/// identifier scheme, ordering and titles never drift between the two.
///
/// Order: "All → Next period" first (the server-resolved "next slot to
/// start", never computed on-device), then one action per cached slot,
/// earliest start first. Titles mirror the "All → …" style the content
/// extension already uses for a resolved custom time.
///
/// Empty when no slots are cached yet — a fresh install, or a build running
/// before the first successful `refreshSlotActions()` fetch, registers
/// exactly what it did before this feature existed. This is also why "Next
/// period" is never registered alone: it is built from the same guard, so it
/// only appears once there is at least one real slot to snooze into.
func slotSnoozeActions() -> [UNNotificationAction] {
    let slots = TimeSlotStore.cachedSlots
    guard !slots.isEmpty else { return [] }

    var actions = [
        UNNotificationAction(
            identifier: NotificationAction.snoozeAllSlotNext,
            title: "All \u{2192} Next period",
            options: []
        ),
    ]
    actions += slots.map { slot in
        UNNotificationAction(
            identifier: NotificationAction.snoozeAllSlotIdentifier(startTime: slot.startTime),
            title: "All \u{2192} \(slot.label)",
            options: []
        )
    }
    return actions
}

/// Register notification categories for the app.
/// Called by both AppDelegate (iOS) and WatchAppDelegate (watchOS).
///
/// Three categories:
/// - TASK_REMINDER: individual task (Done, +1hr, All +1hr, then one
///   All → <slot> action per cached time slot — see `slotSnoozeActions()`)
/// - TASK_SUMMARY: overflow summary (All +1hr, then the same slot actions —
///   no single-task actions)
/// - SLOT_REMINDER: §6 time slot (Complete all; long-press expands to the
///   batch checklist, which supplies its own "Complete checked" button).
///   Slot-snooze actions are NOT added here — this category is about a
///   slot's own pending reminders, an unrelated §6 feature that happens to
///   share the word "slot".
func registerNotificationCategories() {
    let doneAction = UNNotificationAction(
        identifier: NotificationAction.done,
        title: "Done",
        options: []
    )
    let snoozeAction = UNNotificationAction(
        identifier: NotificationAction.snooze1hr,
        title: "+1hr",
        options: []
    )
    let snoozeAllAction = UNNotificationAction(
        identifier: NotificationAction.snoozeAll1hr,
        title: "All +1hr",
        options: []
    )
    let slotActions = slotSnoozeActions()

    let taskReminderCategory = UNNotificationCategory(
        identifier: NotificationCategory.taskReminder,
        actions: [doneAction, snoozeAction, snoozeAllAction] + slotActions,
        intentIdentifiers: [],
        options: []
    )

    let taskSummaryCategory = UNNotificationCategory(
        identifier: NotificationCategory.taskSummary,
        actions: [snoozeAllAction] + slotActions,
        intentIdentifiers: [],
        options: []
    )

    let completeAllAction = UNNotificationAction(
        identifier: NotificationAction.completeAll,
        title: "Complete all",
        options: []
    )

    let slotReminderCategory = UNNotificationCategory(
        identifier: NotificationCategory.slotReminder,
        actions: [completeAllAction],
        intentIdentifiers: [],
        options: []
    )

    UNUserNotificationCenter.current().setNotificationCategories([
        taskReminderCategory,
        taskSummaryCategory,
        slotReminderCategory,
    ])
}

/// Highest priority the server will include in a bulk snooze.
///
/// Mirrors `HIGH_PRIORITY_THRESHOLD` in `src/lib/priority.ts`: the server
/// snoozes P0-P2 and leaves P3 (High) and P4 (Urgent) alone, because their due
/// dates are real deadlines. Dismissing above this value would clear the banner
/// for a task that was never actually snoozed — it would stay overdue while
/// looking handled, which is the failure this app exists to prevent.
///
/// Keep in sync with the server constant; there is no shared source of truth
/// across the Swift/TypeScript boundary.
let bulkSnoozeMaxPriority = 2

/// Remove delivered notifications for tasks at or below the given priority.
/// Used after bulk snooze to clear notifications for tasks that were just snoozed.
/// P3 (High) and P4 (Urgent) are never bulk-snoozed, so those notifications remain.
func dismissNotifications(atOrBelowPriority maxPriority: Int) async {
    let center = UNUserNotificationCenter.current()
    let notifications = await center.deliveredNotifications()
    let idsToRemove = notifications
        .filter { notification in
            let p = notification.request.content.userInfo["priority"] as? Int ?? 0
            return p <= maxPriority
        }
        .map { $0.request.identifier }

    if !idsToRemove.isEmpty {
        center.removeDeliveredNotifications(withIdentifiers: idsToRemove)
    }
}

/// Update the app icon badge after a notification action.
/// The server also sends a silent badge-update push, but it may not arrive
/// reliably when the app is suspended (iOS throttles silent pushes). Updating
/// locally ensures the badge reflects the action immediately.
/// iOS badges the app icon, macOS badges the Dock tile — same call, same
/// meaning. watchOS has no app icon badge, so there it is a no-op.
#if os(iOS) || os(macOS)
func updateBadge(_ count: Int) {
    UNUserNotificationCenter.current().setBadgeCount(max(0, count))
}
#else
func updateBadge(_ count: Int) {
    // watchOS does not support app icon badges
}
#endif

/// Fetch the current time slots, cache them (`TimeSlotStore`), and re-register
/// notification categories so the slot-snooze actions reflect the latest list.
///
/// Call on launch (after the initial cache-only `registerNotificationCategories()`
/// call, so the first registration of a run is never blocked on a network
/// round trip) and again whenever the app foregrounds — slots are
/// user-configurable, so a change made in Settings on another device should
/// reach the notification actions the next time this app is opened, not only
/// on reinstall.
///
/// Silently no-ops if the API isn't configured yet or the fetch fails — the
/// categories already registered (from the cache, or a previous successful
/// fetch) are left exactly as they are.
func refreshSlotActions() async {
    guard APIClient.shared.isConfigured else { return }
    guard let slots = try? await APIClient.shared.fetchTimeSlots() else { return }
    TimeSlotStore.save(slots)
    registerNotificationCategories()
}
