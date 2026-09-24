import Foundation

/// Pure grouping logic for the watch app's Quotas page (`QuotasPageView`) —
/// the watch's own small re-derivation of the phone Quotas widget's
/// `QuotaPeriodKey`/`QuotaSectionBuilder` (`ios/OpenTaskWidgets/
/// TrackWidget.swift`), which in turn ports `src/lib/track.ts`'s
/// `quotaFreqOf`/`groupByPeriod`/`quotaLabelOf`/`trackStripeClass`. Not
/// shared code: `ios/OpenTaskWidgets` is the phone extension's private
/// directory (see `WatchTheme`'s doc for the same split), so the rules are
/// copied, not imported — keep them in step by hand:
///
/// - period = the rrule's `FREQ` only (`INTERVAL` ignored), day → year, then
///   the period-less bucket last;
/// - a quota's label = its first label that isn't `ai-` machinery;
/// - stripe color = that label's `label_config` color, EXCEPT green, which is
///   "met"'s own color and draws neutral instead;
/// - "N of M met" counts EVERY quota in the period, including the met ones
///   the page hides — the summary is corpus-wide, only the rows are filtered.
///
/// Where the watch deliberately differs from the phone widget: no label
/// CLUSTERS (a cluster title row per label costs a whole line of a ~180pt
/// screen each); rows are instead ordered label-first so same-colored stripes
/// sit together, which reads as the same grouping without the chrome.
enum WatchQuotaPeriod: String, CaseIterable {
    case daily, weekly, monthly, yearly, none

    var heading: String {
        switch self {
        case .daily: return "Today"
        case .weekly: return "This week"
        case .monthly: return "This month"
        case .yearly: return "This year"
        case .none: return "No period"
        }
    }

    /// `quotaFreqOf` — only `FREQ` matters, so a biweekly quota still reads
    /// "This week", same as the phone widget and the web panel.
    static func from(rrule: String?) -> WatchQuotaPeriod {
        guard let rrule, !rrule.isEmpty else { return .none }
        for part in rrule.uppercased().split(separator: ";") {
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

/// One period's rows, ready to draw.
struct WatchQuotaSection: Identifiable {
    let period: WatchQuotaPeriod
    var id: String { period.rawValue }
    /// Met vs. total over EVERY quota in the period (unfiltered).
    let metCount: Int
    let totalCount: Int
    /// The rows to show — met ones already filtered out unless shown.
    let rows: [WatchQuotaRow]

    /// "Today · 1 of 2 met".
    var summary: String { "\(period.heading) · \(metCount) of \(totalCount) met" }
}

struct WatchQuotaRow: Identifiable {
    let task: TaskDTO
    /// Raw `label_config` color name (`WatchTheme.projectColor`'s palette),
    /// nil for unlabeled or a green-configured label.
    let color: String?
    var id: Int { task.id }
}

enum WatchQuotaLogic {
    /// `quotaLabelOf` — the first label that isn't machinery (a
    /// case-sensitive `ai-` prefix; enrichment adds those without the user
    /// ever typing one, so `labels[0]` blindly would file a quota under
    /// "ai-added").
    static func label(of task: TaskDTO) -> String? {
        task.labels.first { !$0.hasPrefix("ai-") }
    }

    /// The label's configured color, green excluded (see the type doc).
    static func color(of task: TaskDTO, labelConfig: [LabelConfigDTO]) -> String? {
        guard let label = label(of: task) else { return nil }
        let configured = labelConfig.first {
            $0.name.localizedCaseInsensitiveCompare(label) == .orderedSame
        }?.color
        return configured == "green" ? nil : configured
    }

    /// Every period with at least one quota, day → year then period-less.
    ///
    /// `showMet` false hides met quotas — EXCEPT ids in `keepVisible`: the
    /// quotas this page has just logged. A +1 that completes a quota would
    /// otherwise make its row vanish under the finger, taking the only way
    /// to take the tap back (−1 on a met row) with it — the same problem the
    /// phone widget's mutation grace (`WidgetStore.quotaMutationIsRecent`)
    /// solves, handled here by an explicit id set rather than a timer
    /// because this is a live view: the set is cleared when the page is
    /// left, not after an arbitrary number of seconds (`WatchViewModel.
    /// recentlyLoggedQuotaIds`).
    ///
    /// A period whose every quota is filtered out keeps its SECTION (with
    /// its "N of N met" header and no rows): "This week · 5 of 5 met" is
    /// the good news the page exists to show, not empty chrome.
    static func sections(
        quotas: [TaskDTO],
        labelConfig: [LabelConfigDTO],
        showMet: Bool,
        keepVisible: Set<Int>
    ) -> [WatchQuotaSection] {
        let byPeriod = Dictionary(grouping: quotas) { WatchQuotaPeriod.from(rrule: $0.rrule) }
        return WatchQuotaPeriod.allCases.compactMap { period in
            guard let tasks = byPeriod[period], !tasks.isEmpty else { return nil }
            let visible = sorted(tasks).filter { task in
                showMet || !task.isProgressMet || keepVisible.contains(task.id)
            }
            return WatchQuotaSection(
                period: period,
                metCount: tasks.filter(\.isProgressMet).count,
                totalCount: tasks.count,
                rows: visible.map { WatchQuotaRow(task: $0, color: color(of: $0, labelConfig: labelConfig)) }
            )
        }
    }

    /// Label first (case-insensitive, unlabeled last) so same-colored
    /// stripes sit together, then the FULL title — never `displayTitle`, so
    /// setting a short name never reorders a row out from under itself
    /// (the phone widget's rule too), then id for a stable tie-break.
    private static func sorted(_ tasks: [TaskDTO]) -> [TaskDTO] {
        tasks.sorted { a, b in
            let la = label(of: a), lb = label(of: b)
            if la?.lowercased() != lb?.lowercased() {
                guard let la else { return false }
                guard let lb else { return true }
                return la.localizedCaseInsensitiveCompare(lb) == .orderedAscending
            }
            let cmp = a.title.localizedCaseInsensitiveCompare(b.title)
            return cmp == .orderedSame ? a.id < b.id : cmp == .orderedAscending
        }
    }

    /// How many quotas the "Show met" toggle would reveal.
    static func hiddenMetCount(quotas: [TaskDTO], keepVisible: Set<Int>) -> Int {
        quotas.filter { $0.isProgressMet && !keepVisible.contains($0.id) }.count
    }
}
