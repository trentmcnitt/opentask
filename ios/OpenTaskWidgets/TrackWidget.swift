import SwiftUI
import WidgetKit
#if os(iOS)
import UIKit
#else
import AppKit
#endif

// MARK: - Entry

/// The Quotas widget's timeline entry (redesigned `feat/quotas-widget`,
/// replacing the old single-item-ring "Track" shape — see `TrackWidgetViews.
/// swift`'s file header for the design this now mirrors, and `TrackTimeline`
/// below for what the OLD shape is kept around for).
struct TrackEntry: TimelineEntry {
    let date: Date
    /// Every period section that has at least one quota in it (day → year,
    /// then a period-less "No period" bucket last), each already carrying
    /// its `showMet`-filtered clusters — see `QuotaSectionBuilder`.
    let sections: [QuotaSection]
    /// Met vs. total over EVERY quota, unfiltered by `showMet` — the
    /// header's "M of N" subtitle and the small family's ring both read
    /// this rather than summing `sections`, so neither has to agree with
    /// the other about how the filtered `clusters` add up.
    let totalMet: Int
    let totalCount: Int
    /// First unmet quota in section/cluster order (day → year, then label
    /// alpha, then title alpha) — what `systemSmall`'s "next unmet" line
    /// names. Nil when everything is met or there are no quotas. Valid
    /// regardless of `showMet`: an UNMET quota is never filtered by that
    /// toggle, only a met one ever is — see `QuotaSectionBuilder`.
    let nextUnmet: TrackItem?
    /// The "met" dot's current state, carried on the entry rather than read
    /// live from `WidgetStore` inside the view — see `TrackWidgetViews.swift`
    /// for why every view in that file is pure over this entry.
    let showMet: Bool
    /// Takeback mode (2026-09-24) as THIS entry draws it — already `false`
    /// for anything but a `systemLarge` instance (the provider gates on
    /// `context.family`; see `WidgetStore.quotasTakebackMode`). While true,
    /// `sections` were built with met chips SHOWN whatever `showMet` says,
    /// so a met quota can be taken back; `showMet` itself stays the dot's
    /// real state, so the dot doesn't light up on its own. Defaulted so the
    /// gallery's `SampleData.trackEntry` needn't mention a mode it never
    /// shows.
    var takebackMode = false
    /// The flowed-layout page on screen. Raw `WidgetStore.quotasPage` —
    /// UNCLAMPED here; the view clamps it against the real page count it
    /// alone can compute (it is the only thing that knows the card's real
    /// width/height) — same "store only ever moves it, view clamps" idiom
    /// as `RemindersListView`'s own pager.
    let page: Int
    let staleSince: Date?
    let isSignedOut: Bool
    /// Whether the header's Undo/Redo buttons should be enabled at THIS
    /// entry's `date` — see `WidgetStore.canUndo`/`canRedo` and
    /// `UndoRedoButtons`. Not time-windowed (2026-09-23) — see
    /// `RemindersEntry`'s identical doc.
    let canUndo: Bool
    let canRedo: Bool
    /// The header subtitle's "Undid: …" / "Redid: …" indication — see
    /// `RemindersEntry.actionDescription`'s doc.
    let actionDescription: String?
}

/// A tracked task paired with the §5 pace maths, resolved once in the provider
/// so every family draws the same numbers.
///
/// UNCHANGED by the Quotas rebuild — still what `pacedItems`/`orderedItems`
/// below return, and still what `QuotaSectionBuilder` wraps each chip in
/// (with `elapsedFraction: nil`; the new design has no per-chip pace tick,
/// only the section-level one `PeriodHeading`'s equivalent draws — see
/// `QuotaSection.elapsedFraction`).
struct TrackItem: Identifiable {
    let task: TaskDTO
    /// How much of the current period has gone by, 0...1. Nil when the item has
    /// no period (see `TrackTimeline.elapsedFraction`), or when nothing in the
    /// new design reads this field at all (`QuotaSectionBuilder` always passes
    /// nil — see this struct's own doc).
    let elapsedFraction: Double?

    var id: Int { task.id }

    /// Progress against target, clamped for drawing. The *count* is never
    /// clamped — §5 keeps overflow (3/2) observable, this only stops a ring
    /// from winding past full.
    var doneFraction: Double {
        guard task.progressTarget > 0 else { return 0 }
        return min(Double(task.progressCurrent) / Double(task.progressTarget), 1)
    }

    /// Signed pace: 0 exactly on schedule, negative behind, positive ahead.
    var pace: Double? {
        elapsedFraction.map { doneFraction - $0 }
    }

    var isMet: Bool { task.isProgressMet }
}

// MARK: - Track selection and pace (kept for `ShiftTrackItemIntent` only)

/// Which quotas exist, how they are ordered, and which one the 2×2 shows.
///
/// **No longer drives the Quotas widget's own rendering** (`feat/quotas-
/// widget`, 2026-09-23): the new design has no per-item chevron selection —
/// ordering is static alphabetical (label, then title), built by
/// `QuotaSectionBuilder` instead. This enum is kept, unmodified, because
/// `ShiftTrackItemIntent` and `SampleData` still call it and an archived Home
/// Screen button from before this rebuild may still reference that intent —
/// deleting a whole pace-ranking algorithm that still has a live (if
/// unreachable from the current UI) caller would strand that button on a
/// crash instead of a harmless no-op. See `ShiftTrackItemIntent`'s own doc in
/// `WidgetIntents.swift` for the "why keep it" reasoning in full.
///
/// Split out of the provider for the same reason as `RemindersTimeline`:
/// `ShiftTrackItemIntent` has to answer "which item is selected" from a
/// different process entry point, and two implementations of that rule would
/// drift apart.
enum TrackTimeline {

    /// Every tracked item, most behind pace first.
    ///
    /// **Pace (§5)** is `fraction of target done − fraction of period elapsed`,
    /// both clamped to 0...1: 0 is exactly on pace, negative behind, positive
    /// ahead. The period is the window `[progress_period_start, that + one
    /// period]`: the server anchors every quota to the local calendar boundary
    /// its period began on and advances that anchor as each period closes, and
    /// the length comes from the rule's `FREQ` × `INTERVAL`. Everything else in
    /// an rrule (`BYDAY`, `BYMONTHDAY`) narrows *when* inside the period, never
    /// how long it is, so it is ignored here on purpose.
    ///
    /// The anchor replaced `due_at`, which used to stand in for the period's
    /// end. A quota is dateless as of §5 — `due_at` is always null on one now —
    /// so that window had silently collapsed: every pace read nil, every quota
    /// tied, and the ranking below quietly degraded to id order.
    ///
    /// Items with no rrule or no anchor have no clock to be behind: they get
    /// no pace, no tick, and sort last. Inventing a period for them would put a
    /// moving marker on a bar where it means nothing.
    ///
    /// This is the whole of "behind pace" — arithmetic, deliberately not AI
    /// (§5) — and all it may do is set the default selection, the *initial* row
    /// order, and one small tick's position. It never colors anything (§5: pace
    /// renders, never alarms).
    ///
    /// Pure: no stored order, no side effects. `orderedItems` is what the list
    /// families render; this is the raw ranking they and the 2×2's default
    /// selection are both derived from, and what sample data uses so a gallery
    /// render can never touch the user's persisted order.
    static func pacedItems(from tasks: [TaskDTO], now: Date = Date()) -> [TrackItem] {
        tasks
            .filter(\.isTracked)
            .map { TrackItem(task: $0, elapsedFraction: elapsedFraction(for: $0, now: now)) }
            .sorted(by: isMoreBehind)
    }

    /// The one "most behind pace first" comparator, so the row order and the
    /// default 2×2 selection can never disagree about who is furthest behind.
    ///
    /// No pace sorts last; `.infinity` reads as "infinitely ahead", which is
    /// exactly how a periodless item should be ranked here.
    static func isMoreBehind(_ lhs: TrackItem, _ rhs: TrackItem) -> Bool {
        let l = lhs.pace ?? .infinity
        let r = rhs.pace ?? .infinity
        if l != r { return l < r }
        return lhs.id < rhs.id
    }

