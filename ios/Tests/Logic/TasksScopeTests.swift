import XCTest

/// The Tasks widget's pages (2026-10-12, mockup B-3): three fixed view
/// segments addressed by stable keys, a "Projects ›" chip that steps through
/// projects in server order, and a stored page that nothing but the user
/// moves (`TasksTimeline` § Navigation). Synthetic titles only — the repo is
/// public.
final class TasksScopeTests: WidgetStoreTestCase {

    private let now = Date(timeIntervalSince1970: 1_768_492_800) // 2026-01-15T16:00:00Z
    /// Midnight in the machine's zone: these cases are about the pages, not
    /// the day start.
    private let day = OpenTaskDay.midnight(timeZone: .current)

    /// Server order: Inbox, Work, Home, Garden.
    private let projects = [
        ProjectDTO(id: 1, name: "Inbox", color: nil),
        ProjectDTO(id: 2, name: "Work", color: "red"),
        ProjectDTO(id: 3, name: "Home", color: "orange"),
        ProjectDTO(id: 4, name: "Garden", color: "green"),
    ]

    private func iso(_ offset: TimeInterval) -> String {
        DateHelpers.formatISO(now.addingTimeInterval(offset))
    }

    private func task(_ id: Int, due offset: TimeInterval?, project: Int = 1, priority: Int = 1) -> TaskDTO {
        TaskDTO(id: id, projectId: project, title: "Task \(id)", priority: priority, dueAt: offset.map(iso))
    }

    /// Nothing over target: Inbox and Home have something due later today,
    /// Work only tomorrow, Garden nothing dated.
    private var calm: [TaskDTO] {
        [task(1, due: 3600), task(2, due: 26 * 3600, project: 2), task(3, due: nil, project: 4), task(4, due: 7200, project: 3)]
    }

    /// `calm` plus two over-target tasks (one three days late, one an hour
    /// late, in Work and Inbox).
    private var withOverdue: [TaskDTO] {
        calm + [task(10, due: -3600, project: 2), task(11, due: -3 * 86400)]
    }

    private func state(_ tasks: [TaskDTO], projects: [ProjectDTO]? = nil) -> TasksTimeline.ScopeState {
        TasksTimeline.scopeState(tasks: tasks, projects: projects ?? self.projects, now: now, day: day)
    }

    // MARK: The over-target list

    func testOverdueListIsEligibleTasksPastDueMostOverdueFirst() {
        let reminder = TaskDTO(id: 20, projectId: 1, title: "A reminder", dueAt: iso(-7200), isReminder: true)
        let quota = TaskDTO(id: 21, projectId: 1, title: "A quota", dueAt: iso(-7200), progressTarget: 3)
        let list = TasksTimeline.overdueTasks(from: withOverdue + [reminder, quota], now: now)
        // Reminders (§6: no debt) and quotas (§5) are never over target, as
        // on the web's chip and the server's badge.
        XCTAssertEqual(list.map(\.id), [11, 10])
    }

    // MARK: Stable keys, Over always present

    func testViewPagesAreThreeFixedKeysInOrder() {
        XCTAssertEqual(TasksTimeline.viewPages, [-3, -1, -2])
        XCTAssertEqual(TasksTimeline.viewPages, [WidgetStore.overdueScope, WidgetStore.allProjects, WidgetStore.upNextScope])
    }

    func testOverIsAPageWhetherOrNotAnythingIsOver() {
        for tasks in [calm, withOverdue] {
            let s = state(tasks)
            XCTAssertEqual(Array(s.pages.prefix(3)), TasksTimeline.viewPages)
            // Every project is a page a jump may land on, empty or not.
            XCTAssertEqual(Array(s.pages.dropFirst(3)), projects.map(\.id))
        }
        XCTAssertEqual(state(calm).overCount, 0)
        XCTAssertEqual(state(withOverdue).overCount, 2)
    }

    func testTodayCountIsTodaysWholeSet() {
        // Today includes over target: 2 due later today + 2 over.
        XCTAssertEqual(state(calm).todayCount, 2)
        XCTAssertEqual(state(withOverdue).todayCount, 4)
    }

    // MARK: No auto-jump

    func testFreshWidgetOpensOnTodayEvenWithSomethingOver() {
        XCTAssertNil(WidgetStore.tasksStoredPage())
        XCTAssertEqual(state(withOverdue).scope, WidgetStore.allProjects)
    }

    func testStoredPageIsKeptWhenSomethingGoesOver() {
        WidgetStore.setTasksStoredPage(WidgetStore.upNextScope)
        XCTAssertEqual(state(calm).scope, WidgetStore.upNextScope)
        XCTAssertEqual(state(withOverdue).scope, WidgetStore.upNextScope)
    }

    func testOverPageStaysWhenItsLastTaskGoes() {
        WidgetStore.setTasksStoredPage(WidgetStore.overdueScope)
        XCTAssertEqual(state(withOverdue).scope, WidgetStore.overdueScope)
        XCTAssertEqual(state(calm).scope, WidgetStore.overdueScope, "an empty Over page shows its empty state")
    }

