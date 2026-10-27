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
    private var canSkip: Bool { card.remainingKeys.count > 1 }

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            VStack(alignment: .leading, spacing: 1) {
                header
                if card.urgentOverdue > 0 {
                    UrgentLine(count: card.urgentOverdue)
                }
                if card.promptKey != nil {
                    // A quota prompt (2026-09-24): the label-color stripe
                    // beside its label ("Piano Scales · 1/2"), as on every
                    // other surface.
                    HStack(alignment: .top, spacing: 4) {
                        RoundedRectangle(cornerRadius: 1.5)
                            .fill(WatchTheme.labelColor(card.stripeColor))
                            .frame(width: 3)
                        FittingTitle(title: ReminderStackMetrics.promptCardShowsDidIt
                            ? card.title
                            : "\(card.title)\(QuotaPromptDTO.countSeparator)\(card.countText ?? "")")
                    }
                } else if let meta = card.segmentMeta {
                    // A task segment row (2026-10-10): its small words
                    // ("Weeks · Nov 1") ride with the title.
                    // Joined so a wrap can't start a line with "·".
                    FittingTitle(title: "\(card.title)\(TaskDTO.metaJoiner)\(meta)")
                } else {
                    FittingTitle(title: card.title)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

            if let taskId = card.segmentTaskId {
                // ☐ DONE on a task segment row — the prompt card's ☐ column,
                // bottom-aligned beside the consider button.
                VStack(spacing: 0) {
                    Spacer(minLength: 0)
                    Button(intent: CompleteSegmentCardIntent(taskId: taskId)) {
                        Image(systemName: "square")
                            .font(.system(size: 20, weight: .semibold))
                            .foregroundStyle(WatchTheme.accent)
                            .widgetAccentable()
                            .frame(width: ReminderStackMetrics.didColumn, height: ReminderStackMetrics.buttonColumn)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Done")
                }
                .frame(width: ReminderStackMetrics.didColumn)
            }

            if let promptKey = card.promptKey, ReminderStackMetrics.promptCardShowsDidIt {
                // ☐ DID IT, its own column beside ✓'s, bottom-aligned with
                // it — see `ReminderStackMetrics.promptCardShowsDidIt`.
                VStack(spacing: 0) {
                    // The count, level with ⏭ and right above ☐ — its own
                    // line so it is never cut off with a long title (the
                    // title's last rung truncates; the count must not).
                    // Two lines since the period joined it (2026-09-25):
                    // "0/2" over "today" — one line truncated to "0/2 tod…"
                    // in this 30pt column.
                    Text(card.columnCountText ?? "")
                        .font(.system(size: 11, weight: .semibold).monospacedDigit())
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                        .minimumScaleFactor(0.7)
                        .frame(width: ReminderStackMetrics.didColumn, height: 24)
                    Spacer(minLength: 0)
                    Button(intent: ActOnPromptCardIntent(promptKey: promptKey, did: true)) {
                        Image(systemName: "square")
                            .font(.system(size: 20, weight: .semibold))
                            .foregroundStyle(WatchTheme.accent)
                            .widgetAccentable()
                            .frame(width: ReminderStackMetrics.didColumn, height: ReminderStackMetrics.buttonColumn)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Did it")
                }
                .frame(width: ReminderStackMetrics.didColumn)
            }

            VStack(spacing: 0) {
                if canSkip {
                    Button(intent: SkipReminderIntent(
                        itemKey: card.itemKey, slotKey: card.slotKey, remainingKeys: card.remainingKeys
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
                considerButton
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

    /// "Early morning · 2 left" — how many of the slot's reminders are still
    /// waiting, the shown one included (Trent, 2026-09-24: "4 of 5" read as
    /// a mystery; "2 left" says what's left to do). The slot name is never cut: it scales down
    /// before it truncates (one line, `minimumScaleFactor`). A fixed 12pt,
    /// not a text style: `.caption2` rendered LARGER than the title's own
    /// smallest rung (`.caption`) in the Smart Stack card, and a header
    /// louder than the reminder cost the title a whole line in the first
    /// render (2026-09-24 RenderPreview).
    /// CONSIDERED, for a reminder and a quota prompt alike (the same verb on
    /// both). A prompt goes through its own endpoint by key; a done on a
    /// quota is refused server-side. The glyph differs: ✓ on a reminder, a
    /// DASHED circle on a prompt (2026-09-25; briefly an eye) — for a prompt
    /// the button means "seen", not "done", as on every other prompt surface.
    /// Same disc, same size.
    private var considerButton: some View {
        let glyph = card.segmentTaskId != nil ? "circle" : (card.promptKey == nil ? "checkmark" : "circle.dashed")
        let label = Image(systemName: glyph)
            .font(.system(size: 17, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: ReminderStackMetrics.buttonColumn, height: ReminderStackMetrics.buttonColumn)
            .background(Circle().fill(WatchTheme.accent).widgetAccentable())
            .contentShape(Circle())
        return Group {
            if let taskId = card.segmentTaskId {
                // A task segment row: "I saw it" — never a completion.
                Button(intent: ConsiderSegmentCardIntent(taskId: taskId)) { label }
                    .accessibilityLabel("Considered")
            } else if let promptKey = card.promptKey {
                Button(intent: ActOnPromptCardIntent(promptKey: promptKey, did: false)) { label }
                    .accessibilityLabel("Considered")
            } else {
                Button(intent: ConsiderReminderIntent(taskId: card.taskId)) { label }
                    .accessibilityLabel("Check off")
            }
        }
    }

    /// "Early morning · 3 left", "Task queue · Daily · 2 left". A segment's
    /// title is the long one (2026-10-26): "Task queue · Upcoming · 1 left"
    /// ran past the card and lost its count. So the full words when they
    /// fit, else the segment's word alone ("Upcoming · 1 left" — the
    /// page's colour already says it's the task queue), and only then the
    /// old shrink.
    ///
    /// An Upcoming row's label names its section (2026-10-26, ruling 4):
    /// "Upcoming · Tomorrow · 1 left" doesn't fit either, so a segment card
    /// next tries its label alone — "Upcoming · Tomorrow", "Daily" — before
    /// the shrink: the section is the ruling's words, the count the extra.
    private var header: some View {
        let short = TaskWording.withoutTaskQueuePrefix(card.slotLabel)
        let isSegment = card.segmentTaskId != nil
        return ViewThatFits(in: .horizontal) {
            headerText(card.slotLabel).fixedSize()
            if let short {
                headerText(short).fixedSize()
            }
            if isSegment {
                headerText(short ?? card.slotLabel, count: false).fixedSize()
            }
            headerText(short ?? card.slotLabel, count: !isSegment).minimumScaleFactor(0.75)
        }
    }

    private func headerText(_ label: String, count: Bool = true) -> some View {
        Text(count ? "\(label) · \(card.remainingKeys.count) left" : label)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(WatchTheme.accent)
            .widgetAccentable()
            .lineLimit(1)
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
/// (the same trap the phone widgets documented, `ios/AGENTS.md` "Row counts").
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
        Text("\(count) urgent \(TaskWording.overdueLower)")
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
                // "All caught up" until 2026-09-29 — the phone widget's
                // words now (`ReminderDayProgress`).
                Text(card.isDayComplete ? "Day complete" : "Complete")
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
        // "waiting", not "reminders": the count includes quota prompts
        // (2026-09-25), the same "N left" the reminder card's header uses.
        if let start = card.nextSlotStart {
            return "Next: \(label) at \(DateHelpers.formatShortTime(start)) · \(card.nextSlotCount) waiting"
        }
        return "Next: \(label) · \(card.nextSlotCount) waiting"
    }
}

/// "N overdue" and two buttons side by side, sharing the bottom row: "+1h"
/// (filled — the default, Trent 2026-09-28) and "⏭ 4:30 PM", the sweep to
/// the next period, labelled with its time rather than the words "next
/// period" (⏭ always means next period; the time is what helps).
private struct OverdueCardView: View {
    let card: WatchWidgetEntry.OverdueCard

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Label {
                Text("\(card.count) \(TaskWording.overdueLower)")
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

            HStack(spacing: 4) {
                Button(intent: SnoozeOverduePlusHourIntent()) {
                    pill(Text("+1h"), filled: true)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Defer everything \(TaskWording.overdueLower) one hour")

                Button(intent: SnoozeOverdueNextPeriodIntent(targetLabel: card.targetLabel ?? "")) {
                    pill(nextPeriodLabel, filled: false)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Defer everything \(TaskWording.overdueLower) to the next period")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// "⏭ 4:30 PM"; just "⏭" when there is no slot to preview (the server
    /// still resolves "next" itself).
    private var nextPeriodLabel: Text {
        let icon = Image(systemName: "forward.end.fill")
        guard let date = card.targetDate else { return Text(icon) }
        return Text("\(icon) \(DateHelpers.formatShortTime(date))")
    }

    private func pill(_ label: Text, filled: Bool) -> some View {
        label
            .font(.caption.weight(.semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .foregroundStyle(filled ? Color.white : Color.primary)
            .frame(maxWidth: .infinity, minHeight: 30)
            .background(
                Capsule()
                    .fill(filled ? WatchTheme.accent : Color.secondary.opacity(0.3))
                    .widgetAccentable(filled)
            )
            .contentShape(Capsule())
    }
}

/// The server's real result of the sweep, for `snoozeResultWindow` — then
/// the card reverts to whatever the data calls for (usually reminders).
private struct SnoozedCardView: View {
    let result: WatchWidgetState.SnoozeResult

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Label {
                Text(result.tasksAffected > 0 ? "Deferred \(result.tasksAffected)" : "Nothing to defer")
                    .font(.headline)
            } icon: {
                Image(systemName: result.tasksAffected > 0 ? "checkmark.circle.fill" : "xmark.circle")
                    .foregroundStyle(result.tasksAffected > 0 ? WatchTheme.done : .secondary)
                    .widgetAccentable()
            }
            if let moved = result.movedToLabel {
                Text(moved)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            // Only the counts that apply this run — the same lines as
            // `BulkSnoozeSheetView` (`SweepLine`).
            ForEach(Array(result.summaryLines.enumerated()), id: \.offset) { _, line in
                Text(line.text)
                    .font(.caption2)
                    .foregroundStyle(line.isUrgent ? WatchTheme.overdue : .secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

enum ReminderStackMetrics {
    /// The trailing button column / ✓ disc diameter — a finger target on a
    /// ~44mm screen; smaller and the ✓ becomes a mis-tap machine.
    static let buttonColumn: CGFloat = 36
    /// A quota prompt card's ☐ (did-it) column, beside ✓'s.
    static let didColumn: CGFloat = 30
    /// Whether a quota prompt card draws ☐ DID IT (with the count above it)
    /// beside ✓ CONSIDERED — quota reminders, 2026-09-24, decided on
    /// RenderPreview of realistic prompts (`ReminderStackPreviewData`'s
    /// "Prompt —" previews). It fits: the column costs the title ~36pt, and
    /// the only title that doesn't fit with it ("Look for new evening
    /// courses — …", the longest quota title) doesn't fit without it either
    /// — the card's last rung truncates it either way, as it does paragraph
    /// reminders. The
    /// count sits in the column's top slot, level with ⏭, so it is never
    /// cut off with the title. Off = consider only (count back in the title).
    static let promptCardShowsDidIt = true
}

// MARK: - Circular / Corner (glanceable rings)

/// Count-left-with-a-ring, shared by `.accessoryCircular` and
/// `.accessoryCorner`. Overdue (snoozable) wins the ring when present, in
/// plum, matching the card's own precedence; otherwise the active slot's
/// reminders left, filling as they're considered.
///
/// Colour (Trent, 2026-10-26): a progress indicator like every bar, so the
/// same rule — the reminders' purple while it fills
/// (`WatchTheme.dayBarFilling`), the done green once full (`ringSummary`'s
/// "Complete": fraction 1 only when no started period has anything
/// waiting). It was indigo (`WatchTheme.accent`) until then. Overdue keeps
/// its plum and wins first. On a tinted or monochrome face the system's
/// tint replaces all of these; the colours show in full-colour contexts.
///
/// Glanceable only — a tap
/// opens the app on the matching page (`deepLink`); a button inside a
/// watch-face-sized ring would be a mis-tap machine, even though watchOS 11+
/// technically supports interactivity in every family.
private struct RingContent: View {
    let ring: WatchWidgetEntry.Ring

    var body: some View {
        Gauge(value: ring.fraction) {
            Text(ring.isOverdue ? TaskWording.overdue : "Left")
        } currentValueLabel: {
            Text("\(ring.count)")
        }
        .gaugeStyle(.accessoryCircularCapacity)
        .tint(tint)
    }

    private var tint: Color {
        if ring.isOverdue { return WatchTheme.overdue }
        return ring.fraction >= 1 ? WatchTheme.done : WatchTheme.dayBarFilling
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