    /// The rows as the list families draw them: a STABLE order that is re-sorted
    /// by pace only when the set of quotas changes.
    ///
    /// Pace order is live, and `+1` moves an item's pace — so sorting by it on
    /// every reload meant the list rearranged itself the instant the user used
    /// it, sliding the row out from under the finger that had just tapped it.
    /// The order is therefore frozen at the last membership change: add or stop
    /// tracking a quota and the list re-ranks (there is a genuinely new list to
    /// present), tap `+1` a hundred times and nothing moves. Nothing is lost —
    /// pace is still fully expressed by each row's bar and tick, which is where
    /// §5 says it belongs.
    ///
    /// A frozen order also has to be thrown away once when the pace maths
    /// itself changes, or a wrong order outlives the fix that corrected it —
    /// `WidgetStore.trackOrder` reads as empty when it was frozen under an
    /// older `trackOrderVersion`, which lands on the re-rank branch below.
    static func orderedItems(from tasks: [TaskDTO], now: Date = Date()) -> [TrackItem] {
        let paced = pacedItems(from: tasks, now: now)
        let stored = WidgetStore.trackOrder

        guard !stored.isEmpty, Set(stored) == Set(paced.map(\.id)) else {
            // Only an order that some item's pace actually shaped may retire the
            // version marker — see `WidgetStore.setTrackOrder`.
            WidgetStore.setTrackOrder(
                paced.map(\.id),
                pacedByPeriod: paced.contains { $0.pace != nil }
            )
            return paced
        }

        var rank: [Int: Int] = [:]
        for (index, id) in stored.enumerated() { rank[id] = index }
        // The sets match on this branch, so an unranked id cannot occur;
        // `.max` appends rather than crashes if that ever stops being true.
        return paced.sorted { (rank[$0.id] ?? .max, $0.id) < (rank[$1.id] ?? .max, $1.id) }
    }

    /// Fraction of the current period already gone, 0...1.
    ///
    /// The window is `[progress_period_start, that + one period]`. The anchor is
    /// the server's (`src/core/tasks/period-rollover.ts`): the UTC instant the
    /// current period began by the user's local calendar — Monday 00:00 for a
    /// week, the 1st for a month, midnight for a day — moved forward one period
    /// at a time by the rollover job, which is the same moment it zeroes
    /// `progress_current`. So the tick and the count always describe the same
    /// period.
    ///
    /// No anchor means no pace, and there is deliberately NO fallback to
    /// `due_at`: a quota is dateless (§5), so any date still sitting on one is a
    /// leftover from before that rule, and pacing from it is precisely the bug
    /// this replaced.
    static func elapsedFraction(for task: TaskDTO, now: Date = Date()) -> Double? {
        guard let start = task.periodStartDate,
              let end = periodEnd(rrule: task.rrule, from: start)
        else {
            return nil
        }
        let length = end.timeIntervalSince(start)
        guard length > 0 else { return nil }
        return min(max(now.timeIntervalSince(start) / length, 0), 1)
    }

    /// The instant the period that began at `start` ends.
    ///
    /// Calendar arithmetic rather than `start + periodLength`, now that a real
    /// anchor makes exactness free: the flat 30-day month is visibly wrong at
    /// the short end — a monthly quota in February would divide 28 days by 30
    /// and its tick would stop at 93%, never reaching the end of a period that
    /// had already ended. It also matches the server, which advances this very
    /// anchor in calendar units in the user's timezone, and it keeps a
    /// daily/weekly period honest across a DST change. `periodLength` stays as
    /// the fallback for the case where the calendar cannot answer.
    static func periodEnd(rrule: String?, from start: Date) -> Date? {
        guard let period = periodComponents(rrule: rrule) else { return nil }
        if let end = Calendar.current.date(byAdding: period.unit, value: period.count, to: start) {
            return end
        }
        guard let length = periodLength(rrule: rrule), length > 0 else { return nil }
        return start.addingTimeInterval(length)
    }

    /// The period as calendar units — `.day × 7` for a week, so a `WEEKLY`
    /// rule never depends on where the locale puts the start of its week.
    static func periodComponents(rrule: String?) -> (unit: Calendar.Component, count: Int)? {
        guard let rule = parseFrequency(rrule) else { return nil }
        switch rule.freq {
        case "HOURLY": return (.hour, rule.interval)
        case "DAILY": return (.day, rule.interval)
        case "WEEKLY": return (.day, 7 * rule.interval)
        case "MONTHLY": return (.month, rule.interval)
        case "YEARLY": return (.year, rule.interval)
        default: return nil
        }
    }

    /// Period length implied by an rrule's `FREQ` and `INTERVAL`, as a flat
    /// interval — the fallback path of `periodEnd` and nothing else.
    ///
    /// Months and years are approximated here (30 / 365 days), which is why it
    /// is the fallback and not the measure.
    static func periodLength(rrule: String?) -> TimeInterval? {
        guard let rule = parseFrequency(rrule) else { return nil }
        let day: TimeInterval = 86_400
        switch rule.freq {
        case "HOURLY": return 3_600 * Double(rule.interval)
        case "DAILY": return day * Double(rule.interval)
        case "WEEKLY": return day * 7 * Double(rule.interval)
        case "MONTHLY": return day * 30 * Double(rule.interval)
        case "YEARLY": return day * 365 * Double(rule.interval)
        default: return nil
        }
    }

    /// `FREQ` and `INTERVAL` out of an rrule; everything else is ignored.
    private static func parseFrequency(_ rrule: String?) -> (freq: String, interval: Int)? {
        guard let rrule, !rrule.isEmpty else { return nil }

        // The server writes bare `FREQ=WEEKLY;BYDAY=MO` (see
        // `src/core/recurrence/rrule-builder.ts`); the `RRULE:` prefix is
        // stripped defensively in case a payload ever carries the iCal form.
        var freq: String?
        var interval = 1
        let body = rrule.uppercased().replacingOccurrences(of: "RRULE:", with: "")
        for part in body.split(separator: ";") {
            let pair = part.split(separator: "=", maxSplits: 1)
            guard pair.count == 2 else { continue }
            switch pair[0].trimmingCharacters(in: .whitespaces) {
            case "FREQ": freq = String(pair[1])
            case "INTERVAL": interval = max(Int(pair[1]) ?? 1, 1)
            default: break
            }
        }

        guard let freq else { return nil }
        return (freq, interval)
    }

    /// The quota the 2×2 shows: the user's chevron choice while that item still
    /// exists, otherwise the most behind-pace one.
    ///
    /// The choice is sticky — unlike the Reminders slot override (which expires
    /// when the clock moves on) a quota has no "wrong moment to be looking at
    /// it", so nothing here should second-guess an explicit tap. It resets only
    /// when the chosen item stops being tracked.
    static func selectedId(in items: [TrackItem]) -> Int {
        let stored = WidgetStore.trackSelection
        if stored != WidgetStore.noTrackSelection, items.contains(where: { $0.id == stored }) {
            return stored
        }
        // Live pace, deliberately not `items.first`: the list order is frozen
        // between membership changes (see `orderedItems`), but the 2×2 is a
        // single card with nothing to shuffle under a finger, so its default is
        // free to track pace exactly the way §8 defines it.
        return items.min(by: isMoreBehind)?.id ?? WidgetStore.noTrackSelection
    }

    /// The item the LIST families' window starts from: the user's chevron
    /// position while that item still exists, otherwise the FROZEN order's
    /// first item (2026-09-22, "Eggs moves to the top").
    ///
    /// NOT a twin of `selectedId(in:)` — the two have the same shape (a
    /// sticky pin over a fallback) but deliberately DIFFERENT fallbacks, for
    /// the same reason they're different values at all. `selectedId(in:)`
    /// falls back to live pace because its own comment says why: the 2×2 is
    /// "a single card with nothing to shuffle under a finger". A list window
    /// has plenty to shuffle — falling back to live pace here would mean a
    /// chevron-free user (only ever tapping `+1`, which never sets
    /// `trackPageStart`) gets a window that silently rotates on every
    /// unprompted 30-minute refresh as pace drifts, which is exactly the kind
    /// of unrequested movement this fix exists to remove. `items.first` is
    /// `orderedItems`' frozen position 0 — as stable as that order already
    /// is, re-anchoring only when membership genuinely changes.
    static func pageStartId(in items: [TrackItem]) -> Int {
        let stored = WidgetStore.trackPageStart
        if stored != WidgetStore.noTrackSelection, items.contains(where: { $0.id == stored }) {
            return stored
        }
        return items.first?.id ?? WidgetStore.noTrackSelection
    }
}

// MARK: - Quota periods, sections and clusters (`feat/quotas-widget`)

