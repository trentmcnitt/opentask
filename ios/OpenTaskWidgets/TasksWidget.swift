import SwiftUI
import WidgetKit

// MARK: - Entry

struct TasksEntry: TimelineEntry {
    let date: Date
    /// The current scope's tasks, already filtered and sorted — Today's set
    /// for `allProjects` or a project, or every dated open task for
    /// `upNextScope` (2026-09-23, item 4).
    let tasks: [TaskDTO]
    /// The projects the scope chevrons cycle through, in server order.
    let projects: [ProjectDTO]
    /// A project id, or `WidgetStore.allProjects`/`upNextScope` for one of
    /// the two unified pages.
    let scope: Int
    let staleSince: Date?
    let isSignedOut: Bool
    /// Whether the header's Undo/Redo buttons should be enabled at THIS
    /// entry's `date` — see `WidgetStore.canUndo`/`canRedo` and
    /// `UndoRedoButtons`. Not time-windowed (2026-09-23) — see
    /// `RemindersEntry`'s identical doc.
    let canUndo: Bool
    let canRedo: Bool
    /// The header subtitle's "Undid: …" / "Redid: …" indication — see
    /// `RemindersEntry.actionDescription`'s doc.
    let actionDescription: String?
    /// EVERY project, for color lookups — `projects` above is only the ones
    /// with something due today (it is the chevrons' ring). Up next shows
    /// tasks from any project, so looking colors up in the ring painted a
    /// project with nothing due today gray: Trent's red Work tasks
    /// (2026-09-23). Defaulted so sample entries needn't pass it; empty
    /// falls back to `projects`.
    var colorProjects: [ProjectDTO] = []
    /// Today's completions for THIS scope (2026-09-23, "show completed" —
    /// the DONE section) — unlike the toggle bool itself (pure local UI
    /// state, read live from `WidgetStore`), this has to ride on the entry:
    /// it is server data, already filtered/scoped by the provider
    /// (`TasksTimeline.doneTasks`) the same way `tasks` above is. Defaulted
    /// so every existing `TasksEntry` construction site (the boundary/expiry
    /// entries in `getTimeline`, `SampleData`) keeps compiling without
    /// passing it — see `colorProjects`' identical precedent.
    var doneTasks: [CompletionDTO] = []

    /// Two unified pages up front (2026-09-23, item 4) — Trent: "Instead of
    /// Up Next I'd also like to have just a Today one… We need a Today one
    /// as well." `allProjects` is the literal "due or overdue by end of
    /// today" page (`TasksTimeline.todaysTasks`) — it kept both its name and
    /// its meaning across this change, since that was always exactly what
    /// it rendered. `upNextScope` is the NEW, broader page: every dated open
    /// task the widget considers at all, no cutoff (`TasksTimeline.
    /// upNextTasks`). Both are project-less unified scopes; a real project
    /// id falls through to that project's name.
    var scopeLabel: String {
        if scope == WidgetStore.upNextScope { return "Up next" }
        guard scope != WidgetStore.allProjects else { return "Today" }
        return projects.first(where: { $0.id == scope })?.name ?? "Today"
    }

    /// Whether this is one of the two unified pages (Today / Up next) rather
    /// than a single project — gates the header's project dot (shown only on
    /// a real project page) and each row's project-colored EDGE (shown only
    /// on a unified page — see `TaskRow.showsProjectEdge`).
    var isUnifiedScope: Bool {
        scope == WidgetStore.allProjects || scope == WidgetStore.upNextScope
    }

    var scopeColor: Color {
        guard !isUnifiedScope else { return .secondary }
        return WidgetTheme.projectColor(projects.first(where: { $0.id == scope })?.color)
    }

    /// A task's own project color, for `TaskRow`'s trailing checkbox
    /// (2026-09-23, §3) — every row shows its OWN project's color regardless
    /// of which scope page is on screen, both unified pages included (that's
    /// the whole point: it's how a unified list still tells projects apart).
    /// Falls back to `WidgetTheme.projectColor(nil)` (neutral secondary) if a
    /// task's project has somehow dropped out of `projects` (a project
    /// deleted between fetches, say) rather than crashing or guessing a color.
    func projectColor(for task: TaskDTO) -> Color {
        projectColor(forProjectId: task.projectId)
    }

