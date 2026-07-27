import SwiftUI
import WidgetKit

/// The Track widget's rendering, across all five supported families.
///
/// §5 shapes this surface the way §6 shapes Reminders. A quota is not a
/// deadline: it asks "how far in am I", never "am I late". So nothing here is
/// red, nothing counts days, and *pace renders but never alarms* — being behind
/// moves one small neutral tick and changes the row order, and that is all it
/// is allowed to do. Per L1 a low count late in a period may only mean the user
/// hasn't logged, which is precisely the wrong thing to shout about.
///
/// Reaching target does NOT remove a row: §5 is period-anchored, the item stays
/// open to its rrule boundary, and a fourth log on a 3× quota has to be able to
/// show 4/3. "Met" is therefore a visual state — filled ring, green fraction, a
/// small check — not a filter.
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
        case .accessoryCircular:
            TrackCircularView(entry: entry)
        case .accessoryRectangular:
            TrackRectangularView(entry: entry)
        case .systemSmall:
            TrackSmallView(entry: entry)
        case .systemMedium:
            TrackListView(entry: entry, maxRows: 3, isLarge: false)
        default:
            TrackListView(entry: entry, maxRows: 6, isLarge: true)
        }
    }
}

private let emptyTrackMessage = "Nothing tracked — set a target on a task to see it here."

// MARK: - systemSmall (the flagship, §8)

/// One quota, big.
///
/// §8 (amended 2026-07-27) calls this the flagship small layout: a quota
/// compresses to a ring plus a fraction perfectly, where a *list* of quotas
/// squeezed into 2×2 would be unreadable. So the 2×2 spends its whole area on
/// one item and gives the chevrons somewhere to matter.
///
/// The bottom row merges the two controls that would otherwise each want their
/// own row — `‹`, `+1`, `›` — because at ~126pt of usable height a 2×2 cannot
/// afford a ring, a title, a pager AND a button as four stacked bands. No
/// staleness note here for the same reason; the larger families carry it.
private struct TrackSmallView: View {
    let entry: TrackEntry

    var body: some View {
        if entry.isSignedOut {
            WidgetSignedOutView(compact: true)
        } else if let item = entry.selected {
            VStack(spacing: 2) {
                // Sized to leave the bottom row its 40pt and still clear the
                // shortest 2×2 (an SE's is ~132pt of usable height).
                QuotaRing(item: item, diameter: 62, lineWidth: 7)

                Text(item.task.title)
                    .font(.caption2)
                    .fontWeight(WidgetTheme.priorityWeight(item.task.priority))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .minimumScaleFactor(0.85)

                Spacer(minLength: 0)

                HStack(spacing: 0) {
                    ChevronButton(
                        intent: ShiftTrackItemIntent(offset: -1),
                        direction: .previous,
                        enabled: entry.items.count > 1
                    )
                    Spacer(minLength: 0)
                    PlusOneButton(taskId: item.task.id)
                    Spacer(minLength: 0)
                    ChevronButton(
                        intent: ShiftTrackItemIntent(offset: 1),
                        direction: .next,
                        enabled: entry.items.count > 1
                    )
                }
            }
            .frame(maxWidth: .infinity)
            // Everything that isn't one of the three buttons opens the quota.
            .widgetURL(WidgetLink.task(item.task.id))
        } else {
            WidgetEmptyView(symbol: "target", message: emptyTrackMessage, compact: true)
                .widgetURL(WidgetLink.dashboard)
        }
    }
}

// MARK: - systemMedium / systemLarge list

private struct TrackListView: View {
    let entry: TrackEntry
    let maxRows: Int
    /// Drives the two things systemMedium has no room for: the adjacent-quota
    /// chevron labels (see `ChevronPager`) and the "+N more" line. A quota row
    /// is two lines tall, so three of them plus a header already fill a 4×2 —
    /// the overflow line was clipping off the bottom edge, and the chevrons say
    /// "there is more" anyway.
    let isLarge: Bool

