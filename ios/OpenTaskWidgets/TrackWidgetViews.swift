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
/// (the section bar's notch) renders but never alarms. With the "met" dot
/// off, a quota that becomes met disappears on the tap that met it — no
/// grace window (2026-09-24; PR #58 had ported the web panel's "put away at
/// load, never under a finger" rule, and on a widget it left met chips
/// showing and tappable — see `WidgetStore.quotasShowMet`'s doc). With the
/// dot on, met chips show green and a tap takes one back (`QuotaChip`).
///
/// GROUPED BY PERIOD, THEN LABEL — day → year, then a period-less "No
/// period" bucket, each period's own label clusters inside it, exactly the
/// web panel's 2026-09-23 redesign (`TrackPanel.tsx`'s file header). A
/// cluster's chips wrap left-to-right like CSS flex-wrap
/// (`QuotaFlow.lines` in `TrackWidget.swift`); the systemLarge family PAGES
/// that flow when it overflows the card (`QuotaFlow.paginate`) rather than
/// showing "+N more" — see `ListPager`'s doc in `WidgetTheme.swift`.
///
/// THE "MET" DOT (bottom row, right of the pager — 2026-09-24; it was an eye
/// in the header until then, the same move Reminders/Tasks' "show completed"
/// made): off (default) hides a met quota inside its cluster; on shows every
/// quota regardless of state, in place, in its normal cluster — mirrors the
/// web panel's own met-count button (`TrackHeader`'s "X of Y").
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

/// The flowed, paged body.
///
/// LAID OUT FOR REAL, THEN PAGED (2026-09-24). The header is an ordinary
/// view above a `RenderedTextReader`, so the reader's height is whatever
/// the header really left — at any text size. It used to be `geo.size.height`
/// minus a FIXED 40pt header guess; at Trent's text size (XXX Large) the real
/// header is ~15pt taller, so every page was cut for room it didn't have,
/// overflowed its frame, and the pinned pager was the thing pushed off the
/// bottom — "the pager disappears on page 2, and you can't get back to page
/// 1." The cluster-title rows had the same kind of lie in them (counted at
/// 15pt, drawn at 20 with their padding). Every line's height now comes from
/// `QuotaFlow.height(of:isFirstOnPage:)`, which reads the SAME constants the
/// lines are drawn with.
///
/// PURE OVER `entry`, except the reader's metrics: this view (and
/// everything below it in this file) reads no `WidgetStore` directly —
/// `entry.showMet`/`entry.page` are already resolved by the provider, and
/// `entry.sections` already carry the `showMet` filtering baked in.
private struct QuotasListView: View {
    let entry: TrackEntry
    /// systemLarge only. Drives whether paging (and the bottom row) exists
    /// at all — medium simply renders as many lines as fit.
    let isLarge: Bool

    /// The same gap Reminders' `systemLarge` card puts between its header
    /// and its body.
    private var rowSpacing: CGFloat {
        isLarge ? WidgetTheme.rowSpacing : WidgetTheme.compactRowSpacing
    }

