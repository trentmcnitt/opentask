import SwiftUI
import WidgetKit

// MARK: - Entry

struct TasksEntry: TimelineEntry {
    let date: Date
    /// Today's set for the *current scope*, already filtered and sorted.
    let tasks: [TaskDTO]
    /// The projects the scope chevrons cycle through, in server order.
    let projects: [ProjectDTO]
    /// Project id, or `WidgetStore.allProjects`.
    let scope: Int
    let staleSince: Date?
    let isSignedOut: Bool

    var scopeLabel: String {
        guard scope != WidgetStore.allProjects else { return "Today" }
        return projects.first(where: { $0.id == scope })?.name ?? "Today"
    }

    var scopeColor: Color {
        guard scope != WidgetStore.allProjects else { return .secondary }
        return WidgetTheme.projectColor(projects.first(where: { $0.id == scope })?.color)
    }

    func overdueCount(now: Date = Date()) -> Int {
        tasks.filter { $0.isOverdue(now: now) }.count
    }
}

// MARK: - Today's set

/// The "what counts as today" rule, plus scope handling.
///
/// The server has no today endpoint — the dashboard fetches the open set from
/// `GET /api/tasks` and buckets client-side — so the widget applies the same
/// rule here rather than inventing an endpoint.
enum TasksTimeline {

    /// Due or overdue as of the end of the local day.
    ///
    /// Undated tasks are excluded: §7.1 treats a task without a real due date
    /// as backlog, and putting backlog on a today surface is exactly the noise
    /// the redesign is removing. Reminders are excluded too — they have their
    /// own widget and their own no-debt semantics (§6).
    static func todaysTasks(from tasks: [TaskDTO], now: Date = Date()) -> [TaskDTO] {
        let calendar = Calendar.current
        guard let endOfDay = calendar.date(
            byAdding: .day, value: 1, to: calendar.startOfDay(for: now)
        ) else {
            return []
        }

        return tasks
            .filter { !$0.isReminder }
            .filter { task in
                guard let due = task.dueDate else { return false }
                return due < endOfDay
            }
            .sorted { lhs, rhs in
                let l = lhs.dueDate ?? .distantFuture
                let r = rhs.dueDate ?? .distantFuture
                // Soonest (so: most overdue) first; priority breaks ties.
                if l != r { return l < r }
                return lhs.priority > rhs.priority
            }
    }

    /// Projects that actually have something in today's set, in the order the
    /// server returned them.
    ///
    /// Derived entirely from the payload — nothing on the client knows a
    /// project name or how many there are. §7.1 explicitly leaves the project
    /// set open, so any hardcoded list would go stale by design.
    static func scopedProjects(
        tasks: [TaskDTO],
        projects: [ProjectDTO],
        now: Date = Date()
    ) -> [ProjectDTO] {
        let present = Set(todaysTasks(from: tasks, now: now).map(\.projectId))
        return projects.filter { present.contains($0.id) }
    }

    static func apply(scope: Int, to tasks: [TaskDTO]) -> [TaskDTO] {
        guard scope != WidgetStore.allProjects else { return tasks }
        return tasks.filter { $0.projectId == scope }
    }

    /// Due times still ahead of us today. An entry at each one lets a task
    /// visibly tip into overdue at the right minute without spending budget.
    static func upcomingDueDates(in tasks: [TaskDTO], now: Date = Date()) -> [Date] {
        tasks.compactMap(\.dueDate).filter { $0 > now }.sorted()
    }
}

// MARK: - Provider

struct TasksProvider: TimelineProvider {

    private static let refreshInterval: TimeInterval = 30 * 60

    func placeholder(in context: Context) -> TasksEntry {
        SampleData.tasksEntry
    }

    func getSnapshot(in context: Context, completion: @escaping (TasksEntry) -> Void) {
        if context.isPreview {
            completion(SampleData.tasksEntry)
            return
        }
        Task { completion(await currentEntry()) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TasksEntry>) -> Void) {
        Task {
            let entry = await currentEntry()

            var entries = [entry]
            for due in TasksTimeline.upcomingDueDates(in: entry.tasks).prefix(6) {
                entries.append(
                    TasksEntry(
                        date: due,
                        tasks: entry.tasks,
                        projects: entry.projects,
                        scope: entry.scope,
                        staleSince: entry.staleSince,
                        isSignedOut: false
                    )
                )
            }

            let next = Date().addingTimeInterval(Self.refreshInterval)
            completion(Timeline(entries: entries, policy: .after(next)))
        }
    }

    private func currentEntry() async -> TasksEntry {
        let now = Date()

        guard APIClient.shared.isConfigured else {
            return TasksEntry(
                date: now, tasks: [], projects: [], scope: WidgetStore.allProjects,
                staleSince: nil, isSignedOut: true
            )
        }

        // Interaction fast path (§8 optimistic check-off) — see RemindersWidget.
        if WidgetStore.hasRecentInteraction(now: now), let cached = WidgetStore.loadTasks() {
            return makeEntry(
                tasks: cached.value.tasks,
                projects: cached.value.projects,
                staleSince: nil,
                now: now
            )
        }

        do {
            async let tasks = APIClient.shared.fetchOpenTasks()
            async let projects = APIClient.shared.fetchProjects()
            let (fetchedTasks, fetchedProjects) = try await (tasks, projects)
            WidgetStore.saveTasks(fetchedTasks, projects: fetchedProjects)
            return makeEntry(tasks: fetchedTasks, projects: fetchedProjects, staleSince: nil, now: now)
        } catch {
            print("[OpenTaskWidgets] Tasks fetch failed: \(error)")
            guard let cached = WidgetStore.loadTasks() else {
                return TasksEntry(
                    date: now, tasks: [], projects: [], scope: WidgetStore.allProjects,
                    staleSince: nil, isSignedOut: false
                )
            }
            return makeEntry(
                tasks: cached.value.tasks,
                projects: cached.value.projects,
                staleSince: cached.fetchedAt,
                now: now
            )
        }
    }

    private func makeEntry(
        tasks rawTasks: [TaskDTO],
        projects: [ProjectDTO],
        staleSince: Date?,
        now: Date
    ) -> TasksEntry {
        // Single choke point for the §8 tombstone filter — both the fresh-fetch
        // and cache-fallback paths flow through here.
        let tasks = WidgetStore.filterPending(rawTasks, now: now)
        let ringProjects = TasksTimeline.scopedProjects(tasks: tasks, projects: projects, now: now)

        // A scope whose project has dropped out of today's set would strand the
        // widget on an empty view it can only escape by chevroning, so fall
        // back to All.
        var scope = WidgetStore.projectScope
        if scope != WidgetStore.allProjects, !ringProjects.contains(where: { $0.id == scope }) {
            scope = WidgetStore.allProjects
            WidgetStore.projectScope = scope
        }

        let todays = TasksTimeline.todaysTasks(from: tasks, now: now)
        return TasksEntry(
            date: now,
            tasks: TasksTimeline.apply(scope: scope, to: todays),
            projects: ringProjects,
            scope: scope,
            staleSince: staleSince,
            isSignedOut: false
        )
    }
}

// MARK: - Widget

struct TasksWidget: Widget {
    static let kind = "OpenTaskTasks"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: TasksProvider()) { entry in
            TasksWidgetView(entry: entry)
        }
        .configurationDisplayName("Today's Tasks")
        .description("What's due today, by project, with +1 on anything you're tracking.")
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