/// The four periods a quota can count within, plus the period-less bucket —
/// mirrors `QUOTA_PERIODS` (`src/lib/track.ts`), narrowed to just the FREQ →
/// heading mapping this widget needs (the web table also carries an editor
/// label, a suffix and a noun the widget has no use for).
enum QuotaPeriodKey: String {
    case daily, weekly, monthly, yearly, none

    /// Day → year, period-less last — the section list's fixed order
    /// (`QuotaSectionBuilder.sections`), matching `groupByPeriod`'s.
    static let order: [QuotaPeriodKey] = [.daily, .weekly, .monthly, .yearly, .none]

    var heading: String {
        switch self {
        case .daily: return "Today"
        case .weekly: return "This week"
        case .monthly: return "This month"
        case .yearly: return "This year"
        case .none: return "No period"
        }
    }

    /// The period a quota's rrule counts within — mirrors `quotaFreqOf`
    /// (`src/lib/track.ts`): only `FREQ` matters, `INTERVAL` is ignored (a
    /// biweekly quota still groups under "This week", the same period a
    /// weekly one does — §5's four sections don't distinguish the two).
    static func from(rrule: String?) -> QuotaPeriodKey {
        guard let rrule, !rrule.isEmpty else { return .none }
        let body = rrule.uppercased()
        for part in body.split(separator: ";") {
            let pair = part.split(separator: "=", maxSplits: 1)
            guard pair.count == 2, pair[0].trimmingCharacters(in: .whitespaces) == "FREQ" else { continue }
            switch pair[1] {
            case "DAILY": return .daily
            case "WEEKLY": return .weekly
            case "MONTHLY": return .monthly
            case "YEARLY": return .yearly
            default: return .none
            }
        }
        return .none
    }

    /// A fresh, explicitly-Monday-first calendar — never `Calendar.current`,
    /// whose `firstWeekday` follows the device locale and would silently
    /// disagree with `periodBounds`' week math on a locale that starts its
    /// week on Sunday. Matches Luxon's ISO week (`src/lib/track.ts`'s
    /// `periodBounds`, which the web panel's section math is built on), and
    /// `.current` for the time zone — the widget has no user-timezone field
    /// to read (see the handoff this file was built from for that gap, also
    /// accepted by `TrackTimeline.elapsedFraction` above already).
    private static var calendar: Calendar = {
        var cal = Calendar(identifier: .gregorian)
        cal.firstWeekday = 2
        cal.timeZone = .current
        return cal
    }()

    /// `[start, end)` of this period containing `now`, in calendar units — a
    /// real calendar interval (DST-safe, exact month/year lengths), never a
    /// flat multiple of 86,400. Nil for `.none`, which has no clock.
    func bounds(now: Date) -> (start: Date, end: Date)? {
        switch self {
        case .daily:
            let start = Self.calendar.startOfDay(for: now)
            guard let end = Self.calendar.date(byAdding: .day, value: 1, to: start) else { return nil }
            return (start, end)
        case .weekly:
            guard let interval = Self.calendar.dateInterval(of: .weekOfYear, for: now) else { return nil }
            return (interval.start, interval.end)
        case .monthly:
            guard let interval = Self.calendar.dateInterval(of: .month, for: now) else { return nil }
            return (interval.start, interval.end)
        case .yearly:
            guard let interval = Self.calendar.dateInterval(of: .year, for: now) else { return nil }
            return (interval.start, interval.end)
        case .none:
            return nil
        }
    }

    /// How much of this period has already run, 0...1 — a ratio of two REAL
    /// durations (DST-safe), mirroring `periodElapsedFraction` exactly.
    func elapsedFraction(now: Date) -> Double? {
        guard let (start, end) = bounds(now: now) else { return nil }
        let total = end.timeIntervalSince(start)
        guard total > 0 else { return nil }
        return min(max(now.timeIntervalSince(start) / total, 0), 1)
    }

    /// The section heading's muted clause — "N days left" for a week or
    /// longer, nil for a day and for `.none`. Mirrors `periodTimeLeftText`
    /// (`src/lib/track.ts`), which since PR #62 (Trent, 2026-09-24) returns
    /// null for DAILY: "Today · ends tonight" said the same thing twice. The
    /// heading row's bar flexes, so it takes the freed width. Measured from the start of TODAY to the
    /// period's end (both midnight-aligned in this calendar, so the day
    /// count is already exact — no rounding needed), so the number only
    /// changes at midnight rather than ticking down the instant `now`'s
    /// clock passes.
    func timeLeftText(now: Date) -> String? {
        switch self {
        case .daily, .none: return nil
        case .weekly, .monthly, .yearly:
            guard let (_, end) = bounds(now: now) else { return nil }
            let startOfToday = Self.calendar.startOfDay(for: now)
            let days = Self.calendar.dateComponents([.day], from: startOfToday, to: end).day ?? 0
            return "\(days) day\(days == 1 ? "" : "s") left"
        }
    }
}

/// One period's quotas, ready to draw — the day-to-year (then period-less)
/// grouping the panel's body is built from. Mirrors `TrackSection`
/// (`src/lib/track.ts`), minus the fields (`freq`, `key` as an enum, `tasks`)
/// only the web needs for its own follow-on calls; `barAriaLabel` has no
/// analog since WidgetKit views carry their own accessibility labels
/// per-control rather than one composed string.
struct QuotaSection: Identifiable {
    /// `QuotaPeriodKey.rawValue` — the section's DOM/list key.
    let id: String
    let heading: String
    /// "N days left" — nil for Today (PR #62) and the no-period section.
    let timeLeftText: String?
    /// 0...1, where the section bar's notch sits — nil for the no-period
    /// section (no clock, no notch).
    let elapsedFraction: Double?
    /// `sum(min(current,target)) / sum(target)` over EVERY quota in the
    /// period (unfiltered by `showMet` — matches the web's `trackSections`:
    /// the stats are corpus-wide, only the rendered CHIPS are filtered).
    let barFraction: Double
    /// Every quota in the section is met.
    let allMet: Bool
    /// Met vs. total over ALL quotas in the period, unfiltered by `showMet`.
    let summary: (met: Int, count: Int)
    /// Already `showMet`-filtered — a cluster with zero visible chips after
    /// filtering is OMITTED entirely (mirrors the web's `putAwayMet`), so a
    /// fully-met section with the toggle off legitimately has NO clusters at
    /// all (see `QuotaFlow.paginate`'s doc for what that means for a page
    /// break).
    let clusters: [QuotaCluster]
}

/// One label's quotas within one period section — the panel's inner grouping.
/// Mirrors `groupByLabel` (`src/lib/track.ts`) scoped to a single section, the
/// same "a label with both weekly and monthly quotas gets a cluster in EACH
/// section" rule the web panel documents on `trackStream`.
struct QuotaCluster: Identifiable {
    /// `"<sectionId>:<lowercased label key>"` (empty string key = unlabeled)
    /// — scoped to its section so "kids" under This week and "kids" under
    /// This month are never confused with one cluster.
    let id: String
    /// The label itself, nil for the unlabeled cluster — the grouping key,
    /// case-preserved in its first-seen spelling.
    let label: String?
    /// `label ?? "Other"` — mirrors the web panel's `NO_LABEL_NAME` (not the
    /// Quotas page's "Unlabelled"; see that constant's doc for why the two
    /// surfaces say it differently).
    var displayName: String { label ?? "Other" }
    /// Raw label color name (`WidgetTheme.projectColor`'s eight-name
    /// palette) or nil — green is EXCLUDED before this is set (green is
    /// "met"'s own color; see `trackStripeClass`'s doc), so a green-
    /// configured label renders neutral here, same as the web.
    let color: String?
    /// Met vs. total over EVERY quota in the cluster, unfiltered by
    /// `showMet` — what the cluster title's "✓N" and shut-state meter read.
    let metCount: Int
    let totalCount: Int
    /// The SHOWN chips only — met ones filtered per the toggle, with no
    /// grace for a just-met one (see `WidgetStore.quotasShowMet`), sorted by `title` (matching `trackedItems`' own sort key — display
    /// is `displayTitle`, the sort key is always the full title so a set
    /// short name never reorders a cluster out from under itself).
    let chips: [TrackItem]
}

/// Builds `QuotaSection`s from a flat quota corpus — the pure half of the
/// Quotas widget's business logic, ported from `src/lib/track.ts`'s
/// `trackSections`/`groupByPeriod`/`groupByLabel`/`quotaLabelOf` rather than
/// sharing code with them (that file is a Next.js client bundle; this is a
/// widget extension target, and neither can import the other).
enum QuotaSectionBuilder {

