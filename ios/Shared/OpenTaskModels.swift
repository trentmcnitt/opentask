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
    /// The anchor is the user's local calendar boundary — 00:00 on the user's
    /// first day of the week (`week_start`: Sunday by default, or Monday) for a
    /// week, the 1st for a month, midnight for a day — advanced one period at a
    /// time as each period closes (`src/core/tasks/period-rollover.ts`). It is
    /// the only thing that says where a quota is in its period: §5 quotas carry
    /// no due date at all.
    let progressPeriodStart: String?
    /// Interval quotas (2026-10-16, docs/TASK-MODEL.md § Quotas): the CURRENT
    /// period, served by the server so no native client repeats its
    /// `quotaPeriodEnd` — the window's exclusive end (UTC ISO 8601), the
    /// rule's INTERVAL ("every 2 weeks" is 2), the window's last local day
    /// (`yyyy-MM-dd`), and "by Oct 24" for an interval above 1 (nil at 1:
    /// the surfaces keep their own words, "This week"). All nil on anything
    /// that isn't a quota, and from a server or cache that predates them —
    /// which then reads as interval 1, as before (`QuotaRules.interval(of:)`
    /// falls back to the rrule's INTERVAL).
    let progressPeriodEnd: String?
    let periodInterval: Int?
    let periodLastDay: String?
    let periodLabel: String?
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
    /// The item has notes — the web's `!!notes?.trim()`, which is what puts
    /// its `NotesMarker` after a title. Drives the small note glyph after a
    /// widget row's title (`NotesGlyph`, 2026-09-25) and the watch
    /// Reminders page's.
    ///
    /// A FLAG, not the notes themselves: the server sends the full `notes`
    /// text, but nothing native ever shows it, and every cached payload
    /// (App Group `UserDefaults`, `WatchCache`) would otherwise carry every
    /// paragraph of every open task. So `init(from:)` reads the server's
    /// `notes` and keeps only whether it is non-blank, and a cache stores
    /// that answer under `has_notes` (the key `QuotaPromptDTO` already uses
    /// for the same fact) — see `NotesKey`.
    let hasNotes: Bool

    // MARK: Task model fields (2026-10-10, docs/TASK-MODEL.md § Deadline, target, horizon)
    //
    // `dueAt` above is the TARGET now: when nagging starts. The server also
    // sends it as `target_at` (the primary name since 10-10; `due_at` is the
    // deprecated alias, always the same value), so the native clients keep
    // reading `due_at`. All four are decoded with `decodeIfPresent`, so an
    // older server, or a cache written by an older build, still parses.

    /// UTC ISO 8601 — the real cutoff. Snooze never moves it. Nil = none.
    let deadlineAt: String?
    /// "days" / "weeks" / "months" / "eventually", or nil = UNSET. Unset is
    /// treated as weeks by the server's segment rules, but must be SHOWN as
    /// unset, never as "weeks" (spec §2) — read it through `horizonLabel`.
    let horizon: String?
    /// UTC ISO 8601 — when the task was created. Decoded for the contract;
    /// nothing native reads it (the age badge is the server's `age_label`).
    let createdAt: String?
    /// UTC ISO 8601 — when the target was last set, by any path (2026-10-12,
    /// docs/TASK-MODEL.md § Upcoming): the day Upcoming's heads-up days count
    /// from. Nil for a task with no target, and from an older server or cache.
    /// The server decides who is in Upcoming; nothing native reads it yet.
    let targetSetAt: String?

    // MARK: The two badges and the stored target (2026-10-12, docs/TASK-MODEL.md
    // § The two badges, § Deadline). All decoded with defaults: an older
    // server (or a cache written by an older build) leaves them empty, and
    // the rows then simply draw no badge.

    /// Local days on which the task was over target (as of the server's read).
    /// Drives the badge's depth (`TargetAge.tone(attempts:)`); the text is
    /// `attemptsLabel`.
    let attempts: Int
    /// The local date (yyyy-MM-dd) `attempts` was last checkpointed through.
    /// Decoded for the contract; the server adds the days since it on every
    /// read, so nothing native recounts.
    let attemptsCountedThrough: String?
    /// The attempts badge's text, "3×", or nil (no target, or no attempt yet).
    /// The server's `attemptsLabel` — the ONLY source of the text: the native
    /// rows never count attempts themselves. A cache drawn the next day is a
    /// day behind until the next fetch, like every cached render.
    let attemptsLabel: String?
    /// "remove" / "auto" / nil — what the web row offers at 3×. Kept as a
    /// string (an unknown value must never fail a decode); no native surface
    /// offers it (the offer lives in the app).
    let attemptsOffer: String?
    /// The age badge, ">1 wk" / ">1 mo" / ">3 mo" / ">6 mo", on a task with
    /// neither a target nor a deadline, past its horizon's threshold; else nil.
    let ageLabel: String?
    /// UTC ISO 8601 — Process's "keep" on a growth ask. Decoded for the
    /// contract only.
    let growthKeptAt: String?
    /// The target (`due_at`) is the deadline's AUTOMATIC one (§8), not one the
    /// user picked. Decoded; no native surface labels a target (the web says
    /// "auto" only in its editor and snooze menu, not on rows).
    let targetAuto: Bool
    /// UTC ISO 8601 — a repeating task's scheduled occurrence, kept apart from
    /// its target (`due_at`) since §6. Decoded for the contract; the native
    /// rows show the target.
    let occurrenceAt: String?

    // MARK: On deck and the deadlines page (native PR E, 2026-10-26)

    /// The OpenTask day (yyyy-MM-dd) the task is ON DECK for (2026-10-20,
    /// docs/TASK-MODEL.md § On deck), or nil. A decked task has no picked
    /// target; its Upcoming row says "On deck tomorrow" (Tomorrow) or "On deck Sat
    /// Oct 24" (Later), and a deadlines-page row decked for a later day says
    /// "On deck Sat" (`TaskDTO.deckWords`).
    let onDeckDay: String?
    /// A deadlines-page task's lead day (yyyy-MM-dd, `lead_from`): the day
    /// it joins the page. A row whose lead day was DEFERRED today reads
    /// "· deferred to Thu" from it (`SegmentLeft.words`).
    let leadFrom: String?

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
        case progressPeriodEnd = "progress_period_end"
        case periodInterval = "period_interval"
        case periodLastDay = "period_last_day"
        case periodLabel = "period_label"
        case trackedFlag = "is_tracked"
        case isReminder = "is_reminder"
        case labels
        case shortTitle = "short_title"
        case hasNotes = "has_notes"
        case deadlineAt = "deadline_at"
        case horizon
        case createdAt = "created_at"
        case targetSetAt = "target_set_at"
        case attempts
        case attemptsCountedThrough = "attempts_counted_through"
        case attemptsLabel = "attempts_label"
        case attemptsOffer = "attempts_offer"
        case ageLabel = "age_label"
        case growthKeptAt = "growth_kept_at"
        case targetAuto = "target_auto"
        case occurrenceAt = "occurrence_at"
        case onDeckDay = "on_deck_day"
        case leadFrom = "lead_from"
    }

    /// Decode-only: the server's raw `notes`. Deliberately NOT in
    /// `CodingKeys`, so the synthesized `encode(to:)` never writes the text
    /// back out to a cache (see `hasNotes`).
    private enum NotesKey: String, CodingKey {
        case notes
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
        progressPeriodEnd = try c.decodeIfPresent(String.self, forKey: .progressPeriodEnd)
        periodInterval = try c.decodeIfPresent(Int.self, forKey: .periodInterval)
        periodLastDay = try c.decodeIfPresent(String.self, forKey: .periodLastDay)
        periodLabel = try c.decodeIfPresent(String.self, forKey: .periodLabel)
        trackedFlag = try c.decodeIfPresent(Bool.self, forKey: .trackedFlag) ?? false
        isReminder = try c.decodeIfPresent(Bool.self, forKey: .isReminder) ?? false
        labels = try c.decodeIfPresent([String].self, forKey: .labels) ?? []
        // decodeIfPresent, not decode: a cache written by a build that
        // predates this field (or a server that hasn't picked up the
        // `short_title` column yet) must still round-trip — see the file
        // header's "partial decode" note.
        shortTitle = try c.decodeIfPresent(String.self, forKey: .shortTitle)
        // A cache written by this build carries `has_notes`; the server (and
        // a cache from an older build) carries `notes`, or nothing. Absent
        // everywhere reads as "no notes" — a missing glyph, never a decode
        // failure.
        if let cached = try c.decodeIfPresent(Bool.self, forKey: .hasNotes) {
            hasNotes = cached
        } else {
            let raw = try decoder.container(keyedBy: NotesKey.self).decodeIfPresent(String.self, forKey: .notes)
            hasNotes = !(raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        deadlineAt = try c.decodeIfPresent(String.self, forKey: .deadlineAt)
        horizon = try c.decodeIfPresent(String.self, forKey: .horizon)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        targetSetAt = try c.decodeIfPresent(String.self, forKey: .targetSetAt)
        attempts = try c.decodeIfPresent(Int.self, forKey: .attempts) ?? 0
        attemptsCountedThrough = try c.decodeIfPresent(String.self, forKey: .attemptsCountedThrough)
        attemptsLabel = try c.decodeIfPresent(String.self, forKey: .attemptsLabel)
        attemptsOffer = try c.decodeIfPresent(String.self, forKey: .attemptsOffer)
        ageLabel = try c.decodeIfPresent(String.self, forKey: .ageLabel)
        growthKeptAt = try c.decodeIfPresent(String.self, forKey: .growthKeptAt)
        targetAuto = try c.decodeIfPresent(Bool.self, forKey: .targetAuto) ?? false
        occurrenceAt = try c.decodeIfPresent(String.self, forKey: .occurrenceAt)
        onDeckDay = try c.decodeIfPresent(String.self, forKey: .onDeckDay)
        leadFrom = try c.decodeIfPresent(String.self, forKey: .leadFrom)
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
        shortTitle: String? = nil,
        hasNotes: Bool = false,
        deadlineAt: String? = nil,
        horizon: String? = nil,
        createdAt: String? = nil,
        targetSetAt: String? = nil,
        attempts: Int = 0,
        attemptsCountedThrough: String? = nil,
        attemptsLabel: String? = nil,
        attemptsOffer: String? = nil,
        ageLabel: String? = nil,
        growthKeptAt: String? = nil,
        targetAuto: Bool = false,
        occurrenceAt: String? = nil,
        progressPeriodEnd: String? = nil,
        periodInterval: Int? = nil,
        periodLastDay: String? = nil,
        periodLabel: String? = nil,
        onDeckDay: String? = nil,
        leadFrom: String? = nil
    ) {
        self.onDeckDay = onDeckDay
        self.leadFrom = leadFrom
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
        self.progressPeriodEnd = progressPeriodEnd
        self.periodInterval = periodInterval
        self.periodLastDay = periodLastDay
        self.periodLabel = periodLabel
        self.trackedFlag = trackedFlag
        self.isReminder = isReminder
        self.labels = labels
        self.shortTitle = shortTitle
        self.hasNotes = hasNotes
        self.deadlineAt = deadlineAt
        self.horizon = horizon
        self.createdAt = createdAt
        self.targetSetAt = targetSetAt
        self.attempts = attempts
        self.attemptsCountedThrough = attemptsCountedThrough
        self.attemptsLabel = attemptsLabel
        self.attemptsOffer = attemptsOffer
        self.ageLabel = ageLabel
        self.growthKeptAt = growthKeptAt
        self.targetAuto = targetAuto
        self.occurrenceAt = occurrenceAt
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

    /// "Overdue" ("Over target" 2026-10-10 to 10-21; the user-facing words
    /// live in `TaskWording`): the target (`due_at`) has passed. Since
    /// 2026-10-12 a deadline's target is STORED (`target_auto`), so `due_at`
    /// is the whole answer — the native implied-target rule is gone (see
    /// `TargetAge`).
    func isOverdue(now: Date = Date()) -> Bool {
        guard let target = dueDate else { return false }
        return target < now
    }

    var deadlineDate: Date? {
        guard let deadlineAt else { return nil }
        return DateHelpers.parseISO(deadlineAt)
    }

    /// "Days" / "Weeks" / "Months" / "Eventually", or nil when the horizon is
    /// unset (shown as nothing — never as "Weeks", spec §2) or unrecognised.
    var horizonLabel: String? { TaskHorizon(rawValue: horizon ?? "")?.label }
}

// MARK: - Horizon (2026-10-10)

/// A task's pace — which task segment of the reminders screen it appears in.
/// The server's `HORIZON_ORDER` (`src/lib/task-segments.ts`), in screen order.
/// The word "horizon" is provisional (amendment 4): nothing user-facing says
/// it — rows show only the value ("Days").
enum TaskHorizon: String, CaseIterable, Codable {
    case days, weeks, months, eventually

    var label: String {
        switch self {
        case .days: return "Days"
        case .weeks: return "Weeks"
        case .months: return "Months"
        case .eventually: return "Eventually"
        }
    }

    /// Position in screen order (days first).
    var order: Int { Self.allCases.firstIndex(of: self) ?? 0 }

    /// The task segment's color (Trent, 2026-10-11, mockup
    /// task-segment-colors-2 option 3): one teal per horizon, nearest
    /// first, EXACT values shared with the web — change them together.
    /// Since 2026-10-26 it colours the segment's TITLE only (dark mode's
    /// title is this value, `segmentTitleHex`): no bar fills in it any more —
    /// every bar fills in the reminders' purple (`DayBarColors`). Teal stays
    /// clear of the purple, green (done), the plum of over target, red, and
    /// the priority colors. As 0xRRGGBB; `WidgetTheme`/`WatchTheme` make the
    /// `Color`.
    var segmentColorHex: (light: UInt32, dark: UInt32) {
        switch self {
        case .days: return (0x0F9D8F, 0x2BB5A6)
        case .weeks: return (0x2BB5A6, 0x4FC8BB)
        case .months: return (0x4FB8AB, 0x8FDCD2)
        case .eventually: return (0x8CCFC6, 0xC3ECE6)
        }
    }

    /// A task page's TITLE ("Task queue · Daily"). Light mode uses one deeper teal
    /// for every horizon, for legibility on the light card (Trent,
    /// 2026-10-11); dark mode's title is the horizon's own fill.
    var segmentTitleHex: (light: UInt32, dark: UInt32) {
        (0x0B7A6F, segmentColorHex.dark)
    }
}

/// The day bars' fill (2026-10-26, the web's PR #383; Trent: "Have them all
/// just use the purple and green except for the deadlines, which finish the
/// teal color that they currently finish at. That's the special one."):
/// every progress bar — a reminder period's, every task segment's, a quota
/// period's — fills in the reminders' PURPLE while it fills and turns the
/// done green when finished (a segment's `doneColorHex` may replace the
/// green). The purple is the web's `--badge-reminders`: oklch(0.55 0.2 295)
/// light ≈ #7e4ed7, oklch(0.62 0.19 295) dark ≈ #9167ea. EXACT values
/// shared with the web — change together. The ONE source: `WidgetTheme`
/// (phone and Mac widgets) and `WatchTheme` (the watch, always dark) make
/// the `Color` from it. Only progress fills use it — the bars, the Quotas
/// 2×2's met ring and the watch Smart Stack's circular/corner gauge (Trent,
/// the same day: rings are progress indicators too); buttons, toggles,
/// selection, the quota count boxes and the day word keep their indigo.
enum DayBarColors {
    static let fillingHex: (light: UInt32, dark: UInt32) = (0x7E4ED7, 0x9167EA)
}

/// A task segment's identity (2026-10-12): a horizon, or Upcoming — the web's
/// `SegmentKind = HorizonValue | 'upcoming'` (`src/lib/task-segments.ts`). On
/// the wire it is the segment's `horizon` string, `"upcoming"` for Upcoming.
///
/// Upcoming is NOT a `TaskHorizon`: that enum is a task's own field, and a
/// task never has the horizon "upcoming". Upcoming holds one-off and
/// repeating tasks whose target is still ahead, on their heads-up days
/// (docs/TASK-MODEL.md § Upcoming); the server sends it after Days.
enum SegmentKind: Hashable {
    case horizon(TaskHorizon)
    case upcoming
    /// The DEADLINES page (2026-10-22 on the server and the web; native PR
    /// E, 2026-10-26): a deadline task with no target, from its lead day.
    /// First in the ring, the only queue page that nags. Sent only with the
    /// task-queue switch on and `?deadlines=1`.
    case deadlines
    /// The task queue's two panels (task-queue PR 3; native PR E): "Today's
    /// pulls" (`queue_today`, queued at or after the latest rollover) and
    /// "Previous pulls" (`queue_previous`). Sent only with the switch on and
    /// `?queue=1`, after the deadlines page and before Days.
    case queueToday
    case queuePrevious

    static let upcomingRaw = "upcoming"
    static let deadlinesRaw = "deadlines"
    static let queueTodayRaw = "queue_today"
    static let queuePreviousRaw = "queue_previous"

    /// Nil for a string this build doesn't know (a future segment).
    init?(raw: String) {
        switch raw {
        case Self.upcomingRaw: self = .upcoming
        case Self.deadlinesRaw: self = .deadlines
        case Self.queueTodayRaw: self = .queueToday
        case Self.queuePreviousRaw: self = .queuePrevious
        default:
            guard let horizon = TaskHorizon(rawValue: raw) else { return nil }
            self = .horizon(horizon)
        }
    }

    /// The wire string (`TaskSegmentDTO.horizon`).
    var raw: String {
        switch self {
        case .horizon(let horizon): return horizon.rawValue
        case .upcoming: return Self.upcomingRaw
        case .deadlines: return Self.deadlinesRaw
        case .queueToday: return Self.queueTodayRaw
        case .queuePrevious: return Self.queuePreviousRaw
        }
    }

    /// One of the task queue's two panels (the web's `isQueueKind`).
    var isQueue: Bool { self == .queueToday || self == .queuePrevious }

    /// "Days", "Upcoming" — the web's `segmentWord`. The row's word (a row's
    /// set horizon, "Weeks" on a Days page); a page's TITLE uses `titleWord`.
    /// The queue's panels and the deadlines page have no row word of their
    /// own: their title word stands in (the spoken "Defer all …" label).
    var label: String {
        switch self {
        case .horizon(let horizon): return horizon.label
        case .upcoming: return "Upcoming"
        case .deadlines, .queueToday, .queuePrevious: return titleWord
        }
    }

    /// The segment's TITLE word (2026-10-26, the web's `SEGMENT_TITLES` /
    /// `UPCOMING_LABEL` / `DEADLINES_PAGE_TITLE` / `QUEUE_PANEL_TITLES`,
    /// `src/lib/task-model-words.ts`): "Daily", "Weekly", "Monthly",
    /// "Quarterly", "Upcoming", "Deadlines", "Today's pulls", "Previous
    /// pulls". Apart from `label` on purpose: `TaskHorizon.label` is the
    /// row's "Weeks" word, which keeps its name.
    var titleWord: String {
        switch self {
        case .horizon(.days): return "Daily"
        case .horizon(.weeks): return "Weekly"
        case .horizon(.months): return "Monthly"
        case .horizon(.eventually): return "Quarterly"
        case .upcoming: return "Upcoming"
        case .deadlines: return "Deadlines"
        case .queueToday: return "Today's pulls"
        case .queuePrevious: return "Previous pulls"
        }
    }

    /// The page's title, "Task queue · Daily" (`TaskWording.taskQueueTitle`,
    /// the web's `segmentTitle`).
    var title: String { TaskWording.taskQueueTitle(titleWord) }

    /// The segment's page key in the widget's and the watch's page ring (the
    /// slot-key Int space): -10…-13 the horizons, as before, -14 Upcoming,
    /// -16 the deadlines page, -17 / -18 the queue's two panels — keys of
    /// their own, so a stored override never lands on another page. -15 is
    /// a segment this build doesn't know (`TaskSegmentDTO.pageKey`).
    var pageKey: Int {
        switch self {
        case .horizon(let horizon): return -(10 + horizon.order)
        case .upcoming: return -14
        case .deadlines: return -16
        case .queueToday: return -17
        case .queuePrevious: return -18
        }
    }

    /// The segment's own colour, as 0xRRGGBB — the web's `--segment-*`
    /// token. Upcoming is `--segment-upcoming` (2026-10-12): a blue-teal,
    /// apart from the horizons' teals; the queue's panels
    /// `--segment-queue_today` / `--segment-queue_previous`; the deadlines
    /// page `--deadlines-fill` (#0d9488, dark #2dd4bf). EXACT values shared
    /// with the web — change together. Since 2026-10-26 it is the TITLE's
    /// colour only (the dark title, and the base of `titleHex`); every strip
    /// bar fills in `DayBarColors.fillingHex` — and the deadlines page's
    /// FINISHED bar is this teal (`doneColorHex`).
    var colorHex: (light: UInt32, dark: UInt32) {
        switch self {
        case .horizon(let horizon): return horizon.segmentColorHex
        case .upcoming: return (0x1A8FB0, 0x4CB8D9)
        case .deadlines: return (0x0D9488, 0x2DD4BF)
        case .queueToday: return (0x0D7F8C, 0x36B8C6)
        case .queuePrevious: return (0x5C9BA3, 0x7FBCC4)
        }
    }

    /// The segment's FINISHED bar colour in place of the done green, or nil
    /// for green (2026-10-26, the web's `segmentDoneColor`). The one
    /// exception is the deadlines page — usually empty, so done from the
    /// start of the day — which finishes in its own teal (`--deadlines-fill`:
    /// #0d9488 light, #2dd4bf dark): its bar, its "0 of 0 ✓" check and the
    /// watch's "Nothing today ✓". Every other kind finishes green. The switch
    /// is exhaustive on purpose: a new case won't compile until it picks its
    /// colour here.
    var doneColorHex: (light: UInt32, dark: UInt32)? {
        switch self {
        case .deadlines: return colorHex
        case .horizon, .upcoming, .queueToday, .queuePrevious: return nil
        }
    }

    /// The page title's colour: one deeper shade in light mode for
    /// legibility, the fill in dark (`--segment-title-*`): Upcoming #136f8a,
    /// both queue panels #0a6670, the deadlines page `--deadlines` #008464
    /// (its dark title is `--deadlines` too, #2dd4bf).
    var titleHex: (light: UInt32, dark: UInt32) {
        switch self {
        case .horizon(let horizon): return horizon.segmentTitleHex
        case .upcoming: return (0x136F8A, 0x4CB8D9)
        case .deadlines: return (0x008464, 0x2DD4BF)
        case .queueToday: return (0x0A6670, 0x36B8C6)
        case .queuePrevious: return (0x0A6670, 0x7FBCC4)
        }
    }

    /// Whether the page has "Defer all" (the web's `offersDeferAll`): not
    /// the queue's two panels (spec rule 8: consider, Today and done), and
    /// not the deadlines page, whose Defer moves ONE row's lead day
    /// (`/api/task-segments/defer-lead`) — on native that is the row's deep
    /// link into the app, never a widget button.
    var offersDeferAll: Bool {
        switch self {
        case .horizon, .upcoming: return true
        case .deadlines, .queueToday, .queuePrevious: return false
        }
    }

    /// Whether a row's small words may name its own set horizon when it
    /// differs from the page's ("Weeks" on a Days page). Only a horizon page
    /// has a horizon to differ from: on the queue's panels and the deadlines
    /// page the web shows no horizon word.
    var namesRowHorizon: Bool {
        if case .horizon = self { return true }
        return false
    }

    /// Whether a row wears the two badges ("3×", ">1 mo"). No badges on a
    /// queue row (designer, 10-19): the queue is read at a glance, and a
    /// waiting repeating task there would read "226×".
    var showsBadges: Bool { !isQueue }
}

// MARK: - Notes mark (2026-09-25)

/// The small "this has notes" glyph after a title — the native counterpart
/// of the web's `NotesMarker` (`src/components/NotesMarker.tsx`, a muted
/// lucide `StickyNote`). Named here, where every native target can see it,
/// so the phone/Mac widgets and the watch draw the same symbol and say the
/// same thing to VoiceOver.
///
/// `doc`: a plain page with a folded corner and no text lines — the nearest
/// SF Symbol to lucide's sticky note (`note` and `note.text` draw a window
/// with a title bar; `doc.text` adds lines the web glyph doesn't have).
///
/// Always muted (`.tertiary`/`.secondary`), never a priority color — the
/// yellow circle means Medium priority, and the glyph must not be read as
/// one more priority mark. Callers draw it only when `hasNotes` is true.
enum NotesGlyph {
    static let symbol = "doc"

    /// The row's spoken label: `text` plus ", has notes" when it has notes.
    /// The glyph lives inside the title's `Text`, where it can't carry an
    /// accessibility label of its own.
    static func accessibilityLabel(_ text: String, hasNotes: Bool) -> String {
        hasNotes ? "\(text), has notes" : text
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
    /// Quota prompts assigned to this slot today (quota reminders, 2026-09-24
    /// — `groups[].prompts`, see `QuotaPromptDTO`). EVERY prompt assigned
    /// today, handled ones included and flagged, so a slot's day total never
    /// shrinks as things are handled. Decoded with a default (`[]`): a server
    /// that predates prompts, or a cache written by an older build, still
    /// parses — and simply has none.
    ///
    /// NO DEFAULT in the memberwise init, on purpose: every place that
    /// rebuilds a group (tombstone filters, cache write-throughs, the watch's
    /// optimistic edits) must say what happens to the prompts. A defaulted
    /// parameter is exactly how `considered` once silently read 0 everywhere
    /// (`WidgetStore.filterPending`'s doc).
    let prompts: [QuotaPromptDTO]

    enum CodingKeys: String, CodingKey {
        case slot, reminders, considered, prompts
        case consideredItems = "considered_items"
    }

    init(
        slot: TimeSlotDTO?, reminders: [TaskDTO], considered: Int = 0, consideredItems: [TaskDTO] = [],
        prompts: [QuotaPromptDTO]
    ) {
        self.slot = slot
        self.reminders = reminders
        self.considered = considered
        self.consideredItems = consideredItems
        self.prompts = prompts
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        slot = try c.decodeIfPresent(TimeSlotDTO.self, forKey: .slot)
        reminders = try c.decodeIfPresent([TaskDTO].self, forKey: .reminders) ?? []
        considered = try c.decodeIfPresent(Int.self, forKey: .considered) ?? 0
        consideredItems = try c.decodeIfPresent([TaskDTO].self, forKey: .consideredItems) ?? []
        prompts = try c.decodeIfPresent([QuotaPromptDTO].self, forKey: .prompts) ?? []
    }

    /// Stable identity for the App Group override key. -1 stands in for the
    /// un-slotted group so the override can be persisted as a plain Int.
    var slotKey: Int { slot?.id ?? -1 }

    var label: String { slot?.label ?? "Anytime" }

    // MARK: Counts WITH prompts (quota reminders, 2026-09-24)
    //
    // Prompts behave exactly like reminders in every count a surface shows —
    // "N left", the slot strip, "4 of 7", day complete, the Smart Stack's position —
    // so every such count reads these, never `reminders.count`/`considered`
    // alone. The web's `groupWaiting`/`groupConsidered`
    // (`src/lib/quota-prompts.ts`). Computed here from the prompts themselves
    // rather than trusting the payload's `prompts_waiting`: the optimistic
    // paths edit prompts in place, and a stored count would not follow.
    // `considered` itself stays reminder-only, as the server means it.

    /// Prompts still waiting for today, in the server's order.
    var waitingPrompts: [QuotaPromptDTO] { prompts.filter(\.isWaiting) }

    /// Prompts handled today (considered, or done).
    var handledPrompts: [QuotaPromptDTO] { prompts.filter { !$0.isWaiting } }

    /// Everything still waiting: reminders plus waiting prompts.
    var waitingCount: Int { reminders.count + waitingPrompts.count }

    /// Everything handled today: considered reminders plus handled prompts.
    var consideredCount: Int { considered + handledPrompts.count }

    /// Nothing waiting — no reminders AND no waiting prompts.
    var hasNothingWaiting: Bool { waitingCount == 0 }

    /// A copy with the prompts replaced — for the write-throughs and
    /// optimistic filters that only ever touch prompts.
    func replacingPrompts(_ prompts: [QuotaPromptDTO]) -> ReminderGroupDTO {
        ReminderGroupDTO(
            slot: slot, reminders: reminders, considered: considered,
            consideredItems: consideredItems, prompts: prompts
        )
    }
}

// MARK: - Quota prompts (quota reminders, 2026-09-24)

/// One quota PROMPT from `GET /api/reminders`' `groups[].prompts`
/// (`src/lib/quota-prompts.ts`'s `QuotaPrompt`, wire-identical).
///
/// An unmet quota also shows up as a reminder-like row in a reminder period
/// each day, so it gets the attention a reminder gets. It is NOT a task:
/// nothing is stored per prompt server-side, and a daily quota with target N
/// has one row per period it is spread over, all sharing ONE `taskId`. So a
/// row is keyed by `promptKey` (`q:<taskId>:<k>:<YYYY-MM-DD>`), never by
/// `taskId`, and actions go through the prompt endpoints
/// (`APIClient.considerPrompts`/`didPrompts`, or `completeTasks(ids:prompts:)`
/// for a mixed batch) — never a done endpoint, which refuses quotas.
///
/// Two actions (Trent's final decision): the round circle = CONSIDERED for
/// today, no progress; the square = DID IT, +1 (idempotent per key) and
/// considered too.
///
/// Every field but the key is decoded with a default, so a cache written by a
/// build (or a server) with fewer fields still parses. The key is required:
/// the server always sends it, and a prompt without one can't be acted on.
struct QuotaPromptDTO: Codable, Hashable, Identifiable {
    let promptKey: String
    let taskId: Int
    /// Daily quotas: the highest prompt number assigned to this period; the
    /// row is done once today's count reaches it. `nil` for every other
    /// quota, which prompts once a day.
    let number: Int?
    /// Daily quotas: EVERY number this row stands for, ascending (`number`
    /// is the last) — what moving the row to another period moves (the
    /// watch's hold list, 2026-09-25). `nil` for every other quota, and from
    /// a server that predates the field.
    let numbers: [Int]?
    /// The period (time slot id) this row sits in; `nil` = un-slotted, or a
    /// server that predates the field.
    let slotId: Int?
    let title: String
    /// Today's count — 0 once the period has ended. `var` (with
    /// `considered` and `done`) only so the optimistic rebuilds below copy
    /// the prompt and change these three (`updated(current:considered:done:)`)
    /// rather than re-listing every field — a field added later (the period
    /// fields, 2026-10-16) can't be dropped from a rebuild that way.
    var current: Int
    let target: Int
    /// `DAILY`/`WEEKLY`/`MONTHLY`/`YEARLY`, or nil. The bare FREQ even for an
    /// interval quota — read `periodLabel` beside it.
    let period: String?
    /// Interval quotas (2026-10-16): the quota's served period, as on
    /// `TaskDTO` — the rule's INTERVAL, the window's exclusive end and last
    /// local day, and "by Oct 24" for an interval above 1 (nil at 1, where
    /// the word comes from `period`: "week"). Nil from an older server.
    let periodInterval: Int?
    let periodEnd: String?
    let periodLastDay: String?
    let periodLabel: String?
    /// The quota's label color, resolved server-side: a `LabelColor` name
    /// (`WidgetTheme.projectColor`'s palette) or nil. Never "green" — green
    /// means "met" on quota chips, so the stripe never spends it.
    let stripeColor: String?
    /// Considered today (the circle, or "did it", which implies it).
    var considered: Bool
    /// Done for today: daily — count reached `number`; others — progress
    /// logged today from anywhere.
    var done: Bool
    /// The quota has notes (`has_notes`, 2026-09-25) — the web's
    /// `QuotaPromptRow` marks it with `NotesMarker` after the count, and the
    /// widget row draws the same small glyph there (`NotesGlyph`). False
    /// from a server that predates the field.
    let hasNotes: Bool
    /// The quota's priority (0–4, 2026-10-26), sent so the web's Priority
    /// Display can mark prompt rows. Decoded for the wire contract; no native
    /// surface draws it yet. Nil from an older server.
    let priority: Int?

    var id: String { promptKey }

    enum CodingKeys: String, CodingKey {
        case promptKey = "prompt_key"
        case taskId = "task_id"
        case number, numbers, title, current, target, period
        case periodInterval = "period_interval"
        case periodEnd = "period_end"
        case periodLastDay = "period_last_day"
        case periodLabel = "period_label"
        case slotId = "slot_id"
        case stripeColor = "stripe_color"
        case considered, done
        case hasNotes = "has_notes"
        case priority
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        promptKey = try c.decode(String.self, forKey: .promptKey)
        taskId = try c.decodeIfPresent(Int.self, forKey: .taskId) ?? 0
        number = try c.decodeIfPresent(Int.self, forKey: .number)
        numbers = try c.decodeIfPresent([Int].self, forKey: .numbers)
        slotId = try c.decodeIfPresent(Int.self, forKey: .slotId)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        current = try c.decodeIfPresent(Int.self, forKey: .current) ?? 0
        target = try c.decodeIfPresent(Int.self, forKey: .target) ?? 1
        period = try c.decodeIfPresent(String.self, forKey: .period)
        periodInterval = try c.decodeIfPresent(Int.self, forKey: .periodInterval)
        periodEnd = try c.decodeIfPresent(String.self, forKey: .periodEnd)
        periodLastDay = try c.decodeIfPresent(String.self, forKey: .periodLastDay)
        periodLabel = try c.decodeIfPresent(String.self, forKey: .periodLabel)
        stripeColor = try c.decodeIfPresent(String.self, forKey: .stripeColor)
        considered = try c.decodeIfPresent(Bool.self, forKey: .considered) ?? false
        done = try c.decodeIfPresent(Bool.self, forKey: .done) ?? false
        hasNotes = try c.decodeIfPresent(Bool.self, forKey: .hasNotes) ?? false
        priority = try c.decodeIfPresent(Int.self, forKey: .priority)
    }

    /// `hasNotes` has NO default here, on purpose — `ReminderGroupDTO.
    /// prompts`' rule: every rebuild of a prompt (the optimistic
    /// `handled(did:)`, `WidgetStore.confirmPromptAction`'s write-through)
    /// must carry it over, and a defaulted parameter is how a tapped prompt
    /// would silently lose its glyph.
    init(
        promptKey: String, taskId: Int, number: Int? = nil, numbers: [Int]? = nil, slotId: Int? = nil,
        title: String, current: Int, target: Int,
        period: String? = nil, stripeColor: String? = nil, considered: Bool = false, done: Bool = false,
        hasNotes: Bool,
        periodInterval: Int? = nil, periodEnd: String? = nil, periodLastDay: String? = nil,
        periodLabel: String? = nil, priority: Int? = nil
    ) {
        self.promptKey = promptKey
        self.taskId = taskId
        self.number = number
        self.numbers = numbers
        self.slotId = slotId
        self.title = title
        self.current = current
        self.target = target
        self.period = period
        self.periodInterval = periodInterval
        self.periodEnd = periodEnd
        self.periodLastDay = periodLastDay
        self.periodLabel = periodLabel
        self.stripeColor = stripeColor
        self.considered = considered
        self.done = done
        self.hasNotes = hasNotes
        self.priority = priority
    }

    /// A copy with a new count and handled state — EVERY other field carried
    /// over by construction. The one way an optimistic or write-through
    /// rebuild changes a prompt (`handled`, `putBack`, `WidgetStore`).
    func updated(current: Int? = nil, considered: Bool? = nil, done: Bool? = nil) -> QuotaPromptDTO {
        var copy = self
        if let current { copy.current = current }
        if let considered { copy.considered = considered }
        if let done { copy.done = done }
        return copy
    }

    /// Still waiting for today — the server's `promptWaiting`.
    var isWaiting: Bool { !considered && !done }

    /// "1/2 today", "1/2 week" — the count as TEXT, the period it covers
    /// after it (2026-09-25, Trent: "0/1" alone doesn't say whether it's
    /// today's, the week's or the month's). Since the quota segments
    /// (2026-10-13) the rows draw segments instead (`QuotaSegmentsText`) and
    /// this is the text form's words wherever text is still drawn — the 2×2,
    /// the Lock Screen, the Smart Stack card — with the segments' short words
    /// ("week", not "this week"; the web's `quotaCountText`). Joined with a
    /// non-breaking space, so the count and its word wrap as ONE unit. No
    /// period, count only.
    var countText: String {
        let count = "\(current)/\(target)"
        guard let word = segmentWord else { return count }
        return "\(count)\u{00A0}\(word.replacingOccurrences(of: " ", with: "\u{00A0}"))"
    }

    /// The word after the count — "today", "week", "month" from `period`,
    /// or an interval quota's served end, "by Oct 24" (2026-10-16): "week"
    /// would be wrong for a fortnight. The one word every prompt surface
    /// draws (`QuotaCount.word(period:label:)`).
    var segmentWord: String? { QuotaCount.word(period: period, label: periodLabel) }

    /// The period in natural words, for VoiceOver: "today", "this week",
    /// "this month", "this year" — nil when the quota has none (or an
    /// unknown one). See `spokenCount`.
    var periodWords: String? { QuotaCount.spokenPeriod(period: period, label: periodLabel) }

    /// "1 of 2 today", "1 of 2 this week" — the count's ONE accessibility
    /// label, whichever form it draws (`QuotaCount.spokenLabel`).
    var spokenCount: String {
        QuotaCount.spokenLabel(current: current, target: target, period: period, label: periodLabel)
    }

    /// The count alone, "1/2" — for a surface that sets the period beside it
    /// itself (the Smart Stack card, `compactPeriodWord`).
    var countOnlyText: String { "\(current)/\(target)" }

    /// The Smart Stack card's short period word: "today", "wk", "mo", "yr".
    /// That card's count sits in the 30pt column above ☐, where even "0/2
    /// today" truncated on one line (RenderPreview, 2026-09-25), so it draws
    /// count and word on two lines of one `Text`, with these. Everywhere else
    /// uses the full `periodWords`.
    var compactPeriodWord: String? {
        // An interval quota: its last day as "10/24" — "by Oct 24" doesn't
        // fit the 30pt column, and "wk" would be wrong for a fortnight.
        if periodLabel != nil, let day = QuotaCount.compactDay(periodLastDay) { return day }
        switch period {
        case "DAILY": return "today"
        case "WEEKLY": return "wk"
        case "MONTHLY": return "mo"
        case "YEARLY": return "yr"
        default: return nil
        }
    }

    /// The row's whole label as ONE string: title, `countSeparator`, count.
    /// The one string both the rendered `Text` and the row-height measurement
    /// build from (see `WidgetTheme.dueLabelParts`' "one function" rule).
    var labelText: String { "\(title)\(Self.countSeparator)\(countText)" }

    /// " · " between a title and its count: a plain space BEFORE the dot, a
    /// non-breaking one after it. So "· 1/2 today" is one unit that wraps
    /// whole — the dot never ends a line away from its count — but it is not
    /// glued to the title's last word. It used to be (NBSP on both sides),
    /// and once the period words made the count longer, "omega-3) · 0/2
    /// this week" was one unbreakable run wider than the widget's column, so
    /// the text system broke it mid-run ("0/2 this" / "week") at XXX Large
    /// (RenderPreview, 2026-09-25).
    static let countSeparator = " ·\u{00A0}"

    /// A copy marked handled for today — the optimistic render of an action
    /// whose server round trip is still in flight. `did` also marks it done
    /// and draws the count it will have: a daily prompt's count rises to its
    /// number, anything else +1 (the server's own `applyToQuota` rule).
    func handled(did: Bool) -> QuotaPromptDTO {
        let newCurrent: Int
        if did {
            newCurrent = number.map { max(current, $0) } ?? current + 1
        } else {
            newCurrent = current
        }
        return updated(current: newCurrent, considered: true, done: done || did)
    }

    /// A copy put back — waiting for today again — the optimistic render of
    /// a put-back (`RestorePromptIntent`, 2026-09-25) whose round trip is
    /// still in flight. The COUNT is left alone: what a did-it added (and so
    /// what comes off) is recorded only on the server (`did_applied`), and
    /// its answer is written in by `WidgetStore.confirmPromptRestore`.
    func putBack() -> QuotaPromptDTO {
        updated(considered: false, done: false)
    }
}

struct RemindersPayload: Codable {
    let groups: [ReminderGroupDTO]
    /// Today's task segments (2026-10-10), TOP-LEVEL on purpose: never inside
    /// `groups`, and never to be merged into a group's `reminders` or
    /// `prompts` — every "Complete all" path completes a group's reminders, and
    /// an old build's would archive real tasks. Decoded with a default, so a
    /// server that predates segments still parses (and simply has none).
    let taskSegments: [TaskSegmentDTO]

    enum CodingKeys: String, CodingKey {
        case groups
        case taskSegments = "task_segments"
    }

    init(groups: [ReminderGroupDTO], taskSegments: [TaskSegmentDTO]) {
        self.groups = groups
        self.taskSegments = taskSegments
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        groups = try c.decodeIfPresent([ReminderGroupDTO].self, forKey: .groups) ?? []
        taskSegments = try c.decodeIfPresent([TaskSegmentDTO].self, forKey: .taskSegments) ?? []
    }

    /// The groups in the order their periods come round in the OpenTask day
    /// ("Day starts at" PR 3, the web's `orderGroupsByDay`): the server sends
    /// them by start time, so with the day starting at 3:00 a 1:00 AM period
    /// would come first — it ends the day, so it goes last. Every native
    /// reader's "earliest slot up to now" (`groups[0...natural]`) depends on
    /// this order. Applied once, by `APIClient.fetchReminders`.
    func orderedByDay(_ day: OpenTaskDay) -> RemindersPayload {
        RemindersPayload(groups: day.orderedByDay(groups) { $0.slot?.startMinutes }, taskSegments: taskSegments)
    }
}

// MARK: - Task segments (2026-10-10, docs/TASK-MODEL.md § Task segments)

/// One task segment from `GET /api/reminders`' top-level `task_segments`
/// (`src/core/tasks/task-segments.ts`'s `TaskSegment`): a horizon's open,
/// one-off tasks that are up for a look today. A task sits here BEFORE its
/// target arrives (or with no target), for awareness; once the target arrives
/// it leaves for the "over target" machinery. Never both.
///
/// Rows carry their state: `waiting` (the circle is open), `considered` ("I saw
/// it" today — never a completion) or `deferred` (Defer All: off today's list,
/// back tomorrow). Counts are computed from the rows, like
/// `ReminderGroupDTO.waitingCount`, rather than trusting the payload's
/// `waiting`/`considered`: the optimistic paths edit rows in place, and a
/// stored count would not follow.
///
/// Segment rows count toward NO reminders count (amendment 8): not a slot's
/// headline, not the day's "N of M", not "day complete".
struct TaskSegmentDTO: Codable, Hashable, Identifiable {
    /// The server's horizon string ("days" …). Kept raw so an unknown future
    /// horizon still decodes; read it through `horizonValue`/`label`.
    let horizon: String
    /// In the server's order: priority, then id — fixed, so acting on one
    /// never reorders the rest under the finger.
    let tasks: [SegmentTaskDTO]
    /// Over ~50 items the screen suggests Process or AI help instead.
    let nudge: Bool

    var id: String { horizon }

    enum CodingKeys: String, CodingKey {
        case horizon, tasks, nudge
    }

    /// NO default for `tasks` — the `ReminderGroupDTO.prompts` rule: every
    /// rebuild (tombstone filters, the watch's optimistic edits) must say what
    /// happens to the rows.
    init(horizon: String, tasks: [SegmentTaskDTO], nudge: Bool = false) {
        self.horizon = horizon
        self.tasks = tasks
        self.nudge = nudge
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        horizon = try c.decodeIfPresent(String.self, forKey: .horizon) ?? TaskHorizon.weeks.rawValue
        tasks = try c.decodeIfPresent([SegmentTaskDTO].self, forKey: .tasks) ?? []
        nudge = try c.decodeIfPresent(Bool.self, forKey: .nudge) ?? false
    }

    /// The horizon, or nil for Upcoming (and an unknown segment).
    var horizonValue: TaskHorizon? { TaskHorizon(rawValue: horizon) }

    /// A horizon or Upcoming (2026-10-12); nil only for a segment this build
    /// doesn't know. Read colours through this, never `horizonValue`, or
    /// Upcoming would draw as a horizon.
    var kind: SegmentKind? { SegmentKind(raw: horizon) }

    /// The Upcoming segment (2026-10-12): targeted tasks on their heads-up
    /// days. Its rows show the target date, and every row offers Today (repeating ones too, since 2026-10-12).
    var isUpcoming: Bool { kind == .upcoming }

    /// "Days", "Weeks", "Upcoming", … — the segment's word (its spoken
    /// "Defer all Days tasks"); the page's TITLE is `title`.
    var label: String { kind?.label ?? horizon.capitalized }

    /// The segment's title everywhere it is named — the widget page's header,
    /// the strip bar's spoken label, the watch section and the Smart Stack
    /// card: "Task queue · Daily" (2026-10-26, the web's `segmentTitle`; with
    /// the task-queue switch off too, as on the web). A kind this build
    /// doesn't know keeps its raw word ("Task queue · Someday").
    var title: String { kind?.title ?? TaskWording.taskQueueTitle(horizon.capitalized) }

    /// `title` for a header that may wrap (the widget page's two-line
    /// fallback, the watch section): the space before the dot is
    /// non-breaking (`TaskDTO.metaJoiner`), so it breaks "Task queue ·" /
    /// "Quarterly", never leaving a line that starts with "·".
    var wrappingTitle: String { title.replacingOccurrences(of: " · ", with: TaskDTO.metaJoiner) }

    /// Stable page key for the widget's and the watch's page ring, in the
    /// same Int space as `ReminderGroupDTO.slotKey` (real slot ids are
    /// positive, -1 is Anytime): -10 days, -11 weeks, -12 months, -13
    /// eventually, -14 upcoming (`SegmentKind.pageKey`), -15 a segment this
    /// build doesn't know. So the existing slot-override storage, page index
    /// and chevrons address a segment page with no new storage.
    var pageKey: Int { kind?.pageKey ?? -15 }

    /// Rows on today's list: deferred ones are gone until tomorrow.
    var listedTasks: [SegmentTaskDTO] { tasks.filter { $0.state != .deferred } }
    var waitingTasks: [SegmentTaskDTO] { tasks.filter { $0.state == .waiting } }
    var consideredTasks: [SegmentTaskDTO] { tasks.filter { $0.state == .considered } }
    var waitingCount: Int { waitingTasks.count }
    var hasWaiting: Bool { waitingCount > 0 }
    /// The X of the segment's "X of Y" (docs/TASK-MODEL.md § Task segments,
    /// 2026-10-11): rows considered OR deferred today. Y is `tasks.count` —
    /// every row the segment holds today, deferred ones included (a task
    /// marked done leaves the payload entirely). So a page listing 2 rows can
    /// read "3 of 5"; that is the web header's count, on purpose.
    var handledCount: Int { tasks.count - waitingCount }
    /// No rows at all today (native PR E, the server's `?fill=1`): the
    /// segment is DONE from the start of the day — a full bar in the done
    /// colour, "0 of 0 ✓", "Nothing today ✓" — and stays on the strip and in
    /// the ring, in its fixed place.
    var isEmpty: Bool { tasks.isEmpty }

    /// Whether the segment is a page today. EVERY segment the server sends
    /// (native PR E, 2026-10-26, Trent 10-24 on the web: "always show every
    /// queue segment, every day, in fixed positions" — the server's `?fill=1`
    /// sends every kind, an empty one with no rows). Before PR E an empty or
    /// all-deferred segment dropped out of the ring; an older server, which
    /// ignores `fill`, simply sends fewer segments.
    var isListed: Bool { true }

    /// "Defer all" on this page (`SegmentKind.offersDeferAll`): never on the
    /// queue's panels or the deadlines page. A kind this build doesn't know
    /// offers it as the horizons do (its rows are ordinary segment rows).
    var offersDeferAll: Bool { kind?.offersDeferAll ?? true }

    func replacingTasks(_ tasks: [SegmentTaskDTO]) -> TaskSegmentDTO {
        TaskSegmentDTO(horizon: horizon, tasks: tasks, nudge: nudge)
    }

    /// Segments with a page today, in screen order — every one (`isListed`).
    static func listed(_ segments: [TaskSegmentDTO]) -> [TaskSegmentDTO] {
        segments.filter(\.isListed)
    }

    /// The Smart Stack card's label for one of its rows: the segment's title
    /// ("Task queue · Daily"), and for an Upcoming row its section
    /// (2026-10-26, ruling 4): "Upcoming · Tomorrow", "Upcoming · Later".
    func cardLabel(for row: SegmentTaskDTO) -> String {
        guard isUpcoming else { return title }
        return "\(SegmentKind.upcoming.titleWord) · \(row.section.title)"
    }
}

/// Upcoming's two sections (2026-10-25 on the server and the web, the
/// Upcoming split; native 2026-10-26), in the order the page lists them:
/// Tomorrow (the day before a target or deck day), then Later (the
/// lead-time heads-up, carried over until seen). The wire values; the words
/// are `title` (the web's `UPCOMING_SECTION_TITLES`).
enum UpcomingSection: String, CaseIterable, Codable {
    case tomorrow, later

    var title: String {
        switch self {
        case .tomorrow: return "Tomorrow"
        case .later: return "Later"
        }
    }
}

/// The Upcoming segment split into its sections — the web's
/// `upcomingSections` (`src/lib/upcoming-sections.ts`). BOTH sections are
/// always returned, Tomorrow first, an empty one too (the web draws both
/// headings always). The segment's own "X of Y", strip bar and "Defer all"
/// stay the segment's; each section has its own "n of m".
enum UpcomingSections {
    struct Section: Equatable {
        let section: UpcomingSection
        /// Still waiting, in the server's order.
        let waiting: [SegmentTaskDTO]
        /// Considered or deferred today.
        let handled: [SegmentTaskDTO]

        /// "n of m": n handled, m everything the section held today.
        var handledCount: Int { handled.count }
        var total: Int { waiting.count + handled.count }
        /// Nothing waits — the count goes green with a check ("0 of 0 ✓"
        /// for an empty section, done from the start).
        var finished: Bool { waiting.isEmpty }
        /// No rows at all today: the watch's "Nothing today ✓".
        var isEmpty: Bool { total == 0 }
        /// "1 of 3".
        var countText: String { "\(handledCount) of \(total)" }
    }

    static func split(_ rows: [SegmentTaskDTO]) -> [Section] {
        UpcomingSection.allCases.map { section in
            let mine = rows.filter { $0.section == section }
            return Section(
                section: section,
                waiting: mine.filter { $0.state == .waiting },
                handled: mine.filter { $0.state != .waiting }
            )
        }
    }
}

/// A task segment row: the full task plus its `segment_state`. On the wire
/// it is ONE flat object (the task's fields and `segment_state` side by
/// side), so both `TaskDTO` and this read the same keyed container.
struct SegmentTaskDTO: Codable, Hashable, Identifiable {
    enum State: String, Codable {
        case waiting, considered, deferred
    }

    let task: TaskDTO
    let state: State
    /// A repeating task (2026-10-12, the server's `recurring`). Only Upcoming
    /// holds them, and their row has no "Target today": the server skips a
    /// repeating task there (`skipped_recurring`, ruling Q1), so it keeps the
    /// circle and done only. Falls back to the task's `rrule` when absent (an
    /// older server or cache).
    let recurring: Bool
    /// An Upcoming row's section (2026-10-25 on the server, the Upcoming
    /// split; native 2026-10-26): `upcoming_section`, "tomorrow" (the day
    /// before its target) or "later" (the lead-time heads-up). Nil on every
    /// other kind's rows, and on an Upcoming row from an older server or
    /// cache — read it through `section`, where a missing value is Later.
    let upcomingSection: UpcomingSection?

    /// How the row LEFT its segment today, handled (native PR E; the
    /// server's `segment_left`, sent with `?handled=1` — the day roster,
    /// `src/core/tasks/segment-roster.ts`): done, decked, targeted (Today),
    /// considered out of the queue, or — the deadlines page — its lead day
    /// deferred. Such a row is always `considered`, counts in the segment's
    /// "N of M", is listed behind the done dot with its words
    /// (`SegmentLeft.words`) and has NO controls: its way back is Undo.
    let left: SegmentLeft?
    /// The deadlines page's SAFETY NET (`safety_net`, from the day before
    /// the deadline): seeing the row doesn't silence it, so a consider marks
    /// it `seen` and it stays waiting. False off the deadlines page.
    let safetyNet: Bool
    /// A safety-net row considered this OpenTask day (`seen`): still
    /// waiting, its circle drawn filled and inert (a tap would change
    /// nothing). False off the deadlines page.
    let seen: Bool
    /// "Today's pulls" Try Tomorrow mark (`try_tomorrow`, the web's left-edge
    /// mark). Decoded; Try Tomorrow itself is app only, nothing native draws
    /// the mark yet.
    let tryTomorrow: Bool

    var id: Int { task.id }

    /// The row's Upcoming section; a missing value reads as Later (the web's
    /// `sectionOf`).
    var section: UpcomingSection { upcomingSection ?? .later }

    /// A seen safety-net row: waiting, but its circle does nothing (the web's
    /// `seenInNet`).
    var isSeenInSafetyNet: Bool { safetyNet && seen }

    /// Whether the circle considers: a waiting row, unless it is a seen
    /// safety-net row.
    var isConsiderable: Bool { state == .waiting && !isSeenInSafetyNet }

    /// A row that LEFT today, as one string: its title, then the web's words
    /// for how it left ("Fix the gate · done", "… · deferred to Thu"), the
    /// words' spaces non-breaking; the title alone for a row considered out
    /// of the queue. The widget row draws and measures exactly this; the
    /// watch row shows the same. Only meaningful when `left` is set.
    var leftLabelText: String {
        guard let words = left?.words(leadFrom: task.leadFrom) else { return task.title }
        return task.title + TaskDTO.metaJoiner + words.replacingOccurrences(of: " ", with: "\u{00A0}")
    }

    /// A row behind the "CONSIDERED" divider, as one string — the web's
    /// `ConsideredSegmentRow` exactly (2026-10-27): the title and only the
    /// words it adds, never the waiting row's small words (horizon, target,
    /// deadline, badges). A row that left: `leftLabelText`. A row considered
    /// and still on deck (a deadlines-page row decked for a later day):
    /// "Fix the gate · on deck Sat" / "… · on deck today", lower-case as on
    /// the web (`deckChipWords(…).replace('On deck', 'on deck')`). Otherwise
    /// the title alone. It read "Fix the gate · deadline Jan 20 · On deck
    /// Sat" before.
    func consideredLabelText(now: Date = Date(), day: OpenTaskDay = DayStartStore.current) -> String {
        if left != nil { return leftLabelText }
        guard let deck = task.deckWords(now: now, day: day) else { return task.title }
        let words = deck.replacingOccurrences(of: "On deck", with: "on deck")
        return task.title + TaskDTO.metaJoiner + words.replacingOccurrences(of: " ", with: "\u{00A0}")
    }

    private enum CodingKeys: String, CodingKey {
        case state = "segment_state"
        case recurring
        case upcomingSection = "upcoming_section"
        case left = "segment_left"
        case safetyNet = "safety_net"
        case seen
        case tryTomorrow = "try_tomorrow"
    }

    init(
        task: TaskDTO, state: State, recurring: Bool? = nil, upcomingSection: UpcomingSection? = nil,
        left: SegmentLeft? = nil, safetyNet: Bool = false, seen: Bool = false, tryTomorrow: Bool = false
    ) {
        self.task = task
        self.state = state
        self.recurring = recurring ?? (task.rrule != nil)
        self.upcomingSection = upcomingSection
        self.left = left
        self.safetyNet = safetyNet
        self.seen = seen
        self.tryTomorrow = tryTomorrow
    }

    init(from decoder: Decoder) throws {
        task = try TaskDTO(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // An unknown future state reads as waiting: the row stays actionable
        // rather than the whole segment failing to decode.
        let raw = try c.decodeIfPresent(String.self, forKey: .state) ?? State.waiting.rawValue
        state = State(rawValue: raw) ?? .waiting
        recurring = try c.decodeIfPresent(Bool.self, forKey: .recurring) ?? (task.rrule != nil)
        // An unknown section reads as Later, like a missing one.
        upcomingSection = (try? c.decodeIfPresent(String.self, forKey: .upcomingSection))
            .flatMap { $0 }
            .map { UpcomingSection(rawValue: $0) ?? .later }
        // An unknown way of leaving reads as a plain considered one: the row
        // still left handled, it just says nothing more.
        left = (try? c.decodeIfPresent(String.self, forKey: .left))
            .flatMap { $0 }
            .map { SegmentLeft(rawValue: $0) ?? .considered }
        safetyNet = try c.decodeIfPresent(Bool.self, forKey: .safetyNet) ?? false
        seen = try c.decodeIfPresent(Bool.self, forKey: .seen) ?? false
        tryTomorrow = try c.decodeIfPresent(Bool.self, forKey: .tryTomorrow) ?? false
    }

    /// Written back for the caches (`WidgetStore`'s, the watch's), so a row
    /// drawn from cache keeps its section, how it left, and its safety net.
    func encode(to encoder: Encoder) throws {
        try task.encode(to: encoder)
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(state, forKey: .state)
        try c.encode(recurring, forKey: .recurring)
        try c.encodeIfPresent(upcomingSection?.rawValue, forKey: .upcomingSection)
        try c.encodeIfPresent(left?.rawValue, forKey: .left)
        try c.encode(safetyNet, forKey: .safetyNet)
        try c.encode(seen, forKey: .seen)
        try c.encode(tryTomorrow, forKey: .tryTomorrow)
    }

    func with(state: State) -> SegmentTaskDTO {
        SegmentTaskDTO(
            task: task, state: state, recurring: recurring, upcomingSection: upcomingSection,
            left: left, safetyNet: safetyNet, seen: seen, tryTomorrow: tryTomorrow
        )
    }

    /// The row as it reads once it has LEFT the segment handled (`?handled=1`
    /// — what the server sends back after a done or a Today): considered,
    /// with `left`. The optimistic draw of a done or Today tap, so "N of M"
    /// never shrinks under the finger.
    func leaving(_ how: SegmentLeft) -> SegmentTaskDTO {
        SegmentTaskDTO(
            task: task, state: .considered, recurring: recurring, upcomingSection: upcomingSection,
            left: how, safetyNet: safetyNet, seen: seen, tryTomorrow: tryTomorrow
        )
    }

    /// A consider as this row takes it: a safety-net row is SEEN and keeps
    /// waiting (the deadline is close, so it stays); any other row is
    /// considered. The optimistic draw, and what `confirmSegmentConsider`
    /// writes into the cache.
    func consideredByTap() -> SegmentTaskDTO {
        guard safetyNet else { return state == .waiting ? with(state: .considered) : self }
        return SegmentTaskDTO(
            task: task, state: state, recurring: recurring, upcomingSection: upcomingSection,
            left: left, safetyNet: safetyNet, seen: true, tryTomorrow: tryTomorrow
        )
    }

    /// Whether the row offers "Target today" — the web's
    /// `upcomingRowActions(row).today`: EVERY row, repeating ones included
    /// (2026-10-12, batch 2). Since §6 the server keeps a repeating task's
    /// schedule in `occurrence_at` apart from its target, so Today moves only
    /// the target and done still advances to the next scheduled occurrence.
    /// It was `!recurring` while Today on a repeating task could reset its
    /// schedule. A row that LEFT the segment (`left`) has no controls at all.
    var offersTargetToday: Bool { left == nil }
}

/// How a row left its segment today, handled (the web's `SegmentLeft`,
/// `src/lib/task-segments.ts`; the API's `segment_left`).
enum SegmentLeft: String, Codable, CaseIterable {
    case done, deck, target, considered, deferred

    /// The words after the title on a row that left (the web's
    /// `ConsideredSegmentRow` / `leftWords`, EXACTLY — no more, no less):
    /// "done", "on deck", "targeted", "deferred to Thu" (the lead day's
    /// weekday, `lead_from`; "deferred" without one); nil for a row
    /// considered out of the queue, which says nothing more.
    func words(leadFrom: String?) -> String? {
        switch self {
        case .done: return "done"
        case .deck: return "on deck"
        case .target: return "targeted"
        case .considered: return nil
        case .deferred:
            guard let day = leadFrom.flatMap({ LocalDate($0) }) else { return "deferred" }
            return "deferred to \(day.shortWeekday)"
        }
    }
}

extension LocalDate {
    private static let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    /// "Thu" — the web's `ccc` of a bare date (no zone: a date is a date).
    var shortWeekday: String { Self.weekdays[(weekday - 1 + 7) % 7] }

    /// "Oct 24" — the web's `LLL d` of a bare date.
    var shortMonthDay: String { "\(Self.months[max(0, min(11, month - 1))]) \(day)" }
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
    /// The task's attempts when it was completed (2026-10-12; the web's
    /// History "· 3×"). 0 from an older server. Decoded for the contract.
    let attempts: Int

    enum CodingKeys: String, CodingKey {
        case id
        case taskId = "task_id"
        case completedAt = "completed_at"
        case taskTitle = "task_title"
        case projectId = "project_id"
        case isReminder = "is_reminder"
        case isTracked = "is_tracked"
        case progressTarget = "progress_target"
        case attempts
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
        attempts = try c.decodeIfPresent(Int.self, forKey: .attempts) ?? 0
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
        progressTarget: Int = 1,
        attempts: Int = 0
    ) {
        self.id = id
        self.taskId = taskId
        self.completedAt = completedAt
        self.taskTitle = taskTitle
        self.projectId = projectId
        self.isReminder = isReminder
        self.isTracked = isTracked
        self.progressTarget = progressTarget
        self.attempts = attempts
    }

    var completedDate: Date? {
        DateHelpers.parseISO(completedAt)
    }

    /// A quota's completion — the server's `isTracked()`: the flag OR a
    /// target above 1 (`TaskDTO.isTracked`'s doc — most quotas predate the
    /// flag, so the flag alone misses them). A quota's completions are
    /// written by its period rollover and can never be put back —
    /// `POST /api/tasks/:id/undone` refuses quotas (2026-09-24) — so no DONE
    /// list may offer a put-back on one.
    var isQuota: Bool { isTracked || progressTarget > 1 }
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
    /// The entry a bare undo would take next (scoped native Undo, server PR
    /// #390, 2026-10-26), or nil when nothing is undoable. A native surface
    /// offers Undo only when its own last `undo_id` is this one
    /// (`UndoScope`).
    let newestUndoableId: Int?
    /// The entry a bare redo would take next, or nil.
    let nextRedoableId: Int?
    /// Whether the server sent `newest_undoable_id` at all (even null): a
    /// server that predates scoped Undo doesn't, and then every surface
    /// keeps the older count-based buttons. `decodeIfPresent` alone can't
    /// tell a missing key from a null one.
    let scoped: Bool

    enum CodingKeys: String, CodingKey {
        case latestId = "latest_id"
        case undoableCount = "undoable_count"
        case redoableCount = "redoable_count"
        case newestUndoableId = "newest_undoable_id"
        case nextRedoableId = "next_redoable_id"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        latestId = try c.decodeIfPresent(Int.self, forKey: .latestId)
        undoableCount = try c.decode(Int.self, forKey: .undoableCount)
        redoableCount = try c.decode(Int.self, forKey: .redoableCount)
        newestUndoableId = try c.decodeIfPresent(Int.self, forKey: .newestUndoableId)
        nextRedoableId = try c.decodeIfPresent(Int.self, forKey: .nextRedoableId)
        scoped = c.contains(.newestUndoableId)
    }
}

/// `GET /api/tasks/counts` (`countTasks`, src/lib/task-counts.ts). No
/// defaults, unlike most DTOs here: a renamed key must fail to decode rather
/// than read as 0 and clear the badge.
struct TaskCountsPage: Decodable {
    let total: Int
    let overdue: Int
    let today: Int
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

/// One of the four buttons on the snooze pad's preset row (`pad_presets` in
/// `GET /api/user/preferences`, 2026-10-21). `time` is always the RESOLVED
/// "HH:MM" (local, 24-hour): when the button is linked to a reminder period
/// (`slot_id`), the server has already put that period's current start time
/// in it, so native never resolves a link itself. `slot_id` is decoded for
/// the contract; nothing native reads it.
struct PadPresetDTO: Codable, Hashable {
    let time: String
    let slotId: Int?

    enum CodingKeys: String, CodingKey {
        case time
        case slotId = "slot_id"
    }

    init(time: String, slotId: Int? = nil) {
        self.time = time
        self.slotId = slotId
    }

    /// (hour, minute) from `time`, or nil when it isn't a valid "H:MM"/"HH:MM"
    /// (hour 0–23, minute 0–59) — `PadPresetStore` treats a list holding one
    /// of those as garbage and draws the defaults instead.
    var hourMinute: (hour: Int, minute: Int)? {
        let parts = time.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[1].count == 2,
              let h = Int(parts[0]), let m = Int(parts[1]),
              (0...23).contains(h), (0...59).contains(m)
        else { return nil }
        return (h, m)
    }
}

/// `GET /api/user/preferences` → `{"data":{..., "label_config":[...], ...}}`
/// (`src/app/api/user/preferences/route.ts`) — a ~60-field payload this
/// decodes only the few keys native reads (`label_config`, `pad_presets`,
/// the day boundary's `task_queue` / `rollover_time` / `week_start`) or pins
/// for the contract. `Decodable` already ignores keys it wasn't
/// told about, so no custom `init(from:)` is needed to skip the rest; only
/// `decodeIfPresent` is, so a server that predates a key (or a malformed
/// one) still yields an empty cluster color set / nil presets instead of
/// failing the whole preferences fetch.
struct UserPreferencesLabelConfigPage: Decodable {
    let labelConfig: [LabelConfigDTO]
    /// `morning_time` ("HH:MM", 2026-10-11). Decoded for the contract; nothing
    /// native reads it since 2026-10-12 (a deadline's target is stored, so the
    /// native implied-target rule it fed is gone). Nil from an older server.
    let morningTime: String?
    /// `check_in_day` (2026-10-12): the weekday the Weeks and Months segments
    /// come round on, Luxon numbering (1 = Monday … 7 = Sunday; default 6,
    /// Saturday). Nil from an older server. Decoded for the contract; no
    /// native surface shows the segments' "Saturdays" hints, so nothing reads
    /// it yet — if one ever does, derive the words from this, never hardcode.
    let checkInDay: Int?
    /// `pad_presets` (2026-10-21): the snooze pad's four preset times, each
    /// already resolved by the server. Nil from an older server, in which
    /// case `refreshSlotActions()` leaves `PadPresetStore`'s cache alone.
    let padPresets: [PadPresetDTO]?
    /// `task_queue` (read-only, task-queue PR 3): the server's switch. Nil
    /// from a server that predates it — no switch, so midnight. With the
    /// switch on the day turns at `rolloverTime`, off at midnight
    /// (`DayStartStore.resolvedDayStart`).
    let taskQueue: Bool?
    /// `rollover_time` ("HH:MM", read-only): the user's "Day starts at" —
    /// 03:00 unless they changed it ("Day starts at", 2026-10-23).
    let rolloverTime: String?
    /// `week_start` ("sunday" / "monday"): the quota weeks' first day.
    let weekStart: String?

    enum CodingKeys: String, CodingKey {
        case labelConfig = "label_config"
        case morningTime = "morning_time"
        case checkInDay = "check_in_day"
        case padPresets = "pad_presets"
        case taskQueue = "task_queue"
        case rolloverTime = "rollover_time"
        case weekStart = "week_start"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        labelConfig = try c.decodeIfPresent([LabelConfigDTO].self, forKey: .labelConfig) ?? []
        morningTime = try c.decodeIfPresent(String.self, forKey: .morningTime)
        checkInDay = try c.decodeIfPresent(Int.self, forKey: .checkInDay)
        padPresets = try? c.decodeIfPresent([PadPresetDTO].self, forKey: .padPresets)
        taskQueue = try? c.decodeIfPresent(Bool.self, forKey: .taskQueue)
        rolloverTime = try? c.decodeIfPresent(String.self, forKey: .rolloverTime)
        weekStart = try? c.decodeIfPresent(String.self, forKey: .weekStart)
    }
}
