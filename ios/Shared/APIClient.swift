import Foundation

/// HTTP client for OpenTask server API calls.
///
/// Reads server URL and Bearer token from Keychain (shared via App Group).
/// Used by both the main app (device registration) and the notification
/// content extension (done/snooze actions).
final class APIClient {
    static let shared = APIClient()

    private init() {}

    var serverURL: String? {
        KeychainHelper.read(key: "serverURL")
    }

    var bearerToken: String? {
        KeychainHelper.read(key: "bearerToken")
    }

    var isConfigured: Bool {
        serverURL != nil && bearerToken != nil
    }

    // MARK: - Device Registration

    /// Register this device's APNs token with the server.
    /// Debug builds use "development" (APNs sandbox), Release builds use "production".
    func registerDevice(token: String, bundleId: String) async throws {
        #if DEBUG
        let environment = "development"
        #else
        let environment = "production"
        #endif

        try await post(path: "/api/push/apns/register", body: [
            "device_token": token,
            "bundle_id": bundleId,
            "environment": environment,
        ])
    }

    /// Unregister this device from APNs notifications.
    func unregisterDevice(token: String) async throws {
        try await request(method: "DELETE", path: "/api/push/apns/register", body: [
            "device_token": token,
        ])
    }

    // MARK: - Task Actions

    /// Mark a task as done via the notification actions endpoint.
    func markDone(taskId: Int) async throws {
        guard let token = bearerToken else { throw APIError.notConfigured }
        try await post(path: "/api/notifications/actions", body: [
            "action": "done",
            "task_id": taskId,
            "token": token,
        ] as [String: Any])
    }

    /// Snooze a task to a specific ISO 8601 datetime.
    func snoozeTo(taskId: Int, dueAt: String) async throws {
        try await request(method: "PATCH", path: "/api/tasks/\(taskId)", body: [
            "due_at": dueAt,
        ])
    }

    /// Snooze a task using the "next hour" behavior (rounded to hour boundary).
    func snoozeNextHour(taskId: Int) async throws {
        guard let token = bearerToken else { throw APIError.notConfigured }
        try await post(path: "/api/notifications/actions", body: [
            "action": "snooze",
            "task_id": taskId,
            "token": token,
        ] as [String: Any])
    }

    /// Bulk snooze all overdue tasks by delta minutes.
    /// P3 (High) and P4 (Urgent) excluded unless their ID is passed as `includeTaskId`.
    @discardableResult
    func snoozeOverdue(deltaMinutes: Int, includeTaskId: Int? = nil) async throws -> BulkSnoozeResult {
        var body: [String: Any] = ["delta_minutes": deltaMinutes]
        if let id = includeTaskId {
            body["include_task_ids"] = [id]
        }
        let data = try await post(path: "/api/tasks/bulk/snooze-overdue", body: body)
        return parseBulkSnoozeResult(data)
    }

    /// Bulk snooze all overdue tasks to an absolute time.
    /// P3 (High) and P4 (Urgent) excluded unless their ID is passed as `includeTaskId`.
    @discardableResult
    func snoozeOverdue(until: String, includeTaskId: Int? = nil) async throws -> BulkSnoozeResult {
        var body: [String: Any] = ["until": until]
        if let id = includeTaskId {
            body["include_task_ids"] = [id]
        }
        let data = try await post(path: "/api/tasks/bulk/snooze-overdue", body: body)
        return parseBulkSnoozeResult(data)
    }

    /// Bulk snooze all overdue tasks using user's default preference.
    /// P3 (High) and P4 (Urgent) excluded unless their ID is passed as `includeTaskId`.
    @discardableResult
    func snoozeOverdueDefault(includeTaskId: Int? = nil) async throws -> BulkSnoozeResult {
        var body: [String: Any] = [:]
        if let id = includeTaskId {
            body["include_task_ids"] = [id]
        }
        let data = try await post(path: "/api/tasks/bulk/snooze-overdue", body: body)
        return parseBulkSnoozeResult(data)
    }

    /// Bulk snooze all overdue tasks to a time slot, from a notification's
    /// slot-snooze action (`NotificationAction.parseSnoozeAllSlot`).
    ///
    /// `slot` is sent verbatim as the value parsed from the action identifier
    /// — a slot's `start_time` ("07:00") or the literal "next". The server
    /// resolves that to an actual instant in the user's timezone (a named
    /// slot: its next start, today if it hasn't started yet else tomorrow;
    /// "next": the first slot to start at all, wrapping to tomorrow past the
    /// last one today) — the device never computes the time itself.
    /// P3 (High) and P4 (Urgent) excluded unless their ID is passed as `includeTaskId`.
    @discardableResult
    func snoozeOverdue(slot: String, includeTaskId: Int? = nil) async throws -> BulkSnoozeResult {
        var body: [String: Any] = ["slot": slot]
        if let id = includeTaskId {
            body["include_task_ids"] = [id]
        }
        let data = try await post(path: "/api/tasks/bulk/snooze-overdue", body: body)
        return parseBulkSnoozeResult(data)
    }

