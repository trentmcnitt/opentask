import XCTest

/// The Tasks widget's default page (2026-09-25): Overdue while anything is
/// overdue, else Today, and a chevron choice honored only while the default
/// it was made against still holds (`TasksTimeline.scopeState`,
/// `WidgetStore.TasksScopeChoice`). Synthetic titles only — the repo is public.
final class TasksScopeTests: WidgetStoreTestCase {

    private let now = Date(timeIntervalSince1970: 1_768_492_800) // 2026-01-15T16:00:00Z

    private let projects = [
        ProjectDTO(id: 1, name: "Inbox", color: nil),
        ProjectDTO(id: 2, name: "Work", color: "red"),
    ]

    private func iso(_ offset: TimeInterval) -> String {
        DateHelpers.formatISO(now.addingTimeInterval(offset))
    }

    private func task(_ id: Int, due offset: TimeInterval?, project: Int = 1, priority: Int = 1) -> TaskDTO {
        TaskDTO(id: id, projectId: project, title: "Task \(id)", priority: priority, dueAt: offset.map(iso))
    }

    /// Nothing overdue: one due later today, one tomorrow, one undated.
    private var calm: [TaskDTO] {
        [task(1, due: 3600), task(2, due: 26 * 3600, project: 2), task(3, due: nil)]
    }

    /// `calm` plus two overdue tasks (one three days late, one an hour late).
    private var withOverdue: [TaskDTO] {
        calm + [task(10, due: -3600, project: 2), task(11, due: -3 * 86400)]
    }

    private func state(_ tasks: [TaskDTO]) -> TasksTimeline.ScopeState {
        TasksTimeline.scopeState(tasks: tasks, projects: projects, now: now)
    }

    // MARK: The overdue list

    func testOverdueListIsEligibleTasksPastDueMostOverdueFirst() {
        let reminder = TaskDTO(id: 20, projectId: 1, title: "A reminder", dueAt: iso(-7200), isReminder: true)
        let quota = TaskDTO(id: 21, projectId: 1, title: "A quota", dueAt: iso(-7200), progressTarget: 3)
        let list = TasksTimeline.overdueTasks(from: withOverdue + [reminder, quota], now: now)
        // Reminders (§6: no debt) and quotas (§5) are never overdue, as on
        // the web's Overdue chip and the server's badge.
        XCTAssertEqual(list.map(\.id), [11, 10])
    }

    // MARK: The natural default

    func testNothingOverdueDefaultsToTodayAndOverdueIsNotInTheRing() {
        let s = state(calm)
        XCTAssertEqual(s.scope, WidgetStore.allProjects)
        XCTAssertEqual(s.natural, WidgetStore.allProjects)
        XCTAssertFalse(s.ring.contains(WidgetStore.overdueScope))
        XCTAssertEqual(Array(s.ring.prefix(2)), [WidgetStore.allProjects, WidgetStore.upNextScope])
    }

    func testAnythingOverdueDefaultsToOverdueFirstInTheRing() {
        let s = state(withOverdue)
        XCTAssertEqual(s.scope, WidgetStore.overdueScope)
        XCTAssertEqual(s.natural, WidgetStore.overdueScope)
        XCTAssertEqual(
            Array(s.ring.prefix(3)), [WidgetStore.overdueScope, WidgetStore.allProjects, WidgetStore.upNextScope]
        )
    }

    // MARK: A chevron choice

    func testChoiceIsHonoredWhileOverdueLasts() {
        WidgetStore.setTasksScopeChoice(WidgetStore.upNextScope, naturalScope: WidgetStore.overdueScope)
        XCTAssertEqual(state(withOverdue).scope, WidgetStore.upNextScope)
    }

    func testChoiceLapsesToTodayWhenOverdueDropsToZero() {
        // Chose Up next while Overdue was the default; then the overdue tasks
        // were done. Back to the normal default, not to the old choice.
        WidgetStore.setTasksScopeChoice(WidgetStore.upNextScope, naturalScope: WidgetStore.overdueScope)
        XCTAssertEqual(state(calm).scope, WidgetStore.allProjects)
    }

    func testChoiceMadeWithNothingOverdueLapsesWhenOverdueAppears() {
        WidgetStore.setTasksScopeChoice(1, naturalScope: WidgetStore.allProjects)
        XCTAssertEqual(state(calm).scope, 1, "held while nothing is overdue")
        XCTAssertEqual(state(withOverdue).scope, WidgetStore.overdueScope)
    }

    func testChoiceOffTheRingLapses() {
        // Overdue chosen, then the last overdue task went: Overdue is no
        // longer in the ring and the natural default is Today again.
        WidgetStore.setTasksScopeChoice(WidgetStore.overdueScope, naturalScope: WidgetStore.overdueScope)
        XCTAssertEqual(state(calm).scope, WidgetStore.allProjects)
        // A project with nothing due today any more lapses the same way.
        WidgetStore.setTasksScopeChoice(99, naturalScope: WidgetStore.allProjects)
        XCTAssertEqual(state(calm).scope, WidgetStore.allProjects)
    }

    func testChoiceStoredBeforeTheAnchorExistedReadsAsChosenAgainstToday() throws {
        // An upgraded install has the bare scope key and no anchor.
        let defaults = try XCTUnwrap(WidgetStore.suiteOverride)
        defaults.set(WidgetStore.upNextScope, forKey: "widget.tasks.projectId")
        XCTAssertEqual(
            WidgetStore.tasksScopeChoice(),
            WidgetStore.TasksScopeChoice(scope: WidgetStore.upNextScope, naturalScope: WidgetStore.allProjects)
        )
        XCTAssertEqual(state(calm).scope, WidgetStore.upNextScope)
        XCTAssertEqual(state(withOverdue).scope, WidgetStore.overdueScope)
    }

    // MARK: The intents' view of it

    func testCurrentScopeAppliesCompletionTombstones() {
        WidgetStore.saveTasks(withOverdue, projects: projects, completions: [], fetchStartedAt: now)
        XCTAssertEqual(TasksTimeline.currentScope(now: now), WidgetStore.overdueScope)

        // Checking off both overdue tasks (optimistically) drops the widget
        // back to Today on that same tap — the intent and the repaint agree.
        WidgetStore.stagePendingCompletion(10, now: now)
        WidgetStore.stagePendingCompletion(11, now: now)
        XCTAssertEqual(TasksTimeline.currentScope(now: now), WidgetStore.allProjects)
    }

    func testCurrentScopeBeforeAnyPayloadIsToday() {
        XCTAssertNil(TasksTimeline.currentScopeState(now: now))
        XCTAssertEqual(TasksTimeline.currentScope(now: now), WidgetStore.allProjects)
    }
}