    /// `quotaLabelOf` (`src/lib/track.ts`): the first label that isn't
    /// machinery. Reserved labels are a case-SENSITIVE `ai-` prefix
    /// (`RESERVED_LABEL_PREFIX`, `src/lib/label-vocabulary.ts`) — created by
    /// enrichment/`createTask`, often without the user ever typing one, so
    /// taking `labels[0]` blindly would file a quota under "AI-FAILED".
    static func quotaLabelOf(_ task: TaskDTO) -> String? {
        task.labels.first { !$0.hasPrefix("ai-") }
    }

    /// Every period section with at least one quota in it, day → year then
    /// the period-less bucket — `QuotaPeriodKey.order`, `groupByPeriod`'s
    /// fixed table rather than a hand-rolled list, so a period can never be
    /// silently dropped from the grouping.
    static func sections(
        from quotas: [TaskDTO],
        labelConfig: [LabelConfigDTO],
        showMet: Bool,
        now: Date
    ) -> [QuotaSection] {
        var byPeriod: [QuotaPeriodKey: [TaskDTO]] = [:]
        for task in quotas {
            byPeriod[QuotaPeriodKey.from(rrule: task.rrule), default: []].append(task)
        }
        return QuotaPeriodKey.order.compactMap { key in
            guard let tasks = byPeriod[key], !tasks.isEmpty else { return nil }
            return section(
                key: key, tasks: tasks, labelConfig: labelConfig,
                showMet: showMet, now: now
            )
        }
    }

    private static func section(
        key: QuotaPeriodKey,
        tasks: [TaskDTO],
        labelConfig: [LabelConfigDTO],
        showMet: Bool,
        now: Date
    ) -> QuotaSection {
        let metCount = tasks.filter(\.isProgressMet).count
        let capped = tasks.reduce(0.0) { $0 + Double(min($1.progressCurrent, $1.progressTarget)) }
        let targetSum = tasks.reduce(0.0) { $0 + Double($1.progressTarget) }
        return QuotaSection(
            id: key.rawValue,
            heading: key.heading,
            timeLeftText: key.timeLeftText(now: now),
            elapsedFraction: key.elapsedFraction(now: now),
            barFraction: targetSum > 0 ? capped / targetSum : 0,
            allMet: !tasks.isEmpty && metCount == tasks.count,
            summary: (met: metCount, count: tasks.count),
            clusters: clusters(
                sectionId: key.rawValue, tasks: tasks, labelConfig: labelConfig,
                showMet: showMet
            )
        )
    }

    /// `groupByLabel`, scoped to one section: case-insensitive grouping,
    /// first-seen spelling displayed, unlabeled cluster last. A cluster
    /// whose every quota is filtered out (met, with the toggle off) is
    /// OMITTED — title and all — mirroring the
    /// web's `putAwayMet`.
    private static func clusters(
        sectionId: String,
        tasks: [TaskDTO],
        labelConfig: [LabelConfigDTO],
        showMet: Bool
    ) -> [QuotaCluster] {
        var order: [String] = []
        var display: [String: String] = [:]
        var byKey: [String: [TaskDTO]] = [:]
        var hasUnlabeled = false

        for task in tasks {
            let label = quotaLabelOf(task)
            let key = label?.lowercased() ?? ""
            if let label {
                if display[key] == nil {
                    display[key] = label
                    order.append(key)
                }
            } else {
                hasUnlabeled = true
            }
            byKey[key, default: []].append(task)
        }

        order.sort { (display[$0] ?? "").localizedCaseInsensitiveCompare(display[$1] ?? "") == .orderedAscending }
        var keys = order
        if hasUnlabeled { keys.append("") }

        return keys.compactMap { key in
            guard let clusterTasks = byKey[key] else { return nil }
            let label = key.isEmpty ? nil : display[key]
            let metCount = clusterTasks.filter(\.isProgressMet).count

            let sorted = clusterTasks.sorted { a, b in
                let cmp = a.title.localizedCaseInsensitiveCompare(b.title)
                return cmp == .orderedSame ? a.id < b.id : cmp == .orderedAscending
            }
            let visible = sorted.filter { task in
                showMet || !task.isProgressMet
            }
            guard !visible.isEmpty else { return nil }

            let configColor = label.flatMap { l in
                labelConfig.first { $0.name.localizedCaseInsensitiveCompare(l) == .orderedSame }?.color
            }
            // Green is "met"'s own color everywhere on this widget — a
            // green-configured label draws neutral instead, matching the
            // web's `trackStripeClass`.
            let color = configColor == "green" ? nil : configColor

            return QuotaCluster(
                id: "\(sectionId):\(key)",
                label: label,
                color: color,
                metCount: metCount,
                totalCount: clusterTasks.count,
                chips: visible.map { TrackItem(task: $0, elapsedFraction: nil) }
            )
        }
    }
}

// MARK: - Chip flow layout (`feat/quotas-widget`)

/// Fixed visual constants for the flowed chip layout — ONE set, shared by
/// BOTH the measurement that decides where a row wraps (`QuotaFlow.lines`)
/// and the actual chip rendering (`TrackWidgetViews.swift`'s `QuotaChip`),
/// so the two can never draw a different width than they measured.
///
/// Fonts here are FIXED point sizes, not Dynamic-Type-scaled `.caption2`-
/// style text styles: the packing algorithm needs a stable number to measure
/// against, and a size that grows with the reader's text setting would mean
/// yesterday's flow layout silently stops matching today's render. Tuned
/// against `widgets.html`'s `.qc` CSS (chip height 24, not 28 — verified
/// against the mockup PNG, not assumed) and against the actual Xcode preview
/// render — expect these to move as that render is reviewed.
enum QuotaMetrics {
    static let chipTitleSize: CGFloat = 12
    static let chipCountSize: CGFloat = 11

    static var chipTitleFont: Font { .system(size: chipTitleSize, weight: .regular) }
    static var chipCurrentFont: Font { .system(size: chipCountSize, weight: .semibold) }
    static var chipTargetFont: Font { .system(size: chipCountSize, weight: .regular) }

    static let chipHeight: CGFloat = 24
    static let chipCornerRadius: CGFloat = 9
    static let chipStripeWidth: CGFloat = 3
    /// Inside the stripe — the mockup's `.qc{padding:0 8px 0 10px}`.
    static let chipLeadingPadding: CGFloat = 10
    static let chipTrailingPadding: CGFloat = 8
    static let chipTitleCountGap: CGFloat = 5
    /// Horizontal gap BETWEEN chips on one row.
    static let chipRowGap: CGFloat = 6
    /// Vertical gap between chip rows.
    static let chipRowSpacing: CGFloat = 6

    static let headingRowHeight: CGFloat = 16
    static let clusterTitleRowHeight: CGFloat = 15
    /// The air `QuotaLinesView` puts above and below a cluster's title row —
    /// part of that line's height (`QuotaFlow.height(of:isFirstOnPage:)`),
    /// which counted only the 15pt row until 2026-09-24, so every cluster
    /// on a page drew 5pt more than it was budgeted.
    static let clusterTitleTopPadding: CGFloat = 3
    static let clusterTitleBottomPadding: CGFloat = 2
    /// The hairline between period sections, and its air — drawn before
    /// every heading except the first line on a page (`QuotaLinesView`).
    static let dividerHeight: CGFloat = 1
    static let dividerTopPadding: CGFloat = 4
    static let dividerBottomPadding: CGFloat = 3
    /// The divider and its air — what a heading costs beyond its own row
    /// when it ISN'T the first line on a page.
    static var sectionSpacing: CGFloat { dividerHeight + dividerTopPadding + dividerBottomPadding }

    /// A chip too long for a line of its own wraps its title to this many
    /// lines inside a card-wide chip, and is cut at the end of the last one
    /// only if that still isn't enough (2026-09-24 — see `QuotaChip`).
    static let wrappedTitleLines = 2

    /// A chip's height for a title of `lines` lines: `chipHeight` for one,
    /// plus one title line per extra line.
    static func chipHeight(lines: Int) -> CGFloat {
        chipHeight + CGFloat(max(lines - 1, 0)) * ceil(WidgetTheme.lineHeight(of: chipTitleMeasureFont))
    }

