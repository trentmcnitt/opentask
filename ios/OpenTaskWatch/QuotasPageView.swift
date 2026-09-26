import SwiftUI
import WatchKit

/// Quotas page (third page, after Reminders and Tasks): every open quota
/// (`WatchViewModel.quotas`, the `isTracked` slice of `/api/tasks`) grouped by
/// period — Today / This week / This month / This year / No period — each
/// section headed "This week · 2 of 7 met". A row is a label-color stripe,
/// the quota's `displayTitle` (`short_title ?? title`), and "cur/target".
///
/// Interaction is the phone Quotas widget's Takeback model (2026-09-24,
/// copied from `TrackWidgetViews.QuotaChip` + `TakebackModeToggle`):
///
/// - **Tap = +1**, on every row, met ones included (over-target "2/1" is
///   allowed, as on the phone and the web panel).
/// - **⊖ (toolbar, top-leading) arms Takeback mode**: the glyph fills and
///   turns red, every row with progress shows a red "−1" after its count
///   and taps as `−1`, rows at 0 are dimmed and disabled (nothing to take
///   back), and met rows show even with "Show met" off. The mode STAYS ON
///   across `−1`s until ⊖ is tapped again (or the page is left — see
///   `WatchViewModel.quotasTakebackMode`).
/// - Met quotas vanish on the tap that meets them when "Show met" is off —
///   no grace period (`WatchQuotaLogic.sections`).
///
/// This replaced the page's first model (a tap on a MET row silently meant
/// `−1`, and just-logged rows stayed visible until the page was left): one
/// tap target doing opposite things depending on a count the finger is
/// covering is exactly what the phone moved away from. The toolbar Undo
/// stays — it is every page's "revert whatever changed last, server-wide",
/// not a quota-specific takeback.
///
/// Counts are server-true after every tap (`WatchViewModel.logQuota` writes
/// the task `POST /api/tasks/:id/progress` returns).
///
/// Shape copied from `TasksPageView` (a `List` with the same
/// `hasLoadedOnce`/error gating), not invented — see that file's doc.
struct QuotasPageView: View {
    @ObservedObject var model: WatchViewModel

    private var sections: [WatchQuotaSection] { model.quotaSections }
    private var anyMet: Bool { model.quotas.contains(where: \.isProgressMet) }
    private var takeback: Bool { model.quotasTakebackMode }

    var body: some View {
        // `.navigationTitle`/`.toolbar` anchor to the single `NavigationStack`
        // `WatchRootView` wraps around the paged `TabView` (see its doc).
        List {
            if !model.hasLoadedOnce {
                HStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
                .listRowBackground(Color.clear)
            } else if let error = model.loadError, model.tasks.isEmpty {
                LoadErrorView(message: error)
                    .listRowBackground(Color.clear)
            } else if sections.isEmpty {
                Text("No quotas yet.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .listRowBackground(Color.clear)
            } else {
                ForEach(sections) { section in
                    Section {
                        ForEach(section.rows) { row in
                            QuotaRowButton(row: row, takeback: takeback) {
                                model.logQuota(row.task)
                            }
                        }
                    } header: {
                        // Section header: the period and its corpus-wide met
                        // count. A fully-met period with "Show met" off has
                        // no rows but keeps this header — "5 of 5 met" is
                        // the point, not empty chrome.
                        Text(section.summary)
                            .foregroundStyle(section.metCount == section.totalCount ? WatchTheme.done : .secondary)
                    }
                }

                // Hidden while Takeback is armed: the mode already shows
                // every met row, so the toggle would do nothing visible.
                if !takeback, anyMet || model.showMetQuotas {
                    Toggle(isOn: $model.showMetQuotas) {
                        Text("Show met")
                            .font(.footnote)
                    }
                    .tint(WatchTheme.accent)
                }
            }
        }
        // A one-line quota ("Rowing Sets 2/3") otherwise gets the watch
        // list's tall default row — two lines of empty padding under a short
        // title. Still a comfortable finger target at this height.
        .environment(\.defaultMinListRowHeight, 36)
        .navigationTitle("Quotas")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                TakebackToggle(isOn: $model.quotasTakebackMode)
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    model.undo()
                } label: {
                    Image(systemName: "arrow.uturn.backward.circle")
                }
                .disabled(!model.canUndo)
            }
        }
        .refreshable {
            await model.load()
        }
        .onDisappear {
            // Leaving the page disarms Takeback (`quotasTakebackMode`'s doc).
            // Verified in the watchOS 26.5 simulator (2026-09-24): although
            // the paged TabView keeps neighbours mounted, swiping Quotas →
            // Tasks → Quotas fires this and the ⊖ comes back "Off".
            model.quotasTakebackMode = false
        }
    }
}

