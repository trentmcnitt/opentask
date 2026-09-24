import Foundation

/// Data for the widget gallery and for `placeholder(in:)`.
///
/// The gallery gives a provider no chance to await a network call, so the
/// alternative to sample data is an empty card — which reads as "this widget
/// is broken" at exactly the moment the user is deciding whether to add it.
///
/// Everything here is generic and non-identifying, and every view it feeds is
/// built from plain `Text`/`Image`, so WidgetKit's automatic redaction blurs it
/// correctly rather than leaking a shape that looks like real content.
enum SampleData {

    /// A local time today, as the UTC ISO 8601 string the API would return.
    private static func todayAt(hour: Int, minute: Int = 0) -> String {
        let calendar = Calendar.current
        var comps = calendar.dateComponents([.year, .month, .day], from: Date())
        comps.hour = hour
        comps.minute = minute
        return DateHelpers.formatISO(calendar.date(from: comps) ?? Date())
    }

    // MARK: - Reminders

    static var reminderGroups: [ReminderGroupDTO] {
        [
            // `considered: 2`, backed by 2 real `consideredItems` — some
            // already checked off, so the gallery's slot strip (§6,
            // `ReminderSlotStrip`) has something to show besides "upcoming"
            // for every segment, AND (2026-09-23) the "show completed" DONE
            // section has something to render in the gallery/placeholder/
            // redaction preview too.
            ReminderGroupDTO(
                slot: TimeSlotDTO(id: 1, label: "Early morning", startTime: "07:00"),
                reminders: [
                    TaskDTO(id: 101, title: "Supplements", priority: 3, anchorTime: "07:00", isReminder: true),
                    TaskDTO(id: 102, title: "Stretch for five minutes", priority: 1, anchorTime: "07:15", isReminder: true),
                ],
                considered: 2,
                consideredItems: [
                    TaskDTO(id: 111, title: "Make the bed", isReminder: true),
                    TaskDTO(id: 112, title: "Drink a glass of water", isReminder: true),
                ]
            ),
            ReminderGroupDTO(
                slot: TimeSlotDTO(id: 2, label: "Midday", startTime: "12:00"),
                reminders: [
                    TaskDTO(id: 103, title: "Step away from the desk", priority: 2, anchorTime: "12:30", isReminder: true),
                    TaskDTO(id: 104, title: "Present is peace", priority: 3, anchorTime: "12:45", isReminder: true),
                    TaskDTO(id: 105, title: "Drink water", priority: 0, anchorTime: "13:00", isReminder: true),
                ]
            ),
            ReminderGroupDTO(
                slot: TimeSlotDTO(id: 3, label: "Evening", startTime: "20:30"),
                reminders: [
                    TaskDTO(id: 106, title: "Set out tomorrow's first task", priority: 2, anchorTime: "20:30", isReminder: true),
                ]
            ),
        ]
    }

    static var remindersEntry: RemindersEntry {
        let groups = reminderGroups
        return RemindersEntry(
            date: Date(),
            groups: groups,
            slotIndex: RemindersTimeline.naturalSlotIndex(in: groups),
            staleSince: nil,
            isSignedOut: false,
            canUndo: false,
            canRedo: false,
            actionDescription: nil
        )
    }

    // MARK: - Tasks

    static var projects: [ProjectDTO] {
        [
            ProjectDTO(id: 1, name: "Inbox", color: "gray"),
            ProjectDTO(id: 2, name: "Work", color: "blue"),
            ProjectDTO(id: 3, name: "Personal", color: "green"),
        ]
    }

    static var tasks: [TaskDTO] {
        [
            TaskDTO(id: 201, projectId: 2, title: "Send the quarterly summary", priority: 4, dueAt: todayAt(hour: 9)),
            TaskDTO(id: 202, projectId: 2, title: "Review pull requests", priority: 3, dueAt: todayAt(hour: 11)),
            TaskDTO(id: 204, projectId: 1, title: "Book the dentist", priority: 1, dueAt: todayAt(hour: 15)),
            TaskDTO(id: 206, projectId: 2, title: "Draft the release notes", priority: 2, dueAt: todayAt(hour: 22)),
        ]
    }

    /// One generic completion (2026-09-23, "show completed") — enough for
    /// the gallery/placeholder/redaction preview to have a non-empty DONE
    /// section, without the gallery leaking anything that looks like real
    /// content (this file's own doc: "everything here is generic and
    /// non-identifying").
    static var doneTasksSample: [CompletionDTO] {
        [
            CompletionDTO(
                id: -211, taskId: 211, completedAt: todayAt(hour: 8, minute: 30),
                taskTitle: "Check email", projectId: 1
            )
        ]
    }

    static var tasksEntry: TasksEntry {
        TasksEntry(
            date: Date(),
            tasks: TasksTimeline.todaysTasks(from: tasks),
            projects: projects,
            scope: WidgetStore.allProjects,
            staleSince: nil,
            isSignedOut: false,
            canUndo: false,
            canRedo: false,
            actionDescription: nil,
            doneTasks: doneTasksSample
        )
    }

