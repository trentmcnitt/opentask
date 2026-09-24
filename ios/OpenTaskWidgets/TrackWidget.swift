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
    /// The eye toggle's current state, carried on the entry rather than read
    /// live from `WidgetStore` inside the view — see `TrackWidgetViews.swift`
    /// for why every view in that file is pure over this entry.
    let showMet: Bool
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

    /// The section heading's muted clause — "ends tonight" for a day, "N
    /// days left" for anything longer, nil for `.none`. Mirrors
    /// `periodTimeLeftText`: measured from the start of TODAY to the
    /// period's end (both midnight-aligned in this calendar, so the day
    /// count is already exact — no rounding needed), so the number only
    /// changes at midnight rather than ticking down the instant `now`'s
    /// clock passes.
    func timeLeftText(now: Date) -> String? {
        switch self {
        case .daily: return "ends tonight"
        case .none: return nil
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
    /// "ends tonight" / "N days left" — nil for the no-period section.
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
    /// The SHOWN chips only — met ones filtered per the toggle (and the
    /// mutation-grace exemption, see `WidgetStore.quotaMutationIsRecent`),
    /// sorted by `title` (matching `trackedItems`' own sort key — display
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
        mutationIsRecent: Bool,
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
                showMet: showMet, mutationIsRecent: mutationIsRecent, now: now
            )
        }
    }

    private static func section(
        key: QuotaPeriodKey,
        tasks: [TaskDTO],
        labelConfig: [LabelConfigDTO],
        showMet: Bool,
        mutationIsRecent: Bool,
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
                showMet: showMet, mutationIsRecent: mutationIsRecent
            )
        )
    }

    /// `groupByLabel`, scoped to one section: case-insensitive grouping,
    /// first-seen spelling displayed, unlabeled cluster last. A cluster
    /// whose every quota is filtered out (met, with the toggle off and no
    /// recent mutation grace) is OMITTED — title and all — mirroring the
    /// web's `putAwayMet`.
    private static func clusters(
        sectionId: String,
        tasks: [TaskDTO],
        labelConfig: [LabelConfigDTO],
        showMet: Bool,
        mutationIsRecent: Bool
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
                showMet || !task.isProgressMet || mutationIsRecent
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
    /// Extra vertical space (with a hairline divider) before a section's
    /// heading, when it isn't the first section on the page.
    static let sectionSpacing: CGFloat = 8

    /// The header block's approximate rendered height, used ONLY to budget
    /// the body's available height before layout actually happens (see
    /// `QuotasListView`'s doc for why this is a deliberate, documented
    /// approximation rather than a measured value). Large gets the full
    /// title+subtitle+icon-row stack; medium has no top padding and a
    /// tighter stack.
    static func headerHeight(isLarge: Bool) -> CGFloat { isLarge ? 40 : 30 }

    /// The bottom `ListPager`'s approximate rendered height (large only —
    /// medium never shows one).
    static let pagerHeight: CGFloat = 22

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
    static func chipWidth(for item: TrackItem) -> CGFloat {
        let title = WidgetTheme.measuredWidth(for: item.task.displayTitle, font: chipTitleMeasureFont)
        let current = WidgetTheme.measuredWidth(for: "\(item.task.progressCurrent)", font: chipCurrentMeasureFont)
        let target = WidgetTheme.measuredWidth(for: "/\(item.task.progressTarget)", font: chipTargetMeasureFont)
        return chipLeadingPadding + title + chipTitleCountGap + current + target + chipTrailingPadding
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
        case chipRow(id: String, color: String?, chips: [TrackItem])

        var id: String {
            switch self {
            case .heading(let section): return "h:\(section.id)"
            case .clusterTitle(let cluster): return "t:\(cluster.id)"
            case .chipRow(let id, _, _): return "r:\(id)"
            }
        }
    }

    /// Greedily packs every section's clusters into complete rows that fit
    /// `width` — mirrors CSS flex-wrap. A `.chipRow` this returns is ALWAYS
    /// a whole row by construction: nothing downstream ever re-wraps it, so
    /// a page break landing between two lines can never cut a chip.
    static func lines(sections: [QuotaSection], width: CGFloat) -> [Line] {
        guard width > 0 else { return [] }
        var out: [Line] = []
        for section in sections {
            out.append(.heading(section))
            for cluster in section.clusters {
                out.append(.clusterTitle(cluster))
                var row: [TrackItem] = []
                var rowWidth: CGFloat = 0
                var rowIndex = 0
                for chip in cluster.chips {
                    let chipWidth = QuotaMetrics.chipWidth(for: chip)
                    let needed = row.isEmpty ? chipWidth : rowWidth + QuotaMetrics.chipRowGap + chipWidth
                    if !row.isEmpty, needed > width {
                        out.append(.chipRow(id: "\(cluster.id):\(rowIndex)", color: cluster.color, chips: row))
                        rowIndex += 1
                        row = [chip]
                        rowWidth = chipWidth
                    } else {
                        row.append(chip)
                        rowWidth = needed
                    }
                }
                if !row.isEmpty {
                    out.append(.chipRow(id: "\(cluster.id):\(rowIndex)", color: cluster.color, chips: row))
                }
            }
        }
        return out
    }

    /// This flow's fixed per-line height — the ceiling every page-break
    /// decision below is made against.
    static func height(of line: Line) -> CGFloat {
        switch line {
        case .heading: return QuotaMetrics.headingRowHeight + QuotaMetrics.sectionSpacing
        case .clusterTitle: return QuotaMetrics.clusterTitleRowHeight
        case .chipRow: return QuotaMetrics.chipHeight + QuotaMetrics.chipRowSpacing
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
    /// Known, accepted simplification (time/scope budget): a cluster's own
    /// chip rows may still split across a page boundary with no repeated
    /// heading/label on the continuation page, and a `.heading` CAN end up
    /// alone at a page's bottom with its clusters starting fresh,
    /// unlabeled, on the next page — the same accepted gap, one level up.
    /// Both would need the break to look further ahead than "does the next
    /// line fit", which a quota corpus large enough to hit this is rare
    /// enough not to justify here.
    static func paginate(lines: [Line], pageHeight: CGFloat) -> [[Line]] {
        guard !lines.isEmpty else { return [[]] }
        guard pageHeight > 0 else { return [lines] }

        var pages: [[Line]] = []
        var page: [Line] = []
        var used: CGFloat = 0

        for line in lines {
            let lineHeight = height(of: line)
            if !page.isEmpty, used + lineHeight > pageHeight {
                if case .clusterTitle = page.last {
                    let strand = page.removeLast()
                    pages.append(page)
                    page = [strand, line]
                    used = height(of: strand) + lineHeight
                } else {
                    pages.append(page)
                    page = [line]
                    used = lineHeight
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
        Task { completion(await currentEntry()) }
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
            let entry = await currentEntry()
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
    private func currentEntry() async -> TrackEntry {
        let now = Date()
        let showMet = WidgetStore.quotasShowMet
        let mutationIsRecent = WidgetStore.quotaMutationIsRecent(now: now)

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
                showMet: showMet, page: WidgetStore.quotasPage,
                staleSince: nil, isSignedOut: true, canUndo: false, canRedo: false,
                actionDescription: nil
            )
        }

        let quotas = snapshot.tasks.filter(\.isTracked)
        let labelConfig = await labelConfigTask

        let sections = QuotaSectionBuilder.sections(
            from: quotas, labelConfig: labelConfig, showMet: showMet,
            mutationIsRecent: mutationIsRecent, now: now
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

/// A `SampleData.trackEntry`-shaped entry with `showMet`/`page` varied — the
/// gallery/placeholder entry is always `showMet: false, page: 0` (see
/// `SampleData.trackEntry`'s own doc for why those two knobs live only
/// here), so a render review of the toggle-on and second-page states builds
/// its own entries from the same underlying corpus instead.
private func previewEntry(showMet: Bool, page: Int) -> TrackEntry {
    let now = Date()
    let quotas = SampleData.trackedQuotas
    let sections = QuotaSectionBuilder.sections(
        from: quotas, labelConfig: SampleData.trackLabelConfig,
        showMet: showMet, mutationIsRecent: false, now: now
    )
    let nextUnmet = sections.flatMap(\.clusters).flatMap(\.chips).first { !$0.isMet }
    return TrackEntry(
        date: now,
        sections: sections,
        totalMet: quotas.filter(\.isProgressMet).count,
        totalCount: quotas.count,
        nextUnmet: nextUnmet,
        showMet: showMet,
        page: page,
        staleSince: nil,
        isSignedOut: false,
        canUndo: true,
        canRedo: false,
        actionDescription: nil
    )
}

#Preview("Quotas — Large", as: .systemLarge) {
    TrackWidget()
} timeline: {
    previewEntry(showMet: false, page: 0)
    previewEntry(showMet: false, page: 1)
    previewEntry(showMet: true, page: 0)
}

#Preview("Quotas — Medium", as: .systemMedium) {
    TrackWidget()
} timeline: {
    previewEntry(showMet: false, page: 0)
    previewEntry(showMet: true, page: 0)
}

#Preview("Quotas — Small", as: .systemSmall) {
    TrackWidget()
} timeline: {
    previewEntry(showMet: false, page: 0)
}