    #if os(iOS)
    private static func platformFont(size: CGFloat, weight: UIFont.Weight) -> UIFont {
        .systemFont(ofSize: size, weight: weight)
    }
    static var chipTitleMeasureFont: WidgetTheme.PlatformFont { platformFont(size: chipTitleSize, weight: .regular) }
    static var chipCurrentMeasureFont: WidgetTheme.PlatformFont { platformFont(size: chipCountSize, weight: .semibold) }
    static var chipTargetMeasureFont: WidgetTheme.PlatformFont { platformFont(size: chipCountSize, weight: .regular) }
    #else
    private static func platformFont(size: CGFloat, weight: NSFont.Weight) -> NSFont {
        .systemFont(ofSize: size, weight: weight)
    }
    static var chipTitleMeasureFont: WidgetTheme.PlatformFont { platformFont(size: chipTitleSize, weight: .regular) }
    static var chipCurrentMeasureFont: WidgetTheme.PlatformFont { platformFont(size: chipCountSize, weight: .semibold) }
    static var chipTargetMeasureFont: WidgetTheme.PlatformFont { platformFont(size: chipCountSize, weight: .regular) }
    #endif

    /// A chip's flowed width — leading padding + the title + the
    /// title↔count gap + the count (`"cur"` and `"/target"`, measured as two
    /// runs since they render at different weights) + trailing padding. The
    /// ONE call both `QuotaFlow.lines` and `QuotaChip` use — see this enum's
    /// own doc for why that sharing is the whole point.
    static func chipWidth(for item: TrackItem, takeback: Bool) -> CGFloat {
        let title = WidgetTheme.measuredWidth(for: item.task.displayTitle, font: chipTitleMeasureFont)
        let current = WidgetTheme.measuredWidth(for: "\(item.task.progressCurrent)", font: chipCurrentMeasureFont)
        let target = WidgetTheme.measuredWidth(for: "/\(item.task.progressTarget)", font: chipTargetMeasureFont)
        return chipLeadingPadding + title + chipTitleCountGap + current + target
            + (showsTakeBack(item, takeback: takeback) ? takeBackWidth : 0) + chipTrailingPadding
    }

    /// Whether a chip draws the trailing red "│ −1": in Takeback mode, and
    /// only on a chip with something to take back — a chip at 0 is dimmed
    /// and inert instead (`QuotaChip`). The ONE predicate both the width
    /// above and the chip's own drawing ask, so the two can't disagree.
    static func showsTakeBack(_ item: TrackItem, takeback: Bool) -> Bool {
        takeback && item.task.progressCurrent > 0
    }

    /// The trailing "│ −1" (Takeback mode, 2026-09-24 — it was PR #65's
    /// always-on met-chip affordance until Takeback mode absorbed it, so
    /// there is exactly one way to take one back). The same
    /// `chipTitleCountGap` either side of a hairline, then the label in the
    /// count's own semibold face.
    static let takeBackLabel = "\u{2212}1"
    static let takeBackDividerWidth: CGFloat = 1
    static var takeBackWidth: CGFloat {
        chipTitleCountGap + takeBackDividerWidth + chipTitleCountGap
            + WidgetTheme.measuredWidth(for: takeBackLabel, font: chipCurrentMeasureFont)
    }
}

/// A section's clusters flattened into flowed lines — the pure layout half
/// of the "pages break at whole chip rows, never cut a chip" guarantee.
/// Rendering (`TrackWidgetViews.swift`) only ever draws what this returns; it
/// never re-wraps or re-measures anything itself.
enum QuotaFlow {

    /// One row of the flowed body — a heading, a cluster's label line, or a
    /// complete row of that cluster's chips. Carries what it needs to draw
    /// itself (the whole `QuotaSection`/`QuotaCluster`, not just an id) so
    /// the view never has to look either back up by id.
    enum Line: Identifiable {
        case heading(QuotaSection)
        case clusterTitle(QuotaCluster)
        /// `color` is the owning cluster's — chips carry no color of their
        /// own (`TrackItem` is unchanged by this rebuild; see its doc).
        /// `wrapWidth` is non-nil for a row holding ONE chip too long for
        /// any line (2026-09-24): that chip is drawn exactly `wrapWidth`
        /// wide with a two-line title — see `QuotaChip`.
        case chipRow(id: String, color: String?, chips: [TrackItem], wrapWidth: CGFloat?)

        var id: String {
            switch self {
            case .heading(let section): return "h:\(section.id)"
            case .clusterTitle(let cluster): return "t:\(cluster.id)"
            case .chipRow(let id, _, _, _): return "r:\(id)"
            }
        }
    }

    /// Greedily packs every section's clusters into complete rows that fit
    /// `width` — mirrors CSS flex-wrap. A `.chipRow` this returns is ALWAYS
    /// a whole row by construction: nothing downstream ever re-wraps it, so
    /// a page break landing between two lines can never cut a chip.
    ///
    /// A chip wider than `width` on its own (2026-09-24 — Trent's quotas
    /// have no short names yet) gets a row to itself, marked with
    /// `wrapWidth` so it draws card-wide with its title on two lines,
    /// instead of running off the card's edge as it used to.
    ///
    /// `takeback` widens every chip that draws Takeback mode's "│ −1"
    /// (`QuotaMetrics.showsTakeBack`) — the row wrap has to measure the chip
    /// that will actually be drawn.
    static func lines(sections: [QuotaSection], width: CGFloat, takeback: Bool) -> [Line] {
        guard width > 0 else { return [] }
        var out: [Line] = []
        for section in sections {
            out.append(.heading(section))
            for cluster in section.clusters {
                out.append(.clusterTitle(cluster))
                var row: [TrackItem] = []
                var rowWidth: CGFloat = 0
                var rowIndex = 0
                func flush() {
                    guard !row.isEmpty else { return }
                    out.append(.chipRow(id: "\(cluster.id):\(rowIndex)", color: cluster.color, chips: row, wrapWidth: nil))
                    rowIndex += 1
                    row = []
                    rowWidth = 0
                }
                for chip in cluster.chips {
                    let chipWidth = QuotaMetrics.chipWidth(for: chip, takeback: takeback)
                    if chipWidth > width {
                        flush()
                        out.append(.chipRow(id: "\(cluster.id):\(rowIndex)", color: cluster.color, chips: [chip], wrapWidth: width))
                        rowIndex += 1
                        continue
                    }
                    let needed = row.isEmpty ? chipWidth : rowWidth + QuotaMetrics.chipRowGap + chipWidth
                    if !row.isEmpty, needed > width {
                        flush()
                        row = [chip]
                        rowWidth = chipWidth
                    } else {
                        row.append(chip)
                        rowWidth = needed
                    }
                }
                flush()
            }
        }
        return out
    }

    /// A line's exact drawn height — built from the SAME `QuotaMetrics`
    /// constants `QuotaLinesView` draws with, so a page break decided here
    /// is a page break that fits there. A heading costs its divider only
    /// when it isn't the page's first line (`QuotaLinesView` draws none
    /// there); a wrapped chip row costs a two-line chip.
    static func height(of line: Line, isFirstOnPage: Bool) -> CGFloat {
        switch line {
        case .heading:
            return QuotaMetrics.headingRowHeight + (isFirstOnPage ? 0 : QuotaMetrics.sectionSpacing)
        case .clusterTitle:
            return QuotaMetrics.clusterTitleTopPadding + QuotaMetrics.clusterTitleRowHeight
                + QuotaMetrics.clusterTitleBottomPadding
        case .chipRow(_, _, _, let wrapWidth):
            let lines = wrapWidth == nil ? 1 : QuotaMetrics.wrappedTitleLines
            return QuotaMetrics.chipHeight(lines: lines) + QuotaMetrics.chipRowSpacing
        }
    }

