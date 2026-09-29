import Foundation

// Pure grouping logic for the watch app's Quotas page (`QuotasPageView`) —
// the watch's own layout of the rules the phone Quotas widget's
// `QuotaSectionBuilder` (`ios/OpenTaskWidgets/TrackWidget.swift`) also
// follows, both porting `src/lib/track.ts`. The per-quota rules come from
// `QuotaRules` (ios/Shared/QuotaRules.swift), shared with the widget:
//
// - period = the rrule's `FREQ` only (`QuotaPeriodKey.from(rrule:)`), day →
//   year, then the period-less bucket last;
// - a quota's label = its first label that isn't `ai-` machinery
//   (`QuotaRules.label(of:)`);
// - stripe color = that label's `label_config` color, EXCEPT green, which is
//   "met"'s own color and draws neutral instead (`QuotaRules.stripeColor`).
//
// What stays the watch's own, kept in step with the widget by hand:
//
// - "N of M met" counts EVERY quota in the period, including the met ones
//   the page hides — the summary is corpus-wide, only the rows are filtered;
// - no label CLUSTERS (a cluster title row per label costs a whole line of a
//   ~180pt screen each); rows are instead ordered label-first so
//   same-colored stripes sit together, which reads as the same grouping
//   without the chrome.

/// One period's rows, ready to draw.
struct WatchQuotaSection: Identifiable {
    let period: QuotaPeriodKey
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
    /// Every period with at least one quota, day → year then period-less.
    ///
    /// `showMet` false hides met quotas — immediately, including one that a
    /// tap has just met (no "just logged" grace since 2026-09-24, the
    /// phone widget's rule: a met row left under the finger gets
    /// over-tapped, and taking one back is Takeback mode's job). The caller
    /// passes `showMet || takeback` (`WatchViewModel.quotaSections`), so an
    /// armed Takeback mode shows met rows to take back.
    ///
    /// A period whose every quota is filtered out keeps its SECTION (with
    /// its "N of N met" header and no rows): "This week · 5 of 5 met" is
    /// the good news the page exists to show, not empty chrome.
    static func sections(
        quotas: [TaskDTO],
        labelConfig: [LabelConfigDTO],
        showMet: Bool
    ) -> [WatchQuotaSection] {
        let byPeriod = Dictionary(grouping: quotas) { QuotaPeriodKey.from(rrule: $0.rrule) }
        return QuotaPeriodKey.order.compactMap { period in
            guard let tasks = byPeriod[period], !tasks.isEmpty else { return nil }
            let visible = sorted(tasks).filter { task in
                showMet || !task.isProgressMet
            }
            return WatchQuotaSection(
                period: period,
                metCount: tasks.filter(\.isProgressMet).count,
                totalCount: tasks.count,
                rows: visible.map {
                    WatchQuotaRow(task: $0, color: QuotaRules.stripeColor(of: $0, labelConfig: labelConfig))
                }
            )
        }
    }

    /// Label first (case-insensitive, unlabeled last) so same-colored
    /// stripes sit together, then the FULL title — never `displayTitle`, so
    /// setting a short name never reorders a row out from under itself
    /// (the phone widget's rule too), then id for a stable tie-break.
    private static func sorted(_ tasks: [TaskDTO]) -> [TaskDTO] {
        tasks.sorted { a, b in
            let la = QuotaRules.label(of: a), lb = QuotaRules.label(of: b)
            if la?.lowercased() != lb?.lowercased() {
                guard let la else { return false }
                guard let lb else { return true }
                return la.localizedCaseInsensitiveCompare(lb) == .orderedAscending
            }
            let cmp = a.title.localizedCaseInsensitiveCompare(b.title)
            return cmp == .orderedSame ? a.id < b.id : cmp == .orderedAscending
        }
    }
}

/// Moving a quota PROMPT to another period for good (2026-09-25, the watch
/// Reminders page's press-and-hold list) — the watch's copy of
/// `movedPromptConfig` in `src/lib/quota-prompts.ts`; keep the two in step:
///
/// - a daily row moves only the numbers it stands for (`prompt.numbers`),
///   as per-number overrides — the quota's other numbers keep their places;
/// - every other quota moves as a whole: `slot_id`;
/// - always merged over the STORED config: the PATCH replaces the whole
///   object, so dropping `enabled` or another number's override would
///   silently undo a choice made in the web editor.
enum WatchPromptMove {
    static func movedConfig(stored: [String: Any]?, numbers: [Int]?, toSlotId: Int) -> [String: Any] {
        var config = stored ?? [:]
        if let numbers, !numbers.isEmpty {
            var overrides = config["numbers"] as? [String: Any] ?? [:]
            for k in numbers { overrides[String(k)] = toSlotId }
            config["numbers"] = overrides
        } else {
            config["slot_id"] = toSlotId
        }
        return config
    }
}
