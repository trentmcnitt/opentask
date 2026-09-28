import AppKit
import Foundation

/// The menu bar item's data and actions (Trent, 2026-09-28: "a menu bar icon
/// that's persistently there … a little badge on it for things that are
/// overdue … click it to see what items are overdue … check them off, snooze
/// to next period, snooze 1 hour for each, or in bulk").
///
/// Tasks only — reminders and quotas have their own widgets. "Overdue" is
/// `TaskLists.overdue`, the same rule as the Tasks widget's Overdue page.
///
/// Freshness: one `GET /api/tasks` (the widgets' call) when the panel opens,
/// every `refreshInterval` while the app runs, on wake, after every action,
/// and when the server's silent `dismiss` push says a task changed elsewhere
/// (`MacAppDelegate`). The badge can therefore lag a change made elsewhere by
/// up to `refreshInterval` if no push arrives — cheap enough to poll, and the
/// panel always refetches as it opens.
@MainActor
final class MenuBarModel: ObservableObject {

    static let shared = MenuBarModel()

    /// How many overdue rows the panel lists before "and N more…".
    static let maxRows = 8
    /// How many "Next up" rows when nothing is overdue.
    static let maxNextUp = 5
    private static let refreshInterval: TimeInterval = 120

    @Published private(set) var tasks: [TaskDTO] = []
    @Published private(set) var slots: [TimeSlotDTO] = TimeSlotStore.cachedSlots
    @Published private(set) var hasLoaded = false
    @Published private(set) var errorText: String?
    /// Rows with an action in flight — drawn dimmed, buttons disabled.
    @Published private(set) var busyIds: Set<Int> = []
    @Published private(set) var isSweeping = false
    /// One line of feedback under the bulk bar ("Snoozed 12 · 2 Urgent left"),
    /// cleared on the next action or refresh.
    @Published private(set) var note: String?
    @Published var draftTitle = ""
    @Published private(set) var isAdding = false
    /// Bumps once a minute so "overdue" follows the clock between fetches.
    @Published private(set) var now = Date()

    private var timer: Timer?
    private var clock: Timer?

    private init() {}

    // MARK: - Derived lists

    var overdue: [TaskDTO] { TaskLists.overdue(tasks, now: now) }

    /// With nothing overdue: the rest of today, soonest first.
    var nextUp: [TaskDTO] {
        Array(TaskLists.dueToday(tasks, now: now).filter { !$0.isOverdue(now: now) }.prefix(Self.maxNextUp))
    }

    var sweepCount: Int { TaskLists.overdueSweepEligibleCount(tasks, now: now) }

    /// Where "next period" lands for an overdue task (base = now) — the bulk
    /// bar's label. nil with no cached slots (the server still resolves it).
    var nextPeriodStart: Date? {
        TimeSlotStore.nextPeriodStart(slots: slots, after: now)
    }

    // MARK: - Lifecycle

    /// Start polling. Called once, at launch.
    func start() {
        guard timer == nil else { return }
        timer = Timer.scheduledTimer(withTimeInterval: Self.refreshInterval, repeats: true) { _ in
            Task { @MainActor in await MenuBarModel.shared.refresh() }
        }
        clock = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in
            Task { @MainActor in MenuBarModel.shared.now = Date() }
        }
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { _ in
            Task { @MainActor in await MenuBarModel.shared.refresh() }
        }
        Task { await refresh() }
    }

    func refresh() async {
        guard AppConfig.shared.isConfigured else { return }
        do {
            let fetched = try await APIClient.shared.fetchOpenTasks()
            tasks = fetched
            errorText = nil
        } catch {
            errorText = "Couldn't reach OpenTask"
        }
        now = Date()
        hasLoaded = true
        if let fresh = try? await APIClient.shared.fetchTimeSlots() {
            slots = fresh
            TimeSlotStore.save(fresh)
        }
    }

    // MARK: - Row actions

    func complete(_ task: TaskDTO) {
        act(on: task.id) {
            try await APIClient.shared.completeTasks(ids: [task.id])
            return nil
        }
    }

    /// Per-task snooze, through the phone widget's shared plan
    /// (`TaskSnoozePlan`): an explicit pick bypasses the P3/P4 sweep filter,
    /// and "+1h" on an upcoming task counts from its own due time.
    func snooze(_ task: TaskDTO, _ target: TaskSnoozeTarget) {
        let requests = TaskSnoozePlan.requests(
            target, tasks: [(id: task.id, dueAt: task.dueDate)], now: Date(), slots: slots
        )
        act(on: task.id) {
            let moved = await TaskSnoozePlan.send(requests)
            return moved.contains(task.id) ? nil : "Couldn't snooze \"\(task.title)\""
        }
    }

    private func act(on id: Int, _ work: @escaping () async throws -> String?) {
        busyIds.insert(id)
        note = nil
        Task {
            do {
                note = try await work()
            } catch {
                note = "That didn't go through — try again"
            }
            await refresh()
            busyIds.remove(id)
        }
    }

    // MARK: - Bulk

    /// The server-side sweep (`POST /api/tasks/bulk/snooze-overdue`): the
    /// same call as the phone's "All overdue" bar and the watch — P3 only once
    /// nothing lower is left, P4 never. The note says what stayed behind.
    func snoozeAll(_ target: TaskSnoozeTarget) {
        isSweeping = true
        note = nil
        Task {
            do {
                let result = switch target {
                case .nextPeriod: try await APIClient.shared.snoozeOverdue(slot: "next")
                case .plusOneHour: try await APIClient.shared.snoozeOverdue(deltaMinutes: 60)
                }
                note = Self.sweepSummary(result)
            } catch {
                note = "Snooze failed — try again"
            }
            await refresh()
            isSweeping = false
        }
    }

    static func sweepSummary(_ result: APIClient.BulkSnoozeResult) -> String {
        var parts: [String] = []
        let n = result.tasksAffected
        parts.append(n == 0 ? "Nothing to snooze" : "Snoozed \(n) \(n == 1 ? "task" : "tasks")")
        if result.skippedHigh > 0 { parts.append("\(result.skippedHigh) High left") }
        if result.skippedUrgent > 0 { parts.append("\(result.skippedUrgent) Urgent left") }
        return parts.joined(separator: " · ")
    }

    // MARK: - Quick add

    /// The web's quick add: the title alone, AI fills in the rest server-side.
    func addDraft() {
        let title = draftTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, !isAdding else { return }
        isAdding = true
        note = nil
        Task {
            do {
                try await APIClient.shared.createTask(title: title)
                draftTitle = ""
                note = "Added \"\(title)\""
            } catch {
                note = "Couldn't add the task — try again"
            }
            isAdding = false
            await refresh()
        }
    }
}