    /// The rows on screen.
    ///
    /// When everything fits, the list is simply the list. When it doesn't, the
    /// window starts at the selected item and wraps, so the chevrons scroll it
    /// one row at a time and every quota is reachable — the same selection the
    /// 2×2 pages through, just shown with its neighbours.
    private var window: [TrackItem] {
        guard canPage else { return entry.items }
        let start = entry.selectedIndex ?? 0
        return (0..<maxRows).map { entry.items[(start + $0) % entry.items.count] }
    }

    /// §8: a chevron with nowhere to go dims out rather than looking live and
    /// doing nothing. With every quota already on screen, paging is exactly
    /// that — a no-op the user would read as a broken button.
    private var canPage: Bool { entry.items.count > maxRows }

    var body: some View {
        if entry.isSignedOut {
            WidgetSignedOutView()
        } else {
            VStack(alignment: .leading, spacing: WidgetTheme.rowSpacing) {
                header

                if entry.items.isEmpty {
                    WidgetEmptyView(symbol: "target", message: emptyTrackMessage)
                } else {
                    VStack(alignment: .leading, spacing: WidgetTheme.rowSpacing) {
                        ForEach(window) { item in
                            TrackRow(item: item)
                        }
                    }
                    if canPage, isLarge {
                        Text("+\(entry.items.count - maxRows) more")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    Spacer(minLength: 0)
                }

                if let staleSince = entry.staleSince {
                    HStack {
                        Spacer()
                        StalenessNote(fetchedAt: staleSince)
                    }
                }
            }
            .widgetURL(WidgetLink.dashboard)
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: WidgetTheme.headerSpacing) {
            VStack(alignment: .leading, spacing: 1) {
                Text("Track")
                    .font(.headline)
                    .lineLimit(1)
                Text(countLabel)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            ChevronPager(
                previous: ShiftTrackItemIntent(offset: -1),
                next: ShiftTrackItemIntent(offset: 1),
                hasPrevious: canPage,
                hasNext: canPage,
                previousLabel: entry.neighborTitle(offset: -1),
                nextLabel: entry.neighborTitle(offset: 1),
                showsLabels: isLarge && canPage
            )
        }
    }

    /// "Met" is worth counting — it is the only summary a quota list has. There
    /// is deliberately no "behind" count: §5 forbids pace from alarming, and a
    /// "4 behind" headline is an alarm however calmly it is typeset.
    private var countLabel: String {
        guard !entry.items.isEmpty else { return "nothing tracked" }
        let met = entry.items.filter(\.isMet).count
        let tracked = "\(entry.items.count) tracked"
        return met > 0 ? "\(tracked) · \(met) met" : tracked
    }
}

/// One quota row: title, count, bar with its pace tick, and `+1`.
private struct TrackRow: View {
    let item: TrackItem

    var body: some View {
        HStack(spacing: 10) {
            Link(destination: WidgetLink.task(item.task.id)) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(item.task.title)
                            .font(.subheadline)
                            .fontWeight(WidgetTheme.priorityWeight(item.task.priority))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)

                        QuotaCount(item: item, font: .caption2)
                    }

                    QuotaBar(item: item)
                }
                .contentShape(Rectangle())
            }

            PlusOneButton(taskId: item.task.id)
        }
    }
}

// MARK: - Lock Screen

/// Glanceable only — §8: interactive widgets are inert on a locked device, so a
/// `+1` button here would be a control that silently does nothing.
private struct TrackRectangularView: View {
    let entry: TrackEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if entry.isSignedOut {
                Text("OpenTask")
                    .font(.headline)
                    .widgetAccentable()
                Text("Open to sign in")
                    .font(.caption2)
            } else if let item = entry.selected {
                HStack(spacing: 4) {
                    Text(item.task.title)
                        .font(.headline)
                        .widgetAccentable()
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    Text("\(item.task.progressCurrent)/\(item.task.progressTarget)")
                        .font(.caption.weight(.semibold))
                        .monospacedDigit()
                        .widgetAccentable()
                }
                QuotaBar(item: item, height: 4, monochrome: true)
            } else {
                Text("Track")
                    .font(.headline)
                    .widgetAccentable()
                Text("Nothing tracked")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .widgetURL(WidgetLink.dashboard)
    }
}