    func testCurrentScopeKeepsOverAfterTheLastTombstone() {
        WidgetStore.setTasksStoredPage(WidgetStore.overdueScope)
        WidgetStore.saveTasks(withOverdue, projects: projects, completions: [], fetchStartedAt: now)
        XCTAssertEqual(TasksTimeline.currentScope(now: now), WidgetStore.overdueScope)

        // Checking off both over-target tasks (optimistically) leaves the
        // widget where it is, now empty, and the Over count at 0.
        WidgetStore.stagePendingCompletion(10, now: now)
        WidgetStore.stagePendingCompletion(11, now: now)
        let s = TasksTimeline.currentScopeState(now: now)
        XCTAssertEqual(s?.scope, WidgetStore.overdueScope)
        XCTAssertEqual(s?.overCount, 0)
    }

    func testCurrentScopeBeforeAnyPayload() {
        XCTAssertNil(TasksTimeline.currentScopeState(now: now))
        XCTAssertEqual(TasksTimeline.currentScope(now: now), WidgetStore.allProjects)
        WidgetStore.setTasksStoredPage(WidgetStore.upNextScope)
        XCTAssertEqual(TasksTimeline.currentScope(now: now), WidgetStore.upNextScope)
    }

    func testValueStoredByAnOlderBuildReadsAsAPlainPage() throws {
        // 2026-09-25 to 2026-10-12 stored the page with a "natural default"
        // anchor that made it lapse. The anchor is ignored now.
        let defaults = try XCTUnwrap(WidgetStore.suiteOverride)
        defaults.set(WidgetStore.upNextScope, forKey: "widget.tasks.projectId")
        defaults.set(WidgetStore.allProjects, forKey: "widget.tasks.projectId.naturalScope")
        XCTAssertEqual(state(withOverdue).scope, WidgetStore.upNextScope)
        WidgetStore.setTasksStoredPage(2)
        XCTAssertNil(defaults.object(forKey: "widget.tasks.projectId.naturalScope"))
    }

    // MARK: Project pages

    func testChipListIsProjectsWithSomethingTodayInServerOrder() {
        XCTAssertEqual(state(calm).projectPages.map(\.id), [1, 3])
        // Work joins once something in it is over target.
        XCTAssertEqual(state(withOverdue).projectPages.map(\.id), [1, 2, 3])
    }

    func testEmptiedProjectPageStaysAndDeletedOneFallsBackToToday() {
        WidgetStore.setTasksStoredPage(4) // Garden: nothing dated today
        XCTAssertEqual(state(calm).scope, 4, "a project with nothing due shows its empty state")
        let withoutGarden = Array(projects.prefix(3))
        XCTAssertEqual(state(calm, projects: withoutGarden).scope, WidgetStore.allProjects)
    }

    func testChipFromAViewPageGoesToTheFirstProject() {
        for page in TasksTimeline.viewPages {
            WidgetStore.setTasksStoredPage(page)
            XCTAssertEqual(state(withOverdue).nextProject, 1)
        }
        XCTAssertEqual(state(calm).nextProject, 1, "with nothing stored too")
    }

    func testChipStepsInServerOrderAndWraps() {
        let pages = state(withOverdue).projectPages
        func next(_ from: Int) -> Int? { TasksTimeline.nextProject(after: from, pages: pages, allProjects: projects) }
        XCTAssertEqual(next(1), 2)
        XCTAssertEqual(next(2), 3)
        XCTAssertEqual(next(3), 1, "wraps")
    }

    func testChipFromAnEmptiedProjectContinuesForward() {
        // On Work (2) after its over-target task went: Work has left the
        // chip's list, and the next step is Home (after Work), not Inbox.
        WidgetStore.setTasksStoredPage(2)
        let s = state(calm)
        XCTAssertEqual(s.scope, 2)
        XCTAssertEqual(s.nextProject, 3)
        // From the last project, it wraps to the first with something.
        WidgetStore.setTasksStoredPage(4)
        XCTAssertEqual(state(calm).nextProject, 1)
    }

    func testChipIsNilWithNowhereToGo() {
        let onlyInbox = [task(1, due: 3600)]
        WidgetStore.setTasksStoredPage(1)
        XCTAssertNil(state(onlyInbox).nextProject, "already on the only project with anything")
        WidgetStore.setTasksStoredPage(WidgetStore.allProjects)
        XCTAssertEqual(state(onlyInbox).nextProject, 1)
        XCTAssertNil(state([task(3, due: nil)]).nextProject, "no project has anything")
    }

    func testSelectedProjectRemovedFromServerFallsBackToToday() {
        WidgetStore.setTasksStoredPage(3)
        let withoutHome = projects.filter { $0.id != 3 }
        let s = state(calm, projects: withoutHome)
        XCTAssertEqual(s.scope, WidgetStore.allProjects)
        XCTAssertFalse(s.pages.contains(3))
    }

    func testNewProjectAddedDoesNotShiftTheSelection() {
        WidgetStore.setTasksStoredPage(3) // Home
        XCTAssertEqual(state(calm).scope, 3)
        // A new project sorted FIRST, with something due today: an index
        // would now name a different project; the key still names Home.
        let added = [ProjectDTO(id: 9, name: "Errands", color: "blue")] + projects
        let tasks = calm + [task(30, due: 1800, project: 9)]
        let s = state(tasks, projects: added)
        XCTAssertEqual(s.scope, 3)
        XCTAssertEqual(s.projectPages.map(\.id), [9, 1, 3])
        // And the chip steps on from Home in the new order (wrapping to it).
        XCTAssertEqual(s.nextProject, 9)
    }
}
