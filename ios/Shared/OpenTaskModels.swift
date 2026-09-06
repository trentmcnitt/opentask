import Foundation

/// Wire models for the OpenTask REST API.
///
/// Deliberately *partial*: only the fields the native surfaces render are
/// decoded, so adding a column server-side never breaks the client. Every
/// field that post-dates the v0.3 schema work is decoded with a default so an
/// older server (or a cached payload written by an older build) still parses.
///
/// Property names are camelCase with explicit `CodingKeys` mapping to the
/// API's snake_case. The mapping is symmetric, which matters: the widget
/// extension re-encodes these same structs into its App Group cache and reads
/// them back, so a decode-only key strategy would not round-trip.

// MARK: - Envelope

/// Every OpenTask success response is `{ "data": ... }`.
struct APIEnvelope<T: Decodable>: Decodable {
    let data: T
}

// MARK: - Task

struct TaskDTO: Codable, Identifiable, Hashable {
    let id: Int
    let projectId: Int
    let title: String
    let priority: Int
    /// UTC ISO 8601, or nil for an undated task.
    let dueAt: String?
    let rrule: String?
    /// Local HH:MM — the *intended* time of day for a recurring item.
    let anchorTime: String?
    let progressTarget: Int
    /// `var` alone among the fields: `withOptimisticIncrement()` below needs to
    /// bump it on a value-type copy. Nothing mutates the decoded instance.
    var progressCurrent: Int
    /// The server's explicit "this is a quota" flag. It exists because a quota
    /// whose target is 1 ("date night, once a month") is indistinguishable from
    /// an ordinary task by target alone. Read it through `isTracked`, not
    /// directly — the flag is only half the test.
    let trackedFlag: Bool
    let isReminder: Bool
    let labels: [String]

    enum CodingKeys: String, CodingKey {
        case id
        case projectId = "project_id"
        case title
        case priority
        case dueAt = "due_at"
        case rrule
        case anchorTime = "anchor_time"
        case progressTarget = "progress_target"
        case progressCurrent = "progress_current"
        case trackedFlag = "is_tracked"
        case isReminder = "is_reminder"
        case labels
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        projectId = try c.decodeIfPresent(Int.self, forKey: .projectId) ?? 0
        title = try c.decode(String.self, forKey: .title)
        priority = try c.decodeIfPresent(Int.self, forKey: .priority) ?? 0
        dueAt = try c.decodeIfPresent(String.self, forKey: .dueAt)
        rrule = try c.decodeIfPresent(String.self, forKey: .rrule)
        anchorTime = try c.decodeIfPresent(String.self, forKey: .anchorTime)
        progressTarget = try c.decodeIfPresent(Int.self, forKey: .progressTarget) ?? 1
        progressCurrent = try c.decodeIfPresent(Int.self, forKey: .progressCurrent) ?? 0
        trackedFlag = try c.decodeIfPresent(Bool.self, forKey: .trackedFlag) ?? false
        isReminder = try c.decodeIfPresent(Bool.self, forKey: .isReminder) ?? false
        labels = try c.decodeIfPresent([String].self, forKey: .labels) ?? []
    }

    /// Memberwise init for sample/placeholder data (the synthesized one is lost
    /// once a custom `init(from:)` is declared).
    init(
        id: Int,
        projectId: Int = 0,
        title: String,
        priority: Int = 0,
        dueAt: String? = nil,
        rrule: String? = nil,
        anchorTime: String? = nil,
        progressTarget: Int = 1,
        progressCurrent: Int = 0,
        trackedFlag: Bool = false,
        isReminder: Bool = false,
        labels: [String] = []
    ) {
        self.id = id
        self.projectId = projectId
        self.title = title
        self.priority = priority
        self.dueAt = dueAt
        self.rrule = rrule
        self.anchorTime = anchorTime
        self.progressTarget = progressTarget
        self.progressCurrent = progressCurrent
        self.trackedFlag = trackedFlag
        self.isReminder = isReminder
        self.labels = labels
    }

    var dueDate: Date? {
        guard let dueAt else { return nil }
        return DateHelpers.parseISO(dueAt)
    }

