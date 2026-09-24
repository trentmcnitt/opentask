import Foundation

/// App Group cache written by the watch app after every successful fetch,
/// read by the Smart Stack widget's timeline provider as a fallback when its
/// own network fetch fails or the system won't grant it a fresh round trip.
///
/// Same App Group (`group.io.mcnitt.opentask`, bare — watchOS, not macOS; see
/// `KeychainHelper`'s doc for why the macOS form differs) the phone side uses,
/// but a DISJOINT key namespace (`watch.*`) — this must never collide with
/// `WidgetStore`'s keys in `ios/OpenTaskWidgets`, which is a different
/// extension's storage this target has no business reading or overwriting.
enum WatchCache {
    private static let appGroup = "group.io.mcnitt.opentask"
    private static var defaults: UserDefaults? { UserDefaults(suiteName: appGroup) }

    private static let remindersKey = "watch.reminders.v1"
    private static let tasksKey = "watch.tasks.v1"
    private static let projectsKey = "watch.projects.v1"
    private static let savedAtKey = "watch.savedAt.v1"

    static func saveReminders(_ groups: [ReminderGroupDTO]) {
        guard let data = try? JSONEncoder().encode(groups) else { return }
        defaults?.set(data, forKey: remindersKey)
        touch()
    }

    static func loadReminders() -> [ReminderGroupDTO]? {
        guard let data = defaults?.data(forKey: remindersKey) else { return nil }
        return try? JSONDecoder().decode([ReminderGroupDTO].self, from: data)
    }

    static func saveTasks(_ tasks: [TaskDTO], projects: [ProjectDTO]) {
        guard let taskData = try? JSONEncoder().encode(tasks),
              let projectData = try? JSONEncoder().encode(projects) else { return }
        defaults?.set(taskData, forKey: tasksKey)
        defaults?.set(projectData, forKey: projectsKey)
        touch()
    }

    static func loadTasks() -> (tasks: [TaskDTO], projects: [ProjectDTO])? {
        guard let taskData = defaults?.data(forKey: tasksKey),
              let projectData = defaults?.data(forKey: projectsKey),
              let tasks = try? JSONDecoder().decode([TaskDTO].self, from: taskData),
              let projects = try? JSONDecoder().decode([ProjectDTO].self, from: projectData)
        else { return nil }
        return (tasks, projects)
    }

    private static func touch() {
        defaults?.set(Date(), forKey: savedAtKey)
    }

    static var savedAt: Date? {
        defaults?.object(forKey: savedAtKey) as? Date
    }
}
