import SwiftUI
import WidgetKit

/// The Quotas widget's rendering, across all five supported families
/// (`feat/quotas-widget`, replacing the old single-item-ring "Track" design —
/// see `TrackWidget.swift`'s `TrackTimeline` doc for why that OLD algorithm
/// is still in the tree, just no longer driving this file).
///
/// Mirrors the web Track panel (`src/components/TrackPanel.tsx`) chip mode,
/// not its full-row mode — a widget has no room for a second layout, and
/// chips are the panel's own default. §5 still shapes every rule here: a
/// quota is not a deadline, so nothing is red, nothing counts days, and pace
/// (the section bar's notch) renders but never alarms. "Met" does not remove
/// a chip mid-session — it is a visual state (green fill, green count) until
/// the NEXT timeline build puts it away, matching the web panel's own "met
/// quotas are put away at load, never under a finger" rule (`TrackPanel.tsx`
/// `useMetAtLoad`'s doc) — the widget's equivalent of "at load" is simply
/// "this build": `WidgetStore.quotaMutationIsRecent` is the short grace
/// window that keeps a quota visible through the very tap that met it (see
/// its own doc for why a global stamp, not a persisted id set).
///
/// GROUPED BY PERIOD, THEN LABEL — day → year, then a period-less "No
/// period" bucket, each period's own label clusters inside it, exactly the
/// web panel's 2026-09-23 redesign (`TrackPanel.tsx`'s file header). A
/// cluster's chips wrap left-to-right like CSS flex-wrap
/// (`QuotaFlow.lines` in `TrackWidget.swift`); the systemLarge family PAGES
/// that flow when it overflows the card (`QuotaFlow.paginate`) rather than
/// showing "+N more" — see `ListPager`'s doc in `WidgetTheme.swift`.
///
/// THE EYE TOGGLE (header, left of Undo — Trent asked for it on this widget
/// too, alongside Reminders/Tasks' own "show completed" being built in
/// parallel on `feat/widget-days-show-completed`): off (default) hides a met
/// quota inside its cluster; on shows every quota regardless of state, in
/// place, in its normal cluster — mirrors the web panel's own met-count
/// button (`TrackHeader`'s "X of Y").
struct TrackWidgetView: View {
    @Environment(\.widgetFamily) private var family

    let entry: TrackEntry

    var body: some View {
        content
            .containerBackground(for: .widget) {
                switch family {
                case .systemSmall, .systemMedium, .systemLarge:
                    Rectangle().fill(.fill.tertiary)
                default:
                    Color.clear
                }
            }
    }

    @ViewBuilder
    private var content: some View {
        switch family {
        #if os(iOS)
        case .accessoryCircular:
            QuotasCircularView(entry: entry)
        case .accessoryRectangular:
            QuotasRectangularView(entry: entry)
        #endif
        case .systemSmall:
            QuotasSmallView(entry: entry)
        case .systemMedium:
            QuotasListView(entry: entry, isLarge: false)
                .backgroundTapOpens(WidgetLink.quotas)
        default:
            QuotasListView(entry: entry, isLarge: true)
                .backgroundTapOpens(WidgetLink.quotas)
        }
    }
}

private let emptyQuotasMessage = "Nothing tracked — set a target on a task to see it here."

// MARK: - systemSmall

/// Glanceable only, like Reminders'/Tasks' own 2×2 (§8: "a headline number,
/// one item, whole-card deep link") — a DELIBERATE change from the OLD
/// Track small view, which had inline `+1`/chevrons for a single selected
/// quota. The new design has no "selected item" concept at all (ordering is
/// static alphabetical, not pace-ranked, so there is nothing for a chevron
/// to step through), and at ~126pt a `+1` button here would be the same
/// mis-tap machine the design already avoids on Reminders/Tasks' 2×2s — see
/// `WidgetSignedOutView`'s "compact" split for the established precedent.
/// Whole-card `.widgetURL(WidgetLink.quotas)`.
private struct QuotasSmallView: View {
    let entry: TrackEntry

