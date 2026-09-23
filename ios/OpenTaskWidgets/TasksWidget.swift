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
    /// Three exclusions, each of which has its own home:
    ///
    /// - **Undated** tasks: §7.1 treats a task without a real due date as
    ///   backlog, and putting backlog on a today surface is exactly the noise
    ///   the redesign is removing.
    /// - **Reminders** (§6): their own widget, their own no-debt semantics.
    /// - **Tracked** items, `progress_target > 1` (§8 as amended 2026-07-27):
    ///   their own widget too. A quota row inside a task list buries the thing
    ///   being glanced at — it is twice the height of a task row and answers a
    ///   different question ("how far in", not "is it done").
    static func todaysTasks(from tasks: [TaskDTO], now: Date = Date()) -> [TaskDTO] {
        let calendar = Calendar.current
        guard let endOfDay = calendar.date(
            byAdding: .day, value: 1, to: calendar.startOfDay(for: now)
        ) else {
            return []
        }

        return tasks
            .filter { !$0.isReminder && !$0.isTracked }
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

    /// Fetch/cache/fallback and the §8 optimistic staging all live in
    /// `TaskFeed`, shared with the Track widget — the two kinds render
    /// different slices of one payload.
    private func currentEntry() async -> TasksEntry {
        let now = Date()
        let snapshot = await TaskFeed.snapshot(now: now)

        guard !snapshot.isSignedOut else {
            return TasksEntry(
                date: now, tasks: [], projects: [], scope: WidgetStore.allProjects,
                staleSince: nil, isSignedOut: true
            )
        }
        return makeEntry(snapshot, now: now)
    }

    private func makeEntry(_ snapshot: TaskFeed.Snapshot, now: Date) -> TasksEntry {
        let tasks = snapshot.tasks
        let ringProjects = TasksTimeline.scopedProjects(
            tasks: tasks, projects: snapshot.projects, now: now
        )

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
            staleSince: snapshot.staleSince,
            isSignedOut: false
        )
    }
}

// MARK: - Widget

struct TasksWidget: Widget {
    static let kind = "OpenTaskTasks"

    var body: some WidgetConfiguration {
        // Server-pushed reloads (iOS 26 / macOS 26 — see WidgetPushHandler.swift
        // and docs/NOTIFICATIONS.md § WidgetKit push) need `.pushHandler(...)`,
        // which only exists on iOS 26+, gated here rather than raising this
        // extension's deployment target (iOS 17 / macOS 14). `Widget.body` has
        // no result builder (`@WidgetConfigurationBuilder` does not exist,
        // unlike `View.body`'s `@ViewBuilder`), so an implicit-return `if
        // #available {...} else {...}` — or a `let base = ...; if #available {
        // base.pushHandler(...) } else { base }` form — fails to compile
        // ("branches have mismatching types" / "no return statements ... from
        // which to infer an underlying type"). EXPLICIT `return` in each
        // branch of a `#available`-gated if/else compiles fine even though the
        // two branches are different concrete `WidgetConfiguration` types —
        // that combination is a Swift compiler special case for opaque return
        // types (verified with `swiftc -typecheck` against a minimal
        // reproduction before applying it here).
        if #available(iOS 26.0, macOS 26.0, *) {
            return StaticConfiguration(kind: Self.kind, provider: TasksProvider()) { entry in
                TasksWidgetView(entry: entry)
            }
            .configurationDisplayName("Today's Tasks")
            .description("What's due today, with chevrons to page through your projects.")
            // systemLarge first: it is the primary layout (§8 — the user pointed
            // at a 4x4 Weather widget), and the gallery leads with the first entry.
            // See RemindersWidget for why this is a closure rather than #if inside
            // the array literal (the compiler rejects the latter).
            .supportedFamilies({
                var families: [WidgetFamily] = [.systemLarge, .systemMedium, .systemSmall]
                #if os(iOS)
                families += [.accessoryRectangular, .accessoryCircular]
                #endif
                return families
            }())
            .pushHandler(OpenTaskWidgetPushHandler.self)
        } else {
            return StaticConfiguration(kind: Self.kind, provider: TasksProvider()) { entry in
                TasksWidgetView(entry: entry)
            }
            .configurationDisplayName("Today's Tasks")
            .description("What's due today, with chevrons to page through your projects.")
            .supportedFamilies({
                var families: [WidgetFamily] = [.systemLarge, .systemMedium, .systemSmall]
                #if os(iOS)
                families += [.accessoryRectangular, .accessoryCircular]
                #endif
                return families
            }())
        }
    }
}