/// The selected quota as a capacity ring — the one shape that survives being
/// 30pt across and tinted by the system.
private struct TrackCircularView: View {
    let entry: TrackEntry

    var body: some View {
        Gauge(value: entry.selected?.doneFraction ?? 0) {
            Image(systemName: "target")
        } currentValueLabel: {
            Text("\(entry.selected?.task.progressCurrent ?? 0)")
                .minimumScaleFactor(0.7)
        }
        .gaugeStyle(.accessoryCircularCapacity)
        .widgetURL(WidgetLink.dashboard)
    }
}

// MARK: - Shared quota chrome

/// `n/target`, green once met. Overflow (4/3) is printed as-is — §5 keeps it
/// observable, so this never clamps the way the ring and bar do.
private struct QuotaCount: View {
    let item: TrackItem
    var font: Font = .caption2

    var body: some View {
        HStack(spacing: 2) {
            Text("\(item.task.progressCurrent)/\(item.task.progressTarget)")
                .font(font)
                .monospacedDigit()
            if item.isMet {
                Image(systemName: "checkmark")
                    .font(.system(size: 8, weight: .bold))
            }
        }
        .foregroundStyle(item.isMet ? WidgetTheme.trackMetTint : Color.secondary)
    }
}

/// The flagship shape: a progress ring with the fraction in the middle.
private struct QuotaRing: View {
    let item: TrackItem
    let diameter: CGFloat
    let lineWidth: CGFloat

    private var tint: Color {
        item.isMet ? WidgetTheme.trackMetTint : WidgetTheme.trackTint
    }

    var body: some View {
        ZStack {
            Circle()
                .stroke(.quaternary, lineWidth: lineWidth)

            Circle()
                .trim(from: 0, to: item.doneFraction)
                .stroke(tint, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))

            // The pace tick (§5): where the period's clock has got to. Neutral,
            // thin, and absent once met — a met quota has nothing left to be
            // behind on, and a marker there would only read as criticism.
            if let elapsed = item.elapsedFraction, !item.isMet {
                Circle()
                    .trim(from: max(elapsed - 0.006, 0), to: min(elapsed + 0.006, 1))
                    .stroke(.secondary, style: StrokeStyle(lineWidth: lineWidth + 4))
                    .rotationEffect(.degrees(-90))
            }

            VStack(spacing: -2) {
                Text("\(item.task.progressCurrent)/\(item.task.progressTarget)")
                    .font(.system(size: diameter * 0.29, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
                if item.isMet {
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

/// The list-row shape: a thin bar with the same pace tick as the ring.
private struct QuotaBar: View {
    let item: TrackItem
    var height: CGFloat = 4
    /// Lock Screen accessories are tinted wholesale by the system, so the two
    /// Track colors would collapse into one anyway — asking for them there just
    /// produces an unpredictable wash.
    var monochrome = false

    private var tint: Color {
        if monochrome { return .primary }
        return item.isMet ? WidgetTheme.trackMetTint : WidgetTheme.trackTint
    }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(.quaternary)

                Capsule()
                    .fill(tint)
                    .frame(width: max(geo.size.width * item.doneFraction, 0))

                if let elapsed = item.elapsedFraction, !item.isMet {
                    Capsule()
                        .fill(.secondary)
                        .frame(width: 1.5)
                        .offset(x: min(max(geo.size.width * elapsed - 0.75, 0), geo.size.width - 1.5))
                }
            }
        }
        .frame(height: height)
    }
}

/// The one control a quota needs. `+1`, never a check-off: §5 says a sub-target
/// increment must not fire the completion path, and at target the item stays
/// open to its period boundary anyway.
private struct PlusOneButton: View {
    let taskId: Int

    var body: some View {
        Button(intent: IncrementProgressIntent(taskId: taskId)) {
            Text("+1")
                .font(.caption.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(.primary)
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .background(.fill.secondary, in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}