    var body: some View {
        if entry.isSignedOut {
            WidgetSignedOutView(compact: true)
        } else if entry.totalCount == 0 {
            WidgetEmptyView(symbol: "target", message: emptyQuotasMessage, compact: true)
                .widgetURL(WidgetLink.dashboard)
        } else {
            VStack(spacing: 4) {
                OverallRing(met: entry.totalMet, total: entry.totalCount, diameter: 62, lineWidth: 7)

                if let next = entry.nextUnmet {
                    Text(next.task.displayTitle)
                        .font(.caption2)
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                        .minimumScaleFactor(0.85)
                } else {
                    Text("All met!")
                        .font(.caption2)
                        .fontWeight(.medium)
                        .foregroundStyle(WidgetTheme.trackMetTint)
                }
            }
            .frame(maxWidth: .infinity)
            .widgetURL(WidgetLink.quotas)
        }
    }
}

// MARK: - systemMedium / systemLarge

/// The flowed, paged body — `GeometryReader` owns both dimensions the layout
/// needs: `width` for the chip wrap (`QuotaFlow.lines`) and the real
/// available `height` for pagination (`QuotaFlow.paginate`), so neither
/// number is ever a guess.
///
/// PURE OVER `entry`: this view (and everything below it in this file) reads
/// no `WidgetStore` directly — `entry.showMet`/`entry.page` are already
/// resolved by the provider (`TrackWidget.swift`), and `entry.sections`
/// already carry the `showMet` filtering baked in. That is what lets a
/// single `#Preview` swap between showMet/page variants by handing this view
/// different SAMPLE entries, the same as any other SwiftUI preview — a view
/// that read the store directly would render identically no matter which
/// entry a preview constructed.
///
/// `QuotaMetrics.headerHeight(isLarge:)`/`.pagerHeight` are FIXED
/// approximations of the header/pager chrome's real height, not measured —
/// a deliberate simplification (documented on `QuotaMetrics` itself) that
/// trades exactness at very large Dynamic Type sizes for not needing a
/// two-pass PreferenceKey measurement just to size a chevron's dim state.
private struct QuotasListView: View {
    let entry: TrackEntry
    /// systemLarge only. Drives whether paging exists at all — the spec
    /// explicitly allows medium to show no pager and simply render as many
    /// lines as fit ("no pager if it doesn't fit for medium").
    let isLarge: Bool

    var body: some View {
        if entry.isSignedOut {
            WidgetSignedOutView()
        } else {
            GeometryReader { geo in
                let width = geo.size.width
                let allLines = QuotaFlow.lines(sections: entry.sections, width: width)
                let fullHeight = max(geo.size.height - QuotaMetrics.headerHeight(isLarge: isLarge), 0)
                let fullPages = QuotaFlow.paginate(lines: allLines, pageHeight: fullHeight)
                let canPage = isLarge && fullPages.count > 1
                let pages: [[QuotaFlow.Line]] = canPage
                    ? QuotaFlow.paginate(
                        lines: allLines,
                        pageHeight: max(fullHeight - QuotaMetrics.pagerHeight, 0)
                    )
                    : fullPages
                let totalPages = max(pages.count, 1)
                // Medium never pages (see `isLarge`'s doc) — it always shows
                // whatever fits from the top, ignoring `entry.page`.
                let page = canPage ? min(max(entry.page, 0), totalPages - 1) : 0
                let currentLines = pages.indices.contains(page) ? pages[page] : []

                VStack(alignment: .leading, spacing: 0) {
                    header(canPage: canPage, page: page, totalPages: totalPages)

                    if entry.sections.isEmpty {
                        WidgetEmptyView(symbol: "target", message: emptyQuotasMessage)
                    } else {
                        QuotaLinesView(lines: currentLines)
                        // Pinned to the card's bottom edge, same idiom as
                        // `RemindersListView.card`'s `ListPager` — a
                        // `Spacer`'s ideal height is its `minLength` (0), so
                        // it costs nothing when there's no pager to pin.
                        Spacer(minLength: 0)
                        if canPage {
                            ListPager(
                                page: page, totalPages: totalPages,
                                previous: ShiftQuotasPageIntent(offset: -1),
                                next: ShiftQuotasPageIntent(offset: 1)
                            )
                        }
                    }

                    if let staleSince = entry.staleSince {
                        HStack {
                            Spacer()
                            StalenessNote(fetchedAt: staleSince)
                        }
                    }
                }
                .frame(width: width, height: geo.size.height, alignment: .topLeading)
            }
        }
    }

