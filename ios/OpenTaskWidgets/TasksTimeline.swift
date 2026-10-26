import Foundation

// Foundation-only on purpose (2026-09-25, the Overdue scope): the Tasks
// widget's list rules and its scope ring/default live here, apart from the
// SwiftUI entry/provider in TasksWidget.swift, so the macOS logic-test bundle
// (`OpenTaskLogicTests`, ios/AGENTS.md § Tests) can compile and test them.

// MARK: - Today's set

/// The "what counts as today" rule, plus scope handling.
///
/// The server has no today endpoint — the dashboard fetches the open set from
/// `GET /api/tasks` and buckets client-side — so the widget applies the same
/// rule here rather than inventing an endpoint.
enum TasksTimeline {

    // The list rules themselves (exclusions, order, the overdue test, the
    // sweep estimate) live in `TaskLists` (ios/Shared) since 2026-09-28, so
    // the Mac menu bar item counts "overdue" exactly as the widget does. The
    // page functions below forward to it; each doc says only which page uses it.

    /// The "All overdue" snooze-mode bar's count (2026-09-23, Phase 2) — an
    /// estimate; see `TaskLists.overdueSweepEligibleCount` for the rule and its
    /// two accepted gaps versus the server. `taskQueue` (one High per press)
    /// is read at this edge from what the app or the Quotas widget last
    /// cached (`DayStartStore.cachedTaskQueue`).
    static func overdueSweepEligibleCount(
        from tasks: [TaskDTO], now: Date = Date(), taskQueue: Bool = DayStartStore.cachedTaskQueue
    ) -> Int {
        TaskLists.overdueSweepEligibleCount(tasks, now: now, taskQueue: taskQueue)
    }

    /// Due or overdue as of the end of the OpenTask day (`TaskLists.dueToday`)
    /// — the "Today" unified page (2026-09-23, item 4) and, unchanged, what
    /// every per-project page still shows.
    static func todaysTasks(from tasks: [TaskDTO], now: Date = Date(), day: OpenTaskDay) -> [TaskDTO] {
        TaskLists.dueToday(tasks, now: now, day: day)
    }

    /// "Up next" (2026-09-23, item 4) — Trent: "Instead of Up Next I'd also
    /// like to have just a Today one… We need a Today one as well." This is
    /// what "Up next" used to mean before that request split it in two:
    /// every dated open task the widget considers at all, soonest (most
    /// overdue) first, with NO end-of-today cutoff — `TaskLists.eligible`'s
    /// exclusions apply exactly as `todaysTasks` uses them.
    static func upNextTasks(from tasks: [TaskDTO]) -> [TaskDTO] {
        TaskLists.upNext(tasks)
    }

