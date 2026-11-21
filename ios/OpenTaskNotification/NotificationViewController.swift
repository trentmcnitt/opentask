import UIKit
import SwiftUI
import UserNotifications
import UserNotificationsUI

/// Notification Content Extension — displays the interactive snooze grid
/// when the user long-presses a task notification.
///
/// Handles three notification categories:
/// - **TASK_REMINDER**: the overdue checklist (2026-11-21, `OverdueChecklist`,
///   TNC-1…9) over the grid — the pressed task first and checked, the user's
///   other overdue tasks under it; Done and every time act on the checked
///   set. The grid counts from the task's own time.
/// - **TASK_SUMMARY**: the same checklist with no held row and nothing
///   checked; "All → Next period" (the sweep) while nothing is. The grid
///   counts from now.
/// - **SLOT_REMINDER**: a §6 time slot — shows the batch checklist instead of the
///   grid (see `ReminderChecklistView`), committed with one bulk request.
///
/// Communication flow:
/// 1. User long-presses notification → iOS calls didReceive(_:) with payload
/// 2. User taps grid button / checklist row → the staged state updates the action
///    buttons via extensionContext (staging only — a SwiftUI button NEVER commits)
/// 3. User taps action button → didReceive(_:completionHandler:) fires API call
/// 4. API call succeeds → notification dismissed; on failure `.doNotDismiss`, so a
///    failed action leaves the notification standing rather than pretending.
///    The checklist's "Complete N checked" is the exception: with rows still
///    waiting in the period it reloads in place and stays (`commitSlotChecklist`)
class NotificationViewController: UIViewController, UNNotificationContentExtension {

    /// Typed as the base class because the root view differs by category
    /// (snooze grid vs. reminder checklist); only `view` is used from here.
    private var hostingController: UIViewController?

    /// The grid's base: the held task's own time, or now on a summary (TNC-9).
    private var dueAt: String = ""
    /// The time picked in the grid, for the checked set; nil = none picked.
    private var selectedDueAt: String?
    private var hasReceivedInitialNotification = false

    /// True when displaying a TASK_SUMMARY notification (no held task).
    private var isBulkMode = false

    /// The overdue checklist (TASK_REMINDER and TASK_SUMMARY).
    private var overdueModel: OverdueChecklistModel?

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
        overdueModel = nil
        selectedDueAt = nil

        // Staged check-marks are discarded with the view: an unseen checklist
        // must never commit rows the user staged in a previous expansion —
        // the overdue checklist's checks included (`overdueModel`, above).
        // The next expansion's `didReceive` rebuilds the view and its action
        // list from scratch.
        isSlotMode = false
        slotId = -1
        checklistModel = nil
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