    /// One line, matching the ALREADY-SHIPPED Reminders/Tasks header shape
    /// (`.headline` title + `.caption2` subtitle stack, `RemindersListView.
    /// header`) rather than the OLD Track header's single combined line —
    /// the mockup PNG also draws a big bold "Quotas" over a muted subtitle.
    /// Icon order (left → right): the eye toggle, THEN Undo/Redo (2026-09-23:
    /// "left of Undo" — Trent, on this widget too), then the chevron pager
    /// bound to the SAME page state as the bottom `ListPager` — a deliberate
    /// reuse rather than inventing a second "ring" concept Quotas has no
    /// analog for (see `QuotaFlow`'s handoff notes: Reminders' header ring
    /// pages slots, Tasks' pages projects, Quotas has no such secondary axis
    /// — all periods render together in one flowing body). Flagged as
    /// redundant chrome (both pagers do the same thing) per `ChevronPager`'s
    /// own doc: "a chevron just says there is more this way".
    private func header(canPage: Bool, page: Int, totalPages: Int) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: WidgetTheme.headerSpacing) {
            Link(destination: WidgetLink.quotas) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Quotas")
                        .font(.headline)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    // "Undid: …" / "Redid: …" for ~60s after an undo/redo —
                    // see `WidgetStore`'s "Last-action indication" doc.
                    Text(entry.actionDescription ?? "\(entry.totalMet) of \(entry.totalCount) met")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                .contentShape(Rectangle())
            }
            Spacer(minLength: 0)
            ShowMetToggleButton(showMet: entry.showMet)
            UndoRedoButtons(canUndo: entry.canUndo, canRedo: entry.canRedo)
            if canPage {
                ChevronPager(
                    previous: ShiftQuotasPageIntent(offset: -1),
                    next: ShiftQuotasPageIntent(offset: 1),
                    hasPrevious: page > 0,
                    hasNext: page < totalPages - 1
                )
            }
        }
        .padding(.top, isLarge ? WidgetTheme.headerTopPadding : 0)
    }
}

/// The header's "show met quotas" toggle. Copies `UndoRedoButtons.
/// iconButton`'s visual shape (same padding/sizing/dim-when-off treatment)
/// rather than importing a shared component — `WidgetTheme.swift` is under
/// parallel edit (another agent's twin toggle for Reminders/Tasks' own "show
/// completed", a different shape of state: a COMPLETION, not a target-met
/// quota that stays open past it) — so this stays PRIVATE and Quotas-only,
/// avoiding a shared-name collision between the two.
///
/// `eye.slash` (met hidden, the default) / `eye` (met shown), tinted with
/// Track's own single accent (`WidgetTheme.trackTint`) when on rather than a
/// new hue — the widget's one-accent-hue rule (§ design conventions), and
/// the glyph swap alone already carries the state.
private struct ShowMetToggleButton: View {
    let showMet: Bool

    var body: some View {
        Button(intent: ToggleQuotasShowMetIntent()) {
            Image(systemName: showMet ? "eye" : "eye.slash")
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 5)
                .padding(.vertical, 4)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(showMet ? WidgetTheme.trackTint : Color.secondary)
        .accessibilityLabel(Text(showMet ? "Hide met quotas" : "Show met quotas"))
    }
}

/// The current page's flowed lines, drawn in order — a heading, a cluster
/// label, or one complete chip row. This view never wraps or re-measures
/// anything itself; `QuotaFlow.lines` already decided exactly what belongs
/// on each line, and cutting a page between two `Line`s (never inside a
/// `.chipRow`) is what keeps a chip from ever being cut in half.
private struct QuotaLinesView: View {
    let lines: [QuotaFlow.Line]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(lines.enumerated()), id: \.element.id) { index, line in
                switch line {
                case .heading(let section):
                    // A thin divider between period sections, never before
                    // the first — mirrors the web panel's `SECTION_DIVIDER`.
                    // Only correct for the page's OWN first line; a section
                    // that continues from a previous PAGE (the accepted
                    // "heading stranded, clusters start fresh" gap —
                    // `QuotaFlow.paginate`'s doc) draws no divider either,
                    // since there is nothing on this page to divide from.
                    if index > 0 {
                        Rectangle()
                            .fill(Color.primary.opacity(0.08))
                            .frame(height: 1)
                            .padding(.top, 4)
                            .padding(.bottom, 3)
                    }
                    QuotaHeadingRow(section: section)
                case .clusterTitle(let cluster):
                    QuotaClusterTitleRow(cluster: cluster)
                        .padding(.top, 3)
                        .padding(.bottom, 2)
                case .chipRow(_, let color, let chips):
                    QuotaChipRow(color: color, chips: chips)
                        .padding(.bottom, QuotaMetrics.chipRowSpacing)
                }
            }
        }
    }
}