    /// The `CompletionDTO` twin of `projectColor(for:)` (2026-09-23, "show
    /// completed") — `DoneTaskRow`'s source is a `CompletionDTO`, which
    /// carries a bare `projectId` rather than a full `TaskDTO`, so this is
    /// the same lookup addressed by id directly.
    func projectColor(forProjectId projectId: Int) -> Color {
        let all = colorProjects.isEmpty ? projects : colorProjects
        return WidgetTheme.projectColor(all.first(where: { $0.id == projectId })?.color)
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

    /// The three exclusions both unified pages share, each with its own home:
    ///
    /// - **Undated** tasks: §7.1 treats a task without a real due date as
    ///   backlog, and putting backlog on a today/up-next surface is exactly
    ///   the noise the redesign is removing.
    /// - **Reminders** (§6): their own widget, their own no-debt semantics.
    /// - **Tracked** items, `progress_target > 1` (§8 as amended 2026-07-27):
    ///   their own widget too. A quota row inside a task list buries the thing
    ///   being glanced at — it is twice the height of a task row and answers a
    ///   different question ("how far in", not "is it done").
    private static func eligibleTasks(from tasks: [TaskDTO]) -> [TaskDTO] {
        tasks.filter { !$0.isReminder && !$0.isTracked && $0.dueDate != nil }
    }

    private static func sortedSoonestFirst(_ tasks: [TaskDTO]) -> [TaskDTO] {
        tasks.sorted { lhs, rhs in
            let l = lhs.dueDate ?? .distantFuture
            let r = rhs.dueDate ?? .distantFuture
            // Soonest (so: most overdue) first; priority breaks ties.
            if l != r { return l < r }
            return lhs.priority > rhs.priority
        }
    }

    /// Due or overdue as of the end of the local day — the "Today" unified
    /// page (2026-09-23, item 4) and, unchanged, what every per-project page
    /// still shows.
    static func todaysTasks(from tasks: [TaskDTO], now: Date = Date()) -> [TaskDTO] {
        let calendar = Calendar.current
        guard let endOfDay = calendar.date(
            byAdding: .day, value: 1, to: calendar.startOfDay(for: now)
        ) else {
            return []
        }
        return sortedSoonestFirst(eligibleTasks(from: tasks).filter { ($0.dueDate ?? .distantFuture) < endOfDay })
    }

    /// "Up next" (2026-09-23, item 4) — Trent: "Instead of Up Next I'd also
    /// like to have just a Today one… We need a Today one as well." This is
    /// what "Up next" used to mean before that request split it in two:
    /// every dated open task the widget considers at all, soonest (most
    /// overdue) first, with NO end-of-today cutoff — `eligibleTasks`'
    /// exclusions apply exactly as `todaysTasks` uses them.
    static func upNextTasks(from tasks: [TaskDTO]) -> [TaskDTO] {
        sortedSoonestFirst(eligibleTasks(from: tasks))
    }

    /// Projects that actually have something in TODAY's set, in the order
    /// the server returned them — still the ring `todaysTasks` uses. Per-
    /// project pages are unchanged by item 4 ("Then the per-project pages as
    /// now"), so this stays scoped to `todaysTasks`, not `upNextTasks`.
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

    /// The DONE list for "show completed" (2026-09-23) — today's completions,
    /// scoped the same way `todaysTasks`/`upNextTasks` scope the OPEN list:
    /// reminders and tracked items are excluded ALWAYS (their own widgets own
    /// that data — same exclusions `eligibleTasks` applies), and a
    /// per-project page filters further by `project_id`. Both unified pages
    /// (Today/Up next) show every one of today's matching completions,
    /// unfiltered by project.
    ///
    /// DECISION, not fully spec'd (flagged in the handoff): there is no clean
    /// way to further restrict "Today"'s done list to only tasks that were
    /// DUE today (as opposed to any task completed today) without extra
    /// due-date reconstruction the completions payload doesn't cleanly
    /// support — `CompletionDTO` carries no due date at all. So "Today" here
    /// means "completed today", not "was due today and got done". Sorted
    /// most-recently-completed first — a small, un-spec'd choice: the DONE
    /// section reads top-down like the OPEN list above it, so the item just
    /// checked off appears at its top, not buried under older completions.
    static func doneTasks(from completions: [CompletionDTO], scope: Int) -> [CompletionDTO] {
        let eligible = completions.filter { !$0.isReminder && !$0.isTracked }
        let scoped: [CompletionDTO]
        if scope == WidgetStore.allProjects || scope == WidgetStore.upNextScope {
            scoped = eligible
        } else {
            scoped = eligible.filter { $0.projectId == scope }
        }
        return scoped.sorted { ($0.completedDate ?? .distantPast) > ($1.completedDate ?? .distantPast) }
    }

    /// Filters to one project's slice of `tasks`. Only ever called with a
    /// real project id now — the two unified scopes (`allProjects`,
    /// `upNextScope`) are resolved by `TasksProvider.makeEntry` before this
    /// is reached, each from its own source list (`todaysTasks` /
    /// `upNextTasks`), not by a no-op pass through here.
    static func apply(scope: Int, to tasks: [TaskDTO]) -> [TaskDTO] {
        tasks.filter { $0.projectId == scope }
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
            // A widget push token the server never confirmed — see
            // `WidgetPushRegistration` in WidgetPushHandler.swift.
            await WidgetPushRegistration.retryIfNeeded()
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
                        isSignedOut: false,
                        canUndo: entry.canUndo,
                        canRedo: entry.canRedo,
                        actionDescription: WidgetStore.lastActionDescription(at: due),
                        colorProjects: entry.colorProjects,
                        doneTasks: entry.doneTasks
                    )
                )
            }
            // The explicit "Undid: …" expiry (2026-09-23) — see
            // RemindersProvider's identical block for why this needs its own
            // dated entry.
            if !entry.isSignedOut, entry.actionDescription != nil,
                let expiry = WidgetStore.lastActionExpiry(), expiry > entry.date {
                entries.append(
                    TasksEntry(
                        date: expiry,
                        tasks: entry.tasks,
                        projects: entry.projects,
                        scope: entry.scope,
                        staleSince: entry.staleSince,
                        isSignedOut: false,
                        canUndo: entry.canUndo,
                        canRedo: entry.canRedo,
                        actionDescription: nil,
                        colorProjects: entry.colorProjects,
                        doneTasks: entry.doneTasks
                    )
                )
            }
            entries.sort { $0.date < $1.date }

            let next = Date().addingTimeInterval(Self.refreshInterval)
            completion(Timeline(entries: entries, policy: .after(next)))
        }
    }

    /// Fetch/cache/fallback and the §8 optimistic staging all live in
    /// `TaskFeed`, shared with the Track widget — the two kinds render
    /// different slices of one payload. `TaskFeed` also piggybacks the
    /// undo/redo counts fetch (2026-09-23) — see its doc.
    private func currentEntry() async -> TasksEntry {
        let now = Date()
        let snapshot = await TaskFeed.snapshot(now: now)

        guard !snapshot.isSignedOut else {
            return TasksEntry(
                date: now, tasks: [], projects: [], scope: WidgetStore.allProjects,
                staleSince: nil, isSignedOut: true, canUndo: false, canRedo: false,
                actionDescription: nil
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
        // back to Today. Neither unified scope is ever "dropped" — they always
        // exist, so this guard only ever fires for a real project id.
        var scope = WidgetStore.projectScope
        if scope != WidgetStore.allProjects, scope != WidgetStore.upNextScope,
            !ringProjects.contains(where: { $0.id == scope }) {
            scope = WidgetStore.allProjects
            WidgetStore.projectScope = scope
        }

        // Two unified pages (2026-09-23, item 4): Today (`todaysTasks`, the
        // same end-of-day cutoff every per-project page still uses) and Up
        // next (`upNextTasks`, no cutoff at all). A real project id filters
        // Today's set, exactly as before.
        let displayedTasks: [TaskDTO]
        switch scope {
        case WidgetStore.allProjects:
            displayedTasks = TasksTimeline.todaysTasks(from: tasks, now: now)
        case WidgetStore.upNextScope:
            displayedTasks = TasksTimeline.upNextTasks(from: tasks)
        default:
            displayedTasks = TasksTimeline.apply(scope: scope, to: TasksTimeline.todaysTasks(from: tasks, now: now))
        }

        return TasksEntry(
            date: now,
            tasks: displayedTasks,
            projects: ringProjects,
            scope: scope,
            staleSince: snapshot.staleSince,
            isSignedOut: false,
            canUndo: WidgetStore.canUndo,
            canRedo: WidgetStore.canRedo,
            actionDescription: WidgetStore.lastActionDescription(at: now),
            colorProjects: snapshot.projects,
            doneTasks: TasksTimeline.doneTasks(from: snapshot.completions, scope: scope)
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

#if DEBUG
// MARK: - Previews (2026-09-23, day-naming + "show completed" verification)
//
// See `RemindersWidget.swift`'s identical preview section header for why
// this uses realistic named data (not `SampleData.swift`) and two SEPARATE
// `#Preview` blocks rather than two timeline entries in one.
private enum TasksPreviewData {
    static var projects: [ProjectDTO] {
        [
            ProjectDTO(id: 1, name: "Personal", color: "blue"),
            ProjectDTO(id: 2, name: "Work", color: "red"),
        ]
    }

    /// A local time `days` from now, as the UTC ISO string the API would
    /// return. Relative to `Date()` (not a literal "Oct 1"/"Oct 2", the
    /// verification brief's own wording) so this preview keeps demonstrating
    /// the right day-naming BUCKET (today / tomorrow / 2-6 days / 7+ days)
    /// whenever it's rendered, rather than only on the day it was written.
    private static func at(daysFromNow days: Int, hour: Int, minute: Int = 0) -> String {
        let calendar = Calendar.current
        let day = calendar.date(byAdding: .day, value: days, to: Date()) ?? Date()
        var comps = calendar.dateComponents([.year, .month, .day], from: day)
        comps.hour = hour
        comps.minute = minute
        return DateHelpers.formatISO(calendar.date(from: comps) ?? Date())
    }

    /// Date-only (local midnight) `days` from now — the "Oct 2"-style case:
    /// a day word with no time at all.
    private static func dateOnly(daysFromNow days: Int) -> String {
        let calendar = Calendar.current
        let day = calendar.date(byAdding: .day, value: days, to: Date()) ?? Date()
        return DateHelpers.formatISO(calendar.startOfDay(for: day))
    }

    /// The next Sunday at least 2 days out, so this reliably lands in the
    /// "2-6 days away" weekday-name bucket (`WidgetTheme.dueLabelParts`)
    /// regardless of which day this preview happens to be rendered on — a
    /// Sunday only 1 day away would correctly show "Tomorrow" instead, which
    /// is accurate day-naming behavior but wouldn't demonstrate the "Sun"
    /// case this preview exists to show.
    private static func nextSunday(hour: Int, minute: Int = 0) -> String {
        let calendar = Calendar.current
        let weekday = calendar.component(.weekday, from: Date()) // 1 = Sunday ... 7 = Saturday
        var offset = (8 - weekday) % 7
        if offset < 2 { offset += 7 }
        return at(daysFromNow: offset, hour: hour, minute: minute)
    }

    static var tasks: [TaskDTO] {
        [
            TaskDTO(
                id: 911, projectId: 1, title: "Kelly chocolate", priority: 2,
                dueAt: at(daysFromNow: 0, hour: 20, minute: 30)
            ),
            TaskDTO(
                id: 912, projectId: 2, title: "Check if clients are waiting on me", priority: 3,
                dueAt: at(daysFromNow: 1, hour: 9)
            ),
            TaskDTO(
                id: 913, projectId: 2, title: "Log Upwork hours before the UTC week lock", priority: 2,
                dueAt: nextSunday(hour: 9)
            ),
            TaskDTO(
                id: 914, projectId: 1, title: "Make sure Mercury is cancelled", priority: 2,
                dueAt: at(daysFromNow: 10, hour: 9)
            ),
            TaskDTO(
                id: 915, projectId: 1, title: "Return Burleigh immunization records", priority: 1,
                dueAt: dateOnly(daysFromNow: 11)
            ),
            // Overdue AND date-only (2026-09-23 review fix) — exercises
            // the "Yesterday"/"Sep 22" red-date branch instead of the
            // literal-looking "12:00 am" the first cut showed.
            TaskDTO(
                id: 916, projectId: 2, title: "Approve the contractor invoice", priority: 3,
                dueAt: dateOnly(daysFromNow: -1)
            ),
        ]
    }

    static var doneToday: [CompletionDTO] {
        [
            CompletionDTO(
                id: -920, taskId: 920, completedAt: at(daysFromNow: 0, hour: 8, minute: 15),
                taskTitle: "Morning check-in", projectId: 1
            )
        ]
    }

    static func entry() -> TasksEntry {
        TasksEntry(
            date: Date(),
            tasks: TasksTimeline.upNextTasks(from: tasks),
            projects: projects,
            scope: WidgetStore.upNextScope,
            staleSince: nil,
            isSignedOut: false,
            canUndo: true,
            canRedo: false,
            actionDescription: nil,
            colorProjects: projects,
            doneTasks: doneToday
        )
    }
}

#Preview("Tasks Large — Completed Off", as: .systemLarge) {
    TasksWidget()
} timeline: {
    let _ = WidgetStore.setShowCompleted(false, for: TasksWidget.kind)
    let _ = WidgetStore.setTasksPage(0, for: WidgetStore.upNextScope)
    TasksPreviewData.entry()
}

#Preview("Tasks Large — Completed On", as: .systemLarge) {
    TasksWidget()
} timeline: {
    let _ = WidgetStore.setShowCompleted(true, for: TasksWidget.kind)
    // Reset the stored page — preview renders share the same App Group
    // UserDefaults as the simulator's real widgets, so a page a PRIOR
    // preview (or a real device session) left on 1+ would otherwise bleed
    // into this one.
    let _ = WidgetStore.setTasksPage(0, for: WidgetStore.upNextScope)
    TasksPreviewData.entry()
}
#endif
