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

    /// After a successful overdue sweep: drop the tasks the sweep moved from
    /// the cached list — exactly the server's `moved_ids`, or, from an older
    /// server that doesn't send them, the guess from the counts
    /// (`BulkSnoozeResult.tasksLeft(after:)`, in `ios/Shared/SweepSummary.swift`,
    /// which has both rules and is what `OpenTaskLogicTests` covers).
    static func removeSweptOverdueTasks(after result: APIClient.BulkSnoozeResult, now: Date = Date()) {
        guard let cached = loadTasks() else { return }
        saveTasks(result.tasksLeft(after: cached.tasks, now: now), projects: cached.projects)
    }
}

// MARK: - Task segments (2026-10-10)

extension WatchCache {
    /// `GET /api/reminders`' top-level `task_segments`, under their own key
    /// — never inside the cached groups (a group's reminders are what every
    /// "Complete all" completes). A separate key rather than a new reminders
    /// format, so a cache from an older build still reads, with no segments.
    private static let taskSegmentsKey = "watch.taskSegments.v1"

    static func saveTaskSegments(_ segments: [TaskSegmentDTO]) {
        guard let data = try? JSONEncoder().encode(segments) else { return }
        defaults?.set(data, forKey: taskSegmentsKey)
    }

    static func loadTaskSegments() -> [TaskSegmentDTO] {
        guard let data = defaults?.data(forKey: taskSegmentsKey),
              let segments = try? JSONDecoder().decode([TaskSegmentDTO].self, from: data)
        else { return [] }
        return segments
    }

    /// Mirror a segment action into the cache — `state` for a consider or a
    /// defer, nil to drop the row (done) — so the Smart Stack card agrees
    /// even when its own fetch fails.
    static func setSegmentRow(taskId: Int, state: SegmentTaskDTO.State?) {
        editSegmentRow(taskId: taskId) { row in state.map { row.with(state: $0) } }
    }

    /// Mirror any edit of one row (native PR E): a done or Today that LEFT
    /// the segment (`leaving`), a safety-net row seen (`consideredByTap`);
    /// nil drops the row.
    static func editSegmentRow(taskId: Int, _ edit: (SegmentTaskDTO) -> SegmentTaskDTO?) {
        saveTaskSegments(loadTaskSegments().map { segment in
            segment.replacingTasks(segment.tasks.compactMap { row in
                row.id == taskId ? edit(row) : row
            })
        })
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

// MARK: - Scoped Undo (2026-10-26, `UndoScope`)

extension WatchCache {
    /// The watch's ONE undo surface: the watch app and its Smart Stack card
    /// (two processes, one App Group). Every mutation either sends records its
    /// `undo_id` here (`APIClient.undoRecorder`, set in `OpenTaskWatchApp`
    /// and `OpenTaskWatchWidgetBundle`), so the app's toolbar Undo takes back
    /// a Smart Stack tap too — and never what the phone, the Mac or the web
    /// did. A disjoint `watch.*` key, like every key here.
    private static let undoScopeStore = UndoScopeStore(key: "watch.undoScope.v1") { WatchCache.defaults }

    static var undoScope: UndoScope { undoScopeStore.load() }

    /// Point `APIClient.undoRecorder` here (idempotent). Set at process start
    /// (`OpenTaskWatchApp`, `OpenTaskWatchWidgetBundle`) and again by each
    /// Smart Stack intent before it sends, so no tap's id can be missed.
    static func installUndoRecorder() {
        APIClient.undoRecorder = { WatchCache.recordOwnUndo($0) }
    }

    static func recordOwnUndo(_ id: Int) {
        undoScopeStore.update { $0.recordOwn(id) }
    }

    @discardableResult
    static func updateUndoScope<T>(_ body: (inout UndoScope) -> T) -> T {
        undoScopeStore.update(body)
    }
}