    /// Cuts `lines` into pages that fit `pageHeight` each — the row-wrap
    /// above, one dimension up. The one deliberate exception to "just
    /// accumulate until the next line overflows": a lone `.clusterTitle`
    /// stranded as the LAST line on a page (none of its own chip rows fit
    /// beneath it) moves to the top of the next page instead — a label with
    /// nothing under it reads as a bug. A `.heading` stranded the same way
    /// is left alone on purpose: a fully-met section legitimately renders
    /// heading-only (`QuotaSectionBuilder` omits a cluster — title and all —
    /// once every one of its chips is filtered away), so "heading, then a
    /// page break" is sometimes the true content, not a pagination artifact.
    ///
    /// Known, accepted simplification: a cluster's own chip rows may still
    /// split across a page boundary with no repeated heading/label on the
    /// continuation page, and a `.heading` CAN end up alone at a page's
    /// bottom with its clusters starting fresh, unlabeled, on the next page.
    static func paginate(lines: [Line], pageHeight: CGFloat) -> [[Line]] {
        guard !lines.isEmpty else { return [[]] }
        guard pageHeight > 0 else { return [lines] }

        var pages: [[Line]] = []
        var page: [Line] = []
        var used: CGFloat = 0

        for line in lines {
            let lineHeight = height(of: line, isFirstOnPage: page.isEmpty)
            if !page.isEmpty, used + lineHeight > pageHeight {
                if case .clusterTitle = page.last {
                    let strand = page.removeLast()
                    pages.append(page)
                    page = [strand, line]
                    used = height(of: strand, isFirstOnPage: true) + height(of: line, isFirstOnPage: false)
                } else {
                    pages.append(page)
                    page = [line]
                    used = height(of: line, isFirstOnPage: true)
                }
            } else {
                page.append(line)
                used += lineHeight
            }
        }
        if !page.isEmpty { pages.append(page) }
        return pages.isEmpty ? [[]] : pages
    }
}

// MARK: - Provider

struct TrackProvider: TimelineProvider {

    private static let refreshInterval: TimeInterval = 30 * 60

    func placeholder(in context: Context) -> TrackEntry {
        SampleData.trackEntry
    }

    func getSnapshot(in context: Context, completion: @escaping (TrackEntry) -> Void) {
        if context.isPreview {
            completion(SampleData.trackEntry)
            return
        }
        Task { completion(await currentEntry(family: context.family)) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TrackEntry>) -> Void) {
        Task {
            // A widget push token the server never confirmed — see
            // `WidgetPushRegistration` in WidgetPushHandler.swift.
            await WidgetPushRegistration.retryIfNeeded()
            // One entry, unlike the other two kinds: a quota has no moment in
            // the day that flips it. Pace drifts continuously and the period
            // boundary resets `progress_current` server-side, which no
            // pre-scheduled local entry could know about — so there is nothing
            // to pre-schedule and the 30-minute refresh carries it. The
            // "Undid: …" indication expiry (2026-09-23) is the one
            // exception: still a real moment this provider has to know about
            // ahead of the 30-minute refresh — see RemindersProvider's
            // identical block.
            let entry = await currentEntry(family: context.family)
            var entries = [entry]
            if !entry.isSignedOut, entry.actionDescription != nil,
                let expiry = WidgetStore.lastActionExpiry(), expiry > entry.date {
                entries.append(
                    TrackEntry(
                        date: expiry,
                        sections: entry.sections,
                        totalMet: entry.totalMet,
                        totalCount: entry.totalCount,
                        nextUnmet: entry.nextUnmet,
                        showMet: entry.showMet,
                        takebackMode: entry.takebackMode,
                        page: entry.page,
                        staleSince: entry.staleSince,
                        isSignedOut: false,
                        canUndo: entry.canUndo,
                        canRedo: entry.canRedo,
                        actionDescription: nil
                    )
                )
            }
            let next = Date().addingTimeInterval(Self.refreshInterval)
            completion(Timeline(entries: entries, policy: .after(next)))
        }
    }

    /// Shares `TaskFeed` with the Tasks widget — same endpoint, same cache,
    /// same §8 optimistic staging, different slice. `TaskFeed` also
    /// piggybacks the undo/redo counts fetch (2026-09-23) — see its doc.
    ///
    /// Takeback mode's auto-clear lives here (2026-09-24 — see
    /// `WidgetStore.quotasTakebackMode`): a build that is NOT riding a tap
    /// from seconds ago is a scheduled refresh, a push after a change
    /// somewhere else, or the app foregrounding — and a mode armed against
    /// counts that may no longer be the counts on screen invites an
    /// accidental `−1`. A build riding this widget's own taps keeps it —
    /// including every `−1` (the mode no longer exits after one, 2026-09-24)
    /// and the server's widget push right after, both inside the window
    /// `IncrementProgressIntent`'s `markInteraction()` opens. Read once,
    /// against the same `now` `TaskFeed.snapshot` gets, so the two can't
    /// straddle the window's edge differently.
    private func currentEntry(family: WidgetFamily) async -> TrackEntry {
        let now = Date()
        let showMet = WidgetStore.quotasShowMet
        if WidgetStore.quotasTakebackMode, !WidgetStore.hasRecentInteraction(now: now) {
            WidgetStore.quotasTakebackMode = false
        }
        let takeback = family == .systemLarge && WidgetStore.quotasTakebackMode

        // Concurrent with the tasks/projects fetch below — a quota-only
        // fetch this file OWNS (see `fetchLabelConfig`'s doc for why it
        // isn't folded into `TaskFeed.Snapshot`, which Tasks shares and has
        // no use for label colors).
        async let snapshotTask = TaskFeed.snapshot(now: now)
        async let labelConfigTask = fetchLabelConfig()
        let snapshot = await snapshotTask

        guard !snapshot.isSignedOut else {
            _ = await labelConfigTask
            return TrackEntry(
                date: now, sections: [], totalMet: 0, totalCount: 0, nextUnmet: nil,
                showMet: showMet, takebackMode: false, page: WidgetStore.quotasPage,
                staleSince: nil, isSignedOut: true, canUndo: false, canRedo: false,
                actionDescription: nil
            )
        }

        let quotas = snapshot.tasks.filter(\.isTracked)
        let labelConfig = await labelConfigTask

        // Takeback mode shows met chips too (so they can be taken back),
        // without flipping the dot's own state — see `TrackEntry.takebackMode`.
        let sections = QuotaSectionBuilder.sections(
            from: quotas, labelConfig: labelConfig, showMet: showMet || takeback, now: now
        )
        // Valid regardless of `showMet`: an unmet quota is NEVER filtered by
        // that toggle (only a met one ever is), so this flatten always
        // contains every unmet quota, in section/cluster/title order.
        let nextUnmet = sections
            .flatMap(\.clusters)
            .flatMap(\.chips)
            .first { !$0.isMet }

        return TrackEntry(
            date: now,
            sections: sections,
            totalMet: quotas.filter(\.isProgressMet).count,
            totalCount: quotas.count,
            nextUnmet: nextUnmet,
            showMet: showMet,
            takebackMode: takeback,
            page: WidgetStore.quotasPage,
            staleSince: snapshot.staleSince,
            isSignedOut: false,
            canUndo: WidgetStore.canUndo,
            canRedo: WidgetStore.canRedo,
            actionDescription: WidgetStore.lastActionDescription(at: now)
        )
    }

    /// The cluster color source (`GET /api/user/preferences` → `label_config`),
    /// fetched with the SAME discipline as every other payload this file
    /// draws: skip the network on a fresh interaction (chevron/toggle —
    /// `WidgetStore.hasRecentInteraction`), `try?` so a flaky call never
    /// fails the whole timeline build, and fall back to the cache on
    /// failure — never blank every cluster to neutral just because one
    /// fetch hiccuped.
    private func fetchLabelConfig() async -> [LabelConfigDTO] {
        if WidgetStore.hasRecentInteraction(), let cached = WidgetStore.loadQuotaLabelConfig() {
            return cached.value
        }
        if let config = try? await APIClient.shared.fetchLabelConfig() {
            WidgetStore.saveQuotaLabelConfig(config)
            return config
        }
        return WidgetStore.loadQuotaLabelConfig()?.value ?? []
    }
}

// MARK: - Widget

struct TrackWidget: Widget {
    /// Kept EXACTLY as before (`feat/quotas-widget`) — renaming it would
    /// drop every Home Screen instance a user already placed. Only the
    /// display name/description below change.
    static let kind = "OpenTaskTrack"

