import UserNotifications

/// The UserNotifications half of the notification plumbing: category
/// registration, delivered-notification removal and the badge. The identifiers
/// themselves (`NotificationCategory`, `NotificationAction`, `SlotReminderKey`)
/// live in the Foundation-only `NotificationIdentifiers.swift`, and the action
/// dispatch in `NotificationActionRunner.swift`, so `OpenTaskLogicTests` —
/// which leaves this file out to stay off UserNotifications — can test them.

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
/// Four categories:
/// - TASK_REMINDER: individual task (Done, +1hr, All +1hr, then one
///   All → <slot> action per cached time slot — see `slotSnoozeActions()`)
/// - TASK_ADDED: the "AI finished" notification for a just-added task
///   (Done, Delete). No snooze: a task added a minute ago isn't overdue.
///   Delete is `.destructive` (drawn red) and deliberately NOT
///   `.authenticationRequired` — it is a soft delete the app can undo, the
///   same weight as Done, and neither iOS nor watchOS requires unlocking for
///   a destructive action unless that option is set.
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

    let deleteAction = UNNotificationAction(
        identifier: NotificationAction.delete,
        title: "Delete",
        options: [.destructive]
    )

    let taskAddedCategory = UNNotificationCategory(
        identifier: NotificationCategory.taskAdded,
        actions: [doneAction, deleteAction],
        intentIdentifiers: [],
        options: []
    )

    UNUserNotificationCenter.current().setNotificationCategories([
        taskReminderCategory,
        taskSummaryCategory,
        slotReminderCategory,
        taskAddedCategory,
    ])
}

/// Remove delivered notifications for tasks at or below the given priority.
/// The general form; after a bulk snooze use `dismissNotificationsAfterSweep`.
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

/// After a bulk snooze: clear the delivered notifications of the tiers the
/// sweep actually moved. P0-P2 always; P3 (High) too when the sweep took the
/// High tier (`sweepDismissCeiling`, in `SweepDismissal.swift`); P4 (Urgent)
/// never, since it is never swept. A sweep that moved nothing clears nothing.
///
/// Every sweep path calls this — the notification actions on every device
/// (through `NotificationActionRunner`, which the phone, Mac and Watch
/// delegates and the content extension share) and the Mac's menu items — so
/// they can't drift on which banners a sweep clears.
func dismissNotificationsAfterSweep(_ result: APIClient.BulkSnoozeResult) async {
    guard result.tasksAffected > 0 else { return }
    await dismissNotifications(atOrBelowPriority: sweepDismissCeiling(result))
}

/// The silent `dismiss` push (`dismissNotificationsForTasks`,
/// `src/core/notifications/dismiss.ts`): those tasks were handled somewhere
/// else, so clear their delivered banners here. A banner is matched by its
/// payload's `taskId`. Returns how many were removed — the phone and Watch
/// answer their background-fetch handler `.newData`/`.noData` from it.
///
/// Shared by the phone, Mac and Watch delegates; each keeps its own handling
/// of the other silent types (`badge-update`, `dismiss-all`).
func removeDeliveredNotifications(forTaskIds taskIds: [Int]) async -> Int {
    let center = UNUserNotificationCenter.current()
    let idsToRemove = await center.deliveredNotifications()
        .filter { notification in
            guard let id = notification.request.content.userInfo["taskId"] as? Int else { return false }
            return taskIds.contains(id)
        }
        .map(\.request.identifier)

    if !idsToRemove.isEmpty {
        center.removeDeliveredNotifications(withIdentifiers: idsToRemove)
    }
    return idsToRemove.count
}

extension NotificationActionRunner.Action {
    /// Map a response's `actionIdentifier`: the body tap is
    /// `UNNotificationDefaultActionIdentifier`, anything else is a button.
    init(actionIdentifier: String) {
        self = actionIdentifier == UNNotificationDefaultActionIdentifier ? .bodyTap : .button(actionIdentifier)
    }
}

extension NotificationActionRunner {
    /// A notification action as the phone, Mac and Watch app delegates handle
    /// it: `perform` against the real API, plus the delivered banners around
    /// it. The content extension calls `perform` itself — its banner goes
    /// with its own `.dismiss`/`.doNotDismiss` answer, not by identifier.
    ///
    /// Banner rules (the same on every device):
    /// - summary, or task with a `taskId`: its own banner goes BEFORE the call
    ///   (belt-and-suspenders — the action was taken, whatever the server says).
    /// - slot "Complete all": its banner goes only when something was
    ///   completed. Nothing completed means the slot's reminders are still
    ///   waiting, so it stays.
    /// - body tap: every delivered banner goes for a summary or task (the user
    ///   is opening the app to deal with them); only its own for a slot.
    /// - after a sweep, the moved tiers' banners (`dismissNotificationsAfterSweep`).
    ///
    /// The caller still owns navigation, haptics, error reporting, the badge
    /// and its completion handler.
    static func handle(_ response: UNNotificationResponse) async throws -> Outcome {
        let request = response.notification.request
        let category = request.content.categoryIdentifier
        let userInfo = request.content.userInfo
        let center = UNUserNotificationCenter.current()
        let ownBanner = [request.identifier]

        let isSlot = category == NotificationCategory.slotReminder
        let isSummary = category == NotificationCategory.taskSummary
        if isSummary || (!isSlot && userInfo["taskId"] as? Int != nil) {
            center.removeDeliveredNotifications(withIdentifiers: ownBanner)
        }

        let outcome = try await perform(
            category: category,
            action: Action(actionIdentifier: response.actionIdentifier),
            userInfo: userInfo,
            customDueAt: nil,
            api: APIClient.shared,
            dismissAfterSweep: dismissNotificationsAfterSweep
        )

        switch outcome {
        case .slotCompleted(let affected) where affected > 0:
            center.removeDeliveredNotifications(withIdentifiers: ownBanner)
        case .openDashboard where isSlot:
            center.removeDeliveredNotifications(withIdentifiers: ownBanner)
        case .openDashboard, .openTask:
            center.removeAllDeliveredNotifications()
        default:
            break
        }
        return outcome
    }
}

/// Set the app icon badge (iOS) or the Dock tile badge (macOS) — same call,
/// same meaning. watchOS has no app icon badge, so neither badge function
/// exists there.
#if os(iOS) || os(macOS)
func updateBadge(_ count: Int) {
    UNUserNotificationCenter.current().setBadgeCount(max(0, count))
}

/// Set the badge to the server's overdue count — the Tasks page's red pill,
/// from `GET /api/tasks/counts` (the same `countTasks` the pill uses).
///
/// Called when the app comes to the foreground, and after a notification
/// action or a Mac menu sweep. The server also sends a badge-only push after
/// every change (an alert-type push with just `aps.badge`, which iOS/macOS
/// apply without waking the app), so this is the local half: the moment the
/// user is in the app, or has just acted on a notification, the badge is the
/// real number rather than a guess. (Before 2026-09-29 the actions guessed —
/// "the payload's count minus one" — from a payload count that was never the
/// badge total, and activation zeroed the badge outright.)
///
/// A failed fetch leaves the badge alone; it never zeroes it.
func refreshBadgeFromServer() async {
    guard APIClient.shared.isConfigured,
          let counts = try? await APIClient.shared.fetchTaskCounts() else { return }
    updateBadge(counts.overdue)
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
