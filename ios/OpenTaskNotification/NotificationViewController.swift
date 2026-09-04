import UIKit
import SwiftUI
import UserNotifications
import UserNotificationsUI

/// Notification Content Extension — displays the interactive snooze grid
/// when the user long-presses a task notification.
///
/// Handles three notification categories:
/// - **TASK_REMINDER**: individual task — grid uses the task's dueAt as the base time,
///   action buttons include Done, single-task snooze, and bulk snooze.
/// - **TASK_SUMMARY**: overflow summary — grid uses "now" as the base time,
///   action buttons are bulk-only (no Done or single-task snooze).
/// - **SLOT_REMINDER**: a §6 time slot — shows the batch checklist instead of the
///   grid (see `ReminderChecklistView`), committed with one bulk request.
///
/// Communication flow:
/// 1. User long-presses notification → iOS calls didReceive(_:) with payload
/// 2. User taps grid button / checklist row → the staged state updates the action
///    buttons via extensionContext (staging only — a SwiftUI button NEVER commits)
/// 3. User taps action button → didReceive(_:completionHandler:) fires API call
/// 4. API call succeeds → notification dismissed; on failure `.doNotDismiss`, so a
///    failed action leaves the notification standing rather than pretending
class NotificationViewController: UIViewController, UNNotificationContentExtension {

    /// Typed as the base class because the root view differs by category
    /// (snooze grid vs. reminder checklist); only `view` is used from here.
    private var hostingController: UIViewController?

    // Task data from APNs payload
    private var taskId: Int = 0
    private var dueAt: String = ""
    private var overdueCount: Int?
    private var selectedDueAt: String?
    private var selectedDeltaMinutes: Int?
    private var hasReceivedInitialNotification = false

    /// True when displaying a TASK_SUMMARY notification (bulk-only actions, no taskId).
    private var isBulkMode = false

    // §6.1 batch checklist state
    /// True when displaying a SLOT_REMINDER notification (checklist, not grid).
    private var isSlotMode = false
    /// `time_slots.id` from the payload; -1 is the un-slotted "Anytime" group.
    private var slotId = -1
    private var checklistModel: ReminderChecklistModel?

    // MARK: - Lifecycle

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        // Reset state so the next long-press rebuilds the grid and action buttons fresh.
        // iOS reuses the extension instance for the same notification, so without this
        // the custom action buttons (e.g., "+3hr") persist even though the grid resets.
        hasReceivedInitialNotification = false
        isBulkMode = false
        selectedDueAt = nil
        selectedDeltaMinutes = nil

        // Staged check-marks are discarded with the view: an unseen checklist
        // must never commit rows the user staged in a previous expansion.
        let wasSlotMode = isSlotMode
        isSlotMode = false
        slotId = -1
        checklistModel = nil

