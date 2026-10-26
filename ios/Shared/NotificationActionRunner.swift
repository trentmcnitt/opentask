import Foundation

/// The server calls a notification action button makes, in ONE place.
///
/// Four handlers answer the same buttons: the phone's `AppDelegate`, the
/// Mac's `MacAppDelegate`, the Watch's `WatchAppDelegate` and the phone's
/// notification content extension (`NotificationViewController`). They used
/// to carry four copies of this switch, and the copies drifted (which banners
/// a sweep cleared, whether a slot's banner went on a no-op "Complete all").
/// Now each one asks the runner which call to make and keeps only what really
/// differs per device: navigation (phone, Mac), haptics and error banners
/// (Watch), the badge (phone, Mac), the content extension's dismiss choice,
/// and calling its completion handler on every path.
///
/// What the runner decides, by category:
/// - `TASK_SUMMARY` (overflow summary, no taskId): "All +1hr", "All → <slot>"
///   and the content extension's "All → <custom time>" — bulk snoozes with NO
///   `include_task_ids`, since no single task was picked.
/// - `SLOT_REMINDER` (§6, the slot is the unit): "Complete all" completes the
///   slot's pending reminders (and considers its waiting quota prompts). The
///   content extension's staged checklist commit is NOT here — it is its own
///   request (`commitSlotChecklist`) and never reaches this runner.
/// - the deadlines-page nag (`kind: "deadlines"`, no category): a body tap
///   opens the deadlines page; it has no buttons.
/// - `REMINDER_NAG` (the named reminder push, 2026-10-26): one button,
///   Considered (the `DONE` identifier), which sends `done` with the
///   payload's `reminder_day` as `day`. The server answers
///   `considered: false` and changes nothing when that day is not today or
///   the reminder isn't waiting any more — still a success here
///   (`.reminderConsidered(considered: false)`), never an error. Its own case,
///   not a task notification: the task branch would honour +1hr, the sweeps
///   and Delete, which a reminder banner never offers. A body tap opens the
///   task (`.openTask`), which the web forwards to /reminders.
/// - anything else is a task notification and needs `taskId`: Done, +1hr,
///   the custom time, and the bulk snoozes — which pass the task as
///   `include_task_ids`, so the task whose banner was tapped moves even when
///   it is High (P3) and would otherwise be skipped. `TASK_ADDED` (the "AI
///   finished" notification) is one of these: it offers Done and Delete,
///   and Delete (`NotificationAction.delete`) is a task action too.
///
/// After a successful sweep the runner calls `dismissAfterSweep` with the
/// server's result — `dismissNotificationsAfterSweep` in production, which
/// clears the banners of exactly the tasks that moved (`moved_ids`). A thrown error
/// propagates untouched and nothing is dismissed.
///
/// Foundation-only on purpose (`OpenTaskLogicTests` leaves
/// `NotificationConstants.swift`, the UserNotifications half, out). The
/// UserNotifications wrapper that the three app delegates call — banner
/// removal around the call, the body-tap mapping — is
/// `NotificationActionRunner.handle(_:)` in `NotificationConstants.swift`.
enum NotificationActionRunner {

    /// The action that was taken. The body tap is its own case because its
    /// identifier (`UNNotificationDefaultActionIdentifier`) is a
    /// UserNotifications constant this file can't see; the caller maps it.
    enum Action: Equatable {
        /// The notification's body was tapped (no button).
        case bodyTap
        /// An action button, by its identifier (`NotificationAction`).
        case button(String)
    }

    enum Outcome: Equatable {
        /// Nothing was sent: an action this category doesn't offer, or a
        /// custom snooze with no time picked.
        case ignored
        /// A task notification with no `taskId` in its payload. Nothing sent,
        /// no banner touched, and the phone and Mac skip their badge refresh.
        case missingTaskId
        /// Done, Delete, +1hr or a custom time on the notification's own task.
        case taskUpdated(taskId: Int)
        /// A bulk snooze ran; `dismissAfterSweep` has already been called.
        case swept(APIClient.BulkSnoozeResult)
        /// "Complete all" on a §6 slot; how many the server completed. Zero
        /// means the slot's reminders are still waiting, so its banner stays.
        case slotCompleted(affected: Int)
        /// Considered on a named reminder push. `considered` is the server's
        /// answer: `false` means it changed nothing (another day's banner, or
        /// a reminder already considered elsewhere) — a success all the same.
        case reminderConsidered(taskId: Int, considered: Bool)
        /// Body tap on a summary or slot notification: open the dashboard.
        /// (Not /reminders for a slot: a slot push can arrive on a build
        /// older than the web /reminders route, and the dashboard is never a
        /// 404.)
        case openDashboard
        /// Body tap on a task notification: show that task — the phone and Mac
        /// load `DeepLinkRouter.notificationTaskPath`, which brings its row into
        /// view and selects it (no editor).
        case openTask(taskId: Int)
        /// Body tap on the deadlines-page nag (`kind: "deadlines"`, 2026-10-22):
        /// the phone and Mac load `DeepLinkRouter.notificationDeadlinesPath`,
        /// the dashboard with the task queue's Tasks card on the deadlines page.
        case openDeadlines
    }

