import XCTest

/// Every native surface on the OpenTask day ("Day starts at" PR 3): the
/// Tasks widget's Today list, done-today and Up next, the due labels (phone
/// and watch), the Reminders widget's and the watch's slot logic, the
/// groups' day order, and the Quotas widget's period clock — each at a day
/// start other than midnight, where the old midnight rule gave a different
/// answer. The helper itself is `OpenTaskDayTests`. Synthetic titles only —
/// the repo is public.
///
/// Where a surface formats words in the machine's zone (the due labels), the
/// cases build their instants in that zone too; everything else runs in
/// America/Chicago explicitly.
final class DayStartSurfacesTests: WidgetStoreTestCase {

    private let chicago = TimeZone(identifier: "America/Chicago")!
    private var threeAM: OpenTaskDay { OpenTaskDay(dayStart: "03:00", timeZone: chicago) }

    /// A Chicago wall-clock "yyyy-MM-ddTHH:mm" as an instant.
    private func local(_ wall: String, in zone: TimeZone? = nil) -> Date {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = zone ?? chicago
        f.dateFormat = "yyyy-MM-dd'T'HH:mm"
        return f.date(from: wall)!
    }

    private func task(_ id: Int, due: String?, in zone: TimeZone? = nil) -> TaskDTO {
        TaskDTO(id: id, projectId: 1, title: "Task \(id)", priority: 1, dueAt: due.map { DateHelpers.formatISO(local($0, in: zone)) })
    }

    private func completion(_ id: Int, at wall: String) -> CompletionDTO {
        CompletionDTO(id: 1000 + id, taskId: id, completedAt: DateHelpers.formatISO(local(wall)), taskTitle: "Done \(id)", projectId: 1)
    }

    // MARK: Tasks widget: Today, done today, Up next (TaskLists / TaskDayProgress)

    func testTodayRunsToTheDayStartNotMidnight() {
        // 2:00 AM Tuesday is still Monday's day with a 3:00 AM start.
        let now = local("2026-10-20T02:00")
        let tasks = [
            task(1, due: "2026-10-20T01:30"), // tonight, already past
            task(2, due: "2026-10-20T02:30"), // tonight, still ahead: today's
            task(3, due: "2026-10-20T09:00"), // tomorrow morning
        ]
        XCTAssertEqual(TaskLists.dueToday(tasks, now: now, day: threeAM).map(\.id), [1, 2])
        XCTAssertEqual(TaskDayProgress.upcoming(tasks, now: now, day: threeAM).map(\.id), [3])
        // Midnight (the switch off) is the calendar day: 2:30 and 9:00 are both today's.
        let midnight = OpenTaskDay.midnight(timeZone: chicago)
        XCTAssertEqual(TaskLists.dueToday(tasks, now: now, day: midnight).map(\.id), [1, 2, 3])
        // At 11 PM Monday with an 11 PM start, Tuesday has begun: Tuesday 9:00 is today's.
        let elevenPM = OpenTaskDay(dayStart: "23:00", timeZone: chicago)
        XCTAssertEqual(
            TaskLists.dueToday(tasks, now: local("2026-10-19T23:30"), day: elevenPM).map(\.id), [1, 2, 3]
        )
    }

    func testDoneTodayIsTheOpenTaskDay() {
        let done = [completion(1, at: "2026-10-19T20:00"), completion(2, at: "2026-10-20T01:30")]
        // 2:00 AM: the evening's 8:00 PM check-off is still today's.
        XCTAssertEqual(TaskDayProgress.doneToday(done, now: local("2026-10-20T02:00"), day: threeAM).map(\.taskId), [1, 2])
        // 3:05 AM: a new day — neither counts.
        XCTAssertEqual(TaskDayProgress.doneToday(done, now: local("2026-10-20T03:05"), day: threeAM).map(\.taskId), [])
        XCTAssertEqual(
            TasksTimeline.todayCount(
                scope: WidgetStore.allProjects, openTasks: [], done: done, now: local("2026-10-20T02:00"), day: threeAM
            )?.text,
            "2 of 2"
        )
    }

    func testTheRememberedDayStartReachesTheScopeState() throws {
        try rememberDayStart("03:00")
        XCTAssertEqual(DayStartStore.current.dayStart, "03:00")
        let tasks = [task(1, due: "2026-10-20T09:00", in: .current)]
        let now = local("2026-10-20T02:00", in: .current)
        let state = TasksTimeline.scopeState(tasks: tasks, projects: [], now: now, day: DayStartStore.current)
        XCTAssertEqual(state.todayCount, 0, "9:00 AM is tomorrow's until the 3:00 AM day start")
    }

    // MARK: Due labels (DueLabel, WatchFormatting)