    /// §5: a task is a quota if the server flagged it as one, or if its target
    /// is above 1. Both halves are load-bearing and must stay in step with the
    /// server's `isTracked()` (`src/lib/track.ts`): the target test alone misses
    /// a once-a-month quota, and the flag alone misses every quota created
    /// before the flag existed, which is most of them.
    var isTracked: Bool { trackedFlag || progressTarget > 1 }

    /// At or past target. The task deliberately stays open past this point so
    /// overflow (3/2) remains observable, so this is styling, not filtering.
    var isProgressMet: Bool { isTracked && progressCurrent >= progressTarget }

    /// A copy with `delta` more increments logged (negative corrects a mis-log).
    ///
    /// The widget's optimistic render of taps whose server round trip is still
    /// in flight (§8) — the count is a NET delta, so four quick taps draw +4.
    /// A method rather than a struct literal at the call site so a new field on
    /// `TaskDTO` cannot silently get dropped from the copy.
    ///
    /// Floored at 0 to match `POST /api/tasks/:id/progress`, which clamps there
    /// too: a widget that drew -1/3 for a second would be showing a number the
    /// server will never agree with.
    func withOptimisticIncrement(_ delta: Int = 1) -> TaskDTO {
        var copy = self
        copy.progressCurrent = max(copy.progressCurrent + delta, 0)
        return copy
    }

    func isOverdue(now: Date = Date()) -> Bool {
        guard let dueDate else { return false }
        return dueDate < now
    }
}

// MARK: - Project

struct ProjectDTO: Codable, Identifiable, Hashable {
    let id: Int
    let name: String
    /// One of the eight named palette colors, or nil.
    let color: String?

    enum CodingKeys: String, CodingKey {
        case id, name, color
    }

    init(id: Int, name: String, color: String? = nil) {
        self.id = id
        self.name = name
        self.color = color
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        color = try c.decodeIfPresent(String.self, forKey: .color)
    }
}

// MARK: - Time slot

/// A life-moment container (§6.0) — "Early morning", "Midday", "Evening".
struct TimeSlotDTO: Codable, Identifiable, Hashable {
    let id: Int
    let label: String
    /// HH:MM, 24-hour, local.
    let startTime: String

    enum CodingKeys: String, CodingKey {
        case id
        case label
        case startTime = "start_time"
    }

    init(id: Int, label: String, startTime: String) {
        self.id = id
        self.label = label
        self.startTime = startTime
    }

    /// Minutes past local midnight, or nil if `start_time` is malformed.
    var startMinutes: Int? {
        let parts = startTime.split(separator: ":")
        guard parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]) else { return nil }
        return h * 60 + m
    }
}

// MARK: - Reminders

/// One group from `GET /api/reminders`. `slot` is nil for the trailing
/// "Anytime" group — items with no time of day at all.
struct ReminderGroupDTO: Codable, Hashable {
    let slot: TimeSlotDTO?
    let reminders: [TaskDTO]

    enum CodingKeys: String, CodingKey {
        case slot, reminders
    }

    init(slot: TimeSlotDTO?, reminders: [TaskDTO]) {
        self.slot = slot
        self.reminders = reminders
    }

    /// Stable identity for the App Group override key. -1 stands in for the
    /// un-slotted group so the override can be persisted as a plain Int.
    var slotKey: Int { slot?.id ?? -1 }

    var label: String { slot?.label ?? "Anytime" }
}

struct RemindersPayload: Codable {
    let groups: [ReminderGroupDTO]

    enum CodingKeys: String, CodingKey {
        case groups
    }
}

// MARK: - List envelopes

/// `/api/tasks` and `/api/projects` wrap their arrays in a named field inside
/// `data` (`{"data":{"tasks":[...]}}`), unlike `/api/reminders` whose payload
/// object is decoded directly. These wrappers exist solely to peel that layer.
struct TasksPage: Decodable {
    let tasks: [TaskDTO]
}

struct ProjectsPage: Decodable {
    let projects: [ProjectDTO]
}
