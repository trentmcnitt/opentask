import XCTest

/// The Tasks widget's Today-page finished states (2026-09-29):
/// `TaskDayProgress` (day complete, "N of M", the Up next pick, the empty
/// body), `TasksTimeline`'s Today-only gating of them, and
/// `WidgetStore.completionsIncludingPending` (an in-flight check-off already
/// counts as done). Synthetic titles only — the repo is public.
final class TaskDayProgressTests: WidgetStoreTestCase {

    /// Local noon on a fixed day, so every "today"/"tomorrow" below is a whole
    /// number of hours from a local midnight whatever the machine's zone.
    private let calendar = Calendar.current
    private var startOfToday: Date {
        calendar.startOfDay(for: Date(timeIntervalSince1970: 1_768_492_800)) // 2026-01-15T16:00:00Z
    }
    private var now: Date { startOfToday.addingTimeInterval(12 * 3600) }

    private func iso(hours: Double) -> String {
        DateHelpers.formatISO(startOfToday.addingTimeInterval(hours * 3600))
    }

    private func task(
        _ id: Int, dueHours: Double?, priority: Int = 1, isReminder: Bool = false, progressTarget: Int = 1
    ) -> TaskDTO {
        TaskDTO(
            id: id, projectId: 1, title: "Task \(id)", priority: priority, dueAt: dueHours.map { iso(hours: $0) },
            progressTarget: progressTarget, isReminder: isReminder
        )
    }

    private func completion(_ id: Int, atHours: Double) -> CompletionDTO {
        CompletionDTO(id: 1000 + id, taskId: id, completedAt: iso(hours: atHours), taskTitle: "Done \(id)", projectId: 1)
    }

    // MARK: Done today

    func testDoneTodayKeepsOnlyTheLocalDay() {
        let done = [completion(1, atHours: 9), completion(2, atHours: -1), completion(3, atHours: 23.5)]
        // -1h is yesterday evening: a cache drawn after midnight still holds
        // it, and it must not count toward today.
        XCTAssertEqual(TaskDayProgress.doneToday(done, now: now).map(\.taskId), [1, 3])
    }

    // MARK: Day complete

    func testDayCompleteNeedsNothingOpenAndSomethingDone() {
        XCTAssertTrue(TaskDayProgress.isDayComplete(openToday: 0, doneToday: 1))
        // Nothing due and nothing done is "Nothing due today", not a finish.
        XCTAssertFalse(TaskDayProgress.isDayComplete(openToday: 0, doneToday: 0))
        XCTAssertFalse(TaskDayProgress.isDayComplete(openToday: 1, doneToday: 5))
    }

    func testEmptyBodyIsDayCompleteOnlyWhenSomethingWasDone() {
        XCTAssertEqual(TaskDayProgress.emptyBody(doneToday: 3), .dayComplete)
        XCTAssertEqual(TaskDayProgress.emptyBody(doneToday: 0), .nothingDue)
    }

    // MARK: "N of M"

    func testTodayCountIsDoneOverDonePlusOpen() {
        let count = TaskDayProgress.TodayCount(doneToday: 2, openToday: 4)
        XCTAssertEqual(count.text, "2 of 6")
        XCTAssertFalse(count.isEmpty)
        XCTAssertEqual(TaskDayProgress.TodayCount(doneToday: 5, openToday: 0).text, "5 of 5")
        XCTAssertEqual(TaskDayProgress.TodayCount(doneToday: 0, openToday: 3).text, "0 of 3")
        XCTAssertTrue(TaskDayProgress.TodayCount(doneToday: 0, openToday: 0).isEmpty)
    }

    // MARK: Up next

    func testUpcomingIsTheNextThreeEligibleTasksDueAfterToday() {
        let tasks = [
            task(1, dueHours: 20),              // later today — Today's, not next
            task(2, dueHours: -5),              // overdue — Today's too
            task(3, dueHours: 24 + 17),         // tomorrow 5 pm
            task(4, dueHours: 24 + 9),          // tomorrow 9 am
            task(5, dueHours: 72),              // three days out
            task(6, dueHours: 96),              // four days out — past the cap
            task(7, dueHours: nil),             // undated backlog
            task(8, dueHours: 30, isReminder: true),
            task(9, dueHours: 30, progressTarget: 3),
            task(10, dueHours: 24),             // exactly tomorrow's midnight
        ]
        XCTAssertEqual(TaskDayProgress.upcoming(tasks, now: now).map(\.id), [10, 4, 3])
        XCTAssertEqual(TaskDayProgress.upcoming(tasks, now: now, limit: 5).map(\.id), [10, 4, 3, 5, 6])
    }

