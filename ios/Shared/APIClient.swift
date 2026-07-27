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
    func incrementProgress(taskId: Int, delta: Int = 1) async throws {
        try await post(path: "/api/tasks/\(taskId)/progress", body: ["delta": delta])
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
