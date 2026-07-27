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
            ReminderGroupDTO(
                slot: TimeSlotDTO(id: 1, label: "Early morning", startTime: "07:00"),
                reminders: [
                    TaskDTO(id: 101, title: "Supplements", priority: 3, anchorTime: "07:00", isReminder: true),
                    TaskDTO(id: 102, title: "Stretch for five minutes", priority: 1, anchorTime: "07:15", isReminder: true),
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
            isSignedOut: false
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
            TaskDTO(id: 203, projectId: 3, title: "Workout", priority: 2, dueAt: todayAt(hour: 17),
                    progressTarget: 4, progressCurrent: 2),
            TaskDTO(id: 204, projectId: 1, title: "Book the dentist", priority: 1, dueAt: todayAt(hour: 15)),
            TaskDTO(id: 205, projectId: 3, title: "Read", priority: 0, dueAt: todayAt(hour: 21),
                    progressTarget: 3, progressCurrent: 3),
            TaskDTO(id: 206, projectId: 2, title: "Draft the release notes", priority: 2, dueAt: todayAt(hour: 22)),
        ]
    }

    static var tasksEntry: TasksEntry {
        TasksEntry(
            date: Date(),
            tasks: TasksTimeline.todaysTasks(from: tasks),
            projects: projects,
            scope: WidgetStore.allProjects,
            staleSince: nil,
            isSignedOut: false
        )
    }
}
