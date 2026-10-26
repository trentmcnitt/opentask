import Foundation

/// Shared notification category and action identifiers.
/// Used by AppDelegate (iOS), MacAppDelegate, WatchAppDelegate (watchOS), the
/// content extension and `NotificationActionRunner`. Foundation-only, so
/// `OpenTaskLogicTests` compiles it (the UserNotifications side is in
/// `NotificationConstants.swift`).
/// Must match the `category` field sent by the server in APNs payloads.
enum NotificationCategory {
    static let taskReminder = "TASK_REMINDER"
    static let taskSummary = "TASK_SUMMARY"
    /// REDESIGN-V03 §6: the time SLOT notifies, not the reminder. Long-pressing
    /// one of these expands into the batch checklist (§6.1).
    static let slotReminder = "SLOT_REMINDER"
    /// The "AI finished" notification for a just-added task
    /// (`buildEnrichedNotification` in `src/core/notifications/apns.ts`):
    /// Done and Delete. Not in the content extension's category list, so it
    /// gets the system's expanded view.
    static let taskAdded = "TASK_ADDED"
    /// The named reminder push (2026-10-26, `buildReminderNagNotification` in
    /// `src/core/notifications/apns.ts`): one Medium+ reminder by its own
    /// title, thread `ot-reminders`, collapse id `reminder-<id>`. Its payload
    /// carries `taskId` and `reminder_day` (`ReminderNagKey.day`) and NO
    /// `priority`. One button, "Considered" (the `DONE` identifier, sending
    /// the day). Not in the content extension's category list, so it gets the
    /// system's expanded view.
    static let reminderNag = "REMINDER_NAG"
    /// The named quota-prompt push (Push PR 4, 2026-10-26,
    /// `buildPromptNagNotification` in `src/core/notifications/apns.ts`): one
    /// waiting prompt of a Medium+ quota, titled with the quota's short title,
    /// its body count-first ("Morning · 1/3 this week"); thread
    /// `ot-reminders`, collapse id `prompt-<prompt_key>`. Its payload carries
    /// `taskId` (the quota) and `prompt_key` (`QuotaNagKey.promptKey`) and NO
    /// `priority`. Two buttons, "Considered" and "Did it"
    /// (`NotificationAction.considered` / `.didIt`), both sent by key. Not in
    /// the content extension's category list, so it gets the system's
    /// expanded view.
    static let quotaNag = "QUOTA_NAG"
}

/// Payload keys of a `REMINDER_NAG` push.
enum ReminderNagKey {
    /// The OpenTask date (yyyy-MM-dd) the reminder was waiting on. Sent back
    /// as `day` by the Considered button, so a stale banner (yesterday's, or
    /// a reminder already considered elsewhere) changes nothing.
    static let day = "reminder_day"
}

/// Payload keys of a `QUOTA_NAG` push, and of the silent `dismiss` push that
/// closes one.
enum QuotaNagKey {
    /// The prompt's key (`q:<taskId>:<k>:<OpenTask date>`): what its buttons
    /// send to `POST /api/quota-prompts/consider` and `/did`, what a body tap
    /// opens (`/reminders?prompt=<key>`). A daily quota's prompts in two
    /// periods share one `taskId`, never a key.
    static let promptKey = "prompt_key"
    /// The `dismiss` push's list of prompt keys (`dismissPromptNotifications`,
    /// `src/core/notifications/dismiss.ts`): with it, a banner carrying a
    /// `prompt_key` closes only when its key is listed (`bannerIdentifiers`).
    static let dismissPromptKeys = "promptKeys"
}

enum NotificationAction {
    static let done = "DONE"
    /// Move the task to the trash (`action: "delete"` on
    /// `/api/notifications/actions` — a soft delete, undoable in the app).
    /// Offered only by `TASK_ADDED`.
    static let delete = "DELETE"
    /// `QUOTA_NAG`'s two buttons (2026-10-26): "Considered" — handled for
    /// today, nothing logged (`POST /api/quota-prompts/consider`) — and "Did
    /// it" — +1 and considered (`/did`). Their own identifiers: one category
    /// can't offer `DONE` twice, and neither is a task's Done.
    static let considered = "CONSIDERED"
    static let didIt = "DID_IT"
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