        if !wasSlotMode { setDefaultTimeActions() }
    }

    // MARK: - UNNotificationContentExtension

    /// Called when the notification is expanded (long-press) and again for each
    /// subsequent notification that arrives while the extension is visible.
    /// We lock to the first notification so the UI stays stable while the user
    /// is interacting with it — a burst of incoming notifications must not
    /// swap the task out from under them.
    func didReceive(_ notification: UNNotification) {
        if hasReceivedInitialNotification { return }
        hasReceivedInitialNotification = true

        let userInfo = notification.request.content.userInfo
        let title = notification.request.content.title
        let categoryId = notification.request.content.categoryIdentifier

        isBulkMode = categoryId == NotificationCategory.taskSummary
        isSlotMode = categoryId == NotificationCategory.slotReminder

        // Remove existing hosting controller if re-receiving
        hostingController?.view.removeFromSuperview()
        hostingController?.removeFromParent()

        if isSlotMode {
            presentSlotChecklist(userInfo: userInfo, fallbackTitle: title)
            return
        }

        let mode: SnoozeMode
        if isBulkMode {
            let overflowCount = userInfo["overflowCount"] as? Int ?? 0
            let totalOverdueCount = userInfo["totalOverdueCount"] as? Int ?? overflowCount
            mode = .bulk(taskCount: totalOverdueCount)
            // Use "now" as the base time for bulk mode (no single task's dueAt)
            dueAt = DateHelpers.formatISO(Date())
        } else {
            taskId = userInfo["taskId"] as? Int ?? 0
            dueAt = userInfo["dueAt"] as? String ?? ""
            overdueCount = userInfo["overdueCount"] as? Int
            mode = .individual(taskTitle: title, originalDueAt: dueAt)
        }

        let gridView = SnoozeGridView(
            mode: mode,
            onGridSelection: { [weak self] newDueAt in
                self?.handleGridSelection(newDueAt)
            },
            onDirtyStateChanged: { [weak self] isDirty in
                self?.updatePreferredContentSize()
                if !isDirty {
                    self?.selectedDueAt = nil
                    self?.selectedDeltaMinutes = nil
                    self?.setDefaultTimeActions()
                }
            }
        )

        install(hosting: UIHostingController(rootView: gridView))

        // Set initial action buttons with absolute time (e.g., "4:00 PM" instead of "+1hr")
        setDefaultTimeActions()
    }

    /// Pin a SwiftUI hosting controller to the extension's full bounds.
    private func install(hosting: UIViewController) {
        hosting.view.translatesAutoresizingMaskIntoConstraints = false
        hosting.view.backgroundColor = .clear

        addChild(hosting)
        view.addSubview(hosting.view)
        hosting.didMove(toParent: self)

        NSLayoutConstraint.activate([
            hosting.view.topAnchor.constraint(equalTo: view.topAnchor),
            hosting.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            hosting.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            hosting.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])

        hostingController = hosting
    }

    // MARK: - Slot Checklist (§6.1)

    /// Build the batch checklist for a SLOT_REMINDER notification.
    ///
    /// The push carries only the slot's identity and a count — the item list is
    /// fetched live here, because between "slot opened" and "user long-pressed"
    /// the set can change, and a checklist that completes a stale row is the
    /// exact failure this surface exists to avoid.
    private func presentSlotChecklist(userInfo: [AnyHashable: Any], fallbackTitle: String) {
        slotId = userInfo[SlotReminderKey.slotId] as? Int ?? -1
        let label = userInfo[SlotReminderKey.slotLabel] as? String ?? fallbackTitle
        let expected = userInfo[SlotReminderKey.reminderCount] as? Int ?? 0

        let model = ReminderChecklistModel(slotLabel: label, expectedCount: expected)
        model.onStagedChange = { [weak self] ids in
            self?.setSlotActions(stagedCount: ids.count)
            self?.updatePreferredContentSize()
        }
        checklistModel = model

        install(hosting: UIHostingController(rootView: ReminderChecklistView(model: model)))
        setSlotActions(stagedCount: 0)

        Task {
            do {
                let items = try await APIClient.shared.fetchSlotReminders(slotId: slotId)
                model.state = .loaded(items)
                model.pruneStagedIds()
            } catch {
                print("[OpenTask] Slot checklist load error: \(error)")
                model.state = .failed("Couldn\u{2019}t load this slot")
            }
            setSlotActions(stagedCount: model.checkedIds.count)
            updatePreferredContentSize()
        }
    }

    /// Action buttons for the checklist.
    ///
    /// "Complete checked" only appears once something is staged — an action
    /// button that can only no-op is worse than no button. "Complete all"
    /// always appears and acts on the whole slot, including rows past the
    /// visible cap.
    private func setSlotActions(stagedCount: Int) {
        var actions: [UNNotificationAction] = []

        if stagedCount > 0 {
            actions.append(
                UNNotificationAction(
                    identifier: NotificationAction.completeChecked,
                    title: "Complete \(stagedCount) checked",
                    options: []
                )
            )
        }

        if case .loaded(let items) = checklistModel?.state, items.isEmpty {
            // Nothing to act on — leave only whatever is staged (nothing).
            extensionContext?.notificationActions = actions
            return
        }

        actions.append(
            UNNotificationAction(
                identifier: NotificationAction.completeAll,
                title: "Complete all",
                options: []
            )
        )
        extensionContext?.notificationActions = actions
    }

    /// Called when the user taps an action button while the extension is visible.
    /// Fires the API call and dismisses the notification.
    func didReceive(
        _ response: UNNotificationResponse,
        completionHandler completion: @escaping (UNNotificationContentExtensionResponseOption) -> Void
    ) {
        if isSlotMode {
            commitSlotChecklist(response, completion: completion)
            return
        }

        Task {
            var wasBulkSnooze = false

            do {
                if isBulkMode {
                    // Bulk mode: all actions are bulk snooze (no Done or single-task snooze)
                    switch response.actionIdentifier {
                    case NotificationAction.snoozeAll1hr:
                        let result = try await APIClient.shared.snoozeOverdue(deltaMinutes: 60)
                        wasBulkSnooze = result.tasksAffected > 0
                        updateBadge(result.skippedUrgent)

                    case NotificationAction.snoozeAllCustom:
                        if let dueAt = selectedDueAt {
                            let result = try await APIClient.shared.snoozeOverdue(until: dueAt)
                            wasBulkSnooze = result.tasksAffected > 0
                            updateBadge(result.skippedUrgent)
                        }

                    default:
                        break
                    }
                } else {
                    // Individual mode: task-specific + bulk actions
                    switch response.actionIdentifier {
                    case NotificationAction.done:
                        try await APIClient.shared.markDone(taskId: taskId)
                        if let count = overdueCount { updateBadge(count - 1) }

                    case NotificationAction.snooze1hr:
                        try await APIClient.shared.snoozeNextHour(taskId: taskId)
                        if let count = overdueCount { updateBadge(count - 1) }

                    case NotificationAction.snoozeAll1hr:
                        let result = try await APIClient.shared.snoozeOverdue(deltaMinutes: 60, includeTaskId: taskId)
                        wasBulkSnooze = result.tasksAffected > 0
                        updateBadge(result.skippedUrgent)

                    case NotificationAction.snoozeCustom:
                        if let dueAt = selectedDueAt {
                            try await APIClient.shared.snoozeTo(taskId: taskId, dueAt: dueAt)
                            if let count = overdueCount { updateBadge(count - 1) }
                        }

                    case NotificationAction.snoozeAllCustom:
                        if let dueAt = selectedDueAt {
                            let result = try await APIClient.shared.snoozeOverdue(until: dueAt, includeTaskId: taskId)
                            wasBulkSnooze = result.tasksAffected > 0
                            updateBadge(result.skippedUrgent)
                        }

                    default:
                        break
                    }
                }
            } catch {
                print("[OpenTask] Content extension action error: \(error)")
                // Keep notification visible so the user knows it failed
                completion(.doNotDismiss)
                return
            }

            // After bulk snooze, dismiss notifications for the tasks that were snoozed.
            // P3 (High) and P4 (Urgent) are never bulk-snoozed, so those remain.
            if wasBulkSnooze {
                await dismissNotifications(atOrBelowPriority: bulkSnoozeMaxPriority)
            }

            // Dismiss only — the extension already handled the action via API call.
            // Using .dismissAndForwardAction would cause AppDelegate's didReceive to
            // fire the same API call again (double action).
            completion(.dismiss)
        }
    }

    /// Commit the staged checklist in ONE request (§6.1).
    ///
    /// Anything short of "the server completed something" keeps the
    /// notification on screen (`.doNotDismiss`) — dismissing on a failed or
    /// empty commit would tell the user their reminders were handled when they
    /// were not, which is the one lie this app cannot tell.
    private func commitSlotChecklist(
        _ response: UNNotificationResponse,
        completion: @escaping (UNNotificationContentExtensionResponseOption) -> Void
    ) {
        Task {
            do {
                let affected: Int

                switch response.actionIdentifier {
                case NotificationAction.completeChecked:
                    let ids = checklistModel?.checkedIds ?? []
                    guard !ids.isEmpty else {
                        completion(.doNotDismiss)
                        return
                    }
                    affected = try await APIClient.shared.completeTasks(ids: ids)

                case NotificationAction.completeAll:
                    affected = try await APIClient.shared.completeSlotReminders(slotId: slotId)

                case UNNotificationDefaultActionIdentifier:
                    // Body tap: nothing was committed here, so hand off to the
                    // app (AppDelegate opens the dashboard). Forwarding is safe
                    // precisely because this branch performed no API call.
                    completion(.dismissAndForwardAction)
                    return

                default:
                    completion(.dismiss)
                    return
                }

                guard affected > 0 else {
                    completion(.doNotDismiss)
                    return
                }
            } catch {
                print("[OpenTask] Slot checklist commit error: \(error)")
                completion(.doNotDismiss)
                return
            }

            // The extension already performed the action; forwarding it would
            // make AppDelegate run the same completion a second time.
            completion(.dismiss)
        }
    }

    // MARK: - Size Management

    /// Re-measure the SwiftUI hosting controller and update preferredContentSize
    /// so the notification extension expands to fit the resolved-time preview bar.
    private func updatePreferredContentSize() {
        guard let hosting = hostingController else { return }
        let targetSize = CGSize(width: view.bounds.width, height: UIView.layoutFittingCompressedSize.height)
        let fittingSize = hosting.view.systemLayoutSizeFitting(
            targetSize,
            withHorizontalFittingPriority: .required,
            verticalFittingPriority: .fittingSizeLevel
        )
        preferredContentSize = CGSize(width: view.bounds.width, height: fittingSize.height)
    }

    // MARK: - Grid Selection Handler

    /// Called when the user taps a grid button. Updates the action buttons to show
    /// the resolved absolute time. If the net change is zero (e.g., +1hr then -1hr),
    /// restores default action buttons.
    private func handleGridSelection(_ newDueAt: String) {
        selectedDueAt = newDueAt

        // Compute delta from base time to selected time
        guard let originalDate = DateHelpers.parseISO(dueAt),
              let targetDate = DateHelpers.parseISO(newDueAt)
        else { return }

        let deltaSeconds = targetDate.timeIntervalSince(originalDate)
        let deltaMinutes = Int(deltaSeconds / 60)
        selectedDeltaMinutes = deltaMinutes

        // Net-zero: user adjusted back to the original time — reset to defaults
        if deltaMinutes == 0 {
            selectedDueAt = nil
            selectedDeltaMinutes = nil
            setDefaultTimeActions()
            return
        }

        let timeLabel = DateHelpers.formatShortTime(targetDate)

        if isBulkMode {
            // Bulk mode: only bulk snooze action
            extensionContext?.notificationActions = [
                UNNotificationAction(identifier: NotificationAction.snoozeAllCustom, title: "All \u{2192} \(timeLabel)", options: []),
            ]
        } else {
            // Individual mode: Done, single snooze, bulk snooze
            extensionContext?.notificationActions = [
                UNNotificationAction(identifier: NotificationAction.done, title: "Done", options: []),
                UNNotificationAction(identifier: NotificationAction.snoozeCustom, title: timeLabel, options: []),
                UNNotificationAction(identifier: NotificationAction.snoozeAllCustom, title: "All \u{2192} \(timeLabel)", options: []),
            ]
        }
    }

    // MARK: - Default Actions

    /// Set action buttons showing the absolute "next hour" time (e.g., "4:00 PM").
    /// Called on initial notification expansion and when the grid resets to clean state.
    private func setDefaultTimeActions() {
        let nextHour = DateHelpers.snapToNextHour()
        let timeLabel = DateHelpers.formatShortTime(nextHour)

        if isBulkMode {
            extensionContext?.notificationActions = [
                UNNotificationAction(identifier: NotificationAction.snoozeAll1hr, title: "All \u{2192} \(timeLabel)", options: []),
            ]
        } else {
            extensionContext?.notificationActions = [
                UNNotificationAction(identifier: NotificationAction.done, title: "Done", options: []),
                UNNotificationAction(identifier: NotificationAction.snooze1hr, title: timeLabel, options: []),
                UNNotificationAction(identifier: NotificationAction.snoozeAll1hr, title: "All \u{2192} \(timeLabel)", options: []),
            ]
        }
    }
}