    /// `kind` of the deadlines-page nag's payload (`DEADLINES_NAG_KIND`,
    /// src/core/notifications/apns.ts). It has no category, no `taskId` and
    /// no buttons, so only its body tap means anything.
    static let deadlinesKind = "deadlines"


    /// Make the server call for `action` on a notification of `category`.
    ///
    /// - Parameters:
    ///   - customDueAt: the time picked in the content extension's snooze grid,
    ///     for `SNOOZE_CUSTOM` / `SNOOZE_ALL_CUSTOM`. The app delegates pass
    ///     nil: those two actions are served by the extension, which calls the
    ///     API itself and dismisses without forwarding.
    ///   - dismissAfterSweep: called with the result of every successful bulk
    ///     snooze, before this returns.
    static func perform(
        category: String,
        action: Action,
        userInfo: [AnyHashable: Any],
        customDueAt: String?,
        api: NotificationActionAPI,
        dismissAfterSweep: (APIClient.BulkSnoozeResult) async -> Void
    ) async throws -> Outcome {
        switch category {
        case NotificationCategory.taskSummary:
            return try await performSummary(
                action: action, customDueAt: customDueAt, api: api, dismissAfterSweep: dismissAfterSweep
            )

        case NotificationCategory.slotReminder:
            switch action {
            case .bodyTap:
                return .openDashboard
            case .button(NotificationAction.completeAll):
                let slotId = userInfo[SlotReminderKey.slotId] as? Int ?? -1
                // Its prompts are only considered (no progress), but the batch
                // carries them, so it says where it came from.
                let affected = try await api.completeSlotReminders(
                    slotId: slotId, didKeys: [], source: ProgressSource.forNotificationActions
                )
                return .slotCompleted(affected: affected)
            case .button:
                return .ignored
            }

        case NotificationCategory.reminderNag:
            guard let taskId = userInfo["taskId"] as? Int else { return .missingTaskId }
            switch action {
            case .bodyTap:
                return .openTask(taskId: taskId)
            case .button(NotificationAction.done):
                // No day, no call: a plain done is exactly the stale advance
                // the day guard exists to prevent. Every REMINDER_NAG push
                // carries one.
                guard let day = userInfo[ReminderNagKey.day] as? String, !day.isEmpty else { return .ignored }
                let considered = try await api.markDone(taskId: taskId, day: day)
                return .reminderConsidered(taskId: taskId, considered: considered)
            case .button:
                return .ignored
            }

        default:
            // Before the taskId guard: the deadlines nag is about a page, not
            // a task. A build without this case ends at `.missingTaskId`, so
            // the app just comes forward where it was.
            if userInfo["kind"] as? String == deadlinesKind {
                return action == .bodyTap ? .openDeadlines : .ignored
            }
            guard let taskId = userInfo["taskId"] as? Int else { return .missingTaskId }
            return try await performTask(
                taskId: taskId,
                action: action,
                customDueAt: customDueAt,
                api: api,
                dismissAfterSweep: dismissAfterSweep
            )
        }
    }

