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
    /// upNextTasks`). Both are project-less unified scopes, and so is
    /// "Overdue" (2026-09-25, `overdueScope`), ahead of them while anything
    /// is overdue; a real project id falls through to that project's name.
    var scopeLabel: String {
        if scope == WidgetStore.overdueScope { return "Overdue" }
        if scope == WidgetStore.upNextScope { return "Up next" }
        guard scope != WidgetStore.allProjects else { return "Today" }
        return projects.first(where: { $0.id == scope })?.name ?? "Today"
    }

    /// Whether this is one of the unified pages (Overdue / Today / Up next)
    /// rather than a single project — gates the header's project dot (shown
    /// only on a real project page) and each row's project-colored EDGE
    /// (shown only on a unified page — see `TaskRow.showsProjectEdge`).
    var isUnifiedScope: Bool {
        TasksTimeline.isUnifiedScope(scope)
    }

    /// The Overdue page (2026-09-25) — `TasksTimeline.overdueTasks`.
    var isOverdueScope: Bool { scope == WidgetStore.overdueScope }

    /// Where the header title (and the glanceable families' whole card)
    /// opens the app: the dashboard filtered to overdue on the Overdue page
    /// (2026-09-25 — Trent: "When I tap the header I'd like it to auto-filter
    /// the dashboard in OpenTask to be overdue", instead of tap, scroll to
    /// the top, Filters, Overdue…), the dashboard filtered to the project on
    /// a project page (2026-09-23), the plain dashboard on Today/Up next.
    var headerLink: URL {
        if isOverdueScope { return WidgetLink.overdue }
        guard !isUnifiedScope else { return WidgetLink.dashboard }
        return WidgetLink.project(scope)
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
        Task { completion(await currentEntry().entry) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TasksEntry>) -> Void) {
        Task {
            // A widget push token the server never confirmed — see
            // `WidgetPushRegistration` in WidgetPushHandler.swift.
            await WidgetPushRegistration.retryIfNeeded()
            let (entry, snapshot) = await currentEntry()

            var entries = [entry]
            // A zero-cost entry at each upcoming due time, REBUILT as of that
            // moment rather than copied (2026-09-25, the Overdue scope): the
            // task that tips overdue at 5 PM has to join the Overdue page —
            // and, if it is the first, make Overdue the default — at 5 PM,
            // not at the next fetch. So the times come from every eligible
            // task (`upNextTasks`), not just the page on screen, whose tasks
            // on the Overdue page are all in the past already.
            if let snapshot {
                let upcoming = TasksTimeline.upcomingDueDates(
                    in: TasksTimeline.upNextTasks(from: snapshot.tasks), now: entry.date
                )
                for due in upcoming.prefix(6) {
                    entries.append(makeEntry(snapshot, now: due))
                }
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
    ///
    /// Also hands back the snapshot, so `getTimeline` can build its future
    /// entries from the same payload (nil when signed out).
    private func currentEntry() async -> (entry: TasksEntry, snapshot: TaskFeed.Snapshot?) {
        let now = Date()
        let snapshot = await TaskFeed.snapshot(now: now)

        guard !snapshot.isSignedOut else {
            let signedOut = TasksEntry(
                date: now, tasks: [], projects: [], scope: WidgetStore.allProjects,
                staleSince: nil, isSignedOut: true, canUndo: false, canRedo: false,
                actionDescription: nil
            )
            return (signedOut, nil)
        }
        let entry = makeEntry(snapshot, now: now)
        // A chevron choice that no longer holds — its natural default changed
        // (overdue appeared, or the last overdue task went), or its project
        // has nothing due today any more — is forgotten here, as of now, so
        // it can't come back when the default flips back: "when overdue drops
        // to 0, it falls back to the normal default", not to whatever was
        // chosen before overdue appeared. Only for the entry drawn NOW; the
        // future entries above resolve without writing.
        if let choice = WidgetStore.tasksScopeChoice(), choice.scope != entry.scope {
            WidgetStore.clearTasksScopeChoice()
        }
        return (entry, snapshot)
    }

    /// Read-only: the page is resolved by `TasksTimeline.scopeState` (the
    /// user's chevron choice while it holds, else Overdue while anything is
    /// overdue, else Today), so the same snapshot can be drawn as of any
    /// moment.
    private func makeEntry(_ snapshot: TaskFeed.Snapshot, now: Date) -> TasksEntry {
        let tasks = snapshot.tasks
        let ringProjects = TasksTimeline.scopedProjects(
            tasks: tasks, projects: snapshot.projects, now: now
        )
        let scope = TasksTimeline.scopeState(tasks: tasks, projects: snapshot.projects, now: now).scope

        // Three unified pages — Overdue (2026-09-25, `overdueTasks`), Today
        // (`todaysTasks`, the same end-of-day cutoff every per-project page
        // still uses) and Up next (`upNextTasks`, no cutoff at all). A real
        // project id filters Today's set, exactly as before.
        let displayedTasks: [TaskDTO]
        switch scope {
        case WidgetStore.overdueScope:
            displayedTasks = TasksTimeline.overdueTasks(from: tasks, now: now)
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
// MARK: - Previews (2026-09-24, realistic sample data)
//
// Realistic sample open tasks with the shape of the account whose "Up next
// · 26 due" paged as 13 pages of two rows: 26 dated, non-reminder,
// non-quota tasks, soonest first, with the same title lengths (including
// the long permit-forms and streaming-trial ones), priorities, due times and
// project colors. The titles are invented. With `ios/Previews.local/`'s
// `tasks.json`/`projects.json`/`time-slots.json` present
// (`PreviewLocalData`, gitignored) they render that account data instead.
// See `RemindersWidget.swift`'s preview header for why this is here and not
// in `SampleData.swift`, and why each store state (page, toggle, mode) gets
// its own `#Preview` block.
private enum TasksPreviewData {
    /// The sample's clock: 8:45 AM local today.
    static var now: Date {
        Calendar.current.date(bySettingHour: 8, minute: 45, second: 0, of: Date()) ?? Date()
    }

    /// A sample due date moved by however many whole days separate the
    /// sample's day (2026-09-24) from today — so "today" stays today,
    /// "Tomorrow" stays tomorrow, and the day-naming buckets render the same
    /// whatever day the preview runs.
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
        PreviewLocalData.projects ?? [
            ProjectDTO(id: 1, name: "Inbox", color: nil),
            ProjectDTO(id: 6, name: "Work", color: "red"),
            ProjectDTO(id: 4434, name: "Personal", color: "blue"),
            ProjectDTO(id: 4799, name: "Infra", color: "green"),
        ]
    }

    static var tasks: [TaskDTO] {
        PreviewLocalData.openTasks ?? [
            TaskDTO(id: 23533, projectId: 6, title: "Reply to the pending team messages", priority: 3, dueAt: shifted("2026-09-24T14:00:00.000Z")),
            TaskDTO(id: 22067, projectId: 4434, title: "Email the venue about the room booking before the Oct 1 planning meeting", priority: 3, dueAt: shifted("2026-09-24T22:00:00.000Z")),
            TaskDTO(id: 22793, projectId: 4434, title: "Order birdseed", priority: 2, dueAt: shifted("2026-09-25T01:30:00.000Z")),
            TaskDTO(id: 292, projectId: 4434, title: "Weekly plant food ($6)", priority: 2, dueAt: shifted("2026-09-25T21:00:00.000Z")),
            TaskDTO(id: 308, projectId: 4434, title: "Check out the library pottery class", priority: 1, dueAt: shifted("2026-09-26T14:00:00.000Z")),
            TaskDTO(id: 22586, projectId: 6, title: "Submit timesheet before the weekly cutoff", priority: 3, dueAt: shifted("2026-09-27T14:00:00.000Z")),
            TaskDTO(id: 249, projectId: 4434, title: "Donations? (including shoes)", priority: 2, dueAt: shifted("2026-09-27T22:00:00.000Z")),
            TaskDTO(id: 290, projectId: 4434, title: "Compost bin out", priority: 3, dueAt: shifted("2026-09-27T22:00:00.000Z")),
            TaskDTO(id: 11160, projectId: 4434, title: "Sweep the porch", priority: 3, dueAt: shifted("2026-09-27T22:30:00.000Z")),
            TaskDTO(id: 23555, projectId: 4434, title: "Return the signed permit forms by Oct 2 (the office says they never arrived; the upload link was broken)", priority: 3, dueAt: shifted("2026-09-28T14:00:00.000Z")),
            TaskDTO(id: 17931, projectId: 4799, title: "Look into a build-cache invalidation flag for the CI runner", priority: 1, dueAt: shifted("2026-09-30T14:00:00.000Z")),
            TaskDTO(id: 302, projectId: 4434, title: "Pay the water bill", priority: 3, dueAt: shifted("2026-10-01T12:00:00.000Z")),
            TaskDTO(id: 8385, projectId: 4434, title: "Check if the passport renewal is finished", priority: 1, dueAt: shifted("2026-10-01T14:00:00.000Z")),
            TaskDTO(id: 8870, projectId: 4434, title: "E-sign the new lease and the move-out notice for the old one", priority: 1, dueAt: shifted("2026-10-01T14:00:00.000Z")),
            TaskDTO(id: 9214, projectId: 4434, title: "Make sure the new thermostat is set up properly", priority: 1, dueAt: shifted("2026-10-01T14:00:00.000Z")),
            TaskDTO(id: 9215, projectId: 6, title: "Make sure the old gym membership is cancelled", priority: 1, dueAt: shifted("2026-10-01T14:00:00.000Z")),
            TaskDTO(id: 9312, projectId: 4434, title: "Call the utility company to set up paperless billing and autopay for the new apartment", priority: 1, dueAt: shifted("2026-10-01T14:00:00.000Z")),
            TaskDTO(id: 12224, projectId: 4434, title: "Do something that improves the garden", priority: 2, dueAt: shifted("2026-10-01T14:00:00.000Z")),
            TaskDTO(id: 13256, projectId: 6, title: "Apply for the community garden plot", priority: 1, dueAt: shifted("2026-10-01T14:00:00.000Z")),
            TaskDTO(id: 11315, projectId: 4434, title: "Check the tire pressure", priority: 2, dueAt: shifted("2026-10-01T14:30:00.000Z")),
            TaskDTO(id: 13490, projectId: 4434, title: "Add the new address to the library card", priority: 2, dueAt: shifted("2026-10-01T20:00:00.000Z")),
            TaskDTO(id: 16551, projectId: 4434, title: "Cancel the video streaming free trial before it auto-renews at $7.99/mo (30-day trial started ~9/1/26, ends ~10/1)", priority: 3, dueAt: shifted("2026-10-04T15:00:00.000Z")),
            TaskDTO(id: 21853, projectId: 6, title: "Cancel the photo editor trial before it renews", priority: 3, dueAt: shifted("2026-10-07T14:00:00.000Z")),
            TaskDTO(id: 22794, projectId: 4434, title: "Use the museum guest passes before October 11", priority: 1, dueAt: shifted("2026-10-10T14:00:00.000Z")),
            TaskDTO(id: 12343, projectId: 4434, title: "Pull the annual utility statements — verify the year-end totals match & flag any overcharges", priority: 3, dueAt: shifted("2026-10-12T23:00:00.000Z")),
            TaskDTO(id: 296, projectId: 4434, title: "Clean out the dryer vent", priority: 1, dueAt: shifted("2026-10-17T16:30:00.000Z")),
        ]
    }

    /// One recent completion, stamped this morning so the "show completed"
    /// DONE section has something to render.
    static var doneToday: [CompletionDTO] {
        let at = Calendar.current.date(bySettingHour: 8, minute: 15, second: 0, of: Date()) ?? Date()
        return [
            CompletionDTO(
                id: -1286, taskId: 22852, completedAt: DateHelpers.formatISO(at),
                taskTitle: "Pick the next book for the reading list", projectId: 4434
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

    /// "Up next" with the sample's rows PLUS every due-label shape an
    /// 11:55 screenshot mixed (2026-09-24, the one-rule fix): a "Tomorrow"
    /// at 12:00 pm, and two DATE-ONLY tasks (local midnight — one tomorrow,
    /// one three days out) whose label is a day word alone, one line. The
    /// sample already carries today (time only), "Tomorrow 4:00 pm" and a
    /// weekday ("Sat 9:00 am").
    static func dayLabelsEntry() -> TasksEntry {
        let calendar = Calendar.current
        let today = calendar.startOfDay(for: now)
        func day(_ offset: Int, hour: Int = 0) -> String {
            let base = calendar.date(byAdding: .day, value: offset, to: today) ?? today
            return DateHelpers.formatISO(calendar.date(bySettingHour: hour, minute: 0, second: 0, of: base) ?? base)
        }
        let extra = [
            TaskDTO(id: 900_001, projectId: 4434, title: "Drop off the parcel", priority: 2, dueAt: day(1, hour: 12)),
            TaskDTO(id: 900_002, projectId: 6, title: "Send invoice", priority: 1, dueAt: day(1)),
            TaskDTO(id: 900_003, projectId: 4434, title: "Library books due", priority: 1, dueAt: day(3)),
        ]
        let all = tasks + extra
        return TasksEntry(
            date: now,
            tasks: TasksTimeline.upNextTasks(from: all),
            projects: projects,
            scope: WidgetStore.upNextScope,
            staleSince: nil,
            isSignedOut: false,
            canUndo: true,
            canRedo: false,
            actionDescription: nil,
            colorProjects: projects,
            doneTasks: [],
            overdueSweepCount: TasksTimeline.overdueSweepEligibleCount(from: all)
        )
    }

    /// The Overdue page (2026-09-25) — SYNTHETIC titles (the repo is public;
    /// real-data renders are done locally and never committed), long enough
    /// to wrap, overdue by an hour up to four days, most overdue first.
    static func overdueEntry() -> TasksEntry {
        func ago(_ hours: Double) -> String { DateHelpers.formatISO(now.addingTimeInterval(-hours * 3600)) }
        let overdue = [
            TaskDTO(id: 800_001, projectId: 4434, title: "Renew the library card before the branch closes for the holiday weekend", priority: 2, dueAt: ago(96)),
            TaskDTO(id: 800_002, projectId: 6, title: "Send the quarterly summary to the team, including the open questions from last week's review", priority: 3, dueAt: ago(50)),
            TaskDTO(id: 800_003, projectId: 1, title: "Water the plants", priority: 1, dueAt: ago(26)),
            TaskDTO(id: 800_004, projectId: 4799, title: "Rotate the backup drive and check that last night's snapshot finished", priority: 2, dueAt: ago(5)),
            TaskDTO(id: 800_005, projectId: 4434, title: "Call the dentist to move the appointment", priority: 1, dueAt: ago(1)),
        ]
        let all = tasks + overdue
        return TasksEntry(
            date: now,
            tasks: TasksTimeline.overdueTasks(from: all, now: now),
            projects: projects,
            scope: WidgetStore.overdueScope,
            staleSince: nil,
            isSignedOut: false,
            canUndo: true,
            canRedo: false,
            actionDescription: nil,
            colorProjects: projects,
            doneTasks: [],
            overdueSweepCount: TasksTimeline.overdueSweepEligibleCount(from: all, now: now)
        )
    }

    /// The "Personal" project page (4434) — the longest project name,
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
    // Seed `TimeSlotStore` with the sample slots — the widget extension
    // only ever READS that cache (the main app populates it), so an
    // unseeded preview renders every "⏭ Next period" button disabled,
    // which a real device never shows.
    TimeSlotStore.save(PreviewLocalData.timeSlots ?? [
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

/// Every due-label shape — see `dayLabelsEntry()`; page 2 reaches the
/// weekday and "Oct 1"-style dated rows.
#Preview("Tasks Large — Up next, day labels", as: .systemLarge) {
    TasksWidget()
} timeline: {
    let _ = resetTasksPreviewState(page: 0)
    TasksPreviewData.dayLabelsEntry()
}

#Preview("Tasks Large — Up next, day labels page 2", as: .systemLarge) {
    TasksWidget()
} timeline: {
    let _ = resetTasksPreviewState(page: 1)
    TasksPreviewData.dayLabelsEntry()
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

#Preview("Tasks Large — Up next page 4", as: .systemLarge) {
    TasksWidget()
} timeline: {
    let _ = resetTasksPreviewState(page: 3)
    TasksPreviewData.entry()
}

#Preview("Tasks Large — Up next page 5", as: .systemLarge) {
    TasksWidget()
} timeline: {
    let _ = resetTasksPreviewState(page: 4)
    TasksPreviewData.entry()
}

#Preview("Tasks Large — Up next page 6", as: .systemLarge) {
    TasksWidget()
} timeline: {
    let _ = resetTasksPreviewState(page: 5)
    TasksPreviewData.entry()
}

#Preview("Tasks Large — Up next page 7", as: .systemLarge) {
    TasksWidget()
} timeline: {
    let _ = resetTasksPreviewState(page: 6)
    TasksPreviewData.entry()
}

#Preview("Tasks Large — Up next page 8", as: .systemLarge) {
    TasksWidget()
} timeline: {
    let _ = resetTasksPreviewState(page: 7)
    TasksPreviewData.entry()
}

#Preview("Tasks Large — Up next page 9", as: .systemLarge) {
    TasksWidget()
} timeline: {
    let _ = resetTasksPreviewState(page: 8)
    TasksPreviewData.entry()
}

#Preview("Tasks Large — Up next page 10", as: .systemLarge) {
    TasksWidget()
} timeline: {
    let _ = resetTasksPreviewState(page: 9)
    TasksPreviewData.entry()
}

#Preview("Tasks Large — Up next page 11", as: .systemLarge) {
    TasksWidget()
} timeline: {
    let _ = resetTasksPreviewState(page: 10)
    TasksPreviewData.entry()
}

#Preview("Tasks Large — Up next page 12", as: .systemLarge) {
    TasksWidget()
} timeline: {
    let _ = resetTasksPreviewState(page: 11)
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

#Preview("Tasks Large — Overdue", as: .systemLarge) {
    TasksWidget()
} timeline: {
    let _ = resetTasksPreviewState()
    let _ = WidgetStore.setTasksPage(0, for: WidgetStore.overdueScope)
    TasksPreviewData.overdueEntry()
}

#Preview("Tasks Medium — Overdue", as: .systemMedium) {
    TasksWidget()
} timeline: {
    let _ = resetTasksPreviewState()
    TasksPreviewData.overdueEntry()
}

#Preview("Tasks Small — Overdue", as: .systemSmall) {
    TasksWidget()
} timeline: {
    let _ = resetTasksPreviewState()
    TasksPreviewData.overdueEntry()
}

#Preview("Tasks Medium", as: .systemMedium) {
    TasksWidget()
} timeline: {
    let _ = resetTasksPreviewState()
    TasksPreviewData.entry()
}

#Preview("Tasks Small", as: .systemSmall) {
    TasksWidget()
} timeline: {
    let _ = resetTasksPreviewState(page: 0)
    TasksPreviewData.entry()
}

#endif
