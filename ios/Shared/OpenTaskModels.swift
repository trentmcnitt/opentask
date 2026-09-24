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
    /// UTC ISO 8601 — the instant this quota's CURRENT period began, or nil for
    /// anything that isn't a quota (and for a quota the server's rollover job
    /// has not anchored yet).
    ///
    /// The anchor is the user's local calendar boundary — Monday 00:00 for a
    /// week, the 1st for a month, midnight for a day — advanced one period at a
    /// time as each period closes (`src/core/tasks/period-rollover.ts`). It is
    /// the only thing that says where a quota is in its period: §5 quotas carry
    /// no due date at all.
    let progressPeriodStart: String?
    /// The server's explicit "this is a quota" flag. It exists because a quota
    /// whose target is 1 ("date night, once a month") is indistinguishable from
    /// an ordinary task by target alone. Read it through `isTracked`, not
    /// directly — the flag is only half the test.
    let trackedFlag: Bool
    let isReminder: Bool
    let labels: [String]
    /// The Quotas widget chip's preferred label (§5) — an optional, shorter
    /// stand-in for `title` set on the quota's editor (`short_title` column,
    /// added for exactly this chip — see `feat/quota-short-name`). Nil or
    /// empty means "no short name set"; read it through `displayTitle`, never
    /// directly, so every call site falls back the same way.
    let shortTitle: String?

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
        case progressPeriodStart = "progress_period_start"
        case trackedFlag = "is_tracked"
        case isReminder = "is_reminder"
        case labels
        case shortTitle = "short_title"
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
        progressPeriodStart = try c.decodeIfPresent(String.self, forKey: .progressPeriodStart)
        trackedFlag = try c.decodeIfPresent(Bool.self, forKey: .trackedFlag) ?? false
        isReminder = try c.decodeIfPresent(Bool.self, forKey: .isReminder) ?? false
        labels = try c.decodeIfPresent([String].self, forKey: .labels) ?? []
        // decodeIfPresent, not decode: a cache written by a build that
        // predates this field (or a server that hasn't picked up the
        // `short_title` column yet) must still round-trip — see the file
        // header's "partial decode" note.
        shortTitle = try c.decodeIfPresent(String.self, forKey: .shortTitle)
    }

    /// Memberwise init for sample/placeholder data (the synthesized one is lost
    /// once a custom `init(from:)` is declared).
    ///
    /// `shortTitle` last, defaulted: appended for the Quotas widget rebuild
    /// (`feat/quotas-widget`) without disturbing any positional call site
    /// this init already had.
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
        progressPeriodStart: String? = nil,
        trackedFlag: Bool = false,
        isReminder: Bool = false,
        labels: [String] = [],
        shortTitle: String? = nil
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
        self.progressPeriodStart = progressPeriodStart
        self.trackedFlag = trackedFlag
        self.isReminder = isReminder
        self.labels = labels
        self.shortTitle = shortTitle
    }

    var dueDate: Date? {
        guard let dueAt else { return nil }
        return DateHelpers.parseISO(dueAt)
    }

    /// The Quotas widget chip's title: `shortTitle` when the quota's editor
    /// set a non-empty one, else the full `title`. The one call site every
    /// chip/row reads instead of picking between the two fields itself — see
    /// `shortTitle`'s own doc for why a second call site choosing differently
    /// would be a bug.
    var displayTitle: String {
        guard let shortTitle else { return title }
        let trimmed = shortTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? title : trimmed
    }

    /// Start of the quota's current period, parsed. Nil is meaningful: it means
    /// "no clock to be measured against", and nothing may substitute `dueDate`
    /// for it — see `TrackTimeline.elapsedFraction`.
    var periodStartDate: Date? {
        guard let progressPeriodStart else { return nil }
        return DateHelpers.parseISO(progressPeriodStart)
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
    /// How many reminders in this slot were considered (checked off) today —
    /// `g.considered` from `GET /api/reminders` (`src/app/api/reminders/
    /// route.ts`). Feeds `ReminderSlotStrip` (2026-09-23): a slot with
    /// `considered > 0` and nothing left in `reminders` reads as "finished",
    /// distinct from a slot that never had anything to begin with. Mirrors
    /// the web's `ReminderSlotBar`, which uses the same field
    /// (`src/components/ReminderSlotBar.tsx`). Decoded with a default so an
    /// older cached payload (written before this field existed) still
    /// parses — see the file header's "partial decode" note.
    let considered: Int
    /// The considered-today items THEMSELVES (`g.considered_items` from
    /// `GET /api/reminders`), full `TaskDTO`s — the server already builds
    /// this list to support "put back" (`POST /api/tasks/:id/undone`, the
    /// same endpoint the web Reminders surface's put-back uses,
    /// `useReminders.ts`'s `usePutBack`), so the widget's "show completed"
    /// (2026-09-23) reads it directly rather than inventing a second
    /// fetch. Decoded with a default (`[]`) for the same reason `considered`
    /// is — an older cached payload written before this field existed must
    /// still parse.
    let consideredItems: [TaskDTO]

    enum CodingKeys: String, CodingKey {
        case slot, reminders, considered
        case consideredItems = "considered_items"
    }

    init(slot: TimeSlotDTO?, reminders: [TaskDTO], considered: Int = 0, consideredItems: [TaskDTO] = []) {
        self.slot = slot
        self.reminders = reminders
        self.considered = considered
        self.consideredItems = consideredItems
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        slot = try c.decodeIfPresent(TimeSlotDTO.self, forKey: .slot)
        reminders = try c.decodeIfPresent([TaskDTO].self, forKey: .reminders) ?? []
        considered = try c.decodeIfPresent(Int.self, forKey: .considered) ?? 0
        consideredItems = try c.decodeIfPresent([TaskDTO].self, forKey: .consideredItems) ?? []
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

// MARK: - Completions

/// One row from `GET /api/completions` (`src/app/api/completions/route.ts`) —
/// the Tasks widget's "show completed" DONE list (2026-09-23). The same
/// endpoint the web History page already reads, queried with `?since=&until=`
/// for the local calendar day (`APIClient.fetchTodaysCompletions`).
///
/// `completedAt` is decoded as the raw ISO **String**, mirroring `TaskDTO.
/// dueAt` — `JSONDecoder()`'s default date strategy is `.deferredToDate`
/// (expects a Double), which silently fails against the server's ISO string.
/// Parse with `DateHelpers.parseISO` on demand (`completedDate` below).
struct CompletionDTO: Codable, Identifiable, Hashable {
    let id: Int
    let taskId: Int
    let completedAt: String
    let taskTitle: String
    let projectId: Int
    /// Reminder/tracked completions ride the same `completions` table (both
    /// go through `markDone`) — the DONE list must exclude them (their own
    /// widgets own that data), so the server includes these flags rather
    /// than making the client re-derive them from a task it doesn't have.
    let isReminder: Bool
    let isTracked: Bool
    let progressTarget: Int

    enum CodingKeys: String, CodingKey {
        case id
        case taskId = "task_id"
        case completedAt = "completed_at"
        case taskTitle = "task_title"
        case projectId = "project_id"
        case isReminder = "is_reminder"
        case isTracked = "is_tracked"
        case progressTarget = "progress_target"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        taskId = try c.decodeIfPresent(Int.self, forKey: .taskId) ?? 0
        completedAt = try c.decodeIfPresent(String.self, forKey: .completedAt) ?? ""
        taskTitle = try c.decodeIfPresent(String.self, forKey: .taskTitle) ?? ""
        projectId = try c.decodeIfPresent(Int.self, forKey: .projectId) ?? 0
        isReminder = try c.decodeIfPresent(Bool.self, forKey: .isReminder) ?? false
        isTracked = try c.decodeIfPresent(Bool.self, forKey: .isTracked) ?? false
        progressTarget = try c.decodeIfPresent(Int.self, forKey: .progressTarget) ?? 1
    }

    /// Memberwise init for sample data and `WidgetStore.confirmCompletion`'s
    /// optimistic synthesis (a just-completed `TaskDTO` gets a synthetic
    /// negative `id` purely so `Identifiable`/`ForEach` works locally — see
    /// that function's doc — silently replaced by the real, server-confirmed
    /// row on the next full fetch).
    init(
        id: Int,
        taskId: Int,
        completedAt: String,
        taskTitle: String,
        projectId: Int = 0,
        isReminder: Bool = false,
        isTracked: Bool = false,
        progressTarget: Int = 1
    ) {
        self.id = id
        self.taskId = taskId
        self.completedAt = completedAt
        self.taskTitle = taskTitle
        self.projectId = projectId
        self.isReminder = isReminder
        self.isTracked = isTracked
        self.progressTarget = progressTarget
    }

    var completedDate: Date? {
        DateHelpers.parseISO(completedAt)
    }
}

/// `GET /api/completions` → `{"data":{"completions":[...],"count":...}}` —
/// same named-field envelope shape as `TasksPage`/`ProjectsPage`. `count` is
/// unused by the widget (`completions.count` is equivalent) and left out.
struct CompletionsPage: Decodable {
    let completions: [CompletionDTO]
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

/// `GET /api/time-slots` → `{"data":{"time_slots":[...]}}` — same named-field
/// shape as `TasksPage`/`ProjectsPage`.
struct TimeSlotsPage: Decodable {
    let timeSlots: [TimeSlotDTO]

    enum CodingKeys: String, CodingKey {
        case timeSlots = "time_slots"
    }
}

/// `GET /api/undo/status` → `{"data":{"latest_id":..., "undoable_count":...,
/// "redoable_count":...}}` (`src/app/api/undo/status/route.ts`) — the same
/// endpoint the web Header's undo badge calls on mount. All-time counts, no
/// session scoping: a widget has no session watermark to send (see
/// `APIClient.undoLastAction`'s doc), and "is there anything to undo/redo at
/// all" is exactly what the always-present widget buttons need
/// (2026-09-23 — see `WidgetStore`'s "Undo/redo counts" section).
struct UndoStatusPage: Decodable {
    let latestId: Int?
    let undoableCount: Int
    let redoableCount: Int

    enum CodingKeys: String, CodingKey {
        case latestId = "latest_id"
        case undoableCount = "undoable_count"
        case redoableCount = "redoable_count"
    }
}

// MARK: - Label config (Quotas widget, `feat/quotas-widget`)

/// One entry of `label_config` — the user's display color for a label name,
/// set in Settings. `src/types/index.ts`'s `LabelConfig`, wire-identical (both
/// fields are already bare `name`/`color`, no snake_case to map).
///
/// `color` is `String?`, not the server's closed `LabelColor` enum: the
/// widget already owns a String-keyed palette (`WidgetTheme.projectColor(_:)`,
/// the same eight names), and a future ninth color the client hasn't shipped
/// yet should read as "unrecognized, draw neutral" rather than fail to decode
/// this whole array and blank every quota's cluster color.
struct LabelConfigDTO: Codable, Hashable {
    let name: String
    let color: String?

    enum CodingKeys: String, CodingKey {
        case name, color
    }
}

/// `GET /api/user/preferences` → `{"data":{..., "label_config":[...], ...}}`
/// (`src/app/api/user/preferences/route.ts`) — a ~30-field payload this
/// decodes only ONE key out of. `Decodable` already ignores keys it wasn't
/// told about, so no custom `init(from:)` is needed to skip the rest; only
/// `decodeIfPresent` is, so a server that predates `label_config` (or a
/// malformed one) still yields an empty cluster color set instead of failing
/// the whole preferences fetch.
struct UserPreferencesLabelConfigPage: Decodable {
    let labelConfig: [LabelConfigDTO]

    enum CodingKeys: String, CodingKey {
        case labelConfig = "label_config"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        labelConfig = try c.decodeIfPresent([LabelConfigDTO].self, forKey: .labelConfig) ?? []
    }
}