    func testDueLabelDaysAreOpenTaskDays() {
        let day = OpenTaskDay(dayStart: "03:00", timeZone: .current)
        let now = local("2026-01-14T01:00", in: .current) // Wednesday 1 AM: Tuesday's day
        func words(_ wall: String) -> String? {
            let due = local(wall, in: .current)
            return DueLabel.parts(for: due, now: now, isOverdue: due < now, day: day).dayWord
        }
        XCTAssertNil(words("2026-01-14T02:30"), "tonight before the day start is today")
        XCTAssertEqual(words("2026-01-14T09:00"), "Tomorrow")
        XCTAssertNil(words("2026-01-13T20:00"), "last evening is today, overdue: the time alone")
        XCTAssertEqual(words("2026-01-13T02:00"), "Last night", "Monday night's (the night rule)")
        // Midnight would call Wednesday 9:00 today, and Tuesday 8 PM yesterday.
        let midnight = OpenTaskDay.midnight(timeZone: .current)
        XCTAssertNil(DueLabel.parts(for: local("2026-01-14T09:00", in: .current), now: now, isOverdue: false, day: midnight).dayWord)
    }

    func testWatchDueLineDaysAreOpenTaskDays() {
        let day = OpenTaskDay(dayStart: "03:00", timeZone: .current)
        let now = local("2026-01-14T01:00", in: .current)
        XCTAssertTrue(WatchFormatting.dueLine(for: local("2026-01-14T09:00", in: .current), now: now, day: day).hasPrefix("Tomorrow "))
        XCTAssertFalse(WatchFormatting.dueLine(for: local("2026-01-14T02:30", in: .current), now: now, day: day).contains("Tomorrow"))
        XCTAssertFalse(WatchFormatting.dueLine(for: local("2026-01-13T20:00", in: .current), now: now, day: day).contains("Yesterday"))
    }

    // MARK: Reminders: slots in the day (ReminderDayProgress, RemindersTimeline, WatchSlotLogic)

    private func group(_ id: Int, _ start: String?) -> ReminderGroupDTO {
        ReminderGroupDTO(
            slot: start.map { TimeSlotDTO(id: id, label: "Period \(id)", startTime: $0) },
            reminders: [TaskDTO(id: id * 10, title: "Reminder \(id)", priority: 0, isReminder: true)],
            considered: 0, consideredItems: [], prompts: []
        )
    }

    /// The server's order (start time) with a 1:00 AM period, and the day's.
    private var serverOrder: [ReminderGroupDTO] {
        [group(1, "01:00"), group(2, "07:00"), group(3, "12:00"), group(4, "20:30"), group(5, nil)]
    }

    func testGroupsComeInTheDaysOrder() {
        let payload = RemindersPayload(groups: serverOrder, taskSegments: [])
        XCTAssertEqual(payload.orderedByDay(threeAM).groups.map(\.slotKey), [2, 3, 4, 1, -1])
        XCTAssertEqual(payload.orderedByDay(.midnight(timeZone: chicago)).groups.map(\.slotKey), [1, 2, 3, 4, -1])
    }

    func testSlotsStartWithinTheOpenTaskDay() {
        let groups = RemindersPayload(groups: serverOrder, taskSegments: []).orderedByDay(threeAM).groups
        let halfPastMidnight = local("2026-10-20T00:30")
        // At 00:30 the evening has started; the 1:00 AM period hasn't.
        XCTAssertTrue(ReminderDayProgress.hasStarted(groups[2], now: halfPastMidnight, day: threeAM))
        XCTAssertFalse(ReminderDayProgress.hasStarted(groups[3], now: halfPastMidnight, day: threeAM))
        XCTAssertEqual(RemindersTimeline.naturalSlotIndex(in: groups, now: halfPastMidnight, day: threeAM), 2)
        XCTAssertEqual(WatchSlotLogic.naturalSlotIndex(in: groups, now: halfPastMidnight, day: threeAM), 2)
        XCTAssertEqual(WatchSlotLogic.state(for: groups[3], now: halfPastMidnight, day: threeAM), .notStarted)
        // From the day start until the first period: the first.
        XCTAssertEqual(RemindersTimeline.naturalSlotIndex(in: groups, now: local("2026-10-20T03:30"), day: threeAM), 0)
        XCTAssertEqual(WatchSlotLogic.state(for: groups[2], now: local("2026-10-20T03:30"), day: threeAM), .notStarted)
        // 1:30 AM: the day's last period is the current one.
        XCTAssertEqual(RemindersTimeline.naturalSlotIndex(in: groups, now: local("2026-10-20T01:30"), day: threeAM), 3)
    }

    func testBoundariesAreTonightsPeriods() {
        let groups = RemindersPayload(groups: serverOrder, taskSegments: []).orderedByDay(threeAM).groups
        let boundaries = RemindersTimeline.upcomingBoundaries(in: groups, now: local("2026-10-19T21:00"), day: threeAM)
        XCTAssertEqual(boundaries.map(\.date), [local("2026-10-20T01:00")], "the 1:00 AM period, tonight")
        XCTAssertEqual(boundaries.map(\.index), [3])
        let morning = RemindersTimeline.upcomingBoundaries(in: groups, now: local("2026-10-20T03:30"), day: threeAM)
        XCTAssertEqual(morning.map(\.date), ["2026-10-20T07:00", "2026-10-20T12:00", "2026-10-20T20:30", "2026-10-21T01:00"].map { local($0) })
    }

