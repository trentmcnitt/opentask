import SwiftUI
import WidgetKit

/// The Reminders widget's rendering, across all five supported families.
///
/// §6 shapes the whole surface: reminders are *prompted thoughts*, not actions.
/// They carry no debt — nothing here shows an overdue count, a red badge, or a
/// "days late" number, because those states do not exist for a reminder. The
/// only quantity on screen is "how many are still worth considering in this
/// slot", and checking one off means "I considered it".
struct RemindersWidgetView: View {
    @Environment(\.widgetFamily) private var family

    let entry: RemindersEntry

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
            RemindersCircularView(entry: entry)
        case .accessoryRectangular:
            RemindersRectangularView(entry: entry)
        case .systemSmall:
            RemindersSmallView(entry: entry)
        case .systemMedium:
            RemindersListView(entry: entry, maxRows: 3, showsChevronLabels: false)
        default:
            RemindersListView(entry: entry, maxRows: 6, showsChevronLabels: true)
        }
    }
}

// MARK: - systemSmall

/// The 2×2: glanceable only, by design.
///
/// §8 (amended 2026-07-27) wants a small variant of every kind, but a 2×2 is
/// ~126pt across — a check-off circle, a title and a pager in that width would
/// give three cramped targets where the large layout gives comfortable ones,
/// and a mis-tap here *completes the wrong reminder*. So this one states the
/// slot, how many are left and what the first one is, and the whole card is a
/// single tap into the Reminders surface.
private struct RemindersSmallView: View {
    let entry: RemindersEntry

    private var reminders: [TaskDTO] { entry.group?.reminders ?? [] }

    var body: some View {
        if entry.isSignedOut {
            WidgetSignedOutView(compact: true)
        } else {
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.group?.label ?? "Reminders")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)

                if reminders.isEmpty {
                    Spacer(minLength: 0)
                    WidgetEmptyView(
                        symbol: "checkmark.circle",
                        message: entry.groups.isEmpty ? "No reminders today" : "Nothing left here",
                        compact: true
                    )
                    Spacer(minLength: 0)
                } else {
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text("\(reminders.count)")
                            .font(.system(size: 40, weight: .semibold, design: .rounded))
                            .monospacedDigit()
                            .minimumScaleFactor(0.6)
                            .lineLimit(1)
                        Text("left")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    Text(reminders[0].title)
                        .font(.caption2)
                        .fontWeight(WidgetTheme.priorityWeight(reminders[0].priority))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                        .minimumScaleFactor(0.85)

                    Spacer(minLength: 0)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .widgetURL(WidgetLink.reminders)
        }
    }
}

// MARK: - Home Screen list

private struct RemindersListView: View {
    let entry: RemindersEntry
    let maxRows: Int
    /// systemLarge only — see `ChevronPager`.
    let showsChevronLabels: Bool

    private var reminders: [TaskDTO] { entry.group?.reminders ?? [] }

    /// The slot ring wraps (`ShiftReminderSlotIntent`), so both chevrons stay
    /// live whenever there is more than one slot to move between.
    private var canPage: Bool { entry.groups.count > 1 }

    private func neighborLabel(offset: Int) -> String? {
        guard canPage, entry.groups.indices.contains(entry.slotIndex) else { return nil }
        let count = entry.groups.count
        return entry.groups[((entry.slotIndex + offset) % count + count) % count].label
    }

    var body: some View {
        if entry.isSignedOut {
            WidgetSignedOutView()
        } else {
            VStack(alignment: .leading, spacing: WidgetTheme.rowSpacing) {
                header

                if entry.groups.isEmpty {
                    WidgetEmptyView(symbol: "checkmark.circle", message: "No reminders today")
                } else if reminders.isEmpty {
                    WidgetEmptyView(symbol: "checkmark.circle", message: "Nothing left here")
                } else {
                    VStack(alignment: .leading, spacing: WidgetTheme.rowSpacing) {
                        ForEach(reminders.prefix(maxRows)) { reminder in
                            ReminderRow(reminder: reminder)
                        }
                    }
                    if reminders.count > maxRows {
                        Text("+\(reminders.count - maxRows) more")
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
            .widgetURL(WidgetLink.reminders)
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: WidgetTheme.headerSpacing) {
            VStack(alignment: .leading, spacing: 1) {
                Text(entry.group?.label ?? "Reminders")
                    .font(.headline)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Text(countLabel)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            ChevronPager(
                previous: ShiftReminderSlotIntent(offset: -1),
                next: ShiftReminderSlotIntent(offset: 1),
                hasPrevious: canPage,
                hasNext: canPage,
                previousLabel: neighborLabel(offset: -1),
                nextLabel: neighborLabel(offset: 1),
                showsLabels: showsChevronLabels
            )
        }
    }

    private var countLabel: String {
        reminders.isEmpty ? "all clear" : "\(reminders.count) left"
    }
}

/// One reminder: a check-off button and a tappable title.
///
/// The two tap targets are deliberately distinct — the circle completes in
/// place (§8: budget-free reload), the title opens the app. §8 rules out swipe
/// gestures, so there is nothing hidden behind an edge.
private struct ReminderRow: View {
    let reminder: TaskDTO

    var body: some View {
        HStack(spacing: 10) {
            Button(intent: CompleteTaskIntent(taskId: reminder.id)) {
                Image(systemName: "circle")
                    .font(.system(size: 19, weight: .light))
                    .foregroundStyle(WidgetTheme.priorityColor(reminder.priority))
                    // Rows are ~44pt in the large family, so a 36pt hit target
                    // fits without inflating the layout; 26pt missed too often.
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Link(destination: WidgetLink.task(reminder.id)) {
                Text(reminder.title)
                    .font(.subheadline)
                    .fontWeight(WidgetTheme.priorityWeight(reminder.priority))
                    .foregroundStyle(.primary)
                    .opacity(WidgetTheme.priorityOpacity(reminder.priority))
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
        }
    }
}

// MARK: - Lock Screen

/// Lock Screen rectangular: glanceable only.
///
/// §8: interactive widgets are inert on a locked device, so putting a check-off
/// button here would be a control that silently does nothing until the user
/// authenticates. It states the slot, the count and the first item, and stops.
private struct RemindersRectangularView: View {
    let entry: RemindersEntry

    private var reminders: [TaskDTO] { entry.group?.reminders ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if entry.isSignedOut {
                Text("OpenTask")
                    .font(.headline)
                    .widgetAccentable()
                Text("Open to sign in")
                    .font(.caption2)
            } else {
                HStack(spacing: 4) {
                    Text(entry.group?.label ?? "Reminders")
                        .font(.headline)
                        .widgetAccentable()
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    Text("\(reminders.count)")
                        .font(.headline)
                        .widgetAccentable()
                }
                Text(reminders.first?.title ?? "All clear")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .widgetURL(WidgetLink.reminders)
    }
}

/// Lock Screen circular: the count, and a glyph so it reads at a glance.
private struct RemindersCircularView: View {
    let entry: RemindersEntry

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: -1) {
                Image(systemName: "bell")
                    .font(.system(size: 10, weight: .medium))
                Text("\(entry.group?.reminders.count ?? 0)")
                    .font(.system(size: 17, weight: .semibold, design: .rounded))
                    .minimumScaleFactor(0.7)
            }
        }
        .widgetURL(WidgetLink.reminders)
    }
}
