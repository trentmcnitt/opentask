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

    /// How many tasks the "All overdue" snooze-mode bar's sweep would
    /// actually move (2026-09-23, Phase 2) — computed once by the provider
    /// (`TasksTimeline.overdueSweepEligibleCount`) from the FULL open-tasks
    /// cache, not `tasks` above (which is already scope-filtered to the
    /// on-screen page/project — the sweep bar acts on the WHOLE server-side
    /// overdue set regardless of what scope happens to be on screen). A
    /// plain `Int`, not the task list itself: WidgetKit archives every
    /// timeline entry, and carrying the same few-hundred-task array on
    /// every one of them (7 entries per `getTimeline` pass) for a single
    /// number would be pure waste.
    var overdueSweepCount = 0
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

    /// How many tasks `POST /api/tasks/bulk/snooze-overdue` would actually
    /// move right now (2026-09-23, Phase 2's "All overdue" snooze-mode bar)
    /// — an HONEST CLIENT-SIDE ESTIMATE, not an authoritative count. Mirrors
    /// `filterForBulkSnooze`'s ceiling rule (`src/core/tasks/bulk.ts`): P0-P2
    /// always eligible; P3 (High) joins in ONLY once none of P0-P2 remain in
    /// the overdue-and-snoozable set; P4 (Urgent) never counts. `tasks`
    /// should be the FULL open-tasks cache (unscoped) — the sweep acts
    /// server-wide, not on whatever scope/page happens to be on screen.
    ///
    /// Two honest gaps versus the server, both accepted rather than chased:
    /// (1) "overdue" here is `TaskDTO.isOverdue(now:)` (`due_at < now`), the
    /// SAME check every row's red styling already uses — the server's actual
    /// sweep instead queries `getCurrentlyDueTaskIds` (§4.6: a recurring
    /// task's frozen `due_at` needs its own "is this actually due today"
    /// logic that a raw date comparison can't replicate client-side without
    /// a dedicated endpoint neither this widget nor its API surface has).
    /// (2) `eligibleTasks` already drops reminders/tracked items, matching
    /// `filterForBulkSnooze`'s own "reminders and quotas are never late"
    /// exclusion — no separate filter needed here. Both gaps only ever
    /// affect what number this bar PRINTS and whether it shows at all
    /// (N > 0); the server remains the sole authority on what actually moves
    /// when the button is tapped.
    static func overdueSweepEligibleCount(from tasks: [TaskDTO], now: Date = Date()) -> Int {
        let overdue = eligibleTasks(from: tasks).filter { $0.isOverdue(now: now) }
        let lowCount = overdue.filter { $0.priority < 3 }.count
        if lowCount > 0 { return lowCount }
        return overdue.filter { $0.priority == 3 }.count
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
                        doneTasks: entry.doneTasks,
                        overdueSweepCount: entry.overdueSweepCount
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
                        doneTasks: entry.doneTasks,
                        overdueSweepCount: entry.overdueSweepCount
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
            doneTasks: TasksTimeline.doneTasks(from: snapshot.completions, scope: scope),
            // From the FULL open-tasks cache (`tasks`, unscoped) — see
            // `TasksEntry.overdueSweepCount`'s doc for why this must not be
            // `displayedTasks`.
            overdueSweepCount: TasksTimeline.overdueSweepEligibleCount(from: tasks, now: now)
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
// MARK: - Previews (2026-09-24, real-data snapshot)
//
// Trent's REAL open tasks, read-only from production on 2026-09-24 when he
// screenshotted "Up next · 26 due" paging as 13 pages of two rows — every
// dated, non-reminder, non-quota task, soonest first, titles VERBATIM
// (including the long immunization-records and Amazon-trial ones), with
// his real projects and colors. See `RemindersWidget.swift`'s identical
// preview header for why this is here and not in `SampleData.swift`, and
// why each store state (page, toggle, mode) gets its own `#Preview` block.
private enum TasksPreviewData {
    /// The snapshot's clock: 8:45 AM local today, when the screenshot was
    /// taken.
    static var now: Date {
        Calendar.current.date(bySettingHour: 8, minute: 45, second: 0, of: Date()) ?? Date()
    }

    /// A snapshot due date moved by however many whole days separate the
    /// snapshot (2026-09-24) from today — so "today" stays today, "Tomorrow"
    /// stays tomorrow, and the day-naming buckets render exactly as Trent
    /// saw them whatever day the preview runs.
    private static func shifted(_ iso: String) -> String {
        let calendar = Calendar.current
        var snapshot = DateComponents()
        snapshot.year = 2026
        snapshot.month = 9
        snapshot.day = 24
        guard let snapshotDay = calendar.date(from: snapshot) else { return iso }
        let days = calendar.dateComponents([.day], from: snapshotDay, to: calendar.startOfDay(for: Date())).day ?? 0
        return DateHelpers.adjustByDays(iso, days: days)
    }

    static var projects: [ProjectDTO] {
        [
            ProjectDTO(id: 1, name: "Inbox", color: nil),
            ProjectDTO(id: 6, name: "Work", color: "red"),
            ProjectDTO(id: 4434, name: "Personal", color: "blue"),
            ProjectDTO(id: 4799, name: "Infra", color: "green"),
        ]
    }

    static var tasks: [TaskDTO] {
        [
            TaskDTO(id: 23533, projectId: 6, title: "Check if clients are waiting on me", priority: 3, dueAt: shifted("2026-09-24T14:00:00.000Z")),
            TaskDTO(id: 22067, projectId: 4434, title: "Email Gayle Nicoll about 4-H Brookfield Blazers before the Oct 1 meeting", priority: 3, dueAt: shifted("2026-09-24T22:00:00.000Z")),
            TaskDTO(id: 22793, projectId: 4434, title: "Kelly chocolate", priority: 2, dueAt: shifted("2026-09-25T01:30:00.000Z")),
            TaskDTO(id: 292, projectId: 4434, title: "Josie Allowance ($8)", priority: 2, dueAt: shifted("2026-09-25T21:00:00.000Z")),
            TaskDTO(id: 308, projectId: 4434, title: "Check out Home Depot Craft", priority: 1, dueAt: shifted("2026-09-26T14:00:00.000Z")),
            TaskDTO(id: 22586, projectId: 6, title: "Log Upwork hours before the UTC week lock", priority: 3, dueAt: shifted("2026-09-27T14:00:00.000Z")),
            TaskDTO(id: 249, projectId: 4434, title: "Returns? (including library)", priority: 2, dueAt: shifted("2026-09-27T22:00:00.000Z")),
            TaskDTO(id: 290, projectId: 4434, title: "Josie Garbage", priority: 3, dueAt: shifted("2026-09-27T22:00:00.000Z")),
            TaskDTO(id: 11160, projectId: 4434, title: "Take garbage out", priority: 3, dueAt: shifted("2026-09-27T22:30:00.000Z")),
            TaskDTO(id: 23555, projectId: 4434, title: "Return Burleigh immunization records for Cole and Josie by Oct 2 (school has No Record; form wasn't attached)", priority: 3, dueAt: shifted("2026-09-28T14:00:00.000Z")),
            TaskDTO(id: 17931, projectId: 4799, title: "Check for Claude Code subagent CLAUDE.md-inheritance off-switch", priority: 1, dueAt: shifted("2026-09-30T14:00:00.000Z")),
            TaskDTO(id: 302, projectId: 4434, title: "Rent check", priority: 3, dueAt: shifted("2026-10-01T12:00:00.000Z")),
            TaskDTO(id: 8385, projectId: 4434, title: "Check if insurance is finished", priority: 1, dueAt: shifted("2026-10-01T14:00:00.000Z")),
            TaskDTO(id: 8870, projectId: 4434, title: "E sign for new insurance and for canceling the old insurance", priority: 1, dueAt: shifted("2026-10-01T14:00:00.000Z")),
            TaskDTO(id: 9214, projectId: 4434, title: "Make sure Foremost is set up properly", priority: 1, dueAt: shifted("2026-10-01T14:00:00.000Z")),
            TaskDTO(id: 9215, projectId: 6, title: "Make sure Mercury is cancelled", priority: 1, dueAt: shifted("2026-10-01T14:00:00.000Z")),
            TaskDTO(id: 9312, projectId: 4434, title: "Call Capital One to limit data sharing on privacy preferences for the new 360 Checking account", priority: 1, dueAt: shifted("2026-10-01T14:00:00.000Z")),
            TaskDTO(id: 12224, projectId: 4434, title: "Do something that improves credit", priority: 2, dueAt: shifted("2026-10-01T14:00:00.000Z")),
            TaskDTO(id: 13256, projectId: 6, title: "Apply for the Mercury IO charge card", priority: 1, dueAt: shifted("2026-10-01T14:00:00.000Z")),
            TaskDTO(id: 11315, projectId: 4434, title: "Check water softener", priority: 2, dueAt: shifted("2026-10-01T14:30:00.000Z")),
            TaskDTO(id: 13490, projectId: 4434, title: "Add my name to Capital One", priority: 2, dueAt: shifted("2026-10-01T20:00:00.000Z")),
            TaskDTO(id: 16551, projectId: 4434, title: "Cancel Amazon Music Unlimited free trial before it auto-renews at $11.99/mo (90-day trial started ~7/24/26, ends ~10/22)", priority: 3, dueAt: shifted("2026-10-04T15:00:00.000Z")),
            TaskDTO(id: 21853, projectId: 6, title: "Cancel Microsoft 365 Business trial before it renews", priority: 3, dueAt: shifted("2026-10-07T14:00:00.000Z")),
            TaskDTO(id: 22794, projectId: 4434, title: "Use Raising Cane's kids coupons before October 11", priority: 1, dueAt: shifted("2026-10-10T14:00:00.000Z")),
            TaskDTO(id: 12343, projectId: 4434, title: "Pull Experian and all credit reports — verify post-filing tradeline updates & dispute any errors", priority: 3, dueAt: shifted("2026-10-12T23:00:00.000Z")),
            TaskDTO(id: 296, projectId: 4434, title: "Replace house air filter", priority: 1, dueAt: shifted("2026-10-17T16:30:00.000Z")),
        ]
    }

    /// One real recent completion, stamped this morning so the "show
    /// completed" DONE section has something to render.
    static var doneToday: [CompletionDTO] {
        let at = Calendar.current.date(bySettingHour: 8, minute: 15, second: 0, of: Date()) ?? Date()
        return [
            CompletionDTO(
                id: -1286, taskId: 22852, completedAt: DateHelpers.formatISO(at),
                taskTitle: "Select Happiness Trap audiobook on Audible", projectId: 4434
            )
        ]
    }

    static func entry() -> TasksEntry {
        TasksEntry(
            date: now,
            tasks: TasksTimeline.upNextTasks(from: tasks),
            projects: projects,
            scope: WidgetStore.upNextScope,
            staleSince: nil,
            isSignedOut: false,
            canUndo: true,
            canRedo: false,
            actionDescription: nil,
            colorProjects: projects,
            doneTasks: doneToday,
            // Computed the same way `TasksProvider.makeEntry` does, from the
            // FULL task list — see `TasksEntry.overdueSweepCount`'s doc.
            overdueSweepCount: TasksTimeline.overdueSweepEligibleCount(from: tasks)
        )
    }

    /// Trent's "Personal" project page (4434) — his longest project name,
    /// for checking the header title beside the clock/Undo/Redo/‹ › cluster.
    /// Filtered the way a project page filters "Today" (`todaysTasks`).
    static func personalEntry() -> TasksEntry {
        TasksEntry(
            date: now,
            tasks: TasksTimeline.todaysTasks(from: tasks, now: now).filter { $0.projectId == 4434 },
            projects: projects,
            scope: 4434,
            staleSince: nil,
            isSignedOut: false,
            canUndo: true,
            canRedo: false,
            actionDescription: nil,
            colorProjects: projects,
            doneTasks: [],
            overdueSweepCount: TasksTimeline.overdueSweepEligibleCount(from: tasks)
        )
    }
}

/// Resets EVERY piece of `#Preview`-visible App Group state, then pins the
/// page — previews share the simulator's App Group UserDefaults with each
/// other and with its real widgets, so anything a prior render left set
/// would otherwise bleed into the next one.
private func resetTasksPreviewState(page: Int = 0) {
    WidgetStore.setTasksPage(page, for: WidgetStore.upNextScope)
    WidgetStore.setTasksSnoozeMode(false)
    WidgetStore.setTasksSelectMode(false)
    WidgetStore.clearTasksSelection()
    WidgetStore.setShowCompleted(false, for: TasksWidget.kind)
    // Seed `TimeSlotStore` with Trent's real slots — the widget extension
    // only ever READS that cache (the main app populates it), so an
    // unseeded preview renders every "⏭ Next period" button disabled,
    // which a real device never shows.
    TimeSlotStore.save([
        TimeSlotDTO(id: 11, label: "Early morning", startTime: "07:00"),
        TimeSlotDTO(id: 12, label: "Morning", startTime: "09:00"),
        TimeSlotDTO(id: 13, label: "Midday", startTime: "12:00"),
        TimeSlotDTO(id: 14, label: "Afternoon", startTime: "16:00"),
        TimeSlotDTO(id: 15, label: "Evening", startTime: "20:30"),
    ])
}

#Preview("Tasks Large — Up next page 1", as: .systemLarge) {
    TasksWidget()
} timeline: {
    let _ = resetTasksPreviewState(page: 0)
    TasksPreviewData.entry()
}