    var body: some View {
        if entry.isSignedOut {
            WidgetSignedOutView()
        } else {
            VStack(alignment: .leading, spacing: rowSpacing) {
                header

                RenderedTextReader { size, metrics in
                    listBody(size: size, metrics: metrics)
                }

                if let staleSince = entry.staleSince {
                    HStack {
                        Spacer()
                        StalenessNote(fetchedAt: staleSince)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    /// The current page's lines plus (systemLarge) the bottom row — pinned
    /// to the bottom edge and ALWAYS present on large: the "met" dot lives
    /// there, and the pager (`‹ n/N ›`) is in it on EVERY page whenever there
    /// is more than one. Its height and its `rowSpacing` gap come off the
    /// page budget before paging, and the layout adds exactly those two
    /// (see `RemindersListView.listBody`'s note on the zero-spacing outer
    /// stack).
    private func listBody(size: CGSize, metrics: WidgetTextMetrics) -> some View {
        let barHeight = metrics.bottomBarHeight
        let budget = max(size.height - (isLarge ? barHeight + rowSpacing : 0), 0)
        let pages = QuotaFlow.paginate(
            lines: QuotaFlow.lines(sections: entry.sections, width: size.width), pageHeight: budget
        )
        // Medium never pages — it always shows whatever fits from the top.
        let page = isLarge ? min(max(entry.page, 0), pages.count - 1) : 0

        return VStack(alignment: .leading, spacing: 0) {
            if entry.sections.isEmpty {
                WidgetEmptyView(symbol: "target", message: emptyQuotasMessage)
            } else {
                QuotaLinesView(lines: pages[page])
            }

            Spacer(minLength: 0)

            if isLarge {
                ListBottomBar(height: barHeight) {
                    EmptyView()
                } pager: {
                    if pages.count > 1 {
                        ListPager(
                            page: page, totalPages: pages.count,
                            previous: ShiftQuotasPageIntent(offset: -1),
                            next: ShiftQuotasPageIntent(offset: 1)
                        )
                    }
                } trailing: {
                    // "Show met quotas" (2026-09-24: the header eye, moved
                    // down as the same dot Reminders/Tasks use for "show
                    // completed" — see `CompletedDotToggle`).
                    CompletedDotToggle(
                        intent: ToggleQuotasShowMetIntent(), isOn: entry.showMet, label: "met", height: barHeight
                    )
                }
                .padding(.top, rowSpacing)
            }
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        // A single wrapped chip is the one line that can't be shortened
        // further; clipping here is the backstop that keeps even a
        // mis-measured one inside the card rather than across its edge.
        .clipped()
    }

    /// Matches the Reminders/Tasks header shape (`.headline` title +
    /// `.caption2` subtitle), with only Undo/Redo beside it (2026-09-24).
    /// The header chevrons are gone — they paged the SAME pages as the
    /// bottom pager, and Trent couldn't tell what they switched — and the
    /// show-met eye is now the bottom row's "met" dot.
    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: WidgetTheme.headerSpacing) {
            Link(destination: WidgetLink.quotas) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Quotas")
                        .font(.headline)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                    // "Undid: …" / "Redid: …" for ~60s after an undo/redo —
                    // see `WidgetStore`'s "Last-action indication" doc.
                    Text(entry.actionDescription ?? "\(entry.totalMet) of \(entry.totalCount) met")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.6)
                }
                .contentShape(Rectangle())
            }
            .layoutPriority(1)
            Spacer(minLength: 0)
            UndoRedoButtons(canUndo: entry.canUndo, canRedo: entry.canRedo)
        }
        .padding(.top, isLarge ? WidgetTheme.headerTopPadding : 0)
    }
}

/// The current page's flowed lines, drawn in order — a heading, a cluster
/// label, or one complete chip row. This view never wraps or re-measures
/// anything itself; `QuotaFlow.lines` already decided exactly what belongs
/// on each line, and cutting a page between two `Line`s (never inside a
/// `.chipRow`) is what keeps a chip from ever being cut in half. Every
/// padding here is a `QuotaMetrics` constant that `QuotaFlow.height(of:
/// isFirstOnPage:)` also counts — the page a line is drawn on is the page
/// it was measured for.
private struct QuotaLinesView: View {
    let lines: [QuotaFlow.Line]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(lines.enumerated()), id: \.element.id) { index, line in
                switch line {
                case .heading(let section):
                    // A thin divider between period sections, never before
                    // the page's first line — mirrors the web panel's
                    // `SECTION_DIVIDER`.
                    if index > 0 {
                        Rectangle()
                            .fill(Color.primary.opacity(0.08))
                            .frame(height: QuotaMetrics.dividerHeight)
                            .padding(.top, QuotaMetrics.dividerTopPadding)
                            .padding(.bottom, QuotaMetrics.dividerBottomPadding)
                    }
                    QuotaHeadingRow(section: section)
                case .clusterTitle(let cluster):
                    QuotaClusterTitleRow(cluster: cluster)
                        .padding(.top, QuotaMetrics.clusterTitleTopPadding)
                        .padding(.bottom, QuotaMetrics.clusterTitleBottomPadding)
                case .chipRow(_, let color, let chips, let wrapWidth):
                    QuotaChipRow(color: color, chips: chips, wrapWidth: wrapWidth)
                        .padding(.bottom, QuotaMetrics.chipRowSpacing)
                }
            }
        }
    }
}