    /// The DONE list for "show completed" (2026-09-23) — today's completions,
    /// scoped the same way `todaysTasks`/`upNextTasks` scope the OPEN list:
    /// reminders and tracked items are excluded ALWAYS (their own widgets own
    /// that data — same exclusions `TaskLists.eligible` applies), and a
    /// per-project page filters further by `project_id`. The unified pages
    /// (Overdue/Today/Up next) show every one of today's matching
    /// completions, unfiltered by project.
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
        // `isQuota`, not the bare `isTracked` flag (2026-09-24): most quotas
        // predate the flag and are quotas by target alone, and a quota's
        // completion (its period rollover) must never be offered for put-back
        // — `POST /api/tasks/:id/undone` refuses quotas.
        let eligible = completions.filter { !$0.isReminder && !$0.isQuota }
        let scoped: [CompletionDTO]
        if isUnifiedScope(scope) {
            scoped = eligible
        } else {
            scoped = eligible.filter { $0.projectId == scope }
        }
        return scoped.sorted { ($0.completedDate ?? .distantPast) > ($1.completedDate ?? .distantPast) }
    }

    /// Whether `scope` is one of the project-less pages — Overdue, Today, Up
    /// next — rather than one project's.
    static func isUnifiedScope(_ scope: Int) -> Bool {
        scope == WidgetStore.overdueScope || scope == WidgetStore.allProjects
            || scope == WidgetStore.upNextScope
    }

    /// Filters to one project's slice of `tasks`. Only ever called with a
    /// real project id now — the unified scopes (`overdueScope`, `allProjects`,
    /// `upNextScope`) are resolved by `TasksProvider.makeEntry` before this
    /// is reached, each from its own source list (`overdueTasks` /
    /// `todaysTasks` / `upNextTasks`), not by a no-op pass through here.
    static func apply(scope: Int, to tasks: [TaskDTO]) -> [TaskDTO] {
        tasks.filter { $0.projectId == scope }
    }

    /// Due times still ahead of us today. An entry at each one lets a task
    /// visibly tip into overdue at the right minute without spending budget.
    static func upcomingDueDates(in tasks: [TaskDTO], now: Date = Date()) -> [Date] {
        tasks.compactMap(\.dueDate).filter { $0 > now }.sorted()
    }

    // MARK: Day complete (2026-09-29)

    /// The Today page's finished states — `TaskDayProgress` (ios/Shared) has
    /// the rules; these gate them to the Today page. Day complete, the green
    /// wash and "N of M" belong to Today alone: an empty Up next or project
    /// page says nothing about the day, and neither does an empty Over
    /// target page (it stays on screen at 0 since 2026-10-12).
    static func isDayComplete(scope: Int, openTasks: [TaskDTO], done: [CompletionDTO], now: Date, day: OpenTaskDay) -> Bool {
        scope == WidgetStore.allProjects
            && TaskDayProgress.isDayComplete(
                openToday: openTasks.count, doneToday: TaskDayProgress.doneToday(done, now: now, day: day).count
            )
    }

    /// The Today page's "N of M", nil on every other page.
    static func todayCount(
        scope: Int, openTasks: [TaskDTO], done: [CompletionDTO], now: Date, day: OpenTaskDay
    ) -> TaskDayProgress.TodayCount? {
        guard scope == WidgetStore.allProjects else { return nil }
        return TaskDayProgress.TodayCount(
            doneToday: TaskDayProgress.doneToday(done, now: now, day: day).count, openToday: openTasks.count
        )
    }

    /// What the timeline entry carries for "Up next" under "Nothing due
    /// today": the next few tasks due after today, and ONLY when that state
    /// can show (the Today page, nothing open on it) — every other entry
    /// carries none, since WidgetKit archives each one.
    static func upcomingForEmptyToday(
        scope: Int, openOnPage: [TaskDTO], allTasks: [TaskDTO], now: Date, day: OpenTaskDay
    ) -> [TaskDTO] {
        guard scope == WidgetStore.allProjects, openOnPage.isEmpty else { return [] }
        return TaskDayProgress.upcoming(allTasks, now: now, day: day)
    }

    // MARK: Over target (2026-09-25)

    /// The "Overdue" page. `TaskLists.overdue`: every eligible task whose
    /// due time has passed, most overdue first (the order every other Tasks
    /// page uses). Its doc has why that matches the web dashboard's Overdue
    /// chip, which the header link opens.
    static func overdueTasks(from tasks: [TaskDTO], now: Date = Date()) -> [TaskDTO] {
        TaskLists.overdue(tasks, now: now)
    }

    // MARK: Navigation (2026-10-12, mockup B-3 "fixed views plus project chip")
    //
    // Trent, on the old chevron ring (Over target only while something was,
    // then Today, Up next, then each project with something due — pages
    // appearing and disappearing mid-ring, Over target jumping in on its own,
    // and nothing showing where you were): "I lose my spot." What replaced it:
    //
    // - Three FIXED view segments, "Over · Today · Next", always present in
    //   that order (Over dims at 0 rather than leaving), plus ONE "Projects ›"
    //   chip that steps through projects. Each control names its page by a
    //   stable KEY (−3/−1/−2, or a project id), never an index into a list
    //   that may have changed since the widget was drawn.
    // - The page the user picked is stored and kept. Nothing moves them: not
    //   something going over target (the Over segment's count is the signal),
    //   not the page emptying (it shows its empty state). The one exception is
    //   a project that no longer exists at all, which falls back to Today.
    // - With nothing stored (a fresh widget) the page is Today. It used to be
    //   Over target whenever anything was (2026-09-25), which meant a
    //   never-touched widget flipped to Over the minute a task tipped over —
    //   the same auto-jump in another form.

    /// The three view pages, in the control's order.
    static let viewPages = [WidgetStore.overdueScope, WidgetStore.allProjects, WidgetStore.upNextScope]

    /// The projects the "Projects ›" chip steps through: every project with
    /// something on its page — something due today or over target
    /// (`todaysTasks`, which is what a project page shows) — in the server's
    /// order (`sort_order`, then name).
    ///
    /// Why not every project: at 12–20 projects most taps would land on an
    /// empty page. Why this is still stable: the chip steps by KEY, relative
    /// to the FULL project order (`nextProject`), so a project joining or
    /// leaving this list never moves the page on screen, and stepping on from
    /// a project that just emptied continues to the next one in sort order
    /// rather than starting over.
    static func projectPages(tasks: [TaskDTO], projects: [ProjectDTO], now: Date = Date(), day: OpenTaskDay) -> [ProjectDTO] {
        let present = Set(todaysTasks(from: tasks, now: now, day: day).map(\.projectId))
        return projects.filter { present.contains($0.id) }
    }

    /// The page to show: the stored page while it still names something,
    /// else Today. A view key always does; a project id does while the
    /// project exists, whether or not anything is due in it.
    static func resolvePage(stored: Int?, projects: [ProjectDTO]) -> Int {
        guard let stored else { return WidgetStore.allProjects }
        if viewPages.contains(stored) { return stored }
        return projects.contains(where: { $0.id == stored }) ? stored : WidgetStore.allProjects
    }

    /// Where the "Projects ›" chip goes from `current`: off a project page,
    /// the first project with something on it; on one, the next such project
    /// after it in the full server order, wrapping round to the first. Nil
    /// when there is nowhere else to go — no project has anything, or the
    /// only one that does is already on screen — so the chip can dim rather
    /// than be a button that does nothing.
    static func nextProject(after current: Int, pages: [ProjectDTO], allProjects: [ProjectDTO]) -> Int? {
        guard let first = pages.first else { return nil }
        guard let position = allProjects.firstIndex(where: { $0.id == current }) else {
            return first.id
        }
        var order: [Int: Int] = [:]
        for (index, project) in allProjects.enumerated() where order[project.id] == nil {
            order[project.id] = index
        }
        let next = pages.first { (order[$0.id] ?? -1) > position } ?? first
        return next.id == current ? nil : next.id
    }

    /// Everything the widget needs to draw and act on its page, from one set
    /// of tasks.
    struct ScopeState: Equatable {
        /// The page on screen.
        let scope: Int
        /// Every page a jump may land on: the three views, then every project
        /// (so a tap on a project that has since emptied still lands, and
        /// shows that project's empty state).
        let pages: [Int]
        /// The chip's projects (`projectPages`), in server order.
        let projectPages: [ProjectDTO]
        /// Where the chip goes from here (`nextProject`).
        let nextProject: Int?
        /// The segments' counts.
        let overCount: Int
        let todayCount: Int
    }

    static func scopeState(tasks: [TaskDTO], projects: [ProjectDTO], now: Date = Date(), day: OpenTaskDay) -> ScopeState {
        let scope = resolvePage(stored: WidgetStore.tasksStoredPage(), projects: projects)
        let chipProjects = projectPages(tasks: tasks, projects: projects, now: now, day: day)
        return ScopeState(
            scope: scope,
            pages: viewPages + projects.map(\.id),
            projectPages: chipProjects,
            nextProject: nextProject(after: scope, pages: chipProjects, allProjects: projects),
            overCount: overdueTasks(from: tasks, now: now).count,
            todayCount: todaysTasks(from: tasks, now: now, day: day).count
        )
    }

    /// The page on screen right now, for the intents that key state by it
    /// (the page, the bulk-select picks, the jump and the chip). Built from
    /// the same cache the provider's interaction fast path repaints from,
    /// with the same completion tombstones applied (`WidgetStore.
    /// filterPending`), so an intent and the render it triggers agree.
    static func currentScopeState(now: Date = Date()) -> ScopeState? {
        guard let cache = WidgetStore.loadTasks()?.value else { return nil }
        return scopeState(
            tasks: WidgetStore.filterPending(cache.tasks, now: now), projects: cache.projects, now: now,
            day: DayStartStore.current
        )
    }

    /// `currentScopeState`'s scope; before any payload was cached, the
    /// stored page (else Today).
    static func currentScope(now: Date = Date()) -> Int {
        currentScopeState(now: now)?.scope ?? (WidgetStore.tasksStoredPage() ?? WidgetStore.allProjects)
    }
}