    // MARK: - Quotas (§5, `feat/quotas-widget`)

    /// Quotas, kept separate from `tasks` now that §8 excludes tracked items
    /// from the Tasks widget — mixing them back in would only mean the Tasks
    /// gallery card silently filtering half its sample away.
    ///
    /// This is the corpus from the APPROVED mockup (`~/hub-store/capabilities/
    /// opentask/mockups-2026-09-23/widgets.html`'s `qbody`, section 3 —
    /// "Quotas widget (the design you picked today)") — kept "generic,
    /// non-identifying" per this file's own header rule (grocery/chore/errand
    /// names, not a real household's), padded from the mock's ~14 to 24 so a
    /// systemLarge gallery card genuinely pages to a second screen the way the
    /// mock's own "‹ 1/2 ›" footer shows. Four periods, four labeled clusters
    /// (health/hub/job-hunt/kids) plus an unlabeled "Other" bucket in the
    /// month/year sections, three states represented per cluster where
    /// possible (untouched, partial, met) so a render review sees every chip
    /// treatment the widget draws.
    ///
    /// No `due_at` — §5 quotas are dateless. Also no `progressPeriodStart`:
    /// unlike the OLD per-item pace ring, nothing this widget draws reads a
    /// quota's own anchor any more — `QuotaSectionBuilder` measures every
    /// period fresh from `Date()`/`Calendar`, and `TrackItem.elapsedFraction`
    /// is always nil in the new flow (see that struct's doc).
    static var trackedTasks: [TaskDTO] {
        [
            // Today — met, matching the mock's "Today · ends tonight · 1 of 1".
            TaskDTO(id: 301, projectId: 1, title: "Walk the long way home", priority: 1,
                    rrule: "FREQ=DAILY", progressTarget: 2, progressCurrent: 2),

            // This week · health
            TaskDTO(id: 310, projectId: 3, title: "Vegetables", priority: 2,
                    rrule: "FREQ=WEEKLY", progressTarget: 5, progressCurrent: 3, labels: ["health"]),
            TaskDTO(id: 311, projectId: 3, title: "Supplements", priority: 1,
                    rrule: "FREQ=WEEKLY", progressTarget: 3, progressCurrent: 0, labels: ["health"]),
            TaskDTO(id: 312, projectId: 3, title: "Balloon", priority: 1,
                    rrule: "FREQ=WEEKLY", progressTarget: 4, progressCurrent: 0, labels: ["health"]),
            TaskDTO(id: 313, projectId: 3, title: "Weight lift", priority: 1,
                    rrule: "FREQ=WEEKLY", progressTarget: 3, progressCurrent: 0, labels: ["health"]),
            TaskDTO(id: 314, projectId: 3, title: "Cardio", priority: 1,
                    rrule: "FREQ=WEEKLY", progressTarget: 3, progressCurrent: 1, labels: ["health"]),
            TaskDTO(id: 315, projectId: 3, title: "Meal prep", priority: 1,
                    rrule: "FREQ=WEEKLY", progressTarget: 2, progressCurrent: 0, labels: ["health"]),

            // This week · hub. `trackedFlag: true` on every target-1 quota
            // below: `TaskDTO.isTracked` is `trackedFlag || progressTarget >
            // 1` (mirroring the server's own `isTracked()`), so a "once a
            // period" quota with no explicit flag isn't a quota at all as
            // far as `isProgressMet`/`isTracked` are concerned — a real
            // once-per-period quota always carries this flag from the
            // server. Missing it here first showed up as a met target-1
            // quota that never turned green in a render review (`isTracked
            // == false` makes `isProgressMet` permanently false) — caught
            // and fixed against the actual Xcode preview, not assumed.
            TaskDTO(id: 320, projectId: 1, title: "Audiobook notes", priority: 0,
                    rrule: "FREQ=WEEKLY", progressTarget: 1, progressCurrent: 0,
                    trackedFlag: true, labels: ["hub"]),
            TaskDTO(id: 321, projectId: 1, title: "Card maintenance", priority: 0,
                    rrule: "FREQ=WEEKLY", progressTarget: 1, progressCurrent: 0,
                    trackedFlag: true, labels: ["hub"]),
            TaskDTO(id: 322, projectId: 1, title: "Inbox zero", priority: 0,
                    rrule: "FREQ=WEEKLY", progressTarget: 1, progressCurrent: 0,
                    trackedFlag: true, labels: ["hub"]),
            TaskDTO(id: 323, projectId: 1, title: "Backup photos", priority: 0,
                    rrule: "FREQ=WEEKLY", progressTarget: 1, progressCurrent: 0,
                    trackedFlag: true, labels: ["hub"]),

            // This week · job-hunt
            TaskDTO(id: 330, projectId: 2, title: "Certifications", priority: 2,
                    rrule: "FREQ=WEEKLY", progressTarget: 1, progressCurrent: 0,
                    trackedFlag: true, labels: ["job-hunt"]),
            TaskDTO(id: 331, projectId: 2, title: "Applications", priority: 2,
                    rrule: "FREQ=WEEKLY", progressTarget: 3, progressCurrent: 1, labels: ["job-hunt"]),

            // This week · kids
            TaskDTO(id: 340, projectId: 3, title: "Shower", priority: 1,
                    rrule: "FREQ=WEEKLY", progressTarget: 2, progressCurrent: 1, labels: ["kids"]),
            TaskDTO(id: 341, projectId: 3, title: "Dishes", priority: 1,
                    rrule: "FREQ=WEEKLY", progressTarget: 5, progressCurrent: 0, labels: ["kids"]),
            TaskDTO(id: 342, projectId: 3, title: "Compliment", priority: 1,
                    rrule: "FREQ=WEEKLY", progressTarget: 2, progressCurrent: 0, labels: ["kids"]),
            TaskDTO(id: 343, projectId: 3, title: "Reading time", priority: 1,
                    rrule: "FREQ=WEEKLY", progressTarget: 3, progressCurrent: 3, labels: ["kids"]),

            // This month · unlabeled ("Other")
            TaskDTO(id: 350, projectId: 3, title: "Date night", priority: 2,
                    rrule: "FREQ=MONTHLY", progressTarget: 1, progressCurrent: 0, trackedFlag: true),
            TaskDTO(id: 351, projectId: 1, title: "Budget review", priority: 1,
                    rrule: "FREQ=MONTHLY", progressTarget: 1, progressCurrent: 0, trackedFlag: true),
            TaskDTO(id: 352, projectId: 1, title: "Deep clean", priority: 1,
                    rrule: "FREQ=MONTHLY", progressTarget: 1, progressCurrent: 1, trackedFlag: true),
            TaskDTO(id: 353, projectId: 1, title: "Car maintenance", priority: 1,
                    rrule: "FREQ=MONTHLY", progressTarget: 1, progressCurrent: 0, trackedFlag: true),

            // This year · unlabeled
            TaskDTO(id: 360, projectId: 1, title: "Physical", priority: 2,
                    rrule: "FREQ=YEARLY", progressTarget: 1, progressCurrent: 0, trackedFlag: true),
            TaskDTO(id: 361, projectId: 1, title: "Dentist", priority: 2,
                    rrule: "FREQ=YEARLY", progressTarget: 1, progressCurrent: 1, trackedFlag: true),
            TaskDTO(id: 362, projectId: 1, title: "Eye exam", priority: 1,
                    rrule: "FREQ=YEARLY", progressTarget: 1, progressCurrent: 0, trackedFlag: true),
        ]
    }

