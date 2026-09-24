import SwiftUI
import WidgetKit

/// Dispatches to the right layout for whichever accessory family the system
/// is asking for. Accessory widgets render inside `.widgetAccentable()`'s
/// monochrome/tinted contexts on the Smart Stack and watch face, so every
/// color below is marked so it collapses correctly there — WidgetKit
/// substitutes its own tint outside full-color contexts regardless, but
/// explicit accent marking keeps the RIGHT elements (the ✓ disc, the ring)
/// picked over incidental ones.
///
/// **Tap targets.** Every family carries a whole-card `.widgetURL`
/// (`WatchWidgetEntry.deepLink` — Reminders or Tasks page of the watch app);
/// on the rectangular card the `Button(intent:)`s sit on top of it and win
/// their own hit area, so "tap the card outside the buttons" opens the app
/// and "tap ✓" checks off without opening anything.
struct ReminderStackWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: WatchWidgetEntry

    var body: some View {
        Group {
            switch family {
            case .accessoryRectangular:
                RectangularView(entry: entry)
            case .accessoryCorner:
                CornerView(entry: entry)
            default:
                CircularView(entry: entry)
            }
        }
        .widgetURL(entry.deepLink)
        // Every family must declare its background explicitly on modern
        // WidgetKit — Xcode's preview harness refuses to render without it
        // ("WidgetBackgroundAbsentError"). `.clear` because an accessory
        // widget draws on the watch face / Smart Stack's own chrome.
        .containerBackground(.clear, for: .widget)
    }
}

// MARK: - Rectangular (the card)

private struct RectangularView: View {
    let entry: WatchWidgetEntry

    var body: some View {
        switch entry.content {
        case .signedOut:
            Text("Open OpenTask on your iPhone to connect")
                .font(.caption2)
                .widgetAccentable()
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        case .reminder(let card):
            ReminderCardView(card: card)
        case .caughtUp(let card):
            CaughtUpCardView(card: card)
        case .overdue(let card):
            OverdueCardView(card: card)
        case .snoozed(let result):
            SnoozedCardView(result: result)
        }
    }
}

/// One reminder, in full, with a big ✓ and a small ⏭.
///
/// Layout: text column on the leading side (header, optional urgent line,
/// then the title taking EVERY remaining line), a fixed 36pt button column
/// on the trailing edge — ⏭ at the top, ✓ at the bottom, where a thumb
/// lands on a wrist. Plain `HStack` siblings with fixed/flexible widths, not
/// overlapping views, so the buttons' hit areas can't bleed onto the text.
private struct ReminderCardView: View {
    let card: WatchWidgetEntry.ReminderCard