/// A period section's heading row — period name (bold, full-strength, so it
/// outranks the muted cluster labels beneath it), a muted "N days left"
/// (omitted for Today — PR #62 — and the no-period section, the bar taking
/// that width), a bar that flexes to fill
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
                        .fill(section.allMet ? WidgetTheme.trackMetTint : WidgetTheme.indigoAccent)
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
/// handed to this view). `wrapWidth` is set on a row holding ONE chip too
/// long for a line of its own — see `QuotaChip.wrapWidth`.
private struct QuotaChipRow: View {
    let color: String?
    let chips: [TrackItem]
    let wrapWidth: CGFloat?

    var body: some View {
        HStack(spacing: QuotaMetrics.chipRowGap) {
            ForEach(chips) { item in
                QuotaChip(item: item, color: color, wrapWidth: wrapWidth)
            }
        }
    }
}

/// One quota, as a chip — the widget's only progress control, one button,
/// no second hit target per chip. Tapping opens nothing;
/// `IncrementProgressIntent` fires straight from the chip:
///
/// - **Unmet**: `+1`.
/// - **Met** (2026-09-24): `−1`, and the chip says so with a trailing
///   "│ −1" (`QuotaMetrics.takeBackLabel`, counted in `chipWidth(for:)`).
///   Trent over-tapped "All Kids Kazoo" to 2/1 because a met chip was still
///   a `+1`; past the target a `+1` is almost always a mis-tap, and the one
///   thing worth doing to a met quota from a widget is correcting one. A met
///   chip only ever RENDERS with the "met" dot on — with it off, met chips
///   are filtered out (`QuotaSectionBuilder`, no grace window) — so gating
///   on `item.isMet` alone is "met and the dot is on" by construction. The
///   header Undo still reverses the last action, whatever it was.
///
/// Two shapes:
///
/// - **Fits a line** (`wrapWidth == nil`): one line, `.fixedSize()` at the
///   width `QuotaMetrics.chipWidth(for:)` measured.
/// - **Too long for any line** (`wrapWidth` = the card's width, 2026-09-24):
///   Trent's real quotas have no short names yet ("Kids all blow up balloon
///   (teach josie PRI position + breath…", "Run the card maintenance skill
///   (/maintenance:cards) in a fresh chat"), and a one-line chip ran straight
///   past the card's edge. Now the chip is exactly the card's width, the
///   title wraps to at most TWO lines inside it with the count still
///   trailing, and only a title still too long after two lines is cut —
///   at the end of line 2. `QuotaFlow` gives the row the two-line height.
private struct QuotaChip: View {
    let item: TrackItem
    let color: String?
    let wrapWidth: CGFloat?

    private var fraction: Double { item.doneFraction }

