import SwiftUI
import WidgetKit

/// Dispatches to the right layout for whichever accessory family the system
/// is asking for. Accessory widgets render inside `.widgetAccentable()`'s
/// monochrome/tinted contexts on the Smart Stack and Lock Screen, so every
/// color use below is wrapped so it collapses correctly there — WidgetKit
/// substitutes its own tint outside of full-color contexts regardless of
/// what we specify, but explicit accent marking keeps the RIGHT elements
/// (the ring, the "left" count) picked over incidental ones.
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
        // Every family, accessory ones included, must declare its background
        // explicitly on modern WidgetKit — Xcode's preview harness refuses to
        // render without it ("WidgetBackgroundAbsentError: Get ready to
        // preview"), caught rendering this file's `#Preview`s. `.clear`
        // because an accessory widget draws on the watch face / Smart Stack's
        // own chrome; it must never paint an opaque card behind itself.
        .containerBackground(.clear, for: .widget)
    }
}

/// The "master" widget the task brief calls for: current slot name + "N
/// left", then whichever is more useful on the second line — the overdue
/// task count if anything is overdue (more pressing than the current slot),
/// else up to the first 1–2 upcoming reminder titles.
private struct RectangularView: View {
    let entry: WatchWidgetEntry

    var body: some View {
        if !entry.isConfigured {
            Text("Open OpenTask on your iPhone to configure")
                .font(.caption2)
                .widgetAccentable()
        } else {
            VStack(alignment: .leading, spacing: 1) {
                Text(headline)
                    .font(.headline)
                    .lineLimit(1)
                if !secondLine.isEmpty {
                    Text(secondLine)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            .widgetURL(URL(string: "opentask://reminders"))
        }
    }

    private var headline: String {
        entry.remindersLeft > 0
            ? "\(entry.slotLabel) · \(entry.remindersLeft) left"
            : "\(entry.slotLabel) · Done"
    }

    private var secondLine: String {
        if entry.overdueCount > 0 {
            return entry.overdueCount == 1 ? "1 task overdue" : "\(entry.overdueCount) tasks overdue"
        }
        return entry.upcomingTitles.joined(separator: " · ")
    }
}

/// Count-left-with-a-ring, shared body for `.accessoryCircular` and
/// `.accessoryCorner` (the corner family adds a curved `.widgetLabel` below).
/// Ring subject: the current slot's reminders while any remain, falling back
/// to the overdue task count once the slot is clear — there's only one ring,
/// so it always shows whichever number still needs attention.
private struct RingContent: View {
    let entry: WatchWidgetEntry

    private var showsOverdue: Bool { entry.remindersLeft == 0 && entry.overdueCount > 0 }

    private var fraction: Double {
        if showsOverdue { return 0 }
        guard entry.remindersTotal > 0 else { return entry.isConfigured ? 1 : 0 }
        return Double(entry.remindersTotal - entry.remindersLeft) / Double(entry.remindersTotal)
    }

    private var count: Int {
        showsOverdue ? entry.overdueCount : entry.remindersLeft
    }

    var body: some View {
        Gauge(value: fraction) {
            Text("Left")
        } currentValueLabel: {
            Text("\(count)")
        }
        .gaugeStyle(.accessoryCircularCapacity)
        .tint(showsOverdue ? WatchTheme.overdue : WatchTheme.accent)
    }
}

private struct CircularView: View {
    let entry: WatchWidgetEntry

    var body: some View {
        if entry.isConfigured {
            RingContent(entry: entry)
                .widgetURL(URL(string: "opentask://reminders"))
        } else {
            Image(systemName: "xmark.circle")
        }
    }
}

private struct CornerView: View {
    let entry: WatchWidgetEntry

    var body: some View {
        if entry.isConfigured {
            RingContent(entry: entry)
                .widgetLabel(entry.slotLabel)
                .widgetURL(URL(string: "opentask://reminders"))
        } else {
            Text("OpenTask")
                .widgetLabel("Not connected")
        }
    }
}