/// A period section's heading row — period name (bold, full-strength, so it
/// outranks the muted cluster labels beneath it), a muted "ends tonight"/"N
/// days left" (omitted for the no-period section), a bar that flexes to fill
/// whatever room is left, and "M of N" met. Mirrors `PeriodHeading`
/// (`TrackPanel.tsx`) almost exactly, in SwiftUI.
private struct QuotaHeadingRow: View {
    let section: QuotaSection

    var body: some View {
        HStack(spacing: 6) {
            Text(section.heading.uppercased())
                .font(.system(size: 10, weight: .bold))
                .tracking(0.6)
                .foregroundStyle(.primary)
                .lineLimit(1)
                .fixedSize()

            if let timeLeftText = section.timeLeftText {
                Text(timeLeftText)
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .fixedSize()
            }

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.secondary.opacity(0.25))
                    Capsule()
                        .fill(section.allMet ? WidgetTheme.trackMetTint : WidgetTheme.trackTint)
                        .frame(width: max(geo.size.width * section.barFraction, 0))
                    // The notch: how much of the period's clock has already
                    // run. `Color.primary` rather than a hardcoded white —
                    // §5's ONE flat tone "at every fraction, on the fill or
                    // off it" (`TRACK_NOTCH_CLASS`'s doc), automatically
                    // adapting black/white by color scheme the same way the
                    // web's `dark:` variant does. Clipped by the outer
                    // `.clipShape(Capsule())` below so it can never overhang
                    // the bar's own rounded ends.
                    if let elapsed = section.elapsedFraction {
                        Capsule()
                            .fill(Color.primary.opacity(0.14))
                            .frame(width: 2)
                            .offset(x: min(max(geo.size.width * elapsed - 1, 0), geo.size.width - 2))
                    }
                }
                .clipShape(Capsule())
            }
            .frame(height: 4)

            Text(metCountText)
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .fixedSize()
        }
        .frame(height: QuotaMetrics.headingRowHeight)
    }

    /// "**M** of N" — bold met count, muted rest, one `Text` so the two
    /// weights can sit on one baseline without a second HStack.
    private var metCountText: AttributedString {
        var s = AttributedString("\(section.summary.met) of \(section.summary.count)")
        if let range = s.range(of: "\(section.summary.met)") {
            s[range].font = .system(size: 10, weight: .semibold)
            s[range].foregroundColor = .primary
        }
        return s
    }
}

/// One label cluster's heading, inside a period section: a color dot, the
/// uppercase label name, and — only while the cluster still has unmet
/// quotas — a green "✓N" for how many are already met. Mirrors
/// `ClusterTitle` (`TrackPanel.tsx`).
private struct QuotaClusterTitleRow: View {
    let cluster: QuotaCluster

    private var allMet: Bool { cluster.totalCount > 0 && cluster.metCount == cluster.totalCount }

    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(WidgetTheme.projectColor(cluster.color))
                .frame(width: 6, height: 6)
            Text(cluster.displayName.uppercased())
                .font(.system(size: 9, weight: .semibold))
                .tracking(0.5)
                .foregroundStyle(.secondary)
                .lineLimit(1)

            if cluster.metCount > 0, !allMet {
                HStack(spacing: 2) {
                    Image(systemName: "checkmark")
                        .font(.system(size: 8, weight: .bold))
                    Text("\(cluster.metCount)")
                        .font(.system(size: 9))
                        .monospacedDigit()
                }
                .foregroundStyle(WidgetTheme.trackMetTint)
            }

            Spacer(minLength: 0)
        }
        .frame(height: QuotaMetrics.clusterTitleRowHeight)
    }
}