    /// Summary notifications: bulk actions only, never `include_task_ids`.
    private static func performSummary(
        action: Action,
        customDueAt: String?,
        api: NotificationActionAPI,
        dismissAfterSweep: (APIClient.BulkSnoozeResult) async -> Void
    ) async throws -> Outcome {
        let result: APIClient.BulkSnoozeResult
        switch action {
        case .bodyTap:
            return .openDashboard
        case .button(NotificationAction.snoozeAll1hr):
            result = try await api.snoozeOverdue(deltaMinutes: 60, includeTaskId: nil)
        case .button(NotificationAction.snoozeAllCustom):
            guard let customDueAt else { return .ignored }
            result = try await api.snoozeOverdue(until: customDueAt, includeTaskId: nil)
        case .button(let identifier):
            guard let slot = NotificationAction.parseSnoozeAllSlot(identifier) else { return .ignored }
            result = try await api.snoozeOverdue(slot: slot, includeTaskId: nil)
        }
        await dismissAfterSweep(result)
        return .swept(result)
    }

    /// Task notifications: the task's own actions, and bulk snoozes that
    /// include it.
    private static func performTask(
        taskId: Int,
        action: Action,
        customDueAt: String?,
        api: NotificationActionAPI,
        dismissAfterSweep: (APIClient.BulkSnoozeResult) async -> Void
    ) async throws -> Outcome {
        let result: APIClient.BulkSnoozeResult
        switch action {
        case .bodyTap:
            return .openTask(taskId: taskId)
        case .button(NotificationAction.done):
            try await api.markDone(taskId: taskId)
            return .taskUpdated(taskId: taskId)
        case .button(NotificationAction.delete):
            try await api.deleteTask(taskId: taskId)
            return .taskUpdated(taskId: taskId)
        case .button(NotificationAction.snooze1hr):
            try await api.snoozeNextHour(taskId: taskId)
            return .taskUpdated(taskId: taskId)
        case .button(NotificationAction.snoozeCustom):
            guard let customDueAt else { return .ignored }
            try await api.snoozeTo(taskId: taskId, dueAt: customDueAt)
            return .taskUpdated(taskId: taskId)
        case .button(NotificationAction.snoozeAll1hr):
            result = try await api.snoozeOverdue(deltaMinutes: 60, includeTaskId: taskId)
        case .button(NotificationAction.snoozeAllCustom):
            guard let customDueAt else { return .ignored }
            result = try await api.snoozeOverdue(until: customDueAt, includeTaskId: taskId)
        case .button(let identifier):
            guard let slot = NotificationAction.parseSnoozeAllSlot(identifier) else { return .ignored }
            result = try await api.snoozeOverdue(slot: slot, includeTaskId: taskId)
        }
        await dismissAfterSweep(result)
        return .swept(result)
    }
}

/// The server calls a notification action can make — `APIClient`'s own
/// methods, behind a protocol so `NotificationActionRunnerTests` can record
/// them with a stub instead of hitting the network.
protocol NotificationActionAPI {
    func markDone(taskId: Int) async throws
    /// `done` for one OpenTask `day` (the named reminder push); returns the
    /// server's `considered`.
    func markDone(taskId: Int, day: String?) async throws -> Bool
    func deleteTask(taskId: Int) async throws
    func snoozeNextHour(taskId: Int) async throws
    func snoozeTo(taskId: Int, dueAt: String) async throws
    func snoozeOverdue(deltaMinutes: Int, includeTaskId: Int?) async throws -> APIClient.BulkSnoozeResult
    func snoozeOverdue(until: String, includeTaskId: Int?) async throws -> APIClient.BulkSnoozeResult
    func snoozeOverdue(slot: String, includeTaskId: Int?) async throws -> APIClient.BulkSnoozeResult
    func completeSlotReminders(slotId: Int, didKeys: Set<String>, source: ProgressSource?) async throws -> Int
}

/// The three sweep requirements are spelled out because `APIClient`'s own
/// methods take a trailing `notify:` (a defaulted parameter does not satisfy a
/// protocol requirement). A notification action never passes it: the server's
/// feedback push is how a sweep run from a notification reports what it left.
extension APIClient: NotificationActionAPI {
    func snoozeOverdue(deltaMinutes: Int, includeTaskId: Int?) async throws -> BulkSnoozeResult {
        try await snoozeOverdue(deltaMinutes: deltaMinutes, includeTaskId: includeTaskId, notify: nil)
    }

    func snoozeOverdue(until: String, includeTaskId: Int?) async throws -> BulkSnoozeResult {
        try await snoozeOverdue(until: until, includeTaskId: includeTaskId, notify: nil)
    }

    func snoozeOverdue(slot: String, includeTaskId: Int?) async throws -> BulkSnoozeResult {
        try await snoozeOverdue(slot: slot, includeTaskId: includeTaskId, notify: nil)
    }
}