    /// ⏭ is pointless with one item left (it would just wrap back to itself).
    private var canSkip: Bool { card.remainingIds.count > 1 }

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            VStack(alignment: .leading, spacing: 1) {
                header
                if card.urgentOverdue > 0 {
                    UrgentLine(count: card.urgentOverdue)
                }
                FittingTitle(title: card.title)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

            VStack(spacing: 0) {
                if canSkip {
                    Button(intent: SkipReminderIntent(
                        taskId: card.taskId, slotKey: card.slotKey, remainingIds: card.remainingIds
                    )) {
                        Image(systemName: "forward.fill")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.secondary)
                            .frame(width: ReminderStackMetrics.buttonColumn, height: 24)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Skip for now")
                }
                Spacer(minLength: 2)
                Button(intent: ConsiderReminderIntent(taskId: card.taskId)) {
                    Image(systemName: "checkmark")
                        .font(.system(size: 17, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: ReminderStackMetrics.buttonColumn, height: ReminderStackMetrics.buttonColumn)
                        .background(Circle().fill(WatchTheme.accent).widgetAccentable())
                        .contentShape(Circle())
                }
                .accessibilityLabel("Check off")
            }
            .buttonStyle(.plain)
            .frame(width: ReminderStackMetrics.buttonColumn)
        }
        // Pin the card to the family's full height. Without this the HStack
        // sizes to its tallest child, so hiding ⏭ (one item left) shrank the
        // button column, the card, and with it the title's room — the same
        // long reminder drew 4 lines with ⏭ and 3 without (simulator,
        // 2026-09-24).
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// "Early morning · 2 of 7" — the slot name is never cut: it scales down
    /// before it truncates (one line, `minimumScaleFactor`). A fixed 12pt,
    /// not a text style: `.caption2` rendered LARGER than the title's own
    /// smallest rung (`.caption`) in the Smart Stack card, and a header
    /// louder than the reminder cost the title a whole line in the first
    /// render (2026-09-24 RenderPreview).
    private var header: some View {
        Text("\(card.slotLabel) · \(card.position) of \(card.total)\(card.isLast ? " · last" : "")")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(WatchTheme.accent)
            .widgetAccentable()
            .lineLimit(1)
            .minimumScaleFactor(0.75)
    }
}

/// The reminder title, never truncated if it can fit (Trent's rule). A
/// ladder of candidates, largest first, and `ViewThatFits` takes the first
/// whose REAL wrapped height fits the space left under the header:
/// `.headline` → `.footnote` → `.caption`, each unlimited lines; only when
/// even `.caption` can't hold every line does the last candidate truncate,
/// with a trailing "…", as the last resort. Order verified by rendering, not
/// assumed: swapping the last two rungs drew the truncated fallback visibly
/// LARGER in the Smart Stack card (2026-09-24 RenderPreview), so `.caption`
/// really is the smallest rung in this context.
///
/// `.fixedSize(horizontal: false, vertical: true)` on every candidate but the
/// last is load-bearing: `ViewThatFits` compares IDEAL sizes, and a plain
/// `Text`'s ideal height is one unwrapped line — without it the first
/// candidate always "fits", then gets squeezed and truncated at `.headline`
/// (the same trap the phone widgets documented, `ios/CLAUDE.md` "Row counts").
private struct FittingTitle: View {
    let title: String