/// One complete chip row — exactly the chips `QuotaFlow.lines` packed into
/// it, drawn as a plain `HStack` that SwiftUI never re-wraps (the "never cut
/// a chip" guarantee: the row was already measured to fit before it was
/// handed to this view).
private struct QuotaChipRow: View {
    let color: String?
    let chips: [TrackItem]

    var body: some View {
        HStack(spacing: QuotaMetrics.chipRowGap) {
            ForEach(chips) { item in
                QuotaChip(item: item, color: color)
            }
        }
    }
}

/// One quota, as a chip. The widget's only progress control — `+1` only, no
/// `−1` (a DELIBERATE change from the OLD Track row's `−1` button: Undo
/// covers a mis-tap, and a second button per chip would double the chip-flow
/// measurement's surface for no everyday benefit). Tapping opens nothing —
/// `IncrementProgressIntent` (reused verbatim, no new intent per spec) fires
/// straight from the chip.
///
/// `.fixedSize()`: if `QuotaMetrics.chipWidth(for:)`'s measurement ever
/// under-counts the real rendered width (a font substitution, a measurement
/// rounding difference), the chip overflows the card's edge VISIBLY in a
/// render review, rather than SwiftUI silently truncating the title — the
/// one failure mode Trent's "never truncate" rule can't tolerate. The one
/// legitimate truncation left is a single chip wider than the whole card,
/// capped by the title's own `lineLimit(1)`.
private struct QuotaChip: View {
    let item: TrackItem
    let color: String?

    private var fraction: Double { item.doneFraction }

    var body: some View {
        Button(intent: IncrementProgressIntent(taskId: item.task.id, delta: 1)) {
            HStack(spacing: QuotaMetrics.chipTitleCountGap) {
                Text(item.task.displayTitle)
                    .font(QuotaMetrics.chipTitleFont)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                count
            }
            .padding(.leading, QuotaMetrics.chipLeadingPadding)
            .padding(.trailing, QuotaMetrics.chipTrailingPadding)
            .frame(height: QuotaMetrics.chipHeight)
            .background(fillAndStripe)
            .overlay(
                RoundedRectangle(cornerRadius: QuotaMetrics.chipCornerRadius)
                    .strokeBorder(item.isMet ? WidgetTheme.trackMetTint.opacity(0.3) : Color.primary.opacity(0.12), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: QuotaMetrics.chipCornerRadius))
            .fixedSize()
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            Text("Log one more for \(item.task.displayTitle) — \(item.task.progressCurrent) of \(item.task.progressTarget)")
        )
    }

    private var count: some View {
        HStack(spacing: 0) {
            Text("\(item.task.progressCurrent)")
                .font(QuotaMetrics.chipCurrentFont)
            Text("/\(item.task.progressTarget)")
                .font(QuotaMetrics.chipTargetFont)
        }
        .monospacedDigit()
        .foregroundStyle(item.isMet ? WidgetTheme.trackMetTint : Color.secondary)
    }

    /// The chip's base fill, the progress fill (Track's own teal accent —
    /// see below — green once met, a STRONGER opacity than the section bar's
    /// own fill: the mockup and the original spec prose both call for a
    /// bolder progress fill on the chip specifically, stronger than the web
    /// `TrackChip`'s current, not-yet-updated `bg-foreground/10`), and the
    /// label's 3pt leading stripe, painted AFTER the fill so a fully-met
    /// chip's fill never tints the stripe green underneath it.
    ///
    /// Base is `.fill.secondary` (an adaptive system fill), not a literal
    /// dark gray: WidgetKit's `.containerBackground` already makes this card
    /// light in Light Appearance and dark in Dark Appearance (see
    /// `TrackWidgetView.body`), so a hardcoded dark chip background read as
    /// black-on-black text the instant this renders in Light Appearance — a
    /// bug caught in the first Xcode preview render, fixed here rather than
    /// tuning `.primary`/`.secondary` around a fixed color that fights the
    /// card's own adaptivity.
    ///
    /// TEAL, not the mockup's indigo: `WidgetTheme.trackTint` is Track's
    /// already-established single accent (the old ring/bar mode used it
    /// everywhere pace-related), and introducing indigo here would add a
    /// SECOND accent hue to this widget's vocabulary — a direct conflict
    /// with the one-accent-hue rule this codebase otherwise holds to.
    /// Flagged in the build report as a deliberate deviation from the
    /// mockup's literal color for Trent to weigh in on.
    private var fillAndStripe: some View {
        ZStack(alignment: .leading) {
            Rectangle().fill(.fill.secondary)
            GeometryReader { geo in
                (item.isMet ? WidgetTheme.trackMetTint : WidgetTheme.trackTint)
                    .opacity(item.isMet ? 0.30 : 0.45)
                    .frame(width: max(geo.size.width * fraction, 0))
            }
            HStack(spacing: 0) {
                Rectangle()
                    .fill(WidgetTheme.projectColor(color))
                    .frame(width: QuotaMetrics.chipStripeWidth)
                Spacer(minLength: 0)
            }
        }
    }
}