    /// The cluster color source (`label_config`) for the sample corpus above —
    /// four named labels, the same colors the mock's own swatches use
    /// (health blue, hub gray, job-hunt pink, kids purple).
    static var trackLabelConfig: [LabelConfigDTO] {
        [
            LabelConfigDTO(name: "health", color: "blue"),
            LabelConfigDTO(name: "hub", color: "gray"),
            LabelConfigDTO(name: "job-hunt", color: "pink"),
            LabelConfigDTO(name: "kids", color: "purple"),
        ]
    }

    /// `trackedTasks`, run through the SAME `isTracked` filter the real
    /// provider applies (`TrackProvider.currentEntry`'s `snapshot.tasks.
    /// filter(\.isTracked)`) before anything ever reaches
    /// `QuotaSectionBuilder`. Doing this here too, rather than trusting every
    /// entry in `trackedTasks` to already qualify, is what caught a real bug
    /// in a first render pass: a target-1 sample quota with no `trackedFlag`
    /// isn't a quota at all by `isTracked`'s own rule, and would otherwise
    /// silently read as permanently-unmet in a gallery render instead of
    /// simply not appearing (matching what a real, un-flagged such task
    /// would do in production — never shown, not shown-and-wrong).
    static var trackedQuotas: [TaskDTO] { trackedTasks.filter(\.isTracked) }

    /// `showMet: false` — the default, met-hidden state. Previews/tests that
    /// want the met-shown variant build their own entry from
    /// `QuotaSectionBuilder.sections(from: trackedQuotas, ...)` directly (see
    /// `TrackWidget.swift`'s `#Preview` blocks) rather than adding parameters
    /// here — `placeholder(in:)`/`getSnapshot(in:)` only ever need the one,
    /// default-state entry this property provides.
    static var trackEntry: TrackEntry {
        let now = Date()
        let quotas = trackedQuotas
        let sections = QuotaSectionBuilder.sections(
            from: quotas, labelConfig: trackLabelConfig, showMet: false,
            mutationIsRecent: false, now: now
        )
        let nextUnmet = sections.flatMap(\.clusters).flatMap(\.chips).first { !$0.isMet }
        return TrackEntry(
            date: now,
            sections: sections,
            totalMet: quotas.filter(\.isProgressMet).count,
            totalCount: quotas.count,
            nextUnmet: nextUnmet,
            showMet: false,
            page: 0,
            staleSince: nil,
            isSignedOut: false,
            canUndo: false,
            canRedo: false,
            actionDescription: nil
        )
    }
}
