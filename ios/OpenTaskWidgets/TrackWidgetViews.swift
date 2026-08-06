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
            TrackListView(entry: entry, capacity: 3, isLarge: false)
        default:
            // Eight, not six: a real quota corpus is around eight items, and at
            // six the 4×4 was paging a list that would have fit — the user read
            // the chevrons as "the way to scroll", which is the one thing a
            // Home Screen list should never need. See `TrackRow` for what got
            // compacted to buy the two extra rows.
            TrackListView(entry: entry, capacity: 8, isLarge: true)
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
///
/// And no `−` here, unlike the list families: a fourth control on that bottom
/// row would put four 36pt+ targets across ~126pt, which is a mis-tap machine —
/// and mis-tapping a correction while trying to log is the worst possible place
/// for it. Corrections belong to the 4×4, the 4×2, or the app; a mis-logged 2×2
/// is one tap away from either.
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
    /// Rows that fit when the card carries no pager chrome.
    let capacity: Int
    /// Drives the two things systemMedium has no room for: the adjacent-quota
    /// chevron labels (see `ChevronPager`) and the "+N more" line. A quota row
    /// is two lines tall, so three of them plus a header already fill a 4×2 —
    /// the overflow line was clipping off the bottom edge, and the chevrons say
    /// "there is more" anyway.
    let isLarge: Bool

    /// The rows on screen.
    ///
    /// When everything fits, the list is simply the list — no window, no wrap,
    /// no arithmetic. When it doesn't, the window starts at the selected item
    /// and wraps, so the chevrons scroll it one row at a time and every quota is
    /// reachable — the same selection the 2×2 pages through, just shown with its
    /// neighbours.
    private var window: [TrackItem] {
        guard canPage else { return entry.items }
        let start = entry.selectedIndex ?? 0
        return (0..<maxRows).map { entry.items[(start + $0) % entry.items.count] }
    }

    /// Paging costs a row. The pager's 40pt hit targets deepen the header and
    /// the "+N more" line takes another band, which together is about one row of
    /// height — so the window shrinks by one the moment there is anything to
    /// page to, rather than letting the last row clip off the bottom edge.
    private var maxRows: Int { canPage ? capacity - 1 : capacity }

    /// True only when the corpus genuinely overflows the card.
    ///
    /// Below that there are no chevrons AT ALL — not dimmed ones (§8's usual
    /// treatment for a ring with nowhere to go), none. A pager over a list that
    /// is already entirely on screen is chrome that has to be interpreted before
    /// it can be dismissed, and the interpretation users reach for is "this is
    /// how I scroll", which turns a complete list into a puzzle. With eight rows
    /// of capacity the ordinary corpus simply fits, and the ordinary card is
    /// then a list and nothing else.
    private var canPage: Bool { entry.items.count > capacity }

    var body: some View {
        if entry.isSignedOut {
            WidgetSignedOutView()
        } else {
            // 4pt between the bands (header / rows / footnotes), not
            // `rowSpacing`'s 10: at eight rows the card has no 10pt gaps to
            // spare. See `WidgetTheme.trackRowSpacing`.
            VStack(alignment: .leading, spacing: 4) {
                header

                if entry.items.isEmpty {
                    WidgetEmptyView(symbol: "target", message: emptyTrackMessage)
                } else {
                    VStack(alignment: .leading, spacing: WidgetTheme.trackRowSpacing) {
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

    /// One line, not two: the title and the count sat stacked, and that second
    /// band cost a row of quotas the card would rather spend on content.
    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text("Track")
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
            Text(countLabel)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer(minLength: 0)
            if canPage {
                ChevronPager(
                    previous: ShiftTrackItemIntent(offset: -1),
                    next: ShiftTrackItemIntent(offset: 1),
                    previousLabel: entry.neighborTitle(offset: -1),
                    nextLabel: entry.neighborTitle(offset: 1),
                    showsLabels: isLarge
                )
            }
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

/// One quota row: title, count, bar with its pace tick, `−`, and `+1`.
///
/// Deliberately compact — `.footnote` rather than `.subheadline`, a 3pt bar,
/// 2pt between the two lines — so the row is no taller than the 36pt buttons it
/// carries and eight of them fit a 4×4 whole. The chrome shrank; the touch
/// targets did not.
private struct TrackRow: View {
    let item: TrackItem

    /// The count as DRAWN, staged deltas included (`TaskFeed` applies them
    /// before the view ever sees the task), which is what decides whether `−`
    /// has anything to undo.
    private var canDecrement: Bool { item.task.progressCurrent > 0 }

    var body: some View {
        HStack(spacing: 2) {
            Link(destination: WidgetLink.task(item.task.id)) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(item.task.title)
                            .font(.footnote)
                            .fontWeight(WidgetTheme.priorityWeight(item.task.priority))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)

                        QuotaCount(item: item, font: .caption2)
                    }

                    QuotaBar(item: item, height: 3)
                }
                .contentShape(Rectangle())
            }

            MinusOneButton(taskId: item.task.id, enabled: canDecrement)
            PlusOneButton(taskId: item.task.id)
        }
    }
}

// MARK: - Lock Screen

/// Glanceable only — §8: interactive widgets are inert on a locked device, so a
/// `+1` (or `−`) button here would be a control that silently does nothing.
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

/// The quota's primary control. `+1`, never a check-off: §5 says a sub-target
/// increment must not fire the completion path, and at target the item stays
/// open to its period boundary anyway.
private struct PlusOneButton: View {
    let taskId: Int

    var body: some View {
        Button(intent: IncrementProgressIntent(taskId: taskId, delta: 1)) {
            Text("+1")
                .font(.caption.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(.primary)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(.fill.secondary, in: Capsule())
                // The visible capsule is ~24pt; the TARGET is 36, matching the
                // check-off circles. The row is sized by this frame, so shrink
                // the capsule to fit more rows and never this.
                .frame(minWidth: WidgetTheme.progressButtonSize, minHeight: WidgetTheme.progressButtonSize)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// The correction. A mis-log used to be un-fixable anywhere but the app — the
/// widget could only ever count up — so a fat-fingered `+1` left a number the
/// user knew was wrong sitting on their Home Screen all period.
///
/// Quieter than `+1` on purpose: same 36pt target, but a bare glyph on the
/// faintest fill, because logging is the everyday act and correcting is the rare
/// one. It DIMS and disables at 0 rather than disappearing (the `ChevronButton`
/// treatment): hiding it would slide `+1` sideways every time a count crossed
/// 0/1, moving the one control the user is aiming at.
private struct MinusOneButton: View {
    let taskId: Int
    var enabled = true

    var body: some View {
        Button(intent: IncrementProgressIntent(taskId: taskId, delta: -1)) {
            Text("−")
                .font(.caption.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(.fill.quaternary, in: Capsule())
                .frame(minWidth: WidgetTheme.progressButtonSize, minHeight: WidgetTheme.progressButtonSize)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(enabled ? 1 : 0.3)
        .disabled(!enabled)
        // "−" alone reads as a hyphen to VoiceOver.
        .accessibilityLabel(Text("Remove one"))
    }
}
