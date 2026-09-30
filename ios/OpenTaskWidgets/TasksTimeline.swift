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
    /// two accepted gaps versus the server.
    static func overdueSweepEligibleCount(from tasks: [TaskDTO], now: Date = Date()) -> Int {
        TaskLists.overdueSweepEligibleCount(tasks, now: now)
    }

    /// Due or overdue as of the end of the local day — the "Today" unified
    /// page (2026-09-23, item 4) and, unchanged, what every per-project page
    /// still shows.
    static func todaysTasks(from tasks: [TaskDTO], now: Date = Date()) -> [TaskDTO] {
        TaskLists.dueToday(tasks, now: now)
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
    /// page says nothing about the day. (The Overdue page is never empty —
    /// it leaves the ring when nothing is overdue.)
    static func isDayComplete(scope: Int, openTasks: [TaskDTO], done: [CompletionDTO], now: Date) -> Bool {
        scope == WidgetStore.allProjects
            && TaskDayProgress.isDayComplete(
                openToday: openTasks.count, doneToday: TaskDayProgress.doneToday(done, now: now).count
            )
    }

    /// The Today page's "N of M", nil on every other page.
    static func todayCount(scope: Int, openTasks: [TaskDTO], done: [CompletionDTO], now: Date) -> TaskDayProgress.TodayCount? {
        guard scope == WidgetStore.allProjects else { return nil }
        return TaskDayProgress.TodayCount(
            doneToday: TaskDayProgress.doneToday(done, now: now).count, openToday: openTasks.count
        )
    }

    /// What the timeline entry carries for "Up next" under "Nothing due
    /// today": the next few tasks due after today, and ONLY when that state
    /// can show (the Today page, nothing open on it) — every other entry
    /// carries none, since WidgetKit archives each one.
    static func upcomingForEmptyToday(scope: Int, openOnPage: [TaskDTO], allTasks: [TaskDTO], now: Date) -> [TaskDTO] {
        guard scope == WidgetStore.allProjects, openOnPage.isEmpty else { return [] }
        return TaskDayProgress.upcoming(allTasks, now: now)
    }

    // MARK: Overdue (2026-09-25)

    /// The "Overdue" page — Trent: "if things are overdue, I'd like that to be
    /// the default widget screen for the tasks." `TaskLists.overdue`: every
    /// eligible task whose due time has passed, most overdue first (the
    /// order every other Tasks page uses). Its doc has why that matches the
    /// web dashboard's Overdue chip, which the header link opens.
    static func overdueTasks(from tasks: [TaskDTO], now: Date = Date()) -> [TaskDTO] {
        TaskLists.overdue(tasks, now: now)
    }

    /// The page the widget opens on when the user hasn't chosen one (or their
    /// choice has lapsed — see `resolveScope`): Overdue while anything is
    /// overdue, else Today, which is what it always was.
    static func naturalScope(overdueCount: Int) -> Int {
        overdueCount > 0 ? WidgetStore.overdueScope : WidgetStore.allProjects
    }

    /// The chevrons' ring, in order: Overdue (only while something is — no
    /// page for nothing, Trent's "no chrome for something that isn't there"),
    /// Today, Up next, then every project with something due today.
    ///
    /// The ONE place the ring is built: `ShiftProjectScopeIntent` cycles it
    /// and `resolveScope` checks a stored choice against it, and two copies
    /// would drift on the first change.
    static func scopeRing(tasks: [TaskDTO], projects: [ProjectDTO], now: Date = Date()) -> [Int] {
        let overdue = overdueTasks(from: tasks, now: now).isEmpty ? [] : [WidgetStore.overdueScope]
        return overdue + [WidgetStore.allProjects, WidgetStore.upNextScope]
            + scopedProjects(tasks: tasks, projects: projects, now: now).map(\.id)
    }

    /// Which page to show: the user's chevron choice while it still holds,
    /// else the natural default.
    ///
    /// A choice is paired with the natural default it was made against
    /// (`WidgetStore.TasksScopeChoice`) — the Reminders slot override's
    /// self-expiring trick. While the natural default is unchanged the choice
    /// is honored ("I chevroned to Up next, leave me there"); the moment it
    /// changes — overdue appears, so the default becomes Overdue, or the last
    /// overdue task is done or snoozed, so it drops back to Today — the choice
    /// lapses and the new default shows, with no timer or reset anywhere.
    /// A choice no longer in the ring (a project with nothing due today any
    /// more, or Overdue once nothing is) lapses too, rather than stranding
    /// the widget on an empty page it can only escape by chevroning.
    static func resolveScope(choice: WidgetStore.TasksScopeChoice?, natural: Int, ring: [Int]) -> Int {
        guard let choice, choice.naturalScope == natural, ring.contains(choice.scope) else {
            return natural
        }
        return choice.scope
    }

    /// Everything `resolveScope` needs, from one set of tasks — the scope on
    /// screen, the ring around it, and the natural default the ring's
    /// chevrons should anchor a new choice to.
    struct ScopeState: Equatable {
        let scope: Int
        let ring: [Int]
        let natural: Int
    }

    static func scopeState(tasks: [TaskDTO], projects: [ProjectDTO], now: Date = Date()) -> ScopeState {
        let ring = scopeRing(tasks: tasks, projects: projects, now: now)
        let natural = naturalScope(overdueCount: overdueTasks(from: tasks, now: now).count)
        let scope = resolveScope(choice: WidgetStore.tasksScopeChoice(), natural: natural, ring: ring)
        return ScopeState(scope: scope, ring: ring, natural: natural)
    }

    /// The scope on screen right now, for the intents that key state by it
    /// (the page, the bulk-select picks, the chevrons). Built from the same
    /// cache the provider's interaction fast path repaints from, with the
    /// same completion tombstones applied (`WidgetStore.filterPending`), so
    /// an intent and the render it triggers agree on the page — including
    /// the tap that checks off the last overdue task and drops the widget
    /// back to Today.
    static func currentScopeState(now: Date = Date()) -> ScopeState? {
        guard let cache = WidgetStore.loadTasks()?.value else { return nil }
        return scopeState(tasks: WidgetStore.filterPending(cache.tasks, now: now), projects: cache.projects, now: now)
    }

    /// `currentScopeState`'s scope, or Today before any payload was cached.
    static func currentScope(now: Date = Date()) -> Int {
        currentScopeState(now: now)?.scope ?? WidgetStore.allProjects
    }
}