// MARK: - Lock Screen
//
// Lock Screen accessory families don't exist on macOS — see the #if os(iOS)
// guard on `content` above.
#if os(iOS)

/// Glanceable only — §8: interactive widgets are inert on a locked device.
/// Overall "N/M met" and the next unmet quota's title; no per-item detail
/// (the OLD design showed the single selected item, which no longer exists
/// as a concept — see `QuotasSmallView`'s doc for the same change one family
/// up). `widgetURL(WidgetLink.dashboard)`, matching the OLD code's own
/// choice — kept rather than switched to `.quotas`, since nothing about this
/// rebuild changed what a Lock Screen tap should open.
private struct QuotasRectangularView: View {
    let entry: TrackEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if entry.isSignedOut {
                Text("OpenTask")
                    .font(.headline)
                    .widgetAccentable()
                Text("Open to sign in")
                    .font(.caption2)
            } else if entry.totalCount == 0 {
                Text("Quotas")
                    .font(.headline)
                    .widgetAccentable()
                Text("Nothing tracked")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                HStack(spacing: 4) {
                    Text("Quotas")
                        .font(.headline)
                        .widgetAccentable()
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    Text("\(entry.totalMet)/\(entry.totalCount)")
                        .font(.caption.weight(.semibold))
                        .monospacedDigit()
                        .widgetAccentable()
                }
                if let next = entry.nextUnmet {
                    Text(next.task.displayTitle)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                } else {
                    Text("All met")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .widgetURL(WidgetLink.dashboard)
    }
}

/// The overall met/total fraction as a capacity ring — the one shape that
/// survives being 30pt across and tinted by the system.
private struct QuotasCircularView: View {
    let entry: TrackEntry

    var body: some View {
        Gauge(value: entry.totalCount > 0 ? Double(entry.totalMet) / Double(entry.totalCount) : 0) {
            Image(systemName: "target")
        } currentValueLabel: {
            Text("\(entry.totalMet)")
                .minimumScaleFactor(0.7)
        }
        .gaugeStyle(.accessoryCircularCapacity)
        .widgetURL(WidgetLink.dashboard)
    }
}

#endif

// MARK: - Shared chrome

/// The overall met/total ring — `QuotasSmallView`'s flagship shape, the same
/// visual as the OLD single-item `QuotaRing` but fed the WHOLE corpus'
/// `met`/`total` instead of one task's progress; there is no single
/// "selected" quota to ring any more (see `QuotasSmallView`'s doc).
private struct OverallRing: View {
    let met: Int
    let total: Int
    let diameter: CGFloat
    let lineWidth: CGFloat

    private var fraction: Double { total > 0 ? min(Double(met) / Double(total), 1) : 0 }
    private var allMet: Bool { total > 0 && met == total }

    var body: some View {
        ZStack {
            Circle()
                .stroke(.quaternary, lineWidth: lineWidth)

            Circle()
                .trim(from: 0, to: fraction)
                .stroke(
                    allMet ? WidgetTheme.trackMetTint : WidgetTheme.trackTint,
                    style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))

            VStack(spacing: -2) {
                Text("\(met)/\(total)")
                    .font(.system(size: diameter * 0.24, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
                if allMet {
                    Image(systemName: "checkmark")
                        .font(.system(size: diameter * 0.17, weight: .bold))
                        .foregroundStyle(WidgetTheme.trackMetTint)
                }
            }
            .padding(.horizontal, lineWidth + 2)
        }
        .frame(width: diameter, height: diameter)
    }
}