    var body: some WidgetConfiguration {
        // Server-pushed reloads (iOS 26 / macOS 26 — see WidgetPushHandler.swift
        // and docs/NOTIFICATIONS.md § WidgetKit push) need `.pushHandler(...)`,
        // gated here rather than raising this extension's deployment target
        // (iOS 17 / macOS 14). See the doc comment in TasksWidget.swift for why
        // this needs an EXPLICIT `return` in each branch (implicit return, or
        // an `if` that isn't the body's sole statement, both fail to compile —
        // `Widget.body` has no result builder to reconcile the two branches'
        // different concrete types).
        if #available(iOS 26.0, macOS 26.0, *) {
            return StaticConfiguration(kind: Self.kind, provider: TrackProvider()) { entry in
                TrackWidgetView(entry: entry)
            }
            .configurationDisplayName("Quotas")
            .description("Your quotas, grouped by period — tap a chip to log one.")
            // systemSmall FIRST here, alone among the three kinds: §8 calls the 2×2
            // the flagship Track layout — a quota compresses to a ring and a
            // fraction perfectly, which a list of them does not. (Observed on iOS
            // 26 the gallery orders its cards small→large regardless of this array,
            // so the ordering is a statement of intent, not a lever.)
            // See RemindersWidget for why this is a closure rather than #if inside
            // the array literal (the compiler rejects the latter).
            .supportedFamilies({
                var families: [WidgetFamily] = [.systemSmall, .systemLarge, .systemMedium]
                #if os(iOS)
                families += [.accessoryRectangular, .accessoryCircular]
                #endif
                return families
            }())
            .pushHandler(OpenTaskWidgetPushHandler.self)
        } else {
            return StaticConfiguration(kind: Self.kind, provider: TrackProvider()) { entry in
                TrackWidgetView(entry: entry)
            }
            .configurationDisplayName("Quotas")
            .description("Your quotas, grouped by period — tap a chip to log one.")
            .supportedFamilies({
                var families: [WidgetFamily] = [.systemSmall, .systemLarge, .systemMedium]
                #if os(iOS)
                families += [.accessoryRectangular, .accessoryCircular]
                #endif
                return families
            }())
        }
    }
}

// MARK: - Previews

#if DEBUG
/// Trent's REAL quotas, read-only from production on 2026-09-24 when he
/// screenshotted the Quotas widget ("2 of 24 met"): every open quota
/// (`is_tracked` or `progress_target > 1`), titles VERBATIM — none has a
/// `short_title` yet, which is exactly what made the long ones run off the
/// card — with his real labels and label colors. See
/// `RemindersWidget.swift`'s preview header for why this lives here and not
/// in `SampleData.swift` (which stays generic: it backs the real gallery).
private enum QuotasPreviewData {
    static var quotas: [TaskDTO] {
        [
            TaskDTO(id: 83, projectId: 4434, title: "Daily Walks", priority: 0, rrule: "FREQ=DAILY", progressTarget: 2, progressCurrent: 1, trackedFlag: true, labels: ["health"]),
            TaskDTO(id: 111, projectId: 4434, title: "Clean bedroom fans", priority: 0, rrule: "FREQ=MONTHLY", progressTarget: 1, progressCurrent: 0, trackedFlag: true, labels: ["house"]),
            TaskDTO(id: 152, projectId: 4434, title: "Charge jump starter", priority: 0, rrule: "FREQ=MONTHLY", progressTarget: 1, progressCurrent: 0, trackedFlag: true, labels: ["house", "finance"]),
            TaskDTO(id: 276, projectId: 4434, title: "Clean the car seats", priority: 0, rrule: "FREQ=MONTHLY", progressTarget: 1, progressCurrent: 0, trackedFlag: true, labels: ["kids", "house"]),
            TaskDTO(id: 295, projectId: 4434, title: "Reset the router (power everything off for 10 sec)", priority: 0, rrule: "FREQ=MONTHLY", progressTarget: 1, progressCurrent: 0, trackedFlag: true, labels: ["house"]),
            TaskDTO(id: 309, projectId: 4434, title: "Clean earbuds + phone speakers", priority: 0, rrule: "FREQ=MONTHLY", progressTarget: 1, progressCurrent: 0, trackedFlag: true, labels: ["house"]),
            TaskDTO(id: 27, projectId: 4434, title: "Music Practice", priority: 0, rrule: "FREQ=WEEKLY", progressTarget: 1, progressCurrent: 1, trackedFlag: true, labels: ["kids"]),
            TaskDTO(id: 103, projectId: 4434, title: "Say something kind to someone every day", priority: 0, rrule: "FREQ=WEEKLY", progressTarget: 2, progressCurrent: 0, trackedFlag: true, labels: ["kids", "relationships"]),
            TaskDTO(id: 114, projectId: 4434, title: "Evening Shower", priority: 0, rrule: "FREQ=WEEKLY", progressTarget: 2, progressCurrent: 1, trackedFlag: true, labels: ["kids"]),
            TaskDTO(id: 116, projectId: 1, title: "Green Vegetables", priority: 0, rrule: "FREQ=WEEKLY", progressTarget: 3, progressCurrent: 1, trackedFlag: false, labels: []),
            TaskDTO(id: 129, projectId: 1, title: "High-Fiber Food (e.g. Bran, Oats)", priority: 0, rrule: "FREQ=WEEKLY", progressTarget: 3, progressCurrent: 0, trackedFlag: false, labels: []),
            TaskDTO(id: 132, projectId: 4434, title: "Daily Supplements (Vit. D, maybe Omega-3, etc.)", priority: 0, rrule: "FREQ=WEEKLY", progressTarget: 3, progressCurrent: 0, trackedFlag: true, labels: ["health", "kids"]),
            TaskDTO(id: 160, projectId: 1, title: "Trail mix bites", priority: 0, rrule: "FREQ=WEEKLY", progressTarget: 2, progressCurrent: 0, trackedFlag: false, labels: []),
            TaskDTO(id: 163, projectId: 4434, title: "Balloon breathing practice (slow exhale, relaxed shoulders, breathe into the upper back, seated)", priority: 0, rrule: "FREQ=WEEKLY", progressTarget: 4, progressCurrent: 0, trackedFlag: true, labels: ["health", "kids"]),
            TaskDTO(id: 192, projectId: 4434, title: "Empty the dishwasher (chore)", priority: 0, rrule: "FREQ=WEEKLY", progressTarget: 5, progressCurrent: 0, trackedFlag: true, labels: ["kids", "house"]),
            TaskDTO(id: 193, projectId: 1, title: "Protein Breakfast", priority: 0, rrule: "FREQ=WEEKLY", progressTarget: 2, progressCurrent: 0, trackedFlag: false, labels: []),
            TaskDTO(id: 221, projectId: 4434, title: "Weight Lift", priority: 0, rrule: "FREQ=WEEKLY", progressTarget: 3, progressCurrent: 0, trackedFlag: true, labels: ["health"]),
            TaskDTO(id: 255, projectId: 4434, title: "Cook daily vegetables (incl. black beans)", priority: 0, rrule: "FREQ=WEEKLY", progressTarget: 5, progressCurrent: 3, trackedFlag: true, labels: ["health"]),
            TaskDTO(id: 605, projectId: 4434, title: "Play a card game after dinner", priority: 2, rrule: "FREQ=WEEKLY", progressTarget: 1, progressCurrent: 0, trackedFlag: true, labels: ["kids", "media"]),
            TaskDTO(id: 3307, projectId: 6, title: "Check for new certifications — vendor academies, platform certs, automation credentials", priority: 2, rrule: "FREQ=WEEKLY", progressTarget: 1, progressCurrent: 0, trackedFlag: true, labels: ["ideas"]),
            TaskDTO(id: 21771, projectId: 1, title: "Play Catch in the Backyard", priority: 0, rrule: "FREQ=WEEKLY", progressTarget: 1, progressCurrent: 0, trackedFlag: true, labels: []),
            TaskDTO(id: 21829, projectId: 1, title: "Iron-Rich Meal (e.g. lentils, spinach)", priority: 0, rrule: "FREQ=WEEKLY", progressTarget: 2, progressCurrent: 2, trackedFlag: true, labels: []),
            TaskDTO(id: 23532, projectId: 1, title: "Review book highlights", priority: 0, rrule: "FREQ=WEEKLY", progressTarget: 1, progressCurrent: 0, trackedFlag: true, labels: ["hub"]),
            TaskDTO(id: 23534, projectId: 1, title: "Run the weekly maintenance checklist in a fresh chat", priority: 0, rrule: "FREQ=WEEKLY", progressTarget: 1, progressCurrent: 0, trackedFlag: true, labels: ["hub", "ai-added"]),
        ].filter(\.isTracked)
    }

    static var labelConfig: [LabelConfigDTO] {
        [
            LabelConfigDTO(name: "health", color: "blue"),
            LabelConfigDTO(name: "house", color: "orange"),
            LabelConfigDTO(name: "kids", color: "purple"),
            LabelConfigDTO(name: "ideas", color: "pink"),
        ]
    }
}

