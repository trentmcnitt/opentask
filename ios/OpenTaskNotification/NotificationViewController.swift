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
        // Content taller than the granted height clips at the bottom rather
        // than drawing past the extension's bounds (see `install(hosting:)`).
        view.clipsToBounds = true
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

    /// Pin a SwiftUI hosting controller to the extension's top and sides.
    ///
    /// The BOTTOM pin is deliberately below required priority (2026-09-24,
    /// the grouped-checklist overlap): a required top+bottom pin forces the
    /// SwiftUI view to exactly the extension's CURRENT height, and whenever
    /// that lagged the content — the live fetch landing, a stacked/grouped
    /// notification expanding at a different width, large Dynamic Type —
    /// SwiftUI compressed the checklist and its rows drew over each other.
    /// Now the hosting view keeps its own (intrinsic) height and the
    /// extension's frame follows `preferredContentSize`; a transient
    /// mismatch clips at the bottom instead of overlapping.
    private func install(hosting: UIViewController) {
        hosting.view.translatesAutoresizingMaskIntoConstraints = false
        hosting.view.backgroundColor = .clear
        if let swiftUIHost = hosting as? any SizingHost {
            swiftUIHost.enableContentSizing()
        }

        addChild(hosting)
        view.addSubview(hosting.view)
        hosting.didMove(toParent: self)

        let bottom = hosting.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        // Just BELOW the hosting view's default vertical content hugging
        // (250): if iOS grants MORE height than the content needs, the view
        // keeps its content height pinned to the top instead of stretching
        // (which would centre the fixed-size checklist with gaps).
        bottom.priority = UILayoutPriority(UILayoutPriority.defaultLow.rawValue - 1)
        NSLayoutConstraint.activate([
            hosting.view.topAnchor.constraint(equalTo: view.topAnchor),
            hosting.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            hosting.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bottom,
        ])

        hostingController = hosting
    }

    /// The hosting controller reports a new ideal size whenever its SwiftUI
    /// content changes (`sizingOptions` includes `.preferredContentSize`) —
    /// re-measure then, rather than only when a caller remembers to.
    override func preferredContentSizeDidChange(forChildContentContainer container: UIContentContainer) {
        super.preferredContentSizeDidChange(forChildContentContainer: container)
        updatePreferredContentSize()
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
        model.onStagedChange = { [weak self] count in
            self?.setSlotActions(stagedCount: count)
            self?.updatePreferredContentSize()
        }
        checklistModel = model

        install(hosting: UIHostingController(rootView: ReminderChecklistView(model: model)))
        setSlotActions(stagedCount: 0)

        Task { await reloadSlotChecklist(model) }
    }

    /// Fetch the slot's live group into the checklist: its reminders, then
    /// its waiting quota prompts (2026-09-25 — the web's and the widgets'
    /// order), dropping staged rows that are gone. Also the recovery after a
    /// refused commit (a stale prompt key after midnight).
    private func reloadSlotChecklist(_ model: ReminderChecklistModel) async {
        do {
            let group = try await APIClient.shared.fetchSlotGroup(slotId: slotId)
            let items = (group?.reminders ?? []).map(ChecklistItem.reminder)
                + (group?.waitingPrompts ?? []).map(ChecklistItem.prompt)
            model.state = .loaded(items)
            model.pruneStaged()
        } catch {
            print("[OpenTask] Slot checklist load error: \(error)")
            model.state = .failed("Couldn\u{2019}t load this slot")
        }
        setSlotActions(stagedCount: model.staged.count)
        updatePreferredContentSize()
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
                        if let slot = NotificationAction.parseSnoozeAllSlot(response.actionIdentifier) {
                            let result = try await APIClient.shared.snoozeOverdue(slot: slot)
                            wasBulkSnooze = result.tasksAffected > 0
                            updateBadge(result.skippedUrgent)
                        }
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
                        if let slot = NotificationAction.parseSnoozeAllSlot(response.actionIdentifier) {
                            let result = try await APIClient.shared.snoozeOverdue(slot: slot, includeTaskId: taskId)
                            wasBulkSnooze = result.tasksAffected > 0
                            updateBadge(result.skippedUrgent)
                        }
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
                    // Reminders AND quota prompts (2026-09-24), in ONE
                    // request — one transaction, one undo entry. `affected`
                    // counts both, so a prompts-only commit still dismisses.
                    let ids = checklistModel?.stagedReminderIds ?? []
                    let prompts = checklistModel?.stagedPrompts ?? []
                    guard !ids.isEmpty || !prompts.isEmpty else {
                        completion(.doNotDismiss)
                        return
                    }
                    affected = try await APIClient.shared.completeTasks(ids: ids, prompts: prompts).total

                case NotificationAction.completeAll:
                    // Reminders completed + waiting prompts CONSIDERED —
                    // except any the user staged as DID IT here first, which
                    // keep their +1 (`completeSlotReminders`' doc).
                    let didKeys = Set((checklistModel?.stagedPrompts ?? []).filter(\.did).map(\.key))
                    affected = try await APIClient.shared.completeSlotReminders(slotId: slotId, didKeys: didKeys)

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
                // A refused batch (4xx) is almost always a prompt key from
                // before midnight — the server refuses another day's key, and
                // the WHOLE batch with it. Retrying the same staging would
                // fail forever, so reload today's slot and drop staged rows
                // that no longer exist (quota reminders, 2026-09-25); the user
                // re-checks and commits again.
                if case APIError.serverError(let code) = error, (400..<500).contains(code),
                   let model = checklistModel {
                    await reloadSlotChecklist(model)
                }
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
    /// so the notification extension expands to fit its content.
    ///
    /// THREE THINGS THIS HAS TO GET RIGHT:
    ///
    /// 1. MEASURE AFTER SwiftUI HAS LAID OUT. Every caller runs at the moment
    ///    the model changes — the slot checklist's live fetch resolving, a grid
    ///    selection — but SwiftUI does not rebuild until the next layout pass.
    ///    Measuring first returns the height of the PREVIOUS content (for the
    ///    checklist, the little "loading" state), so iOS reserves too little
    ///    room and the expanded checklist draws over the notifications stacked
    ///    below it. So this also re-runs from `preferredContentSizeDidChange`,
    ///    which the hosting controller fires AFTER SwiftUI has rebuilt.
    ///
    /// 2. DON'T MEASURE A ZERO-WIDTH VIEW. `didReceive` can run before the
    ///    extension's view has bounds; a fitting size against width 0 is
    ///    meaningless. `viewDidLayoutSubviews` re-runs this once bounds are
    ///    real, which is also what makes the initial render correct — until now
    ///    nothing sized the view except user interaction.
    ///
    /// 3. (2026-09-24) ASK SwiftUI, DON'T REVERSE-ENGINEER AUTO LAYOUT. The
    ///    height used to come from `systemLayoutSizeFitting` on the hosting
    ///    view — which, with the view pinned top AND bottom to the extension,
    ///    reflected the constraints as much as the content, and under-reported
    ///    a tall checklist (wrapped rows, XXX Large text, a grouped
    ///    notification's expansion): the rows then overlapped. It is now the
    ///    hosting controller's own `sizeThatFits(in:)` — SwiftUI's ideal
    ///    height for the content at this exact width, unbounded vertically.
    private func updatePreferredContentSize() {
        guard let hosting = hostingController as? any SizingHost else { return }
        let width = view.bounds.width
        guard width > 0 else { return }

        let fittingHeight = hosting.idealHeight(forWidth: width)

        // Assigning preferredContentSize triggers a layout pass, and this is
        // called FROM one — without this guard the two feed each other.
        let newSize = CGSize(width: width, height: ceil(fittingHeight))
        guard abs(newSize.height - preferredContentSize.height) > 0.5
            || abs(newSize.width - preferredContentSize.width) > 0.5
        else { return }

        preferredContentSize = newSize
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        updatePreferredContentSize()
    }

    // MARK: - Grid Selection Handler (see also `SizingHost` below)

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
    ///
    /// Slot-snooze actions (from `TimeSlotStore`'s cache — the extension never
    /// fetches on its own, see `TimeSlotStore.swift`) are appended after the
    /// default +1hr actions using the same `slotSnoozeActions()` builder
    /// `registerNotificationCategories()` uses, so the identifiers, ordering
    /// and "All → …" titles never drift between the lock-screen category and
    /// this expanded view.
    private func setDefaultTimeActions() {
        let nextHour = DateHelpers.snapToNextHour()
        let timeLabel = DateHelpers.formatShortTime(nextHour)
        let slotActions = slotSnoozeActions()

        if isBulkMode {
            extensionContext?.notificationActions = [
                UNNotificationAction(identifier: NotificationAction.snoozeAll1hr, title: "All \u{2192} \(timeLabel)", options: []),
            ] + slotActions
        } else {
            extensionContext?.notificationActions = [
                UNNotificationAction(identifier: NotificationAction.done, title: "Done", options: []),
                UNNotificationAction(identifier: NotificationAction.snooze1hr, title: timeLabel, options: []),
                UNNotificationAction(identifier: NotificationAction.snoozeAll1hr, title: "All \u{2192} \(timeLabel)", options: []),
            ] + slotActions
        }
    }
}

/// The two things `NotificationViewController` needs from its SwiftUI host,
/// whatever its root view type (snooze grid or checklist): content-driven
/// sizing, and SwiftUI's ideal height at a given width.
protocol SizingHost: UIViewController {
    func enableContentSizing()
    func idealHeight(forWidth width: CGFloat) -> CGFloat
}

extension UIHostingController: SizingHost {
    /// `.intrinsicContentSize` so the hosting view keeps its content's height
    /// when the bottom pin yields; `.preferredContentSize` so SwiftUI tells
    /// the parent when that height changes (`preferredContentSizeDidChange`).
    func enableContentSizing() {
        sizingOptions = [.intrinsicContentSize, .preferredContentSize]
    }

    func idealHeight(forWidth width: CGFloat) -> CGFloat {
        sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude)).height
    }
}