    private func parseBulkSnoozeResult(_ data: Data) -> BulkSnoozeResult {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let responseData = json["data"] as? [String: Any] else {
            return BulkSnoozeResult(tasksAffected: 0, skippedUrgent: 0)
        }
        return BulkSnoozeResult(
            tasksAffected: responseData["tasks_affected"] as? Int ?? 0,
            skippedUrgent: responseData["skipped_urgent"] as? Int ?? 0
        )
    }

    struct BulkSnoozeResult {
        let tasksAffected: Int
        /// Number of P4 (Urgent) tasks that were skipped — these remain overdue.
        let skippedUrgent: Int
    }

    /// Complete N tasks in ONE request (§6.1 batch checklist).
    ///
    /// One request, not N: the notification content extension can be suspended
    /// the instant the user's finger leaves the screen, and a half-applied
    /// checklist is worse than none. The server runs this as a single
    /// transaction with a single undo entry.
    ///
    /// Returns how many tasks the server actually completed.
    @discardableResult
    func completeTasks(ids: [Int]) async throws -> Int {
        guard !ids.isEmpty else { return 0 }
        let data = try await post(path: "/api/tasks/bulk/complete", body: ["ids": ids])
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let responseData = json["data"] as? [String: Any] else {
            return 0
        }
        return responseData["tasks_affected"] as? Int ?? 0
    }

    /// Pending reminders for one time slot (§6), newest server truth.
    ///
    /// `slotId` is the `slot_id` from the SLOT_REMINDER push; -1 means the
    /// un-slotted "Anytime" group, matching `ReminderGroupDTO.slotKey`.
    func fetchSlotReminders(slotId: Int) async throws -> [TaskDTO] {
        let payload = try await fetchReminders()
        return payload.groups.first(where: { $0.slotKey == slotId })?.reminders ?? []
    }

    /// Complete every pending reminder in a slot. Used by the "Complete all"
    /// action, which is available even without the expanded checklist.
    @discardableResult
    func completeSlotReminders(slotId: Int) async throws -> Int {
        try await completeTasks(ids: fetchSlotReminders(slotId: slotId).map(\.id))
    }

    /// Log progress on a tracked task (§5). Deliberately NOT a completion —
    /// the task stays open past its target so overflow (3/2) stays observable.
    ///
    /// Signed: `+1` logs, `−1` corrects a mis-log (the server floors the result
    /// at 0). Named `logProgress` rather than `incrementProgress` because a
    /// method that can subtract should not be called an increment.
    func logProgress(taskId: Int, delta: Int = 1) async throws {
        try await post(path: "/api/tasks/\(taskId)/progress", body: ["delta": delta])
    }

    /// Undo the most recent action for the signed-in user (2026-09-23,
    /// widgets' Undo/Redo affordance) — the same endpoint the web app's
    /// toast Undo button calls (`useTaskActions.handleUndo`,
    /// `src/app/api/undo/route.ts`). No body: the web client optionally sends
    /// `session_start_id` to scope its undo/redo COUNTS to the page's
    /// session, but the undo itself always targets "the last action", and a
    /// widget has no session watermark to send in the first place — its
    /// counts are always all-time (see `fetchUndoStatus`).
    @discardableResult
    func undoLastAction() async throws -> UndoRedoResult {
        let data = try await post(path: "/api/undo", body: [:])
        return try parseUndoRedoResult(data)
    }

    /// Redo the most recently undone action (2026-09-23) — the twin of
    /// `undoLastAction`, hitting `POST /api/redo`
    /// (`src/app/api/redo/route.ts`). Same no-session-watermark reasoning.
    @discardableResult
    func redoLastAction() async throws -> UndoRedoResult {
        let data = try await post(path: "/api/redo", body: [:])
        return try parseUndoRedoResult(data)
    }

    /// The shared response shape of `/api/undo` and `/api/redo`: a
    /// human-readable description of what just happened (shown in the
    /// widget header's subtitle for ~60s — see `WidgetStore.
    /// recordLastAction`), and the resulting all-time counts (the server is
    /// the source of truth for whether the buttons should still be enabled
    /// after this call).
    struct UndoRedoResult {
        let description: String
        let tasksAffected: Int
        let undoableCount: Int
        let redoableCount: Int
    }

    private func parseUndoRedoResult(_ data: Data) throws -> UndoRedoResult {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let responseData = json["data"] as? [String: Any],
              let description = responseData["description"] as? String
        else {
            throw APIError.invalidResponse
        }
        return UndoRedoResult(
            description: description,
            tasksAffected: responseData["tasks_affected"] as? Int ?? 0,
            undoableCount: responseData["undoable_count"] as? Int ?? 0,
            redoableCount: responseData["redoable_count"] as? Int ?? 0
        )
    }