/// The ⊖ that arms/disarms Takeback mode — the phone's `TakebackModeToggle`
/// (`minus.circle`, icon only; accessibility label "Takeback mode"). Off:
/// the outline glyph in the toolbar's ordinary tint. On: the FILLED glyph in
/// `WatchTheme.takebackTint` — "armed" must be unmistakable at a glance.
/// Tapping it again exits without doing anything else.
private struct TakebackToggle: View {
    @Binding var isOn: Bool

    var body: some View {
        Button {
            isOn.toggle()
            WKInterfaceDevice.current().play(.click)
        } label: {
            Image(systemName: isOn ? "minus.circle.fill" : "minus.circle")
                .foregroundStyle(isOn ? WatchTheme.takebackTint : Color.primary)
        }
        .accessibilityLabel(Text("Takeback mode"))
        .accessibilityValue(Text(isOn ? "On" : "Off"))
    }
}

/// One quota row as a button: `+1` normally, `−1` in Takeback mode, and
/// disabled + dimmed in Takeback mode at a count of 0 (the phone chip's
/// `isInert`: nothing to take back). The row itself draws the "−1".
private struct QuotaRowButton: View {
    let row: WatchQuotaRow
    let takeback: Bool
    let action: () -> Void

    private var task: TaskDTO { row.task }
    /// Takeback mode, on a row with something to take back: draws "−1".
    private var takesBack: Bool { takeback && task.progressCurrent > 0 }
    /// Takeback mode, at 0: dimmed and inert.
    private var isInert: Bool { takeback && !takesBack }

    var body: some View {
        Button(action: action) {
            QuotaRow(row: row, takesBack: takesBack)
        }
        .disabled(isInert)
        // 0.55, the phone chip's value: quieter, still readable.
        .opacity(isInert ? 0.55 : 1)
        .accessibilityLabel(Text(accessibilityText))
    }

    private var accessibilityText: String {
        let count = "\(task.progressCurrent) of \(task.progressTarget)"
        if isInert { return "\(task.displayTitle) — \(count), nothing to take back" }
        return "\(takesBack ? "Take one back from" : "Log one more for") \(task.displayTitle) — \(count)"
    }
}

/// One quota row: label stripe, wrapped title, trailing "cur/target" (and,
/// in Takeback mode, a red "│ −1" after it — the phone chip's mark).
///
/// The title is never truncated (Trent's rule for reminders, extended here):
/// the watch list scrolls, so a long quota name just takes more lines. Both
/// caps tried on the 44mm simulator cut realistic titles — 4 lines ended
/// "Posture practice (tall spine, soft jaw, shoulders do…", 6 lines ended
/// "Look for new evening courses — … weekend wor…" — and a quota with its
/// point cut off is one you can't tell apart from its neighbours. Setting
/// a `short_title` on the quota is the way to make a row shorter.
///
/// Met: the count turns green with a checkmark, the title dims — done for
/// the period, but still legible (shown with "Show met", or in Takeback).
private struct QuotaRow: View {
    let row: WatchQuotaRow
    let takesBack: Bool

    private var task: TaskDTO { row.task }
    private var met: Bool { task.isProgressMet }

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            RoundedRectangle(cornerRadius: 2)
                .fill(WatchTheme.labelColor(row.color))
                .frame(width: 3)

            Text(task.displayTitle)
                .font(.body)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(met ? .secondary : .primary)
                .frame(maxWidth: .infinity, alignment: .leading)

            VStack(alignment: .trailing, spacing: 2) {
                HStack(spacing: 2) {
                    if met {
                        Image(systemName: "checkmark")
                            .font(.caption2.weight(.bold))
                    }
                    Text("\(task.progressCurrent)/\(task.progressTarget)")
                        .font(.body.monospacedDigit().weight(.semibold))
                }
                .foregroundStyle(met ? WatchTheme.done : WatchTheme.accent)

                // Under the count rather than beside it: at the watch's
                // width (and at large text sizes) "3/5 │ −1" on one line
                // would eat the title's column. Red whatever the count's
                // color — it names the ACTION, not the quota's state.
                if takesBack {
                    Text("−1")
                        .font(.body.monospacedDigit().weight(.semibold))
                        .foregroundStyle(WatchTheme.takebackTint)
                }
            }
            .fixedSize()
        }
        .accessibilityElement(children: .combine)
    }
}

#if DEBUG
// Realistic sample quotas (`WatchPreviewData.quotas`, or local data via
// `PreviewLocalData`) — the long titles are the point: they're what a watch-width row has to wrap
// without eating the count.
#Preview("Quotas — met hidden") {
    NavigationStack {
        QuotasPageView(model: .preview(showMet: false))
    }
}

#Preview("Quotas — show met") {
    NavigationStack {
        QuotasPageView(model: .preview(showMet: true))
    }
}

#Preview("Quotas — takeback") {
    NavigationStack {
        QuotasPageView(model: .preview(showMet: false, takeback: true))
    }
}

#Preview("Quotas — takeback, XXX Large") {
    NavigationStack {
        QuotasPageView(model: .preview(showMet: false, takeback: true))
    }
    .dynamicTypeSize(.xxxLarge)
}
#endif