    var body: some View {
        Button(intent: IncrementProgressIntent(taskId: item.task.id, delta: item.isMet ? -1 : 1)) {
            if let wrapWidth {
                content(lines: QuotaMetrics.wrappedTitleLines)
                    .frame(width: wrapWidth, height: QuotaMetrics.chipHeight(lines: QuotaMetrics.wrappedTitleLines))
                    .modifier(ChipChrome(item: item, fillAndStripe: fillAndStripe))
            } else {
                content(lines: 1)
                    .frame(height: QuotaMetrics.chipHeight)
                    .modifier(ChipChrome(item: item, fillAndStripe: fillAndStripe))
                    .fixedSize()
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            Text(
                "\(item.isMet ? "Take one back from" : "Log one more for") \(item.task.displayTitle) — "
                    + "\(item.task.progressCurrent) of \(item.task.progressTarget)"
            )
        )
    }

    private func content(lines: Int) -> some View {
        HStack(spacing: QuotaMetrics.chipTitleCountGap) {
            Text(item.task.displayTitle)
                .font(QuotaMetrics.chipTitleFont)
                .foregroundStyle(.primary)
                .lineLimit(lines)
                .truncationMode(.tail)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: lines > 1 ? .infinity : nil, alignment: .leading)
            count
        }
        .padding(.leading, QuotaMetrics.chipLeadingPadding)
        .padding(.trailing, QuotaMetrics.chipTrailingPadding)
    }

    private var count: some View {
        HStack(spacing: 0) {
            Text("\(item.task.progressCurrent)")
                .font(QuotaMetrics.chipCurrentFont)
            Text("/\(item.task.progressTarget)")
                .font(QuotaMetrics.chipTargetFont)
            if item.isMet {
                // "│ −1" — exactly `QuotaMetrics.takeBackWidth`: gap,
                // hairline, gap, label (see `chipWidth(for:)`).
                Rectangle()
                    .fill(WidgetTheme.trackMetTint.opacity(0.45))
                    .frame(width: QuotaMetrics.takeBackDividerWidth, height: QuotaMetrics.chipCountSize + 1)
                    .padding(.horizontal, QuotaMetrics.chipTitleCountGap)
                Text(QuotaMetrics.takeBackLabel)
                    .font(QuotaMetrics.chipCurrentFont)
            }
        }
        .monospacedDigit()
        .foregroundStyle(item.isMet ? WidgetTheme.trackMetTint : Color.secondary)
        .fixedSize()
    }

    /// The chip's base fill, the progress fill (indigo, green once met — a
    /// STRONGER opacity than the section bar's own fill: the mockup and the
    /// original spec prose both call for a bolder progress fill on the chip
    /// specifically), and the label's 3pt leading stripe, painted AFTER the
    /// fill so a fully-met chip's fill never tints the stripe green
    /// underneath it.
    ///
    /// Base is `.fill.secondary` (an adaptive system fill), not a literal
    /// dark gray: WidgetKit's `.containerBackground` already makes this card
    /// light in Light Appearance and dark in Dark Appearance, so a hardcoded
    /// dark chip background read as black-on-black text in Light Appearance.
    ///
    /// `WidgetTheme.indigoAccent` — the app's one "in progress" accent, the
    /// same constant `ReminderSlotStrip.color(for:)` uses for `.behind`.
    private var fillAndStripe: some View {
        ZStack(alignment: .leading) {
            Rectangle().fill(.fill.secondary)
            GeometryReader { geo in
                (item.isMet ? WidgetTheme.trackMetTint : WidgetTheme.indigoAccent)
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

/// A chip's background, border and rounded clip — shared by both chip
/// shapes so the one-line and two-line chips can't drift apart visually.
private struct ChipChrome<Fill: View>: ViewModifier {
    let item: TrackItem
    let fillAndStripe: Fill

    func body(content: Content) -> some View {
        content
            .background(fillAndStripe)
            .overlay(
                RoundedRectangle(cornerRadius: QuotaMetrics.chipCornerRadius)
                    .strokeBorder(
                        item.isMet ? WidgetTheme.trackMetTint.opacity(0.3) : Color.primary.opacity(0.12), lineWidth: 1
                    )
            )
            .clipShape(RoundedRectangle(cornerRadius: QuotaMetrics.chipCornerRadius))
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
                    allMet ? WidgetTheme.trackMetTint : WidgetTheme.indigoAccent,
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