#Preview("Tasks Large — Up next page 2", as: .systemLarge) {
    TasksWidget()
} timeline: {
    let _ = resetTasksPreviewState(page: 1)
    TasksPreviewData.entry()
}

#Preview("Tasks Large — Up next page 3", as: .systemLarge) {
    TasksWidget()
} timeline: {
    let _ = resetTasksPreviewState(page: 2)
    TasksPreviewData.entry()
}

#Preview("Tasks Large — Completed On, last page", as: .systemLarge) {
    TasksWidget()
} timeline: {
    // Past the end on purpose — the list clamps to its last page.
    let _ = resetTasksPreviewState(page: 99)
    let _ = WidgetStore.setShowCompleted(true, for: TasksWidget.kind)
    TasksPreviewData.entry()
}

#Preview("Tasks Large — Snooze mode", as: .systemLarge) {
    TasksWidget()
} timeline: {
    let _ = resetTasksPreviewState()
    let _ = WidgetStore.setTasksSnoozeMode(true)
    TasksPreviewData.entry()
}

#Preview("Tasks Large — Select mode (2 picked)", as: .systemLarge) {
    TasksWidget()
} timeline: {
    let _ = resetTasksPreviewState()
    let _ = WidgetStore.setTasksSelectMode(true)
    let _ = WidgetStore.setSelectedTaskIds([23533, 22793], for: WidgetStore.upNextScope)
    TasksPreviewData.entry()
}

#Preview("Tasks Large — Personal project page", as: .systemLarge) {
    TasksWidget()
} timeline: {
    let _ = resetTasksPreviewState()
    let _ = WidgetStore.setTasksPage(0, for: 4434)
    TasksPreviewData.personalEntry()
}

#Preview("Tasks Medium", as: .systemMedium) {
    TasksWidget()
} timeline: {
    let _ = resetTasksPreviewState()
    TasksPreviewData.entry()
}

#endif