    /// All-time undo/redo counts (`GET /api/undo/status`), piggybacked on
    /// every widget data fetch (`RemindersProvider`, `TaskFeed`) so the
    /// always-present Undo/Redo buttons' enabled state reflects the server
    /// even when the last change came from the web app or another device,
    /// not just this widget's own taps.
    struct UndoStatus {
        let undoableCount: Int
        let redoableCount: Int
    }

    func fetchUndoStatus() async throws -> UndoStatus {
        let page = try await get(path: "/api/undo/status", as: UndoStatusPage.self)
        return UndoStatus(undoableCount: page.undoableCount, redoableCount: page.redoableCount)
    }

    // MARK: - Widget Data

    /// Today's incomplete reminders grouped by time slot (§6).
    func fetchReminders() async throws -> RemindersPayload {
        try await get(path: "/api/reminders", as: RemindersPayload.self)
    }

    /// Open (not-done) tasks. The server has no "today" filter — the dashboard
    /// fetches the open set and buckets client-side, and the widget does the
    /// same rather than inventing an endpoint.
    func fetchOpenTasks(limit: Int = 300) async throws -> [TaskDTO] {
        try await get(path: "/api/tasks?done=false&limit=\(limit)", as: TasksPage.self).tasks
    }

    /// Projects, used for the Tasks widget's scope chevrons. Names are never
    /// hardcoded on the client — whatever the server returns is what cycles.
    func fetchProjects() async throws -> [ProjectDTO] {
        try await get(path: "/api/projects", as: ProjectsPage.self).projects
    }

    /// The user's label display colors (`label_config`), for the Quotas
    /// widget's cluster stripes/dots — the same source the web Track panel
    /// reads (`PreferencesProvider`'s `data.label_config`, NOT `/api/labels`,
    /// which is the separate label *registry*, decoupled from display color).
    /// Pulled from the big `/api/user/preferences` payload one field at a
    /// time (`UserPreferencesLabelConfigPage`) rather than adding a
    /// label-config-only endpoint server-side.
    func fetchLabelConfig() async throws -> [LabelConfigDTO] {
        try await get(path: "/api/user/preferences", as: UserPreferencesLabelConfigPage.self)
            .labelConfig
    }

    /// The user's time slots (§6.0), for the notification slot-snooze actions
    /// (`TimeSlotStore`, `refreshSlotActions()`). User-configurable — nothing
    /// about the slot list is hardcoded on the client.
    func fetchTimeSlots() async throws -> [TimeSlotDTO] {
        try await get(path: "/api/time-slots", as: TimeSlotsPage.self).timeSlots
    }

    // MARK: - Notification Dismiss

    /// Tell the server to dismiss all notifications on all other devices.
    /// Called when the app comes to foreground — the user can see their tasks,
    /// so notification noise on other devices should clear.
    func dismissAllNotifications() async throws {
        try await post(path: "/api/notifications/dismiss-all", body: [:])
    }

    // MARK: - Preferences (for setup validation)

    /// Validate the server connection by fetching user preferences.
    /// Returns true if the server responds with 200.
    func validateConnection() async throws -> Bool {
        guard let urlString = serverURL,
              let url = URL(string: "\(urlString)/api/user/preferences"),
              let token = bearerToken
        else {
            throw APIError.notConfigured
        }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        return httpResponse.statusCode == 200
    }

    // MARK: - Internal

    /// POST with Bearer auth from Keychain.
    @discardableResult
    private func post(path: String, body: [String: Any]) async throws -> Data {
        try await request(method: "POST", path: path, body: body)
    }

    /// GET with Bearer auth, unwrapping the `{ "data": ... }` envelope.
    private func get<T: Decodable>(path: String, as type: T.Type) async throws -> T {
        guard let urlString = serverURL,
              let url = URL(string: "\(urlString)\(path)"),
              let token = bearerToken
        else {
            throw APIError.notConfigured
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        // Widget timelines are built under a tight system budget — fail fast and
        // fall back to the cached payload rather than stalling the reload.
        request.timeoutInterval = 12
        request.cachePolicy = .reloadIgnoringLocalCacheData

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            throw APIError.serverError(statusCode: httpResponse.statusCode)
        }

        return try JSONDecoder().decode(APIEnvelope<T>.self, from: data).data
    }

    @discardableResult
    private func request(method: String, path: String, body: [String: Any]) async throws -> Data {
        guard let urlString = serverURL,
              let url = URL(string: "\(urlString)\(path)"),
              let token = bearerToken
        else {
            throw APIError.notConfigured
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 15
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            throw APIError.serverError(statusCode: httpResponse.statusCode)
        }

        return data
    }
}

enum APIError: LocalizedError {
    case notConfigured
    case invalidResponse
    case serverError(statusCode: Int)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "Server not configured"
        case .invalidResponse:
            return "Invalid server response"
        case .serverError(let code):
            return "Server error (\(code))"
        }
    }
}
