import SwiftUI

/// Quotas page (third page, after Reminders and Tasks): every open quota
/// (`WatchViewModel.quotas`, the `isTracked` slice of `/api/tasks`) grouped by
/// period — Today / This week / This month / This year / No period — each
/// section headed "This week · 2 of 7 met". A row is a label-color stripe,
/// the quota's `displayTitle` (`short_title ?? title`), and "cur/target".
///
/// Tap = +1. On a MET row, tap = −1 ("take back" a mis-log) — the only
/// useful thing to do to a quota that's done for its period, and the only
/// way to undo one tap without reaching for the toolbar Undo (which reverts
/// whatever changed LAST server-wide, same as the other pages).
///
/// Met quotas are hidden by default; a "Show met" toggle at the foot of the
/// list (only drawn when something is met — no empty chrome) reveals them.
/// A quota logged from this page stays visible after it becomes met until
/// the page is left (`WatchViewModel.recentlyLoggedQuotaIds`), so a +1 that
/// completes it never yanks the row out from under the finger.
///
/// Shape copied from `TasksPageView` (a `List` with the same
/// `hasLoadedOnce`/error gating), not invented — see that file's doc.
struct QuotasPageView: View {
    @ObservedObject var model: WatchViewModel

    private var sections: [WatchQuotaSection] { model.quotaSections }
    private var anyMet: Bool { model.quotas.contains(where: \.isProgressMet) }

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
                            Button {
                                model.logQuota(row.task)
                            } label: {
                                QuotaRow(row: row)
                            }
                            .accessibilityHint(row.task.isProgressMet ? "Takes back one" : "Logs one")
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

                if anyMet || model.showMetQuotas {
                    Toggle(isOn: $model.showMetQuotas) {
                        Text("Show met")
                            .font(.footnote)
                    }
                    .tint(WatchTheme.accent)
                }
            }
        }
        // A one-line quota ("Weight Lift 2/3") otherwise gets the watch
        // list's tall default row — two lines of empty padding under a short
        // title. Still a comfortable finger target at this height.
        .environment(\.defaultMinListRowHeight, 36)
        .navigationTitle("Quotas")
        .toolbar {
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
            model.clearRecentlyLoggedQuotas()
        }
    }
}

/// One quota row: label stripe, wrapped title, trailing "cur/target".
///
/// The title is never truncated (Trent's rule for reminders, extended here):
/// the watch list scrolls, so a long quota name just takes more lines. Both
/// caps tried on the 44mm simulator cut his real data — 4 lines ended
/// "Balloon breathing practice (slow exhale, relaxed shoul…", 6 lines
/// ended "Check for new certifications — … business aut…" — and a quota with
/// its point cut off is one he can't tell apart from its neighbours. Setting
/// a `short_title` on the quota is the way to make a row shorter.
///
/// Met: the count turns green with a checkmark, the title dims — done for
/// the period, but still legible (the row is tappable to take one back).
private struct QuotaRow: View {
    let row: WatchQuotaRow

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

            HStack(spacing: 2) {
                if met {
                    Image(systemName: "checkmark")
                        .font(.caption2.weight(.bold))
                }
                Text("\(task.progressCurrent)/\(task.progressTarget)")
                    .font(.body.monospacedDigit().weight(.semibold))
            }
            .foregroundStyle(met ? WatchTheme.done : WatchTheme.accent)
            .fixedSize()
        }
        .accessibilityElement(children: .combine)
    }
}

#if DEBUG
// Trent's real prod quotas (`ReminderStackPreviewData.quotas`, read-only
// snapshot) — the long titles are the point: they're what a watch-width row
// has to wrap without eating the count.
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
#endif