/// A real-data entry with `showMet`/`page` varied. This view is pure over
/// its entry (`QuotasListView`'s doc), so one preview's timeline can step
/// through every page and both toggle states.
///
/// `justMet` (2026-09-24) is the state right after the tap that met that
/// quota: its count at its target — what `TaskFeed`'s staged `+1` draws on
/// the tap's own repaint — so the met-off render shows it GONE (no grace
/// window any more) and the met-on render shows it green (a plain `+1`
/// chip, like the web — Takeback mode is the only `−1`).
///
/// `takeback` builds the entry the way the provider does in Takeback mode
/// (met chips shown whatever `showMet` says — `TrackEntry.takebackMode`);
/// `takenBack` is the state right after ONE takeback on that quota: its
/// count one lower (pass `takeback: true` too — the mode stays on across
/// `−1`s since 2026-09-24).
private func previewEntry(
    showMet: Bool, page: Int, justMet: Int? = nil, takeback: Bool = false, takenBack: Int? = nil
) -> TrackEntry {
    let now = Date()
    let quotas = QuotasPreviewData.quotas.map { task -> TaskDTO in
        let current: Int
        if task.id == justMet {
            current = task.progressTarget
        } else if task.id == takenBack {
            current = max(task.progressCurrent - 1, 0)
        } else {
            return task
        }
        return TaskDTO(
            id: task.id, projectId: task.projectId, title: task.title, priority: task.priority,
            dueAt: task.dueAt, rrule: task.rrule, progressTarget: task.progressTarget,
            progressCurrent: current, trackedFlag: task.trackedFlag, labels: task.labels
        )
    }
    let sections = QuotaSectionBuilder.sections(
        from: quotas, labelConfig: QuotasPreviewData.labelConfig,
        showMet: showMet || takeback, now: now
    )
    let nextUnmet = sections.flatMap(\.clusters).flatMap(\.chips).first { !$0.isMet }
    return TrackEntry(
        date: now,
        sections: sections,
        totalMet: quotas.filter(\.isProgressMet).count,
        totalCount: quotas.count,
        nextUnmet: nextUnmet,
        showMet: showMet,
        takebackMode: takeback,
        page: page,
        staleSince: nil,
        isSignedOut: false,
        canUndo: true,
        canRedo: false,
        actionDescription: nil
    )
}

/// Timeline indexes 0-4: met hidden, pages 1-5; 5-9: met shown, pages 1-5.
/// Pages past the end clamp to the last one.
#Preview("Quotas — Large", as: .systemLarge) {
    TrackWidget()
} timeline: {
    previewEntry(showMet: false, page: 0)
    previewEntry(showMet: false, page: 1)
    previewEntry(showMet: false, page: 2)
    previewEntry(showMet: false, page: 3)
    previewEntry(showMet: false, page: 4)
    previewEntry(showMet: true, page: 0)
    previewEntry(showMet: true, page: 1)
    previewEntry(showMet: true, page: 2)
    previewEntry(showMet: true, page: 3)
    previewEntry(showMet: true, page: 4)
}

/// Right after "Weight Lift" (id 221, 0/3 in the snapshot) is tapped to its
/// target. Indexes 0-2: met dot OFF, pages 1-3 — Weight Lift is gone, and
/// so is "Music Practice" (1/1, already met). Indexes 3-5: met dot ON, pages
/// 1-3 — both show green, plain `+1` chips (Weight Lift sorts last in THIS
/// WEEK's HEALTH cluster, so it lands on page 2).
#Preview("Quotas — Large, just met", as: .systemLarge) {
    TrackWidget()
} timeline: {
    previewEntry(showMet: false, page: 0, justMet: 221)
    previewEntry(showMet: false, page: 1, justMet: 221)
    previewEntry(showMet: false, page: 2, justMet: 221)
    previewEntry(showMet: true, page: 0, justMet: 221)
    previewEntry(showMet: true, page: 1, justMet: 221)
    previewEntry(showMet: true, page: 2, justMet: 221)
}

/// Takeback mode (2026-09-24), met dot OFF throughout. Indexes 0-3: mode
/// ON, pages 1-4 — every chip with progress carries a red "−1", chips at 0
/// are dimmed, and the met chips ("Music Practice" 1/1, "Iron-Rich Meal"
/// 2/2) are back even though the dot is off. Index 4-5: right after ONE
/// takeback on Music Practice — the mode STILL ON (2026-09-24; it used to
/// exit here), Kazoo at 0/1 and so dimmed/inert, pages 1 and 3 (Kazoo
/// lands on page 3 at XXX Large, page 2 at the default text size).
#Preview("Quotas — Large, takeback", as: .systemLarge) {
    TrackWidget()
} timeline: {
    previewEntry(showMet: false, page: 0, takeback: true)
    previewEntry(showMet: false, page: 1, takeback: true)
    previewEntry(showMet: false, page: 2, takeback: true)
    previewEntry(showMet: false, page: 3, takeback: true)
    previewEntry(showMet: false, page: 0, takeback: true, takenBack: 27)
    previewEntry(showMet: false, page: 2, takeback: true, takenBack: 27)
}

/// The stale-count fix (2026-09-24), drawn THROUGH THE REAL STORE rather
/// than a hand-built entry: the App Group cache is seeded with the snapshot
/// (Weight Lift, id 221, at 3/3 — where Trent started his 11:53 taps), and
/// every entry is built from `WidgetStore.loadTasks()` +
/// `applyPendingProgress`, exactly what `TaskFeed`'s fast path draws.
/// Takeback mode is armed once and never re-armed.
private func storeEntry(page: Int) -> TrackEntry {
    let now = Date()
    let cached = WidgetStore.loadTasks()?.value.tasks ?? []
    let quotas = WidgetStore.applyPendingProgress(cached, now: now).filter(\.isTracked)
    let takeback = WidgetStore.quotasTakebackMode
    let sections = QuotaSectionBuilder.sections(
        from: quotas, labelConfig: QuotasPreviewData.labelConfig, showMet: takeback, now: now
    )
    return TrackEntry(
        date: now, sections: sections, totalMet: quotas.filter(\.isProgressMet).count,
        totalCount: quotas.count, nextUnmet: sections.flatMap(\.clusters).flatMap(\.chips).first { !$0.isMet },
        showMet: false, takebackMode: takeback, page: page, staleSince: nil, isSignedOut: false,
        canUndo: true, canRedo: false, actionDescription: nil
    )
}

/// One takeback `−1` on Weight Lift, the way `IncrementProgressIntent`
/// runs it, with the server's answer written back (`confirmProgress`).
private func previewTakeback(from current: Int) {
    WidgetStore.markInteraction()
    WidgetStore.stagePendingProgress(221, delta: -1)
    let serverTask = TaskDTO(
        id: 221, projectId: 4434, title: "Weight Lift", rrule: "FREQ=WEEKLY", progressTarget: 3,
        progressCurrent: current - 1, trackedFlag: true, labels: ["health"]
    )
    WidgetStore.confirmProgress(serverTask, delta: -1)
}

private func seedQuotasStore() {
    let seeded = QuotasPreviewData.quotas.map { task -> TaskDTO in
        guard task.id == 221 else { return task }
        return TaskDTO(
            id: 221, projectId: 4434, title: "Weight Lift", rrule: "FREQ=WEEKLY", progressTarget: 3,
            progressCurrent: 3, trackedFlag: true, labels: ["health"]
        )
    }
    WidgetStore.clearAllPendingState()
    WidgetStore.saveTasks(seeded, projects: [], completions: [])
    WidgetStore.setQuotasTakebackMode(true)  // ToggleQuotasTakebackModeIntent
    WidgetStore.markInteraction()
}

/// Indexes 0-2: pages 1-3 before any tap (Weight Lift 3/3, mode on).
/// Indexes 3-5: pages 1-3 after TWO takebacks — Weight Lift 1/3 from the
/// confirmed cache, the mode still on (no re-arm between the taps).
#Preview("Quotas — Large, after takeback taps (store path)", as: .systemLarge) {
    TrackWidget()
} timeline: {
    let _ = seedQuotasStore()
    storeEntry(page: 0)
    storeEntry(page: 1)
    storeEntry(page: 2)
    let _ = previewTakeback(from: 3)
    let _ = previewTakeback(from: 2)
    storeEntry(page: 0)
    storeEntry(page: 1)
    storeEntry(page: 2)
}

#Preview("Quotas — Medium", as: .systemMedium) {
    TrackWidget()
} timeline: {
    previewEntry(showMet: false, page: 0)
}

#Preview("Quotas — Small", as: .systemSmall) {
    TrackWidget()
} timeline: {
    previewEntry(showMet: false, page: 0)
}
#endif
