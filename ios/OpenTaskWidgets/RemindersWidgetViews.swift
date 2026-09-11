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
            RemindersListView(entry: entry, maxRows: 3, isLarge: false)
        default:
            RemindersListView(entry: entry, maxRows: 6, isLarge: true)
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

/// The Home Screen list.
///
/// HOW MANY ROWS: the card shows as many as actually FIT and no more.
///
/// A fixed row count was the bug behind two of Trent's complaints at once
/// (2026-09-11). Six rows, a header and an overflow line asked for more height
/// than a 4×4 has; WidgetKit does not scroll or clip a widget, it squeezes it,
/// so every `lineLimit(2)` title collapsed to one truncated line ("I am a
/// thinker, not a d…") and the leftover overflow pushed the header off the top
/// edge — on systemMedium the whole header was gone. Rows were cut off because
/// there were too many of them, and the header looked jammed against the top
/// for the same reason.
///
/// So `maxRows` is a ceiling, not a count: `ViewThatFits` walks down from it and
/// renders the first version whose real height — these titles, at this text
/// size, on this device — fits the card. Short reminders fill the card; long
/// ones show fewer rows and say "+N more". Nothing is ever squeezed, and no
/// number here needs re-tuning for a different phone or a larger text setting.
private struct RemindersListView: View {
    let entry: RemindersEntry
    let maxRows: Int
    /// systemLarge. Drives the three things a 4×2 has no height for: two-line
    /// titles, 10pt row gaps, and the "+N more" line.
    let isLarge: Bool

    private var reminders: [TaskDTO] { entry.group?.reminders ?? [] }

    /// The slot ring wraps (`ShiftReminderSlotIntent`), so both chevrons stay
    /// live whenever there is more than one slot to move between.
    private var canPage: Bool { entry.groups.count > 1 }

    private var rowSpacing: CGFloat {
        isLarge ? WidgetTheme.rowSpacing : WidgetTheme.compactRowSpacing
    }

    var body: some View {
        if entry.isSignedOut {
            WidgetSignedOutView()
        } else {
            // Tallest first — ViewThatFits renders the first that fits. Written
            // out rather than looped: ViewThatFits has to see each candidate as
            // its own child, and a ForEach would hand it one.
            ViewThatFits(in: .vertical) {
                card(rows: min(6, maxRows))
                card(rows: min(5, maxRows))
                card(rows: min(4, maxRows))
                card(rows: min(3, maxRows))
                card(rows: min(2, maxRows))
                card(rows: 1)
            }
            // The candidates carry no Spacer — a flexible child would report
            // "fits" at every height and defeat the measurement — so the card
            // is pinned to the top here instead.
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .widgetURL(WidgetLink.reminders)
        }
    }

    private func card(rows: Int) -> some View {
        VStack(alignment: .leading, spacing: rowSpacing) {
            header

            if entry.groups.isEmpty {
                WidgetEmptyView(symbol: "checkmark.circle", message: "No reminders today")
            } else if reminders.isEmpty {
                WidgetEmptyView(symbol: "checkmark.circle", message: "Nothing left here")
            } else {
                VStack(alignment: .leading, spacing: rowSpacing) {
                    ForEach(reminders.prefix(rows)) { reminder in
                        ReminderRow(reminder: reminder, titleLineLimit: isLarge ? 2 : 1)
                    }
                }
                // systemMedium drops the overflow line, as Track's does: at
                // 4×2 that band costs a whole row, and the header's "N left"
                // already states the total.
                if isLarge, reminders.count > rows {
                    Text("+\(reminders.count - rows) more")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }

            if let staleSince = entry.staleSince {
                HStack {
                    Spacer()
                    StalenessNote(fetchedAt: staleSince)
                }
            }
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
                hasNext: canPage
            )
        }
        // systemMedium gets none: its card is 128pt tall and a header plus two
        // rows spends 122 of that, so 6pt of air there costs the second row —
        // and a row of content beats a comfortable title every time. The 4×2's
        // breathing room is WidgetKit's own content margin.
        .padding(.top, isLarge ? WidgetTheme.headerTopPadding : 0)
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
///
/// A reminder is a THOUGHT, not an errand ("I am a thinker, not a doer. Kel is
/// a doer."), and half a thought prompts nothing — so in systemLarge the title
/// wraps to two lines rather than ellipsising at one. The list above shows
/// fewer rows to pay for it.
private struct ReminderRow: View {
    let reminder: TaskDTO
    var titleLineLimit = 2

    var body: some View {
        // .top, not .center: on a two-line row a centred circle floats down
        // into the gap between the lines, reading as if it belongs to neither.
        HStack(alignment: .top, spacing: 10) {
            Button(intent: CompleteTaskIntent(taskId: reminder.id)) {
                Image(systemName: "circle")
                    .font(.system(size: 19, weight: .light))
                    .foregroundStyle(WidgetTheme.priorityColor(reminder.priority))
                    // The glyph centres on the title's first line; the 36pt hit
                    // target then hangs below it, so the circle sits beside the
                    // words while staying as easy to hit as ever (26pt missed
                    // too often).
                    .frame(width: 36, height: WidgetTheme.rowTitleLineHeight)
                    .frame(width: 36, height: 36, alignment: .top)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            Link(destination: WidgetLink.reminder(reminder.id)) {
                Text(reminder.title)
                    .font(.subheadline)
                    .fontWeight(WidgetTheme.priorityWeight(reminder.priority))
                    .foregroundStyle(.primary)
                    .opacity(WidgetTheme.priorityOpacity(reminder.priority))
                    .lineLimit(titleLineLimit)
                    .multilineTextAlignment(.leading)
                    // fixedSize: the wrapped height is the height, and no
                    // parent gets to squeeze it back to one truncated line.
                    // minHeight: the row RESERVES its lines whether this title
                    // uses them or not, which is what `ViewThatFits` measures.
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(
                        maxWidth: .infinity,
                        minHeight: CGFloat(titleLineLimit) * WidgetTheme.rowTitleLineHeight,
                        alignment: .topLeading
                    )
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
