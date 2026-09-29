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
}

enum QuotaRules {

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