    // MARK: Quotas widget: the period clock (QuotaPeriodBounds)

    func testAWeekRunsFromItsFirstDatesDayStart() {
        // Sunday 1:30 AM with 3:00 AM is still Saturday's day: last week's.
        let now = local("2026-10-18T01:30")
        let week = QuotaPeriodKey.weekly.bounds(now: now, firstWeekday: QuotaPeriodKey.sundayFirst, day: threeAM)
        XCTAssertEqual(week?.start, local("2026-10-11T03:00"))
        XCTAssertEqual(week?.end, local("2026-10-18T03:00"))
        XCTAssertEqual(QuotaPeriodKey.weekly.timeLeftText(now: now, firstWeekday: 1, day: threeAM), "1 day left")
        // Midnight: the new week has begun.
        let midnight = OpenTaskDay.midnight(timeZone: chicago)
        XCTAssertEqual(QuotaPeriodKey.weekly.timeLeftText(now: now, firstWeekday: 1, day: midnight), "7 days left")
        // 11 PM: the week named by Sunday the 18th starts Saturday 23:00.
        let elevenPM = OpenTaskDay(dayStart: "23:00", timeZone: chicago)
        let late = QuotaPeriodKey.weekly.bounds(now: local("2026-10-17T23:30"), firstWeekday: 1, day: elevenPM)
        XCTAssertEqual(late?.start, local("2026-10-17T23:00"))
        XCTAssertEqual(QuotaPeriodKey.weekly.timeLeftText(now: local("2026-10-17T23:30"), firstWeekday: 1, day: elevenPM), "7 days left")
        // Monday-first.
        XCTAssertEqual(
            QuotaPeriodKey.weekly.bounds(now: local("2026-10-20T12:00"), firstWeekday: QuotaPeriodKey.mondayFirst, day: threeAM)?.start,
            local("2026-10-19T03:00")
        )
    }

    func testMonthAndDayAcrossTheFallBackNight() {
        // November 1st 1:30 AM is still October's last day: October's month.
        let month = QuotaPeriodKey.monthly.bounds(now: local("2026-11-01T01:30"), firstWeekday: 1, day: threeAM)
        XCTAssertEqual(month?.start, local("2026-10-01T03:00"))
        XCTAssertEqual(month?.end, DateHelpers.parseISO("2026-11-01T09:00:00Z"), "Nov 1 3:00 AM CST")
        XCTAssertEqual(QuotaPeriodKey.monthly.timeLeftText(now: local("2026-11-01T01:30"), firstWeekday: 1, day: threeAM), "1 day left")
        // The fall-back day with an 11 PM start is 25 hours; half of it is gone at 11:30 AM CST.
        let elevenPM = OpenTaskDay(dayStart: "23:00", timeZone: chicago)
        let daySpan = QuotaPeriodKey.daily.bounds(now: local("2026-11-01T12:00"), firstWeekday: 1, day: elevenPM)!
        XCTAssertEqual(daySpan.end.timeIntervalSince(daySpan.start), 25 * 3600)
        XCTAssertEqual(
            QuotaPeriodKey.daily.elapsedFraction(now: daySpan.start.addingTimeInterval(12.5 * 3600), firstWeekday: 1, day: elevenPM)!,
            0.5, accuracy: 1e-9
        )
        XCTAssertNil(QuotaPeriodKey.daily.timeLeftText(now: local("2026-11-01T12:00"), firstWeekday: 1, day: elevenPM))
        XCTAssertEqual(
            QuotaPeriodKey.yearly.bounds(now: local("2027-01-01T02:00"), firstWeekday: 1, day: threeAM)?.start,
            local("2026-01-01T03:00")
        )
    }

    func testFirstWeekdayPrefersTheFetchedWeekStart() {
        func weekly(anchor wall: String) -> TaskDTO {
            TaskDTO(
                id: 1, title: "Quota", priority: 0, rrule: "FREQ=WEEKLY", progressTarget: 3,
                progressPeriodStart: DateHelpers.formatISO(local(wall))
            )
        }
        XCTAssertEqual(QuotaPeriodKey.firstWeekday(from: [weekly(anchor: "2026-10-18T03:00")], known: 2, timeZone: chicago), 2)
        // Without it, the anchor's date: Sunday 3:00 AM is a Sunday week…
        XCTAssertEqual(QuotaPeriodKey.firstWeekday(from: [weekly(anchor: "2026-10-18T03:00")], known: nil, timeZone: chicago), 1)
        // …and an 11 PM start stamps a Sunday week on Saturday 23:00, a Monday week on Sunday 23:00.
        XCTAssertEqual(QuotaPeriodKey.firstWeekday(from: [weekly(anchor: "2026-10-17T23:00")], known: nil, timeZone: chicago), 1)
        XCTAssertEqual(QuotaPeriodKey.firstWeekday(from: [weekly(anchor: "2026-10-18T23:00")], known: nil, timeZone: chicago), 2)
        XCTAssertEqual(QuotaPeriodKey.firstWeekday(from: [], known: nil, timeZone: chicago), 1)
    }
}