    var body: some View {
        ViewThatFits(in: .vertical) {
            candidate(.headline)
            candidate(.footnote.weight(.medium))
            candidate(.caption.weight(.medium))
            Text(title)
                .font(.caption.weight(.medium))
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private func candidate(_ font: Font) -> some View {
        Text(title)
            .font(font)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct UrgentLine: View {
    let count: Int

    var body: some View {
        Text("\(count) urgent overdue")
            .font(.caption2)
            .foregroundStyle(WatchTheme.overdue)
            .lineLimit(1)
    }
}

private struct CaughtUpCardView: View {
    let card: WatchWidgetEntry.CaughtUpCard

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Label {
                Text("All caught up")
                    .font(.headline)
            } icon: {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(WatchTheme.done)
                    .widgetAccentable()
            }
            if card.urgentOverdue > 0 {
                UrgentLine(count: card.urgentOverdue)
            }
            Text(nextLine)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private var nextLine: String {
        guard let label = card.nextSlotLabel else { return "Nothing left today" }
        let noun = card.nextSlotCount == 1 ? "reminder" : "reminders"
        if let start = card.nextSlotStart {
            return "Next: \(label) at \(DateHelpers.formatShortTime(start)) · \(card.nextSlotCount) \(noun)"
        }
        return "Next: \(label) · \(card.nextSlotCount) \(noun)"
    }
}

/// "N overdue" and ONE button: the sweep to the next period. Full-width
/// capsule at the bottom — the only control, so it gets the whole row.
private struct OverdueCardView: View {
    let card: WatchWidgetEntry.OverdueCard

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Label {
                Text("\(card.count) overdue")
                    .font(.headline)
            } icon: {
                Image(systemName: "exclamationmark.circle.fill")
                    .foregroundStyle(WatchTheme.overdue)
                    .widgetAccentable()
            }
            // Context line: which Urgent ones won't move (the honest caveat
            // before the tap), else the earliest overdue title.
            Group {
                if card.urgent > 0 {
                    Text("\(card.urgent) urgent won't move")
                        .foregroundStyle(WatchTheme.overdue)
                } else if let title = card.firstTitle {
                    Text(title)
                        .foregroundStyle(.secondary)
                }
            }
            .font(.caption2)
            .lineLimit(1)

            Spacer(minLength: 2)

            Button(intent: SnoozeOverdueNextPeriodIntent(targetLabel: card.targetLabel ?? "")) {
                Label(buttonTitle, systemImage: "moon.zzz.fill")
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, minHeight: 30)
                    .background(Capsule().fill(WatchTheme.accent).widgetAccentable())
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Snooze all overdue to the next period")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var buttonTitle: String {
        guard let label = card.targetLabel else { return "Snooze all → next" }
        return "Snooze all → \(label)"
    }
}

/// The server's real result of the sweep, for `snoozeResultWindow` — then
/// the card reverts to whatever the data calls for (usually reminders).
private struct SnoozedCardView: View {
    let result: WatchWidgetState.SnoozeResult

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Label {
                Text(result.tasksAffected > 0 ? "Snoozed \(result.tasksAffected)" : "Nothing to snooze")
                    .font(.headline)
            } icon: {
                Image(systemName: result.tasksAffected > 0 ? "checkmark.circle.fill" : "xmark.circle")
                    .foregroundStyle(result.tasksAffected > 0 ? WatchTheme.done : .secondary)
                    .widgetAccentable()
            }
            if result.tasksAffected > 0, let target = result.targetLabel {
                Text("Moved to \(target)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            // Only the counts that apply this run, like `BulkSnoozeSheetView`.
            if result.snoozedHigh > 0 {
                Text("Included \(result.snoozedHigh) High")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if result.skippedHigh > 0 {
                Text("\(result.skippedHigh) High still overdue")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if result.skippedUrgent > 0 {
                Text("\(result.skippedUrgent) Urgent still overdue")
                    .font(.caption2)
                    .foregroundStyle(WatchTheme.overdue)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

enum ReminderStackMetrics {
    /// The trailing button column / ✓ disc diameter — a finger target on a
    /// ~44mm screen; smaller and the ✓ becomes a mis-tap machine.
    static let buttonColumn: CGFloat = 36
}

// MARK: - Circular / Corner (glanceable rings)

/// Count-left-with-a-ring, shared by `.accessoryCircular` and
/// `.accessoryCorner`. Overdue (snoozable) wins the ring when present, in
/// red, matching the card's own precedence; otherwise the active slot's
/// reminders left, filling as they're considered. Glanceable only — a tap
/// opens the app on the matching page (`deepLink`); a button inside a
/// watch-face-sized ring would be a mis-tap machine, even though watchOS 11+
/// technically supports interactivity in every family.
private struct RingContent: View {
    let ring: WatchWidgetEntry.Ring

    var body: some View {
        Gauge(value: ring.fraction) {
            Text(ring.isOverdue ? "Overdue" : "Left")
        } currentValueLabel: {
            Text("\(ring.count)")
        }
        .gaugeStyle(.accessoryCircularCapacity)
        .tint(ring.isOverdue ? WatchTheme.overdue : WatchTheme.accent)
    }
}

private struct CircularView: View {
    let entry: WatchWidgetEntry

    var body: some View {
        if case .signedOut = entry.content {
            Image(systemName: "xmark.circle")
        } else {
            RingContent(ring: entry.ring)
        }
    }
}

private struct CornerView: View {
    let entry: WatchWidgetEntry

    var body: some View {
        if case .signedOut = entry.content {
            Text("OpenTask")
                .widgetLabel("Not connected")
        } else {
            RingContent(ring: entry.ring)
                .widgetLabel(entry.ring.label)
        }
    }
}
