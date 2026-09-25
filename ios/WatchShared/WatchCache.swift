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

// MARK: - Smart Stack widget write-throughs

extension WatchCache {
    /// Mirror a successful check-off into the cached reminders (row out,
    /// `considered + 1`) — the same edit `WatchViewModel.completeReminder`
    /// makes to its live copy, persisted so the widget's next render agrees
    /// even when its own fetch fails. No-op when the id isn't cached.
    static func markReminderConsidered(taskId: Int) {
        guard let groups = loadReminders(),
              groups.contains(where: { group in group.reminders.contains { $0.id == taskId } })
        else { return }
        saveReminders(groups.map { group in
            guard let done = group.reminders.first(where: { $0.id == taskId }) else { return group }
            return ReminderGroupDTO(
                slot: group.slot,
                reminders: group.reminders.filter { $0.id != taskId },
                considered: group.considered + 1,
                consideredItems: [done] + group.consideredItems,
                prompts: group.prompts
            )
        })
    }

    /// Mirror a successful quota-prompt action from the Smart Stack card
    /// (quota reminders, 2026-09-24) into the cached reminders: the prompt
    /// drawn handled (`QuotaPromptDTO.handled(did:)`), so a reload whose own
    /// fetch fails still shows the card advanced. No-op when not cached.
    static func markPromptHandled(key: String, did: Bool) {
        guard let groups = loadReminders(),
              groups.contains(where: { group in group.prompts.contains { $0.promptKey == key } })
        else { return }
        saveReminders(groups.map { group in
            group.replacingPrompts(group.prompts.map { prompt in
                prompt.promptKey == key && prompt.isWaiting ? prompt.handled(did: did) : prompt
            })
        })
    }

    /// After a successful overdue sweep: drop the overdue tasks the sweep
    /// moved from the cached list (P0-P2 always; P3 too unless the server
    /// reported skipping High). Their new due dates aren't known client-side
    /// (the server resolved "next"), so they're removed rather than guessed
    /// at — the next successful fetch puts them back with real dates.
    static func removeSweptOverdueTasks(keepHigh: Bool, now: Date = Date()) {
        guard let cached = loadTasks() else { return }
        let kept = cached.tasks.filter { task in
            guard task.isOverdue(now: now), !task.isReminder, !task.isTracked else { return true }
            if task.priority >= 4 { return true }
            if task.priority == 3 { return keepHigh }
            return false
        }
        saveTasks(kept, projects: cached.projects)
    }
}

// MARK: - Quotas page

extension WatchCache {
    private static let labelConfigKey = "watch.labelConfig.v1"
    private static let showMetQuotasKey = "watch.quotas.showMet.v1"

    /// The user's label display colors (`label_config`) — the Quotas page's
    /// stripe colors. Cached like everything else so a failed fetch keeps
    /// last-known colors instead of drawing every stripe neutral.
    static func saveLabelConfig(_ config: [LabelConfigDTO]) {
        guard let data = try? JSONEncoder().encode(config) else { return }
        defaults?.set(data, forKey: labelConfigKey)
    }

    static func loadLabelConfig() -> [LabelConfigDTO]? {
        guard let data = defaults?.data(forKey: labelConfigKey) else { return nil }
        return try? JSONDecoder().decode([LabelConfigDTO].self, from: data)
    }

    /// The Quotas page's "Show met" toggle. Off by default (a missing key
    /// reads `false`) — a met quota is done for its period and stays out of
    /// the way unless asked for, the same default as the phone widget and the
    /// web panel. Local UI state, never synced.
    static var showMetQuotas: Bool {
        get { defaults?.bool(forKey: showMetQuotasKey) ?? false }
        set { defaults?.set(newValue, forKey: showMetQuotasKey) }
    }
}
