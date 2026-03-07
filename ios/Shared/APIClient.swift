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
    /// P4 (Urgent) excluded unless their ID is passed as `includeTaskId`.
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
    /// P4 (Urgent) excluded unless their ID is passed as `includeTaskId`.
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
    /// P4 (Urgent) excluded unless their ID is passed as `includeTaskId`.
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
            return BulkSnoozeResult(tasksAffected: 0)
        }
        return BulkSnoozeResult(
            tasksAffected: responseData["tasks_affected"] as? Int ?? 0
        )
    }

    struct BulkSnoozeResult {
        let tasksAffected: Int
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
