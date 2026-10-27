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
    /// The environment follows the signing entitlement (`ApsEnvironment`),
    /// not the build configuration.
    func registerDevice(token: String, bundleId: String) async throws {
        let environment = ApsEnvironment.current

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

    /// Register a widget extension's WidgetKit push token — the WIDGET
    /// EXTENSION's token, not the app's own APNs token above, stored in
    /// `widget_push_tokens`. `bundleId` is the containing app's id (the
    /// server appends `.push-type.widgets` for the APNs topic); `platform` is
    /// `ios`, `macos` or `watchos`. Called only through
    /// `WidgetPushRegistration`, which owns the retry-until-confirmed state.
    func registerWidgetToken(token: String, bundleId: String, platform: String, widgetKind: String) async throws {
        try await post(path: "/api/push/apns/widget-token", body: [
            "push_token": token,
            "bundle_id": bundleId,
            "platform": platform,
            "environment": ApsEnvironment.current,
            "widget_kind": widgetKind,
        ])
    }

    /// Delete a widget push token's row. No extension calls this today: an
    /// empty widget list is deliberately NOT taken as "the last widget was
    /// removed" (see `WidgetPushRegistration`, rule 1), and APNs retires a
    /// dead token server-side. Kept so the route's `DELETE` has its client.
    func unregisterWidgetToken(token: String) async throws {
        try await request(method: "DELETE", path: "/api/push/apns/widget-token", body: [
            "push_token": token,
        ])
    }

    // MARK: - Task Actions

    /// Mark a task as done via the notification actions endpoint.
    func markDone(taskId: Int) async throws {
        try await markDone(taskId: taskId, day: nil)
    }

    /// `POST /api/notifications/actions` `done` with `day` → `{ "considered": Bool }`.
    ///
    /// `considered: false` means the server changed nothing: the push was for
    /// another OpenTask day, or the reminder is no longer waiting (considered
    /// somewhere else). A missing field reads as `true`: a server from before
    /// the day guard ignores `day` and does a plain done, so it acted.
    struct ReminderConsiderResult: Decodable, Equatable {
        let considered: Bool

        init(considered: Bool) {
            self.considered = considered
        }

        private enum CodingKeys: String, CodingKey { case considered }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            considered = try c.decodeIfPresent(Bool.self, forKey: .considered) ?? true
        }
    }

    /// Mark a task as done via the notification actions endpoint, optionally
    /// for one OpenTask `day` — the named reminder push's Considered button
    /// (`REMINDER_NAG`, 2026-10-26) sends its payload's `reminder_day`, and the
    /// server considers the reminder only if it is waiting on that day, today.
    /// Returns the server's `considered` (always `true` with no `day`). A 2xx
    /// whose body doesn't decode still means the server acted: `true`.
    ///
    /// `markDone(taskId:)` above is this with no day; it stays its own method
    /// because `WidgetOutboxTransport` requires that exact Void signature.
    @discardableResult
    func markDone(taskId: Int, day: String?) async throws -> Bool {
        guard let token = bearerToken else { throw APIError.notConfigured }
        var body: [String: Any] = [
            "action": "done",
            "task_id": taskId,
            "token": token,
        ]
        if let day { body["day"] = day }
        let data = try await post(path: "/api/notifications/actions", body: body)
        guard day != nil else { return true }
        return (try? JSONDecoder().decode(APIEnvelope<ReminderConsiderResult>.self, from: data).data.considered) ?? true
    }

    /// Move a task to the trash from a notification's Delete button
    /// (`TASK_ADDED`). Same endpoint and body-token auth as `markDone`; the
    /// server's `deleteTask` is the app's soft delete, so Undo in the app
    /// brings it back.
    func deleteTask(taskId: Int) async throws {
        guard let token = bearerToken else { throw APIError.notConfigured }
        try await post(path: "/api/notifications/actions", body: [
            "action": "delete",
            "task_id": taskId,
            "token": token,
        ] as [String: Any])
    }

    /// Create a task from a title alone — the web's quick add
    /// (`POST /api/tasks` `{ title }`). The server tags it for AI enrichment
    /// when AI is on, exactly as it does for the dashboard's quick add.
    func createTask(title: String) async throws {
        try await post(path: "/api/tasks", body: ["title": title])
    }

    /// Snooze a task to a specific ISO 8601 datetime.
    ///
    /// `cap_at_deadline: true` (ruling A3, 2026-10-11): a one-tap snooze
    /// stops AT a deadline still ahead instead of passing it — the server
    /// moves the target to the deadline. Only the web's "Defer anyway" goes
    /// past. A 409 from an older server surfaces as `APIError.serverError(409)`.
    func snoozeTo(taskId: Int, dueAt: String) async throws {
        try await request(method: "PATCH", path: "/api/tasks/\(taskId)", body: [
            "due_at": dueAt,
            "cap_at_deadline": true,
        ])
    }

    /// Restore a completed item to open (2026-09-23, "show completed" — a
    /// tap on a DONE row's checkmark). `POST /api/tasks/:id/undone`
    /// (`src/app/api/tasks/[id]/undone/route.ts` → `markUndone()`), the same
    /// endpoint the web Reminders surface's "put back" gesture already uses
    /// (`useReminders.ts`'s `usePutBack`) — confirmed correct for a one-off
    /// Task too: `markUndone` only requires `task.done === true` for a
    /// non-recurring task. A recurring task/reminder throws
    /// `ValidationError('Task changed since it was completed')` if it was
    /// snoozed/edited/completed-again since — `UncompleteTaskIntent` treats
    /// that the same as any other failure (see its doc). Empty body, no
    /// response parsing beyond success/failure — mirrors `undoLastAction()`'s
    /// call shape.
    @discardableResult
    func markUndone(taskId: Int) async throws -> Data {
        try await post(path: "/api/tasks/\(taskId)/undone", body: [:])
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

    // `notify` (every `snoozeOverdue*` below): `false` sends `notify: false`,
    // which stops the server's "what was left overdue" feedback push for this
    // call (`src/core/notifications/sweep-feedback.ts`). Only for a caller that
    // shows the result itself — the Home Screen quick actions, which open the
    // app and its toast (`QuickActionHandler`). `nil` (the default) omits the
    // field, so the push goes out when something High or Urgent was left.

    /// Bulk snooze all overdue tasks by delta minutes.
    /// P3 (High) and P4 (Urgent) excluded unless their ID is passed as `includeTaskId`.
    @discardableResult
    func snoozeOverdue(deltaMinutes: Int, includeTaskId: Int? = nil, notify: Bool? = nil) async throws -> BulkSnoozeResult {
        var body: [String: Any] = ["delta_minutes": deltaMinutes]
        if let id = includeTaskId {
            body["include_task_ids"] = [id]
        }
        return try await snoozeOverdue(body: body, notify: notify)
    }

    /// Bulk snooze all overdue tasks to an absolute time.
    /// P3 (High) and P4 (Urgent) excluded unless their ID is passed as `includeTaskId`.
    @discardableResult
    func snoozeOverdue(until: String, includeTaskId: Int? = nil, notify: Bool? = nil) async throws -> BulkSnoozeResult {
        var body: [String: Any] = ["until": until]
        if let id = includeTaskId {
            body["include_task_ids"] = [id]
        }
        return try await snoozeOverdue(body: body, notify: notify)
    }

    /// Bulk snooze all overdue tasks to tomorrow at the user's morning time
    /// (`tomorrow: true`, resolved server-side — the Home Screen quick action
    /// and the Mac's "Defer All to Tomorrow" menu item).
    @discardableResult
    func snoozeOverdueTomorrow(notify: Bool? = nil) async throws -> BulkSnoozeResult {
        try await snoozeOverdue(body: ["tomorrow": true], notify: notify)
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
    func snoozeOverdue(slot: String, includeTaskId: Int? = nil, notify: Bool? = nil) async throws -> BulkSnoozeResult {
        var body: [String: Any] = ["slot": slot]
        if let id = includeTaskId {
            body["include_task_ids"] = [id]
        }
        return try await snoozeOverdue(body: body, notify: notify)
    }

    private func snoozeOverdue(body: [String: Any], notify: Bool?) async throws -> BulkSnoozeResult {
        var body = body
        if let notify { body["notify"] = notify }
        let data = try await post(path: "/api/tasks/bulk/snooze-overdue", body: body)
        return Self.parseBulkSnoozeResult(data)
    }

    static func parseBulkSnoozeResult(_ data: Data) -> BulkSnoozeResult {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let responseData = json["data"] as? [String: Any] else {
            return BulkSnoozeResult(tasksAffected: 0, skippedOnPriority: 0, skippedHigh: 0, snoozedHigh: 0)
        }
        return BulkSnoozeResult(
            tasksAffected: responseData["tasks_affected"] as? Int ?? 0,
            skippedOnPriority: responseData["skipped_urgent"] as? Int ?? 0,
            skippedHigh: responseData["skipped_high"] as? Int ?? 0,
            snoozedHigh: responseData["snoozed_high"] as? Int ?? 0,
            skippedDeadline: responseData["skipped_deadline"] as? Int ?? 0,
            cappedDeadline: responseData["capped_deadline"] as? Int ?? 0,
            queued: responseData["queued"] as? Int ?? 0,
            queuedUntil: (responseData["queued_until"] as? String).flatMap(DateHelpers.parseISO),
            summary: (responseData["summary"] as? String).flatMap { $0.isEmpty ? nil : $0 },
            movedIds: responseData["moved_ids"] as? [Int]
        )
    }

    /// `POST /api/tasks/bulk/snooze-overdue`'s response — see
    /// `src/core/tasks/bulk.ts`'s `filterForBulkSnooze` doc for where these
    /// numbers come from server-side.
    struct BulkSnoozeResult: Equatable {
        let tasksAffected: Int
        /// The server's `skipped_urgent` field, kept under its wire name for
        /// clarity about what it actually is: despite the name, this is the
        /// COMBINED High + Urgent count skipped on priority, not Urgent alone
        /// — a legacy name that predates the High/Urgent split (`src/core/
        /// tasks/bulk.ts`: "`urgentSkipped` is the TOTAL skipped on priority
        /// ... keeps its name for API compatibility"). Use `skippedUrgent`
        /// below for the true Urgent-only count.
        let skippedOnPriority: Int
        /// The High (P3) subset of `skippedOnPriority`.
        let skippedHigh: Int
        /// How many of the moved tasks were High (P3) — nonzero only once a
        /// batch had nothing lower left (docs/TASK-MODEL.md: P3 is swept only
        /// when no lower-priority task in the same batch is still eligible).
        let snoozedHigh: Int
        /// Urgent (P4) alone — never swept, ever (docs/TASK-MODEL.md). Derived
        /// rather than read directly: the server has no single field for this,
        /// only the combined `skippedOnPriority` and the `skippedHigh` subset.
        var skippedUrgent: Int { skippedOnPriority - skippedHigh }
        /// Tasks left where they were because the snooze would have carried
        /// their target past a deadline still ahead (2026-10-10, the server's
        /// `skipped_deadline`; 0 from an older server). A sweep skips them on
        /// purpose; an explicit per-row tap stops at the deadline instead by
        /// sending `cap_at_deadline_ids` (`bulkSnoozeTasks`, ruling A3).
        var skippedDeadline: Int = 0
        /// Snoozed only as far as their deadline (ruling A3, 2026-10-11, the
        /// server's `capped_deadline` for the ids in `cap_at_deadline_ids`;
        /// 0 from an older server).
        var cappedDeadline: Int = 0
        /// Of `tasksAffected`, the ones the sweep sent to the Tasks queue at
        /// the next day start instead of the period asked for (task queue,
        /// docs/TASK-MODEL.md § Picks and defers: a below-High task whose
        /// landing is at or after the next rollover gets the rollover, marked)
        /// — so "Moved to Evening" would be false for them. 0 with the queue
        /// switch off and from an older server.
        var queued: Int = 0
        /// The rollover the queued tasks were targeted at (`queued_until`);
        /// nil when none were.
        var queuedUntil: Date?
        /// The server's one-line account of the press (`summary`,
        /// `bulkSnoozeMessage`: "3 will move to the Tasks queue at 3:00 AM ·
        /// Deferred 2 tasks (1 urgent skipped)") — the web toast's words.
        /// Nil from an older server.
        var summary: String?
        /// The ids this call moved (`moved_ids`, 2026-10-26), queued ones
        /// included: after a sweep exactly these tasks' banners are cleared
        /// (`dismissNotificationsAfterSweep`), and exactly these leave the
        /// watch's cached task list (`tasksLeft(after:)`). Empty when nothing
        /// moved. NIL from an older server, which doesn't say: then no banner
        /// is cleared locally (its silent `dismiss` push still clears the
        /// moved ones) and the cache falls back to guessing from the counts.
        var movedIds: [Int]?
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
        try await completeTasks(ids: ids, prompts: []).total
    }

    /// One quota-prompt action inside a `bulk/complete` batch (quota
    /// reminders, 2026-09-24): consider (the circle) or "did it" (the square).
    struct PromptCommit: Hashable {
        let key: String
        let did: Bool
    }

    /// `POST /api/tasks/bulk/complete`'s answer, reminders and prompts both.
    struct BulkCompleteResult {
        let tasksAffected: Int
        let promptsConsidered: Int
        let promptsDid: Int
        /// Everything the server acted on — what "did the commit do
        /// anything" guards read, so a prompts-only batch counts.
        var total: Int { tasksAffected + promptsConsidered + promptsDid }
    }

    /// Complete reminders AND act on quota prompts in ONE request — one
    /// transaction, one undo entry (the notification checklist's mixed
    /// commit, and every "Complete all"). `prompts` is sent only when there
    /// are any: a consider is a bare key, a did-it `{key, did: true}` — the
    /// server's two accepted shapes. `ids` may be empty when `prompts` is
    /// not. A key from another day refuses the whole batch (400), so a
    /// caller holding a payload from before midnight must re-fetch.
    ///
    /// `source` (2026-10-16, `ProgressSource`) is sent only with prompts —
    /// a did-it is the batch's only progress; a reminders-only batch logs
    /// none, so it stays as it was.
    @discardableResult
    func completeTasks(
        ids: [Int], prompts: [PromptCommit], source: ProgressSource? = nil
    ) async throws -> BulkCompleteResult {
        guard !ids.isEmpty || !prompts.isEmpty else {
            return BulkCompleteResult(tasksAffected: 0, promptsConsidered: 0, promptsDid: 0)
        }
        var body: [String: Any] = ["ids": ids]
        if !prompts.isEmpty {
            body["prompts"] = prompts.map { commit -> Any in
                commit.did ? ["key": commit.key, "did": true] as [String: Any] : commit.key
            }
            body = ProgressSource.adding(source, to: body)
        }
        let data = try await post(path: "/api/tasks/bulk/complete", body: body)
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let responseData = json["data"] as? [String: Any] else {
            return BulkCompleteResult(tasksAffected: 0, promptsConsidered: 0, promptsDid: 0)
        }
        return BulkCompleteResult(
            tasksAffected: responseData["tasks_affected"] as? Int ?? 0,
            promptsConsidered: responseData["prompts_considered"] as? Int ?? 0,
            promptsDid: responseData["prompts_did"] as? Int ?? 0
        )
    }

    // MARK: - Quota prompts (quota reminders, 2026-09-24)

    /// What `POST /api/quota-prompts/consider` and `/did` answer: how many
    /// were acted on, and every quota touched AS THE SERVER LEFT IT — which
    /// callers write straight into their caches, so counts stay server-true
    /// (the confirmProgress lesson, `ios/AGENTS.md`).
    struct PromptActionResult: Decodable {
        let considered: Int
        let did: Int
        let tasks: [TaskDTO]
        /// False when the call SUCCEEDED but its body didn't decode — the
        /// server acted, but there are no confirmed quotas to write, so a
        /// caller must mark its caches stale rather than trust them.
        let decoded: Bool

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            considered = try c.decodeIfPresent(Int.self, forKey: .considered) ?? 0
            did = try c.decodeIfPresent(Int.self, forKey: .did) ?? 0
            tasks = try c.decodeIfPresent([TaskDTO].self, forKey: .tasks) ?? []
            decoded = true
        }

        init(considered: Int, did: Int, tasks: [TaskDTO], decoded: Bool = true) {
            self.considered = considered
            self.did = did
            self.tasks = tasks
            self.decoded = decoded
        }

        enum CodingKeys: String, CodingKey { case considered, did, tasks }
    }

    /// The round circle on a quota prompt: handled for today, NO progress.
    /// Idempotent; one transaction and one undo entry for every key.
    @discardableResult
    func considerPrompts(keys: [String]) async throws -> PromptActionResult {
        try await promptAction(path: "/api/quota-prompts/consider", keys: keys)
    }

    /// The square on a quota prompt: "did it" — progress AND considered.
    /// Idempotent per key (a daily #k raises the count to at least k; any
    /// other quota +1 unless that key was already done today), so a retried
    /// request logs once.
    @discardableResult
    func didPrompts(keys: [String], source: ProgressSource? = nil) async throws -> PromptActionResult {
        try await promptAction(path: "/api/quota-prompts/did", keys: keys, source: source)
    }

    /// What `POST /api/quota-prompts/restore` answers (2026-09-25): how many
    /// keys were handled and now wait again, and every quota touched AS THE
    /// SERVER LEFT IT — a did-it's progress taken back — for the caches.
    struct PromptRestoreResult: Decodable {
        let restored: Int
        let tasks: [TaskDTO]
        /// See `PromptActionResult.decoded`.
        let decoded: Bool

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            restored = try c.decodeIfPresent(Int.self, forKey: .restored) ?? 0
            tasks = try c.decodeIfPresent([TaskDTO].self, forKey: .tasks) ?? []
            decoded = true
        }

        init(restored: Int, tasks: [TaskDTO], decoded: Bool = true) {
            self.restored = restored
            self.tasks = tasks
            self.decoded = decoded
        }

        enum CodingKeys: String, CodingKey { case restored, tasks }
    }

    /// PUT BACK a handled prompt (the filled dashed circle in the Reminders
    /// widget's DONE section, 2026-09-25): it waits for today again, and a
    /// did-it's progress comes off — exactly what it added. One transaction,
    /// one undo entry. Never `/undone`, which a quota refuses.
    @discardableResult
    func restorePrompts(keys: [String], source: ProgressSource? = nil) async throws -> PromptRestoreResult {
        guard !keys.isEmpty else { return PromptRestoreResult(restored: 0, tasks: []) }
        let data = try await post(
            path: "/api/quota-prompts/restore", body: ProgressSource.adding(source, to: ["keys": keys])
        )
        return (try? JSONDecoder().decode(APIEnvelope<PromptRestoreResult>.self, from: data).data)
            ?? PromptRestoreResult(restored: 0, tasks: [], decoded: false)
    }

    /// `source` only on did-it: a consider logs no progress, so it sends none.
    private func promptAction(
        path: String, keys: [String], source: ProgressSource? = nil
    ) async throws -> PromptActionResult {
        guard !keys.isEmpty else { return PromptActionResult(considered: 0, did: 0, tasks: []) }
        let data = try await post(path: path, body: ProgressSource.adding(source, to: ["keys": keys]))
        // A body that doesn't decode after a 2xx still means the server
        // acted: report success with no tasks, and let the caller re-fetch.
        return (try? JSONDecoder().decode(APIEnvelope<PromptActionResult>.self, from: data).data)
            ?? PromptActionResult(considered: 0, did: 0, tasks: [], decoded: false)
    }

    // MARK: Task segments (2026-10-10, docs/TASK-MODEL.md § Task segments)
    //
    // The three task-segment actions, each `{ ids: [taskId, ...] }` and each
    // ONE server undo entry (the standard `POST /api/undo` takes it back).
    // Done on a segment row is NOT here: it is the ordinary completion
    // (`markDone`, through the widget outbox, or `completeTasks(ids:)`).

    /// `POST /api/task-segments/consider` → `{ "considered": N }`.
    struct SegmentConsiderResult: Decodable, Equatable {
        let considered: Int
    }

    /// The segment row's circle: "I saw it" — stamps `last_considered_at`.
    /// NEVER a completion. Idempotent in effect (considering a row already
    /// considered today changes nothing but still logs an undo entry), so a
    /// resend after a cut-off request is safe.
    @discardableResult
    func considerSegmentTasks(ids: [Int]) async throws -> Int {
        guard !ids.isEmpty else { return 0 }
        let data = try await post(path: "/api/task-segments/consider", body: ["ids": ids])
        return (try? JSONDecoder().decode(APIEnvelope<SegmentConsiderResult>.self, from: data).data.considered) ?? 0
    }

    /// Defer All: off today's segment, back tomorrow. Not a consider.
    @discardableResult
    func deferSegmentTasks(ids: [Int]) async throws -> Data {
        guard !ids.isEmpty else { return Data() }
        return try await post(path: "/api/task-segments/defer", body: ["ids": ids])
    }

    /// `POST /api/task-segments/target-today` → `{ until, affected,
    /// skipped_recurring? }`. `skippedRecurring` (2026-10-12): ids the server
    /// left alone because they repeat (ruling Q1) — their target is the
    /// recurrence's, so "Target today" doesn't apply.
    struct SegmentTargetResult: Decodable, Equatable {
        let affected: Int
        let skippedRecurring: [Int]

        enum CodingKeys: String, CodingKey {
            case affected
            case skippedRecurring = "skipped_recurring"
        }

        init(affected: Int, skippedRecurring: [Int] = []) {
            self.affected = affected
            self.skippedRecurring = skippedRecurring
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            affected = try c.decodeIfPresent(Int.self, forKey: .affected) ?? 0
            skippedRecurring = try c.decodeIfPresent([Int].self, forKey: .skippedRecurring) ?? []
        }
    }

    /// "Target today": a deliberate target today (the age clock starts
    /// there), also marking the rows considered. A body that doesn't decode
    /// after a 2xx still means the server acted: it reads as nothing skipped.
    @discardableResult
    func targetSegmentTasksToday(ids: [Int]) async throws -> SegmentTargetResult {
        guard !ids.isEmpty else { return SegmentTargetResult(affected: 0) }
        let data = try await post(path: "/api/task-segments/target-today", body: ["ids": ids])
        return (try? JSONDecoder().decode(APIEnvelope<SegmentTargetResult>.self, from: data).data)
            ?? SegmentTargetResult(affected: ids.count)
    }

    /// Snooze SPECIFIC tasks by id — `POST /api/tasks/bulk/snooze`
    /// (2026-09-23, Tasks widget snooze mode / bulk select). The ids-based
    /// twin of `snoozeOverdue`'s sweep: that endpoint (`bulk/snooze-overdue`)
    /// queries the overdue set server-side and has no `ids` mode at all;
    /// this one does the opposite — it never looks at what's overdue, it
    /// acts on EXACTLY the ids given.
    ///
    /// `includeTaskIds`, when passed, bypasses the P3(High)/P4(Urgent) sweep
    /// -safety filter (`filterForBulkSnooze`, `src/core/tasks/bulk.ts`) for
    /// those specific ids — mirroring the web's OWN explicit-selection
    /// convention exactly (`src/lib/save-quick-panel-changes.ts`'s
    /// `buildDateRequest`: "explicit user selections always pass
    /// `include_task_ids` so explicit selections bypass the P4/Urgent skip
    /// filter... the sweep remains the only caller that omits it"). Callers
    /// in THIS file follow the same split: a per-row snooze-mode tap and a
    /// bulk-select action are both explicit, deliberate picks (pass
    /// `includeTaskIds` = `ids`); nothing here ever omits it, because
    /// nothing here is a sweep — `snoozeOverdue` above is the sweep.
    ///
    /// `deltaMinutes`, on THIS endpoint, means "N minutes added to EACH
    /// task's own `due_at`" — confirmed against `bulkSnooze`'s server
    /// implementation (`src/core/tasks/bulk.ts`) and matched by the web's
    /// OWN bulk relative-INCREMENT button (`QuickActionPanel`'s
    /// `applyIncrement`, which feeds `save-quick-panel-changes.ts`'s
    /// `changes.delta_minutes`). This is DIFFERENT from
    /// `snoozeOverdue(deltaMinutes:)` above, whose `delta_minutes` means "N
    /// minutes from NOW, snapped" — two different endpoints with two
    /// different established meanings for the same parameter name.
    ///
    /// The Tasks widget uses BOTH modes (2026-09-24, `TaskSnoozePlan` in
    /// `Shared/TaskSnoozePlan.swift`, also the watch): "+1h" on an UPCOMING task is
    /// exactly its own due + 60 — this `deltaMinutes: 60` — while "+1h" on an
    /// overdue/undated one is one hour from now, snapped, sent as `until`.
    /// (2026-09-23 had every "+1h" as from-now `until`; that moved a 5 PM
    /// task to 11 AM.)
    @discardableResult
    func bulkSnoozeTasks(
        ids: [Int], until: String? = nil, deltaMinutes: Int? = nil, includeTaskIds: [Int]? = nil,
        capAtDeadlineIds: [Int]? = nil
    ) async throws -> BulkSnoozeResult {
        var body: [String: Any] = ["ids": ids]
        if let until { body["until"] = until }
        if let deltaMinutes { body["delta_minutes"] = deltaMinutes }
        if let includeTaskIds { body["include_task_ids"] = includeTaskIds }
        // The server skips a task whose snooze would cross a deadline still
        // ahead (`skipped_deadline`), or, for an id here, stops it AT the
        // deadline (ruling A3, 2026-10-11) — an explicit per-row/selected tap
        // passes its own ids, a sweep never.
        if let capAtDeadlineIds { body["cap_at_deadline_ids"] = capAtDeadlineIds }
        let data = try await post(path: "/api/tasks/bulk/snooze", body: body)
        return Self.parseBulkSnoozeResult(data)
    }

    /// Pending reminders for one time slot (§6), newest server truth.
    ///
    /// `slotId` is the `slot_id` from the SLOT_REMINDER push; -1 means the
    /// un-slotted "Anytime" group, matching `ReminderGroupDTO.slotKey`.
    func fetchSlotReminders(slotId: Int) async throws -> [TaskDTO] {
        try await fetchSlotGroup(slotId: slotId)?.reminders ?? []
    }

    /// One slot's whole group — reminders AND quota prompts (2026-09-24) —
    /// newest server truth. `nil` when the slot has no group today.
    func fetchSlotGroup(slotId: Int) async throws -> ReminderGroupDTO? {
        let payload = try await fetchReminders()
        return payload.groups.first(where: { $0.slotKey == slotId })
    }

    /// "Complete all" for a slot, available even without the expanded
    /// checklist (iOS, watch and Mac notification actions). Completes every
    /// pending reminder AND considers every waiting quota prompt — CONSIDERED
    /// only, never "did it" (Trent's rule: consider-all never logs progress)
    /// — in one request. Returns everything the server acted on, so a slot
    /// holding only prompts still reads as handled. Fetched fresh right
    /// before the commit, so the prompt keys are today's.
    ///
    /// `didKeys`: prompts the user explicitly staged as DID IT in the
    /// expanded checklist before pressing Complete all — those keep their
    /// +1 (dropping a staged did-it silently would be a lie); every other
    /// waiting prompt is considered. Empty from the lock-screen action paths,
    /// which have no staging.
    @discardableResult
    func completeSlotReminders(
        slotId: Int, didKeys: Set<String> = [], source: ProgressSource? = nil
    ) async throws -> Int {
        guard let group = try await fetchSlotGroup(slotId: slotId) else { return 0 }
        return try await completeTasks(
            ids: group.reminders.map(\.id),
            prompts: group.waitingPrompts.map {
                PromptCommit(key: $0.promptKey, did: didKeys.contains($0.promptKey))
            },
            source: source
        ).total
    }

    /// Log progress on a tracked task (§5). Deliberately NOT a completion —
    /// the task stays open past its target so overflow (3/2) stays observable.
    ///
    /// Signed: `+1` logs, `−1` corrects a mis-log (the server floors the result
    /// at 0). Named `logProgress` rather than `incrementProgress` because a
    /// method that can subtract should not be called an increment.
    ///
    /// Returns the task as the server left it (the route answers with
    /// `formatTaskResponse(task)` + `met`/`description`, which decoding
    /// ignores) — the widget writes it straight into its cache
    /// (`WidgetStore.confirmProgress`, 2026-09-24, the stale-count fix).
    /// `nil` only when the call SUCCEEDED but the body didn't decode: the
    /// server has committed the delta either way, so a decode problem must
    /// never surface as a thrown error the caller would read as "the log
    /// failed" and revert.
    @discardableResult
    ///
    /// `source`: where it was logged from (`ProgressSource`); nil → `api`.
    func logProgress(taskId: Int, delta: Int = 1, source: ProgressSource? = nil) async throws -> TaskDTO? {
        let data = try await post(
            path: "/api/tasks/\(taskId)/progress", body: ProgressSource.adding(source, to: ["delta": delta])
        )
        return try? JSONDecoder().decode(APIEnvelope<TaskDTO>.self, from: data).data
    }

    /// A quota's stored `quota_prompt_config` as raw JSON (`nil` = the
    /// defaults) — `GET /api/tasks/{id}`. Raw rather than a model: the move
    /// below must hand back every key it did not touch (`enabled`, the other
    /// numbers' overrides) exactly as stored, since a PATCH replaces the
    /// whole object.
    func fetchQuotaPromptConfig(taskId: Int) async throws -> [String: Any]? {
        let data = try await request(method: "GET", path: "/api/tasks/\(taskId)", body: nil)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let task = json?["data"] as? [String: Any]
        return task?["quota_prompt_config"] as? [String: Any]
    }

    /// The three fields that say whether a completion already landed — raw
    /// `GET /api/tasks/{id}` (`TaskDTO` carries no `done`). `nil` when the
    /// task is gone for this user (404). The widget outbox reads it before
    /// RESENDING a completion (`WidgetOutboxDrainer`): a recurring task's
    /// `done` stays false and its `due_at` moves on, so "still the occurrence
    /// that was tapped" is what makes a retry safe to send.
    struct TaskState: Equatable {
        let done: Bool
        let dueAt: String?
        let deleted: Bool
    }

    func fetchTaskState(taskId: Int) async throws -> TaskState? {
        let data: Data
        do {
            data = try await request(method: "GET", path: "/api/tasks/\(taskId)", body: nil)
        } catch APIError.serverError(statusCode: 404) {
            return nil
        }
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let task = json["data"] as? [String: Any]
        else { throw APIError.invalidResponse }
        return TaskState(
            done: task["done"] as? Bool ?? false,
            dueAt: task["due_at"] as? String,
            deleted: task["deleted_at"] is String
        )
    }

    /// Write a quota's `quota_prompt_config` — `PATCH /api/tasks/{id}`, the
    /// web quota editor's own write (one undo entry; the server refuses a
    /// slot id that isn't one of the owner's periods). The watch's
    /// press-and-hold "move to period" list (2026-09-25).
    @discardableResult
    func setQuotaPromptConfig(taskId: Int, config: [String: Any]) async throws -> TaskDTO? {
        let data = try await request(
            method: "PATCH", path: "/api/tasks/\(taskId)", body: ["quota_prompt_config": config]
        )
        return try? JSONDecoder().decode(APIEnvelope<TaskDTO>.self, from: data).data
    }

    /// Undo the most recent action for the signed-in user (2026-09-23,
    /// widgets' Undo/Redo affordance) — the same endpoint the web app's
    /// toast Undo button calls (`useTaskActions.handleUndo`,
    /// `src/app/api/undo/route.ts`). No body: the web client optionally sends
    /// `session_start_id` to scope its undo/redo COUNTS to the page's
    /// session, but the undo itself always targets "the last action", and a
    /// widget has no session watermark to send in the first place — its
    /// counts are always all-time (see `fetchUndoStatus`). The BARE form,
    /// kept for an older server (scoped native Undo falls back to it, see
    /// `UndoScope`); a surface that knows its own last id calls
    /// `undo(id:)`.
    @discardableResult
    func undoLastAction() async throws -> UndoRedoResult {
        let data = try await post(path: "/api/undo", body: [:])
        return try Self.parseUndoRedoResult(data)
    }

    /// Redo the most recently undone action (2026-09-23) — the twin of
    /// `undoLastAction`, hitting `POST /api/redo`
    /// (`src/app/api/redo/route.ts`). Same no-session-watermark reasoning.
    @discardableResult
    func redoLastAction() async throws -> UndoRedoResult {
        let data = try await post(path: "/api/redo", body: [:])
        return try Self.parseUndoRedoResult(data)
    }

    /// What a scoped undo or redo did (scoped native Undo, 2026-10-26).
    enum ScopedUndoOutcome {
        /// The server undid (redid) exactly `id`.
        case done(UndoRedoResult)
        /// 409: `id` is no longer the entry a bare undo (redo) would take —
        /// something newer happened, or it was already undone, or it is gone.
        /// `newest` is `details.newest_undoable_id` for an undo,
        /// `details.next_redoable_id` for a redo.
        case conflict(reason: UndoConflictReason, newest: Int?)
    }

    /// `POST /api/undo { id }` (server PR #390): undo ONLY that entry, and
    /// only while it is still the one a bare undo would take. The surface's
    /// own last `undo_id` (`UndoScope.undoTarget`) — so a widget's Undo never
    /// reverses what another device did.
    func undo(id: Int) async throws -> ScopedUndoOutcome {
        try await scopedUndoRedo(path: "/api/undo", id: id, newestKey: "newest_undoable_id")
    }

    /// `POST /api/redo { id }`: redo only that entry, while it is the next redo.
    func redo(id: Int) async throws -> ScopedUndoOutcome {
        try await scopedUndoRedo(path: "/api/redo", id: id, newestKey: "next_redoable_id")
    }

    private func scopedUndoRedo(path: String, id: Int, newestKey: String) async throws -> ScopedUndoOutcome {
        let (status, data) = try await rawRequest(method: "POST", path: path, body: ["id": id])
        if status == 409 {
            return Self.parseUndoConflict(data, newestKey: newestKey)
        }
        guard (200...299).contains(status) else { throw APIError.serverError(statusCode: status) }
        return .done(try Self.parseUndoRedoResult(data))
    }

    /// A 409's `details` — `{ reason, newest_undoable_id }` from `/api/undo`,
    /// `{ reason, next_redoable_id }` from `/api/redo`. Pure, for the tests.
    static func parseUndoConflict(_ data: Data, newestKey: String) -> ScopedUndoOutcome {
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        let details = json?["details"] as? [String: Any]
        let reason = (details?["reason"] as? String).flatMap(UndoConflictReason.init(rawValue:)) ?? .unknown
        return .conflict(reason: reason, newest: details?[newestKey] as? Int)
    }

    /// The shared response shape of `/api/undo` and `/api/redo`: a
    /// human-readable description of what just happened (shown in the
    /// widget header's subtitle for ~60s — see `WidgetStore.
    /// recordLastAction`), and the resulting all-time counts (the server is
    /// the source of truth for whether the buttons should still be enabled
    /// after this call). `actedId` is the entry undone or redone
    /// (`undone_id` / `redone_id`, server PR #390; nil from an older server).
    struct UndoRedoResult {
        let description: String
        let tasksAffected: Int
        let undoableCount: Int
        let redoableCount: Int
        var actedId: Int? = nil
    }

    /// Pure, for the tests (`ContractDecodeTests.testUndoById`).
    static func parseUndoRedoResult(_ data: Data) throws -> UndoRedoResult {
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
            redoableCount: responseData["redoable_count"] as? Int ?? 0,
            actedId: (responseData["undone_id"] as? Int) ?? (responseData["redone_id"] as? Int)
        )
    }

    /// All-time undo/redo counts (`GET /api/undo/status`), piggybacked on
    /// every widget data fetch (`RemindersProvider`, `TaskFeed`) so the
    /// always-present Undo/Redo buttons' enabled state reflects the server
    /// even when the last change came from the web app or another device,
    /// not just this widget's own taps. Since scoped native Undo
    /// (2026-10-26) also the two ids a surface compares its own stack with
    /// (`UndoScope.apply`), and whether the server sends them at all.
    struct UndoStatus {
        let undoableCount: Int
        let redoableCount: Int
        var newestUndoableId: Int? = nil
        var nextRedoableId: Int? = nil
        /// False from a server that predates scoped Undo.
        var scoped: Bool = false
    }

    func fetchUndoStatus() async throws -> UndoStatus {
        let page = try await get(path: "/api/undo/status", as: UndoStatusPage.self)
        return UndoStatus(
            undoableCount: page.undoableCount, redoableCount: page.redoableCount,
            newestUndoableId: page.newestUndoableId, nextRedoableId: page.nextRedoableId, scoped: page.scoped
        )
    }

    // MARK: - Widget Data

    /// The question every native Reminders surface asks (native PR E,
    /// 2026-10-26): EXACTLY the web's (`REMINDERS_URL`,
    /// `src/lib/reminders-query.ts`) — the task queue's panels (`queue`), a
    /// future deck's Upcoming row (`deck`), the day roster's left rows
    /// (`handled`), the deadlines page (`deadlines`) and every segment kind,
    /// an empty one too (`fill`). Guarded against drift by
    /// `tests/fixtures/contract/reminders-query.json`
    /// (`ContractDecodeTests.testRemindersPathIsTheWebsQuery`). An older
    /// server ignores the flags it doesn't know.
    static let remindersPath = "/api/reminders?queue=1&deck=1&handled=1&deadlines=1&fill=1"

    /// Today's incomplete reminders grouped by time slot (§6), the groups in
    /// the OpenTask day's order (`RemindersPayload.orderedByDay` — the one
    /// place every widget, watch and cache reader gets them from).
    func fetchReminders(day: OpenTaskDay = DayStartStore.current) async throws -> RemindersPayload {
        try await get(path: Self.remindersPath, as: RemindersPayload.self).orderedByDay(day)
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
        try await fetchPreferencesPage().labelConfig
    }

    /// `GET /api/user/preferences`, decoded down to the keys native reads
    /// (`UserPreferencesLabelConfigPage`: `label_config`, `pad_presets`, …).
    /// One fetch for a caller that needs more than one of them.
    ///
    /// Every successful decode also remembers the day boundary
    /// (`DayStartStore.save(from:)`, "Day starts at" PR 3): whichever process
    /// fetched preferences, the next surface to draw reads the user's day.
    func fetchPreferencesPage() async throws -> UserPreferencesLabelConfigPage {
        let page = try await get(path: "/api/user/preferences", as: UserPreferencesLabelConfigPage.self)
        DayStartStore.save(from: page)
        return page
    }

    /// The user's time slots (§6.0), for the notification slot-snooze actions
    /// (`TimeSlotStore`, `refreshSlotActions()`). User-configurable — nothing
    /// about the slot list is hardcoded on the client.
    func fetchTimeSlots() async throws -> [TimeSlotDTO] {
        try await get(path: "/api/time-slots", as: TimeSlotsPage.self).timeSlots
    }

    /// Completions in `[since, until)` — `GET /api/completions`
    /// (`src/app/api/completions/route.ts`), for the Tasks widget's "show
    /// completed" DONE list (2026-09-23). `URLComponents` is used only for
    /// its percent-encoding of the ISO query values, not for the request
    /// itself — `get(path:as:)` already builds the full URL from `serverURL`
    /// + `path`.
    func fetchCompletions(since: Date, until: Date) async throws -> [CompletionDTO] {
        var components = URLComponents()
        components.queryItems = [
            URLQueryItem(name: "since", value: DateHelpers.formatISO(since)),
            URLQueryItem(name: "until", value: DateHelpers.formatISO(until)),
        ]
        let query = components.percentEncodedQuery ?? ""
        return try await get(path: "/api/completions?\(query)", as: CompletionsPage.self).completions
    }

    /// Today's completions — the OpenTask day `now` is in ("Day starts at"
    /// PR 3: `DayStartStore`'s day, so a 1:30 AM check-off with the day
    /// starting at 3:00 is the evening's) — a thin convenience over
    /// `fetchCompletions(since:until:)`, so `TaskFeed` and the Undo/Redo
    /// intents' full refetch (`UndoLastActionIntent`/`RedoLastActionIntent`)
    /// don't each work out the window.
    func fetchTodaysCompletions(now: Date = Date(), day: OpenTaskDay = DayStartStore.current) async throws -> [CompletionDTO] {
        let today = day.daySpan(containing: now)
        return try await fetchCompletions(since: today.start, until: today.end)
    }

    /// The Tasks page's own counts — `{ total, overdue, today }` from
    /// `GET /api/tasks/counts`, computed by the same function as the web top
    /// bar's pills. `overdue` is what the app icon / Dock badge shows
    /// (`refreshBadgeFromServer()`).
    func fetchTaskCounts() async throws -> TaskCountsPage {
        try await get(path: "/api/tasks/counts", as: TaskCountsPage.self)
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
    private func request(method: String, path: String, body: [String: Any]?) async throws -> Data {
        let (status, data) = try await rawRequest(method: method, path: path, body: body)
        guard (200...299).contains(status) else {
            throw APIError.serverError(statusCode: status)
        }
        return data
    }

    // MARK: - Scoped native Undo: the recorder (2026-10-26)

    /// Where this process keeps its OWN undo ids (`UndoScope`): set once at
    /// process start by the widget extension (`WidgetStore.recordOwnUndo`,
    /// iOS and Mac — all three widget kinds are one surface), the watch app
    /// and the watch's Smart Stack extension (`WatchCache.recordOwnUndo` —
    /// one surface). Nil — the iPhone app, its notification extension, the
    /// Mac app — records nothing. Every successful non-GET request's
    /// `data.undo_id` reaches it (a null one doesn't: a tap that logged
    /// nothing keeps the previous id) — so a widget tap sent later by the
    /// outbox drain is recorded the moment its answer lands, in tap order.
    static var undoRecorder: ((Int) -> Void)?

    /// A mutation response's own undo entry (`data.undo_id`), or nil when it
    /// logged nothing (`null`) or the server predates it (absent). Pure, for
    /// the tests.
    static func undoId(in data: Data) -> Int? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let payload = json["data"] as? [String: Any]
        else { return nil }
        return payload["undo_id"] as? Int
    }

    /// The request with its HTTP status, for a caller that reads a non-2xx
    /// body (the scoped undo's 409 `details`). Records a 2xx mutation's
    /// `undo_id` (`undoRecorder`).
    private func rawRequest(method: String, path: String, body: [String: Any]?) async throws -> (Int, Data) {
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
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        if method != "GET", (200...299).contains(httpResponse.statusCode),
           let recorder = Self.undoRecorder, let id = Self.undoId(in: data) {
            recorder(id)
        }
        return (httpResponse.statusCode, data)
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