        presentOverdueChecklist(userInfo: userInfo, title: title)
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
    ///
    /// The period checklist commits its own staging (`commitSlotChecklist`);
    /// a task notification and a summary commit the overdue checklist
    /// (`commitOverdueChecklist`). Neither is forwarded to the app: the
    /// extension made the call, and `.dismissAndForwardAction` would make the
    /// AppDelegate run it a second time.
    func didReceive(
        _ response: UNNotificationResponse,
        completionHandler completion: @escaping (UNNotificationContentExtensionResponseOption) -> Void
    ) {
        if isSlotMode {
            commitSlotChecklist(response, completion: completion)
            return
        }
        commitOverdueChecklist(response, completion: completion)
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

            // LEFTOVERS STAY REACHABLE (Trent, 2026-11-12: he checked the
            // rows shown, tapped "Complete N checked", and the banner went —
            // with "+4 more" still waiting and no way back to them: "it's a
            // confusing state… I'm tempted to not use that"). After a
            // "Complete checked" the checklist reloads IN PLACE with what
            // still waits in the period, and the notification stays until
            // nothing does. Only an empty period (or "Complete all", which
            // takes the whole period) dismisses. A reload that fails keeps
            // the banner too: the leftovers are unknown, and a body tap still
            // leads to them. The server agrees: its reconcile keeps a period
            // banner while anything in the period waits (`stale.ts`).
            if response.actionIdentifier == NotificationAction.completeChecked,
               let model = checklistModel {
                await reloadSlotChecklist(model)
                if case .loaded(let items) = model.state, items.isEmpty {
                    completion(.dismiss)
                } else {
                    completion(.doNotDismiss)
                }
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

    // MARK: - Overdue Checklist (2026-11-21, TNC-1…9)

    /// Build the overdue checklist for a task notification or a summary.
    ///
    /// The held row comes from the payload, checked, so Done and the times
    /// work at once (TNC-2); the user's other overdue tasks are fetched live
    /// and fill in under it (TNC-1). The grid below keeps #499's grid; it
    /// counts from the held task's own time, or from now on a summary (TNC-9).
    private func presentOverdueChecklist(userInfo: [AnyHashable: Any], title: String) {
        let state: OverdueChecklist.State
        let gridMode: SnoozeMode
        if !isBulkMode, let taskId = userInfo["taskId"] as? Int {
            let taskDueAt = userInfo["dueAt"] as? String ?? ""
            dueAt = taskDueAt
            state = .held(OverdueChecklist.Row(
                id: taskId, title: title, priority: userInfo["priority"] as? Int ?? 0,
                dueAt: taskDueAt.isEmpty ? nil : taskDueAt
            ))
            gridMode = .individual(taskTitle: title, originalDueAt: taskDueAt)
        } else {
            dueAt = DateHelpers.formatISO(Date())
            state = .summary()
            gridMode = .bulk(taskCount: 0)
        }

        let model = OverdueChecklistModel(state)
        model.onChange = { [weak self] in
            self?.setChecklistActions()
            self?.updatePreferredContentSize()
        }
        overdueModel = model

        let onDirty: (Bool) -> Void = { [weak self] isDirty in
            if !isDirty {
                self?.selectedDueAt = nil
                self?.setChecklistActions()
            }
            self?.updatePreferredContentSize()
        }
        install(hosting: UIHostingController(rootView: OverdueLongPressView(
            model: model,
            gridMode: gridMode,
            onGridSelection: { [weak self] newDueAt in self?.handleGridSelection(newDueAt) },
            onDirtyStateChanged: onDirty
        )))
        setChecklistActions()

        Task { await reloadOverdueChecklist(model) }
    }

    /// Fetch the overdue list into the checklist (on open, and to recover
    /// from a refused batch or a re-check that left nothing to send). A
    /// failure keeps whatever is drawn; the held row still works alone.
    private func reloadOverdueChecklist(_ model: OverdueChecklistModel) async {
        do {
            let tasks = try await APIClient.shared.fetchOverdueTasks()
            model.update { $0.apply(fetched: tasks) }
        } catch {
            print("[OpenTask] Overdue checklist load error: \(error)")
            model.update { $0.fetchFailed() }
        }
    }

    /// The action list for what is on screen (`OverdueChecklist.actions`):
    /// the checked set's rows, "(N)" from two up, Cancel last.
    private func setChecklistActions() {
        guard let model = overdueModel else { return }
        extensionContext?.notificationActions = notificationActions(
            OverdueChecklist.actions(
                for: model.state, picked: selectedDueAt.flatMap(DateHelpers.parseISO),
                now: Date(), slots: TimeSlotStore.cachedSlots
            )
        )
    }

    /// Commit the checked set in ONE request (TNC-4), after the re-check
    /// (TNC-6); Cancel closes and removes this banner (TNC-8).
    ///
    /// As the period checklist does, anything short of the server acting
    /// keeps the view open (`.doNotDismiss`): a failure must never look like
    /// a success. After a success the banners of the tasks acted on go
    /// (TNC-7). This notification's own banner goes with them when its task
    /// was one of them; when it was unchecked, the view closes WITHOUT
    /// dismissing it (`dismissNotificationContentExtension`), so the banner
    /// stays — to confirm on a device.
    private func commitOverdueChecklist(
        _ response: UNNotificationResponse,
        completion: @escaping (UNNotificationContentExtensionResponseOption) -> Void
    ) {
        let content = response.notification.request.content
        guard response.actionIdentifier != UNNotificationDefaultActionIdentifier, let model = overdueModel else {
            // A body tap: nothing was committed here, and it is not forwarded
            // (as before the checklist).
            completion(.dismiss)
            return
        }
        let intent = OverdueChecklist.intent(
            for: response.actionIdentifier, picked: selectedDueAt.flatMap(DateHelpers.parseISO),
            now: Date(), slots: TimeSlotStore.cachedSlots
        )
        Task {
            switch intent {
            case .none:
                completion(.doNotDismiss)

            case .cancel:
                UNUserNotificationCenter.current().removeDeliveredNotifications(
                    withIdentifiers: [response.notification.request.identifier]
                )
                completion(.dismiss)

            case .sweep:
                // "All → Next period" on a summary with nothing checked: the
                // ordinary sweep, which clears the moved tasks' banners.
                do {
                    _ = try await NotificationActionRunner.perform(
                        category: content.categoryIdentifier,
                        action: .button(response.actionIdentifier),
                        userInfo: content.userInfo,
                        customDueAt: nil,
                        api: APIClient.shared,
                        dismissAfterSweep: dismissNotificationsAfterSweep
                    )
                    completion(.dismiss)
                } catch {
                    print("[OpenTask] Overdue checklist sweep error: \(error)")
                    completion(.doNotDismiss)
                }

            case .complete, .snooze:
                await commitChecked(intent, model: model, completion: completion)
            }
        }
    }

    private func commitChecked(
        _ intent: OverdueChecklist.Intent,
        model: OverdueChecklistModel,
        completion: @escaping (UNNotificationContentExtensionResponseOption) -> Void
    ) async {
        let checked = model.state.checkedRows
        guard !checked.isEmpty else {
            completion(.doNotDismiss)
            return
        }
        do {
            // TNC-6: only rows still overdue at the time the list showed.
            let current = try await APIClient.shared.fetchOverdueTasks()
            let ids = OverdueChecklist.toSend(checked: checked, current: current)
            guard !ids.isEmpty else {
                model.update { $0.apply(fetched: current) }
                completion(.doNotDismiss)
                return
            }

            let acted: [Int]
            switch intent {
            case .complete:
                _ = try await APIClient.shared.completeTasks(ids: ids)
                acted = ids
                _ = await removeDeliveredNotifications(
                    forTaskIds: OverdueChecklist.bannersToClear(completed: ids)
                )
            case .snooze(let until):
                let result = try await APIClient.shared.bulkSnoozeTasks(
                    ids: ids, until: DateHelpers.formatISO(until), includeTaskIds: ids, capAtDeadlineIds: ids
                )
                acted = result.movedIds ?? ids
                _ = await removeDeliveredNotifications(
                    forTaskIds: OverdueChecklist.bannersToClear(snoozed: result)
                )
            default:
                completion(.doNotDismiss)
                return
            }

            if OverdueChecklist.removesOwnBanner(intent: intent, heldId: model.state.heldId, acted: acted) {
                completion(.dismiss)
            } else {
                completion(.doNotDismiss)
                extensionContext?.dismissNotificationContentExtension()
            }
        } catch {
            print("[OpenTask] Overdue checklist commit error: \(error)")
            // A refused batch (4xx: a sent id was done or deleted between the
            // re-check and the request): reload, keep what is still checked.
            if case APIError.serverError(let code) = error, (400..<500).contains(code) {
                await reloadOverdueChecklist(model)
            }
            completion(.doNotDismiss)
        }
    }

    // MARK: - Grid Selection Handler (see also `SizingHost` below)

    /// Called when the user taps a grid button: the action list names the
    /// picked time for the checked set (TNC-9). Back at the grid's own base
    /// (e.g. +1hr then -1hr), the list goes back to its named rows.
    private func handleGridSelection(_ newDueAt: String) {
        selectedDueAt = newDueAt
        if let base = DateHelpers.parseISO(dueAt), let picked = DateHelpers.parseISO(newDueAt),
           Int(picked.timeIntervalSince(base) / 60) == 0 {
            selectedDueAt = nil
        }
        setChecklistActions()
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