    func testUpcomingBreaksTiesByPriority() {
        let tasks = [task(1, dueHours: 33, priority: 1), task(2, dueHours: 33, priority: 3)]
        XCTAssertEqual(TaskDayProgress.upcoming(tasks, now: now).map(\.id), [2, 1])
    }

    // MARK: Today-only gating (TasksTimeline)

    func testDayCompleteBelongsToTheTodayPageOnly() {
        let done = [completion(1, atHours: 9)]
        XCTAssertTrue(TasksTimeline.isDayComplete(scope: WidgetStore.allProjects, openTasks: [], done: done, now: now))
        XCTAssertFalse(TasksTimeline.isDayComplete(scope: WidgetStore.upNextScope, openTasks: [], done: done, now: now))
        XCTAssertFalse(TasksTimeline.isDayComplete(scope: 7, openTasks: [], done: done, now: now))
        // Yesterday's completions don't finish today.
        XCTAssertFalse(TasksTimeline.isDayComplete(
            scope: WidgetStore.allProjects, openTasks: [], done: [completion(1, atHours: -2)], now: now
        ))
    }

    func testTodayCountShowsOnTheTodayPageOnly() {
        let open = [task(1, dueHours: 14), task(2, dueHours: 15)]
        let done = [completion(3, atHours: 9)]
        XCTAssertEqual(
            TasksTimeline.todayCount(scope: WidgetStore.allProjects, openTasks: open, done: done, now: now)?.text,
            "1 of 3"
        )
        XCTAssertNil(TasksTimeline.todayCount(scope: WidgetStore.upNextScope, openTasks: open, done: done, now: now))
        XCTAssertNil(TasksTimeline.todayCount(scope: WidgetStore.overdueScope, openTasks: open, done: done, now: now))
    }

    func testTheEntryCarriesUpNextOnlyForAnEmptyToday() {
        let later = [task(1, dueHours: 30), task(2, dueHours: 50)]
        let today = [task(3, dueHours: 14)]
        XCTAssertEqual(
            TasksTimeline.upcomingForEmptyToday(scope: WidgetStore.allProjects, openOnPage: [], allTasks: later, now: now)
                .map(\.id),
            [1, 2]
        )
        XCTAssertTrue(TasksTimeline.upcomingForEmptyToday(
            scope: WidgetStore.allProjects, openOnPage: today, allTasks: today + later, now: now
        ).isEmpty)
        XCTAssertTrue(TasksTimeline.upcomingForEmptyToday(
            scope: WidgetStore.upNextScope, openOnPage: [], allTasks: later, now: now
        ).isEmpty)
    }

    // MARK: In-flight check-offs (WidgetStore)

    func testAnInFlightCheckOffCountsAsDoneOnce() {
        let last = task(1, dueHours: 14)
        let reminder = task(2, dueHours: 14, isReminder: true)
        WidgetStore.stagePendingCompletion(1, now: now)
        WidgetStore.stagePendingCompletion(2, now: now)

        let merged = WidgetStore.completionsIncludingPending([], tasks: [last, reminder], now: now)
        // The Tasks task gets a synthetic row; the reminder is not the Tasks
        // widget's to count.
        XCTAssertEqual(merged.map(\.taskId), [1])
        XCTAssertEqual(merged.first?.id, -1)
        XCTAssertTrue(TasksTimeline.isDayComplete(
            scope: WidgetStore.allProjects,
            openTasks: WidgetStore.filterPending([last], now: now),
            done: merged, now: now
        ))

        // Already confirmed (or fetched): not added a second time.
        let confirmed = [completion(1, atHours: 12)]
        XCTAssertEqual(
            WidgetStore.completionsIncludingPending(confirmed, tasks: [last], now: now).map(\.taskId), [1]
        )
    }

    func testNoTombstonesLeavesCompletionsAlone() {
        let done = [completion(5, atHours: 9)]
        XCTAssertEqual(WidgetStore.completionsIncludingPending(done, tasks: [task(1, dueHours: 14)], now: now), done)
    }
}
