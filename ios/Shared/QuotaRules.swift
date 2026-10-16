import Foundation

// The quota rules every native surface shares — the phone/Mac Quotas widget
// (`QuotaSectionBuilder`, ios/OpenTaskWidgets/TrackWidget.swift) and the
// watch's Quotas page (`WatchQuotaLogic`, ios/WatchShared). One home since
// 2026-09-29: the watch used to keep a hand-maintained copy of each rule.
// Each ports its web original in `src/lib/track.ts`; keep them in step with it.
//
// Foundation-only (compiled into the widget extensions, the apps, the watch
// targets and `OpenTaskLogicTests`).

/// The four periods a quota can count within, plus the period-less bucket —
/// mirrors `QUOTA_PERIODS` (`src/lib/track.ts`), narrowed to just the FREQ →
/// heading mapping the native surfaces need (the web table also carries an
/// editor label, a suffix and a noun they have no use for).
///
/// The widget's calendar math for a period (bounds, elapsed fraction, "N days
/// left") is an extension in TrackWidget.swift, since only the widget draws it.
enum QuotaPeriodKey: String {
    case daily, weekly, monthly, yearly, none

    /// Day → year, period-less last — every section list's fixed order,
    /// matching `groupByPeriod`'s.
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

    /// The period UNIT a quota's rrule counts within — mirrors `quotaFreqOf`
    /// (`src/lib/track.ts`): only `FREQ`. A fortnight is `.weekly` here; the
    /// grouping that tells it apart from a week is `QuotaPeriodGroup`
    /// (interval quotas, 2026-10-16).
    static func from(rrule: String?) -> QuotaPeriodKey {
        guard let rrule, !rrule.isEmpty else { return .none }
        switch RRuleParts.parse(rrule)["FREQ"]?.uppercased() {
        case "DAILY": return .daily
        case "WEEKLY": return .weekly
        case "MONTHLY": return .monthly
        case "YEARLY": return .yearly
        default: return .none
        }
    }
}

/// A quota's period for GROUPING: its unit and its INTERVAL (interval quotas,
/// 2026-10-16) — the web's `quotaPeriodKey`. "Every 2 weeks" is its own
/// section, after "This week": a fortnight doesn't run on this week's clock,
/// so it can't share that section's notch and "N days left", and two
/// fortnights made in adjacent weeks end on different days — so an interval
/// section has no clock at all, and each of its quotas says its own end
/// (`TaskDTO.periodLabel`, "by Oct 24", served by the server).
struct QuotaPeriodGroup: Hashable {
    let key: QuotaPeriodKey
    /// 1 for an ordinary period.
    let interval: Int

    static func of(_ task: TaskDTO) -> QuotaPeriodGroup {
        QuotaPeriodGroup(key: .from(rrule: task.rrule), interval: QuotaRules.interval(of: task))
    }

    /// "weekly", "weekly/2" — the section's list key (the web's "WEEKLY/2").
    var id: String { interval > 1 ? "\(key.rawValue)/\(interval)" : key.rawValue }

    /// "This week", or "Every 2 weeks" for an interval section.
    var heading: String {
        guard interval > 1 else { return key.heading }
        let unit: String
        switch key {
        case .daily: unit = "days"
        case .weekly: unit = "weeks"
        case .monthly: unit = "months"
        case .yearly: unit = "years"
        case .none: return key.heading
        }
        return "Every \(interval) \(unit)"
    }

    /// Whether the section shares one clock (notch, "N days left") — only an
    /// ordinary period does.
    var hasClock: Bool { interval == 1 && key != .none }

    /// Day → year, each unit's interval-1 group first, then its intervals
    /// shortest first; the period-less bucket last.
    static func ordered(_ groups: some Sequence<QuotaPeriodGroup>) -> [QuotaPeriodGroup] {
        groups.sorted { a, b in
            let ia = QuotaPeriodKey.order.firstIndex(of: a.key) ?? 0
            let ib = QuotaPeriodKey.order.firstIndex(of: b.key) ?? 0
            return ia == ib ? a.interval < b.interval : ia < ib
        }
    }
}

enum QuotaRules {

    /// A quota's INTERVAL — the server's `period_interval` when it sent one,
    /// else the rrule's own `INTERVAL` (an older server or cache), else 1.
    static func interval(of task: TaskDTO) -> Int {
        if let served = task.periodInterval { return max(served, 1) }
        guard let rrule = task.rrule, let raw = RRuleParts.parse(rrule)["INTERVAL"], let n = Int(raw) else {
            return 1
        }
        return max(n, 1)
    }

    /// `quotaLabelOf` (`src/lib/track.ts`): the first label that isn't
    /// machinery. Reserved labels are a case-SENSITIVE `ai-` prefix
    /// (`RESERVED_LABEL_PREFIX`, `src/lib/label-vocabulary.ts`) — created by
    /// enrichment/`createTask`, often without the user ever typing one, so
    /// taking `labels[0]` blindly would file a quota under "AI-FAILED".
    static func label(of task: TaskDTO) -> String? {
        task.labels.first { !$0.hasPrefix("ai-") }
    }

    /// The quota's stripe color: its label's (`label(of:)`) configured color.
    static func stripeColor(of task: TaskDTO, labelConfig: [LabelConfigDTO]) -> String? {
        stripeColor(forLabel: label(of: task), labelConfig: labelConfig)
    }

    /// A label's `label_config` color (matched case-insensitively), as a raw
    /// color name (`WidgetTheme`/`WatchTheme.projectColor`'s palette), or nil
    /// for no label or no configured color. Green is EXCLUDED: green is
    /// "met"'s own color on every quota surface, so a green-configured label
    /// draws neutral instead — the web's `trackStripeClass`.
    static func stripeColor(forLabel label: String?, labelConfig: [LabelConfigDTO]) -> String? {
        guard let label else { return nil }
        let configured = labelConfig.first {
            $0.name.localizedCaseInsensitiveCompare(label) == .orderedSame
        }?.color
        return configured == "green" ? nil : configured
    }
}
