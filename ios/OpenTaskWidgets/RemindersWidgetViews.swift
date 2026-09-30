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
                    // Day complete (2026-09-29): the green wash on EVERY
                    // period's view, not just the clock's — see
                    // `ReminderDayProgress`. Lock Screen families keep the
                    // system's own background.
                    ZStack {
                        Rectangle().fill(.fill.tertiary)
                        if ReminderDayProgress.isDayComplete(entry.groups) {
                            Rectangle().fill(WidgetTheme.dayCompleteWash)
                        }
                    }
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
            RemindersCircularView(entry: entry)
        case .accessoryRectangular:
            RemindersRectangularView(entry: entry)
        #endif
        case .systemSmall:
            RemindersSmallView(entry: entry)
        case .systemMedium:
            RemindersListView(entry: entry, isLarge: false)
                .backgroundTapOpens(WidgetLink.reminders)
        default:
            // No row ceiling (2026-09-24): the list pages by real row
            // height, as many as fit — see `RemindersListView`'s doc.
            RemindersListView(entry: entry, isLarge: true)
                .backgroundTapOpens(WidgetLink.reminders)
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

    /// Reminders AND waiting quota prompts (2026-09-24) — a prompt counts
    /// exactly like a reminder.
    private var waitingCount: Int { entry.group?.waitingCount ?? 0 }

    /// The first waiting item's text and weight: the first reminder, else
    /// the first waiting prompt ("Piano Scales · 0/2") — prompts come after
    /// reminders in a slot, as on the web.
    private var firstItem: (text: String, weight: Font.Weight)? {
        if let reminder = entry.group?.reminders.first {
            return (reminder.title, WidgetTheme.priorityWeight(reminder.priority))
        }
        if let prompt = entry.group?.waitingPrompts.first {
            return (prompt.labelText, .regular)
        }
        return nil
    }

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

                if let firstItem {
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text("\(waitingCount)")
                            .font(.system(size: 40, weight: .semibold, design: .rounded))
                            .monospacedDigit()
                            .minimumScaleFactor(0.6)
                            .lineLimit(1)
                        Text("left")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    // No line limit (2026-09-24, never truncate a reminder):
                    // the 2×2 has a fixed card, so a long title SHRINKS into
                    // what's left under the count instead of ending in "…"
                    // ("Breakfast ( Oatmeal, Berri…" at XXX Large).
                    Text(firstItem.text)
                        .font(.caption2)
                        .fontWeight(firstItem.weight)
                        .foregroundStyle(.primary)
                        .minimumScaleFactor(WidgetTheme.overflowTitleScale)

                    Spacer(minLength: 0)
                } else {
                    Spacer(minLength: 0)
                    emptyState
                    Spacer(minLength: 0)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .widgetURL(WidgetLink.reminders)
        }
    }

    /// Nothing waiting in the on-screen period — the 2×2 keeps its one
    /// compact line, in the same words as the larger cards (2026-09-29):
    /// "Day complete" on the clock's period once the whole day is done (the
    /// card also takes the green wash), "All done" for a finished period.
    /// There is no room here for the big seal or the "N reminders" line.
    @ViewBuilder
    private var emptyState: some View {
        let state = ReminderDayProgress.emptyBody(
            groups: entry.groups, displayedIndex: entry.slotIndex,
            naturalIndex: RemindersTimeline.naturalSlotIndex(in: entry.groups, now: entry.date)
        )
        switch state {
        case .noReminders:
            WidgetEmptyView(symbol: "checkmark.circle", message: "No reminders today", compact: true)
        case .dayComplete:
            WidgetEmptyView(symbol: "checkmark.seal.fill", message: "Day complete", compact: true)
        case .periodDone:
            WidgetEmptyView(symbol: "checkmark.seal.fill", message: "All done", compact: true)
        case .nothingHere:
            WidgetEmptyView(symbol: "checkmark.circle", message: "Nothing left here", compact: true)
        }
    }
}

// MARK: - Home Screen list

/// One row of the combined open+divider+done list (2026-09-23, "show
/// completed") — see `combinedItems`' doc. `Identifiable` by a prefixed
/// string rather than an `Int` id so `.divider` (which has no natural id of
/// its own) fits the same `ForEach` as the other two cases.
///
/// Quota prompts (2026-09-24) are rows too: `.prompt` for a waiting one (after
/// the slot's open reminders — the web's `SlotPromptList` sits under the
/// reminders the same way), `.donePrompt` for one handled today (after the
/// considered reminders in DONE). Keyed by `prompt_key`, NEVER the task id: a
/// daily quota's prompts share one task id.
private enum ReminderListItem: Identifiable {
    case open(TaskDTO)
    case prompt(QuotaPromptDTO)
    case divider(count: Int)
    case done(TaskDTO)
    case donePrompt(QuotaPromptDTO)

    var id: String {
        switch self {
        case .open(let reminder): return "open-\(reminder.id)"
        case .prompt(let prompt): return "prompt-\(prompt.promptKey)"
        case .divider: return "divider"
        case .done(let reminder): return "done-\(reminder.id)"
        case .donePrompt(let prompt): return "done-prompt-\(prompt.promptKey)"
        }
    }
}

/// One row's size, decided ONCE per render and used twice: by the pager to
/// add up what fits (`WidgetTheme.pages`), and by the row itself as its
/// exact frame. The two can't disagree because they are the same numbers.
private struct ReminderRowLayout {
    /// Title lines — the row's `lineLimit`, and what its height is built from.
    let lines: Int
    let height: CGFloat
    /// The title is longer than the whole card: the row is one page tall and
    /// the title shrinks to fit it (see `WidgetTextMetrics.titleLines`).
    var shrinks = false
}

/// The Home Screen list.
///
/// HOW MANY ROWS (2026-09-24): as many as genuinely fit, page after page.
///
/// A `GeometryReader` takes whatever height the header and slot strip leave
/// (so neither needs estimating — they are laid out for real above it),
/// minus the bottom row's fixed `bottomBarHeight`. Every row's height is
/// computed up front from its real title (`WidgetTextMetrics`, at the
/// widget's real text size), and `WidgetTheme.pages` fills each page greedily
/// until the next row doesn't fit. Each row is then FRAMED to exactly the
/// height the pager counted, so the page on screen is the page that was
/// measured — see `WidgetTheme.pages` for the uniform `ViewThatFits` pages
/// this replaced ("7 left" as four pages of two rows).
///
/// Nothing is ever squeezed: WidgetKit doesn't scroll or clip a widget, it
/// compresses it, which is what once collapsed every two-line title to one
/// truncated line (2026-09-11) — the reason rows carry their own heights at
/// all.
private struct RemindersListView: View {
    let entry: RemindersEntry
    /// systemLarge. Drives the things a 4×2 has no height for: wrapped
    /// titles, 10pt row gaps, the slot strip, the DONE section and the
    /// bottom row (pager + completed dot).
    let isLarge: Bool

    private var reminders: [TaskDTO] { entry.group?.reminders ?? [] }

    private var showCompleted: Bool {
        isLarge && WidgetStore.showCompleted(for: RemindersWidget.kind)
    }

    /// ONE flat sequence — open rows, then (only when "show completed" is on
    /// AND there is something to show, AND only on `systemLarge`) a divider
    /// and the slot's `consideredItems` (2026-09-23, decision #4 in the
    /// handoff). Paging THIS array is what makes "recount on toggle flip,
    /// break only on whole rows" fall out for free: the toggle changes the
    /// array, and `WidgetTheme.pages` only ever cuts between two items.
    ///
    /// Quota prompts (2026-09-24): waiting ones follow the open reminders;
    /// handled ones follow the considered reminders in DONE and count in its
    /// "DONE · N" (a prompt counts exactly like a reminder). A handled
    /// prompt's DONE row puts it back (2026-09-25) — see `DonePromptRow`.
    private var combinedItems: [ReminderListItem] {
        let openItems = reminders.map(ReminderListItem.open)
            + (entry.group?.waitingPrompts ?? []).map(ReminderListItem.prompt)
        guard showCompleted, let group = entry.group else { return openItems }
        let doneCount = group.consideredItems.count + group.handledPrompts.count
        guard doneCount > 0 else { return openItems }
        return openItems + [.divider(count: doneCount)]
            + group.consideredItems.map(ReminderListItem.done)
            + group.handledPrompts.map(ReminderListItem.donePrompt)
    }

    /// The slot ring wraps (`ShiftReminderSlotIntent`), so both chevrons stay
    /// live whenever there is more than one slot to move between.
    private var canPage: Bool { entry.groups.count > 1 }

    private var rowSpacing: CGFloat {
        isLarge ? WidgetTheme.rowSpacing : WidgetTheme.compactRowSpacing
    }

    /// The row-height floor: iOS systemMedium keeps the 36pt finger target
    /// for its check-off (it has no `markerBleed` to borrow from the gaps);
    /// iOS systemLarge bleeds instead, and macOS needs no floor.
    ///
    /// systemMedium used to get a flat ONE line per title on iOS ("a header
    /// plus two one-line rows and nothing more"). Since 2026-09-24 it wraps
    /// like every other family — Trent's rule is that a reminder is never
    /// truncated — and simply shows fewer rows: it has no pager, and its
    /// header count already says how many are waiting.
    private var rowFloor: CGFloat {
        #if os(iOS)
        isLarge ? 0 : WidgetTheme.rowMarkerSize
        #else
        0
        #endif
    }

    /// iOS only, systemLarge only: the check-off's tap target reaches half a
    /// `rowSpacing` into the gaps above and below its row instead of forcing
    /// the row up to a 36pt finger floor (2026-09-23 — a one-line row's pitch
    /// fell from 46pt to 28pt). systemMedium keeps the floor; macOS needs
    /// none.
    private var markerBleed: CGFloat {
        #if os(iOS)
        isLarge ? WidgetTheme.rowSpacing / 2 : 0
        #else
        0
        #endif
    }

    var body: some View {
        if entry.isSignedOut {
            WidgetSignedOutView()
        } else {
            // No `.widgetURL` here (removed 2026-09-22, the misclick fix):
            // only the header and each row's `Link` are tap targets on
            // systemMedium/Large — see `header`.
            VStack(alignment: .leading, spacing: rowSpacing) {
                header

                // systemLarge only — see `ReminderSlotStrip`'s doc for why
                // systemMedium skips it entirely rather than just costing it
                // some height.
                if isLarge {
                    ReminderSlotStrip(groups: entry.groups, currentIndex: entry.slotIndex, now: entry.date)
                }

                // Everything below the header and strip. The reader gets the
                // height they left, laid out for real — never an estimate of
                // how tall a header is at this text size — plus SwiftUI's
                // real text metrics (`RenderedTextReader`'s doc).
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

    /// The paged rows plus (systemLarge) the bottom row, laid out in `size`.
    ///
    /// The height arithmetic is exact, and the layout below is built so it
    /// stays exact: rows in their own `VStack(spacing: rowSpacing)` (n rows
    /// cost their heights plus n−1 gaps — what `WidgetTheme.pages` adds up),
    /// then a `Spacer`, then the bottom row carrying its OWN `rowSpacing` of
    /// top padding. The outer stack has zero spacing: a spaced outer stack
    /// would add a gap on BOTH sides of the Spacer, a second `rowSpacing`
    /// the budget never subtracted — enough, on a tight page, to push the
    /// pager off the bottom edge.
    private func listBody(size: CGSize, metrics: WidgetTextMetrics) -> some View {
        let items = combinedItems
        let barHeight = metrics.bottomBarHeight
        // The bottom row is always present on systemLarge (the completed dot
        // lives there even on a one-page list), so it and its gap always
        // come off the row budget.
        let budget = max(size.height - (isLarge ? barHeight + rowSpacing : 0), 0)
        let layouts = items.map { layout(for: $0, width: size.width, budget: budget, metrics: metrics) }
        let pages = WidgetTheme.pages(heights: layouts.map(\.height), spacing: rowSpacing, budget: budget) {
            if case .divider = items[$0] { return true }
            return false
        }
        // systemMedium has no pager, so it always shows the first page — the
        // stored page belongs to the systemLarge card's pager.
        let page = isLarge ? min(max(WidgetStore.remindersPage(for: entry.group?.slotKey ?? -1), 0), pages.count - 1) : 0
        let range = pages[page]

        return VStack(alignment: .leading, spacing: 0) {
            if entry.groups.isEmpty {
                WidgetEmptyView(symbol: "checkmark.circle", message: "No reminders today")
            } else if items.isEmpty {
                emptySlotView
            } else {
                VStack(alignment: .leading, spacing: rowSpacing) {
                    ForEach(range, id: \.self) { index in
                        row(items[index], layout: layouts[index], metrics: metrics)
                            .frame(height: layouts[index].height, alignment: .top)
                    }
                }
            }

            // Pins the bottom row to the card's bottom edge (Trent,
            // 2026-09-23: "the page switcher should not move").
            Spacer(minLength: 0)

            if isLarge {
                ListBottomBar(height: barHeight) {
                    periodCountLabel(width: size.width, pages: pages.count, page: page, metrics: metrics)
                } pager: {
                    if pages.count > 1 {
                        ListPager(
                            page: page,
                            totalPages: pages.count,
                            previous: ShiftReminderPageIntent(offset: -1),
                            next: ShiftReminderPageIntent(offset: 1)
                        )
                    }
                } trailing: {
                    CompletedDotToggle(
                        intent: ToggleShowCompletedIntent(kind: RemindersWidget.kind),
                        isOn: showCompleted, label: "done", height: barHeight
                    )
                }
                .padding(.top, rowSpacing)
            }
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
    }

    /// `item`'s lines and exact height at this card's `width`.
    ///
    /// An open reminder's title column is the card minus the check-off's
    /// `rowMarkerSize` column and its 10pt `HStack` gap. The title wraps to
    /// its full line count on every family and platform (2026-09-24 — the
    /// iOS 3-line cap and systemMedium's one-line rows are gone); only a
    /// title longer than the whole `budget` is clamped (see
    /// `WidgetTextMetrics.titleLines`). iOS systemMedium rows sit on the
    /// 36pt finger floor (`rowFloor`). A done row is one line; the divider is
    /// one caption2 line.
    private func layout(
        for item: ReminderListItem, width: CGFloat, budget: CGFloat, metrics: WidgetTextMetrics
    ) -> ReminderRowLayout {
        switch item {
        case .open(let reminder):
            let fit = metrics.titleLines(
                reminder.title, width: width - WidgetTheme.rowMarkerSize - 10,
                weight: WidgetTheme.priorityWeight(reminder.priority), maxHeight: budget,
                hasNotes: reminder.hasNotes
            )
            if fit.shrinks {
                return ReminderRowLayout(lines: fit.lines, height: budget, shrinks: true)
            }
            return ReminderRowLayout(lines: fit.lines, height: max(metrics.titleHeight(lines: fit.lines), rowFloor))
        case .divider:
            return ReminderRowLayout(lines: 1, height: metrics.caption2Height)
        case .done(let reminder):
            // Wraps in full too (2026-09-24) — a completed reminder is still
            // a reminder, and "Morning = Focus, Afternoon…" struck through
            // says nothing.
            let fit = metrics.titleLines(
                reminder.title, width: width - WidgetTheme.rowMarkerSize - 10, weight: .regular, maxHeight: budget,
                hasNotes: reminder.hasNotes
            )
            if fit.shrinks { return ReminderRowLayout(lines: fit.lines, height: budget, shrinks: true) }
            return ReminderRowLayout(lines: fit.lines, height: metrics.titleHeight(lines: fit.lines))
        case .prompt(let prompt):
            // The label is ONE string, title and count together
            // (`QuotaPromptDTO.labelText`), measured at the column the row
            // really gives it: the card minus the stripe, and minus BOTH
            // trailing controls — the did-it square and the consider circle
            // (`PromptRowMetrics.titleWidth`). Same floor as a reminder row.
            let fit = metrics.titleLines(
                prompt.labelText, width: PromptRowMetrics.titleWidth(in: width), weight: .regular, maxHeight: budget,
                hasNotes: prompt.hasNotes
            )
            if fit.shrinks {
                return ReminderRowLayout(lines: fit.lines, height: budget, shrinks: true)
            }
            return ReminderRowLayout(lines: fit.lines, height: max(metrics.titleHeight(lines: fit.lines), rowFloor))
        case .donePrompt(let prompt):
            // DONE rows have one trailing marker, like `DoneReminderRow`.
            let fit = metrics.titleLines(
                prompt.labelText, width: PromptRowMetrics.doneTitleWidth(in: width), weight: .regular,
                maxHeight: budget, hasNotes: prompt.hasNotes
            )
            if fit.shrinks { return ReminderRowLayout(lines: fit.lines, height: budget, shrinks: true) }
            return ReminderRowLayout(lines: fit.lines, height: metrics.titleHeight(lines: fit.lines))
        }
    }

    @ViewBuilder
    private func row(_ item: ReminderListItem, layout: ReminderRowLayout, metrics: WidgetTextMetrics) -> some View {
        switch item {
        case .open(let reminder):
            ReminderRow(
                reminder: reminder, lines: layout.lines, height: layout.height, shrinks: layout.shrinks,
                firstLineHeight: metrics.titleHeight(lines: 1), markerBleed: markerBleed,
                notesGlyphSize: metrics.notesGlyphSize(hasNotes: reminder.hasNotes)
            )
        case .divider(let count):
            DoneDivider(count: count)
        case .done(let reminder):
            DoneReminderRow(
                reminder: reminder, lines: layout.lines, height: layout.height, shrinks: layout.shrinks,
                firstLineHeight: metrics.titleHeight(lines: 1),
                notesGlyphSize: metrics.notesGlyphSize(hasNotes: reminder.hasNotes)
            )
        case .prompt(let prompt):
            PromptRow(
                prompt: prompt, lines: layout.lines, height: layout.height, shrinks: layout.shrinks,
                firstLineHeight: metrics.titleHeight(lines: 1), markerBleed: markerBleed,
                notesGlyphSize: metrics.notesGlyphSize(hasNotes: prompt.hasNotes)
            )
        case .donePrompt(let prompt):
            DonePromptRow(
                prompt: prompt, lines: layout.lines, height: layout.height, shrinks: layout.shrinks,
                firstLineHeight: metrics.titleHeight(lines: 1),
                notesGlyphSize: metrics.notesGlyphSize(hasNotes: prompt.hasNotes)
            )
        }
    }

    /// The on-screen period's list is empty (2026-09-29, the "day complete"
    /// design approved from mockups r3). It replaced "All caught up", which
    /// fired once every STARTED period was finished — a false finish line
    /// with later periods still to come — and "<Period> done". The rule is
    /// `ReminderDayProgress.emptyBody` (tested in `ReminderDayProgressTests`):
    ///
    /// 1. **Day complete** — every period, started or not, has nothing
    ///    waiting and something was handled — AND this is the clock's
    ///    period: a big seal, "Congratulations", "Day complete". Any other
    ///    period that day reads as #2, under the same green wash
    ///    (`RemindersWidgetView`'s background).
    /// 2. **This period is finished**: the seal, "All done", "7 reminders"
    ///    (prompts counted as reminders — `ReminderDayProgress.itemsText`).
    ///    The header already names the period, so the body doesn't.
    /// 3. **Never had anything** — the original "Nothing left here".
    ///
    /// No finish time and no "Next …" line: the strip above already shows
    /// what's left of the day (Trent's review of the mockups).
    @ViewBuilder
    private var emptySlotView: some View {
        let state = ReminderDayProgress.emptyBody(
            groups: entry.groups, displayedIndex: entry.slotIndex,
            naturalIndex: RemindersTimeline.naturalSlotIndex(in: entry.groups, now: entry.date)
        )
        switch state {
        case .noReminders:
            WidgetEmptyView(symbol: "checkmark.circle", message: "No reminders today")
        case .dayComplete:
            DayCompleteView(isLarge: isLarge)
        case .periodDone(let count):
            PeriodDoneView(count: count, isLarge: isLarge)
        case .nothingHere:
            WidgetEmptyView(symbol: "checkmark.circle", message: "Nothing left here")
        }
    }

    /// The bottom row's leading "4 of 7" (2026-09-29): the on-screen
    /// period's handled items over its day total, prompts included
    /// (`ReminderDayProgress.PeriodCount`). systemLarge only — it lives in
    /// the bottom row, which systemMedium doesn't have. Quiet, like the
    /// "○ done" toggle opposite it. Hidden when the period holds nothing
    /// ("0 of 0" says nothing).
    ///
    /// SHARING THE ROW WITH THE PAGER: the `‹ 1/2 ›` pager is centred on the
    /// card in its own layer (`ListBottomBar`), so the count only has the
    /// left half of the card minus half the pager. At the default text size
    /// that is plenty (mockup r3-x); at the largest text sizes, on a
    /// multi-page list, it may not be — and a label running under the
    /// pager's "previous page" chevron would be both unreadable and a
    /// mis-tap. So the widths are MEASURED, in the drawn caption2 font the
    /// pager's page number uses (`WidgetTextMetrics.caption2Font`): the
    /// count shows whenever it fits left of the pager with an 8pt gap, and
    /// is left out while the pager shows when it doesn't. Never truncated or
    /// shrunk — the header's "N left" still carries the period's count, and
    /// the count comes back on a one-page list.
    @ViewBuilder
    private func periodCountLabel(width: CGFloat, pages: Int, page: Int, metrics: WidgetTextMetrics) -> some View {
        if let group = entry.group {
            let count = ReminderDayProgress.PeriodCount(group)
            let pagerText: String? = pages > 1 ? "\(page + 1)/\(pages)" : nil
            if count.total > 0 && WidgetTheme.fitsLeftOfPager(
                width: WidgetTheme.measuredWidth(for: count.text, font: metrics.caption2Font),
                cardWidth: width, pagerText: pagerText, metrics: metrics
            ) {
                Text(count.text)
                    .font(.caption2)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .fixedSize()
                    .accessibilityLabel(Text("\(count.handled) of \(count.total) done in this period"))
            }
        }
    }

    /// The header IS the card's tap target now that the whole-card link is
    /// gone. Only the title/count block is a `Link` — the buttons stay
    /// siblings outside it, because a `Button(intent:)` nested inside a
    /// `Link` is a WidgetKit combination this repo has no way to verify
    /// without a device. `.foregroundStyle` on the title is explicit: `Link`
    /// tints an unstyled label with the accent color.
    ///
    /// THE TITLE NEVER TRUNCATES (2026-09-24 — "Early m…" on Trent's phone,
    /// at XXX Large text). It is `fixedSize` horizontally and its block has
    /// the row's layout priority, and the header was thinned so that costs
    /// nothing: the eye moved to the bottom row as the completed dot.
    ///
    /// PERIOD CHEVRONS ON EVERY SIZE (2026-09-25, Trent: "‹ › in the header
    /// to move between periods, laid out like the Tasks widget's header").
    /// systemLarge had dropped them on 2026-09-24 in favour of the slot
    /// strip's tappable segments; they are back, in the Tasks header's exact
    /// arrangement — undo/redo, then the `ChevronPager` at the right edge.
    /// Two `‹ ›` controls on one card is only confusing if they look alike
    /// or do the same thing (Quotas' header pair paged the same pages as its
    /// bottom pager, and went). Here they don't: the header pair changes the
    /// PERIOD — the title it sits beside is what changes, and the page
    /// resets to 1 (`WidgetStore.remindersPage(for:)` is paired with the
    /// slot) — while the bottom `‹ n/N ›` pages WITHIN the period, small,
    /// with its page count between the glyphs. The Tasks widget has had this
    /// same header-vs-bottom split since 2026-09-23.
    private var header: some View {
        // Tasks' arrangement when it fits; else undo/redo drop to the
        // subtitle line — see `compactHeaderRow`.
        ViewThatFits(in: .horizontal) {
            headerRow
            compactHeaderRow
        }
        // systemMedium gets none: its card is 128pt tall and a header plus two
        // rows spends 122 of that, so 6pt of air there costs the second row —
        // and a row of content beats a comfortable title every time. The 4×2's
        // breathing room is WidgetKit's own content margin.
        .padding(.top, isLarge ? WidgetTheme.headerTopPadding : 0)
    }

    /// Title block, undo/redo, period chevrons — the Tasks header's layout.
    private var headerRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: WidgetTheme.headerSpacing) {
            Link(destination: headerDestination) {
                VStack(alignment: .leading, spacing: 1) {
                    headerTitle
                    headerSubtitle
                }
                .contentShape(Rectangle())
            }
            .layoutPriority(1)
            Spacer(minLength: 0)
            // Right-aligned (2026-09-23) — see `UndoRedoButtons`' doc:
            // always present, dimmed when there is nothing to undo/redo.
            undoRedo
            periodChevrons
        }
    }

    /// The fallback when the title, undo/redo and chevrons don't fit on one
    /// line (2026-09-25): "Early morning" at XXX Large on Trent's 402pt-wide
    /// iPhone 16 Pro ran a few points past the card's edge, and a
    /// `fixedSize` title that can't truncate pushes the whole card sideways
    /// instead. The chevrons keep their place at the title line's right
    /// edge; undo/redo move to the right end of the subtitle line, which
    /// "N left" leaves mostly empty. They cancel their own vertical padding
    /// there so the subtitle line doesn't grow — the header's height, which
    /// the list's paging budget is measured from, stays the one-row header's.
    private var compactHeaderRow: some View {
        HStack(alignment: .top, spacing: WidgetTheme.headerSpacing) {
            VStack(alignment: .leading, spacing: 1) {
                Link(destination: headerDestination) {
                    headerTitle.contentShape(Rectangle())
                }
                HStack(alignment: .center, spacing: WidgetTheme.headerSpacing) {
                    Link(destination: headerDestination) {
                        headerSubtitle.contentShape(Rectangle())
                    }
                    Spacer(minLength: 0)
                    undoRedo.padding(.vertical, -UndoRedoButtons.verticalPadding)
                }
            }
            .layoutPriority(1)
            periodChevrons
        }
    }

    /// Never truncates — see `header`'s doc.
    private var headerTitle: some View {
        Text(entry.group?.label ?? "Reminders")
            .font(.headline)
            .foregroundStyle(.primary)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
    }

    /// "Undid: …" / "Redid: …" for ~60s after an undo/redo (2026-09-23) —
    /// see `WidgetStore`'s "Last-action indication" doc. Replaces the
    /// ordinary count subtitle rather than sitting beside it: the header has
    /// no spare height for a third line on systemMedium.
    private var headerSubtitle: some View {
        Text(entry.actionDescription ?? subtitleLabel)
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
    }

    private var undoRedo: some View {
        UndoRedoButtons(canUndo: entry.canUndo, canRedo: entry.canRedo, kind: RemindersWidget.kind)
    }

    private var periodChevrons: some View {
        ChevronPager(
            previous: ShiftReminderSlotIntent(offset: -1),
            next: ShiftReminderSlotIntent(offset: 1),
            hasPrevious: canPage,
            hasNext: canPage,
            previousLabel: "Previous period",
            nextLabel: "Next period"
        )
    }

    /// The header title `Link`'s destination (2026-09-23) — Trent: "it
    /// should scroll down to the actual afternoon section." The on-screen
    /// slot's key, or the bare `reminders` link when there is no group at
    /// all (nothing configured today) for this entry to scope to.
    private var headerDestination: URL {
        guard let group = entry.group else { return WidgetLink.reminders }
        return WidgetLink.reminders(slot: group.slotKey)
    }

    /// "8:30 am · 12 left": the period's start time first (Trent, 2026-09-28:
    /// "the reminder widget needs to somehow show the time for that segment
    /// because I get lost as to which segment we're in"), then the count —
    /// or the time alone once nothing is left ("· all clear" was cut, as was
    /// a "· now" on the clock's period: "we just don't need that"). The strip
    /// still implies which period is live (`ReminderSlotStrip`). "Anytime"
    /// has no start time and gets only the count.
    private var subtitleLabel: String {
        guard let group = entry.group, let minutes = group.slot?.startMinutes,
              let start = Calendar.current.date(
                  byAdding: .minute, value: minutes, to: Calendar.current.startOfDay(for: entry.date)
              )
        else { return countLabel }
        let time = WidgetTheme.shortTime(start)
        let count = countLabel
        return count == "all clear" ? time : "\(time) · \(count)"
    }

    /// "N left" ordinarily; "N left · M done" once "show completed" is on
    /// (2026-09-23) — systemLarge only, like the toggle itself.
    ///
    /// Both numbers include quota prompts (2026-09-24): "left" is reminders
    /// plus waiting prompts, "done" is exactly what the DONE section lists.
    private var countLabel: String {
        let waiting = entry.group?.waitingCount ?? 0
        guard showCompleted else {
            return waiting == 0 ? "all clear" : "\(waiting) left"
        }
        let doneCount = (entry.group?.consideredItems.count ?? 0) + (entry.group?.handledPrompts.count ?? 0)
        guard waiting > 0 || doneCount > 0 else { return "all clear" }
        return "\(waiting) left · \(doneCount) done"
    }
}

/// "Congratulations / Day complete" (2026-09-29, mockups r3-c/e/f): the
/// clock's period once EVERY period of the day has nothing waiting
/// (`ReminderDayProgress.isDayComplete`). The seal is about twice
/// `PeriodDoneView`'s on systemLarge; systemMedium sizes everything down so
/// the three lines fit its ~80pt body. No tint here — the green wash is the
/// whole card's background (`RemindersWidgetView`).
private struct DayCompleteView: View {
    let isLarge: Bool

    var body: some View {
        VStack(spacing: isLarge ? 6 : 2) {
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: isLarge ? 44 : 30))
                .foregroundStyle(.green.opacity(0.85))
                .padding(.bottom, isLarge ? 6 : 2)
            Text("Congratulations")
                .font(isLarge ? .title2.weight(.semibold) : .headline)
                .foregroundStyle(.primary)
            Text("Day complete")
                .font(isLarge ? .footnote : .caption)
                .foregroundStyle(.secondary)
        }
        .multilineTextAlignment(.center)
        .minimumScaleFactor(0.8)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }
}

/// A finished period (2026-09-29, mockup r3-b1): the seal at
/// `WidgetEmptyView`'s size, "All done" (semibold, primary) and
/// "7 reminders" (`ReminderDayProgress.itemsText`, prompts included) under
/// it. It replaced "<Period> done" and "All caught up".
private struct PeriodDoneView: View {
    let count: Int
    let isLarge: Bool

    var body: some View {
        VStack(spacing: isLarge ? 8 : 4) {
            Image(systemName: "checkmark.seal.fill")
                .font(isLarge ? .title2 : .title3)
                .foregroundStyle(.green.opacity(0.85))
            VStack(spacing: 2) {
                Text("All done")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                Text(ReminderDayProgress.itemsText(count))
                    .font(isLarge ? .footnote : .caption)
                    .foregroundStyle(.secondary)
            }
        }
        .multilineTextAlignment(.center)
        .minimumScaleFactor(0.8)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }
}

/// The whole day's reminder slots as one thin strip under the header — Trent,
/// 2026-09-23: "I finished everything for the morning, and I was excited. I
/// didn't even realize that I actually did not finish the things for early
/// morning, so there needs to be some indication that there are other things
/// missing." A per-slot progress bar answers only "how is THIS slot doing";
/// this answers the whole-day question a header alone cannot.
///
/// Mirrors the web's `ReminderSlotBar` (`src/components/ReminderSlotBar.tsx`)
/// for STATE and COLOR, not layout: `.behind` (started, still waiting) draws
/// indigo, `.done` (started, nothing waiting, something WAS considered) draws
/// green, `.upcoming` (time hasn't come) draws a barely-there neutral — "the
/// things that haven't happened yet don't need a colour... they're obviously
/// going to be undone" (Trent, same feature, web side). The on-screen slot
/// (`currentIndex`) draws taller, the web's way of marking "you are here"
/// without a second colour.
///
/// Segments are PROPORTIONAL to what each period holds (2026-09-28; they were
/// equal until then): Trent's pre-bedtime has 2 reminders, evening 8 and
/// after school 17, "and it's just not visually apparent". Width keys off the
/// period's day total (waiting plus considered), so checking things off moves
/// the fill but never resizes a segment — the web `ReminderSlotBar`'s rule.
/// No segment is narrower than `minimumSegmentWidth`, a more generous floor
/// than the web's 28px since this is a finger on a phone (`SegmentWidths`).
///
/// The period the CLOCK is in is implied rather than drawn: every period
/// that hasn't started yet draws a fainter track than one that has (Trent,
/// same day: "we can actually imply it by just fading the gray out a little
/// bit for future segments"), so "now" is the last segment at full weight.
/// An empty slot (nothing ever in it, `reminders` and `considered`
/// both zero) gets no segment at all, same as the web — a segment is a claim
/// that there is something to report.
///
/// systemLarge only (`RemindersListView.card`'s `if isLarge`) — a systemMedium
/// card has no height to spare on a fourth band at all (see
/// `RemindersListView.header`'s `padding.top` comment). Kept deliberately
/// tiny even on systemLarge (a few points, plus one more `rowSpacing` gap
/// the `VStack` adds around it) rather than free: it IS real height the
/// list's height-based paging leaves out of the row budget like any other
/// content, so a card tight enough on a given day can end up fitting one
/// fewer reminder row than it would with the strip hidden. That is the
/// system working as intended — "as many rows as genuinely fit" already
/// accounts for whatever's above them — not a bug to route around.
///
/// Each segment is its own tap target (2026-09-23, "I'd like to be able to
/// tap a segment to jump to that section even within the widget") — see
/// `body`'s `Button` and `segmentBleed`'s doc for how the finger target grows
/// past the 3-4pt bar without costing the strip (or the row it would
/// otherwise steal from) any extra height. The on-screen slot also gets a
/// ring, not just its existing height bump (2026-09-23, "we need some kind
/// of outline... to show which segment we're currently on" — the bump alone
/// didn't read clearly enough at a glance) — see `segmentBar`.
private struct ReminderSlotStrip: View {
    let groups: [ReminderGroupDTO]
    let currentIndex: Int
    let now: Date

    private enum SlotState { case done, behind, upcoming }

    private struct Segment: Identifiable {
        let id: Int
        /// The slot this segment represents — what `JumpToReminderSlotIntent`
        /// needs to jump straight to it, since `id` is only this segment's
        /// position in the (already-filtered) `segments` array, not a stable
        /// slot identity.
        let slotKey: Int
        let state: SlotState
        let isCurrent: Bool
        /// Considered over the slot's total — how far the indigo has filled.
        let fraction: Double
        /// The slot's day total (waiting plus considered) — its width weight.
        let total: Int
    }

    private var segments: [Segment] {
        // Quota prompts count exactly like reminders (2026-09-24): waiting
        // and handled both, so a slot's segment is sized by its day total.
        groups.enumerated().compactMap { index, group -> Segment? in
            let waiting = group.waitingCount
            let considered = group.consideredCount
            guard waiting + considered > 0 else { return nil }
            let started = RemindersTimeline.hasStarted(group, now: now)
            // Fully considered reads as done whatever the clock says — a
            // period finished EARLY (Trent, 2026-09-28: pre-bedtime and
            // evening done at 8 PM drew gray) is finished, the web
            // `ReminderSlotBar`'s rule. The track below still tells started
            // from not-yet.
            let state: SlotState
            if waiting == 0 { state = .done } else if started { state = .behind } else {
                state = .upcoming
            }
            return Segment(
                id: index, slotKey: group.slotKey, state: state, isCurrent: index == currentIndex,
                fraction: Double(considered) / Double(waiting + considered),
                total: waiting + considered
            )
        }
    }

    /// Half of `WidgetTheme.rowSpacing` — the same bleed `ReminderRow`'s
    /// check-off button uses for its TAP target (see its `markerBleed` doc
    /// for the mechanics: a taller invisible `contentShape`, then negative
    /// padding on the OUTER view so the parent `VStack` doesn't see that
    /// extra height). Hit-testing reads the layout tree's geometry, so this
    /// bleed is safe — unlike bleeding the ring's PAINTED pixels this way
    /// (see `segmentBar`'s doc for why that part doesn't get the same
    /// trick). The strip sits between the header and the first row, both
    /// separated by a full `rowSpacing`, so this is exactly what's free to
    /// bleed the tap area into on each side without touching either
    /// neighbor.
    private var segmentBleed: CGFloat { WidgetTheme.rowSpacing / 2 }

    /// The tallest a segment is ever drawn — the on-screen slot's ring (see
    /// `segmentBar`). Every segment reserves this much real height (even the
    /// plain 3pt bars, centered within it) because the `HStack`'s reported
    /// height is the max of its children's, so this is what the strip
    /// actually costs the card — 2pt more than before the ring, on top of
    /// what the pre-existing height bump already cost.
    private var maxSegmentHeight: CGFloat { 8 }

    /// See the type's doc: a finger's width, wider than the web's 28px floor.
    static let minimumSegmentWidth: Double = 36

    private let segmentSpacing: CGFloat = 3

    var body: some View {
        // One segment is not a strip — same rule as the web's ReminderSlotBar
        // ("it would say only 'everything is here', which the header already
        // says better").
        let shown = segments
        if shown.count >= 2 {
            GeometryReader { geo in
                let gaps = segmentSpacing * CGFloat(shown.count - 1)
                let widths = SegmentWidths.widths(
                    weights: shown.map { Double($0.total) },
                    available: Double(max(geo.size.width - gaps, 0)),
                    minimum: Self.minimumSegmentWidth
                )
                HStack(spacing: segmentSpacing) {
                    ForEach(Array(shown.enumerated()), id: \.element.id) { position, segment in
                        Button(intent: JumpToReminderSlotIntent(slotKey: segment.slotKey)) {
                            segmentBar(for: segment)
                                // Real visual size — nothing painted beyond this
                                // frame, so nothing for WidgetKit's renderer to
                                // clip (see `segmentBar`'s doc).
                                .frame(height: maxSegmentHeight)
                                // THEN a taller invisible frame purely for the
                                // tap target — see `segmentBleed`'s doc.
                                .frame(height: maxSegmentHeight + 2 * segmentBleed)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .frame(width: CGFloat(widths[position]))
                        .padding(.vertical, -segmentBleed)
                        .accessibilityLabel(Text(groups[segment.id].label))
                    }
                }
            }
            .frame(height: maxSegmentHeight)
            .padding(.bottom, 2)
        }
    }

    /// One slot: a faint track, filled INDIGO as far as it has been considered
    /// and GREEN end to end once it is done — the web's `ReminderSlotBar`
    /// (Trent, 2026-09-23: "when it's partially full, it's either showing full
    /// indigo or full green when really the indigo should be filling up"). A
    /// slot whose time has not come shows only the track.
    ///
    /// THE CURRENT SLOT IS TWICE AS THICK (option A of five he was shown,
    /// rendered side by side). Option B — current at full strength, the rest
    /// dimmed — was tried first and dropped the same day: "I'm not a huge fan
    /// of the dimness", and a current slot with nothing considered is a gray
    /// track that barely stood out from dimmed gray ones. Thickness reads the
    /// same whatever the fill. Both replaced a 1pt white ring he found hard to
    /// look at, which the widget also clipped at both rounded ends. Nothing is
    /// drawn outside the bar's own frame, so nothing can be clipped.
    private func segmentBar(for segment: Segment) -> some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                // Fainter for a period whose time hasn't come — which is
                // what makes the clock's period read as "now" (type doc).
                Capsule().fill(Color.primary.opacity(segment.state == .upcoming ? 0.055 : 0.14))
                // Any progress fills, started or not — indigo while something
                // waits, green once nothing does (`color(for:)`), as on the web.
                if segment.fraction > 0 {
                    Capsule()
                        .fill(color(for: segment.state))
                        .frame(width: max(geo.size.height, geo.size.width * segment.fraction))
                }
            }
        }
        .frame(height: segment.isCurrent ? 8 : 4)
    }

    private func color(for state: SlotState) -> Color {
        switch state {
        case .done: return WidgetTheme.trackMetTint.opacity(0.85)
        // `WidgetTheme.indigoAccent` (2026-09-23) — the same named constant
        // the "show completed" dot's ON state now uses, so this
        // segment's fill and that toggle can never drift into two
        // different indigos.
        // A period not yet started but with some already considered fills
        // indigo too, as far as it goes (its faint track says "not yet").
        case .behind, .upcoming: return WidgetTheme.indigoAccent
        }
    }
}

/// One reminder: a tappable title and, at the row's trailing edge, a
/// check-off button.
///
/// The two tap targets are deliberately distinct — the circle completes in
/// place (§8: budget-free reload), the title opens the app. §8 rules out swipe
/// gestures, so there is nothing hidden behind an edge.
///
/// The circle moved to the TRAILING edge 2026-09-23 (Trent: "I need some way
/// to complete the reminders by tapping on the right side because my thumb
/// can't reach the circles on the left"). No overlap risk: `HStack` lays
/// out the `Link` and the `Button` as non-overlapping siblings — the Link's
/// `.frame(maxWidth: .infinity)` fills whatever the marker's fixed
/// `WidgetTheme.rowMarkerSize` column doesn't take; nothing here relies on
/// hit-testing precedence between overlapping views (the community-reported
/// failure mode `ios/AGENTS.md`'s tap-targets note warns about).
///
/// A reminder is a THOUGHT, not an errand ("Done is better than perfect. Start
/// small."), and half a thought prompts nothing — so the title wraps to its
/// full length (`lines`, uncapped on every family since 2026-09-24) rather
/// than ellipsising. The list shows fewer rows to pay for it.
///
/// DUMB ABOUT ITS OWN SIZE (2026-09-24): `lines` and `height` come from
/// `RemindersListView.layout(for:)` — the same numbers the pager added up —
/// and the list frames the row to `height`. The row used to measure itself
/// and reserve a `minHeight`, which only had to AGREE with a `ViewThatFits`
/// guess; now there is nothing to agree with.
private struct ReminderRow: View {
    let reminder: TaskDTO
    let lines: Int
    let height: CGFloat
    /// Longer than the whole card — draw ALL of it, smaller, in `height`.
    var shrinks = false
    /// One title line's height — the marker centres on the FIRST line.
    let firstLineHeight: CGFloat
    /// How far the check-off's tap area reaches into the gap above and below
    /// the row without taking layout space (see `RemindersListView.
    /// markerBleed`). Applied as negative vertical padding on the Button, so
    /// adjacent targets meet but never overlap.
    let markerBleed: CGFloat
    /// The notes glyph's size after the title, nil when the reminder has no
    /// notes — the value the pager measured with (`WidgetTheme.
    /// titleText(_:notesGlyphSize:)`).
    let notesGlyphSize: CGFloat?

    var body: some View {
        // .top, not .center: on a two-line row a centred circle floats down
        // into the gap between the lines, reading as if it belongs to neither.
        HStack(alignment: .top, spacing: 10) {
            Link(destination: WidgetLink.reminder(reminder.id)) {
                WidgetTheme.titleText(Text(reminder.title), notesGlyphSize: notesGlyphSize)
                    .font(.subheadline)
                    .fontWeight(WidgetTheme.priorityWeight(reminder.priority))
                    .foregroundStyle(.primary)
                    .opacity(WidgetTheme.priorityOpacity(reminder.priority))
                    .modifier(RowTitleFit(lines: lines, height: height, shrinks: shrinks))
                    .contentShape(Rectangle())
                    .accessibilityLabel(
                        Text(NotesGlyph.accessibilityLabel(reminder.title, hasNotes: reminder.hasNotes))
                    )
            }

            Button(intent: CompleteTaskIntent(taskId: reminder.id, kind: RemindersWidget.kind)) {
                Image(systemName: "circle")
                    .font(.system(size: 19, weight: .light))
                    .foregroundStyle(WidgetTheme.priorityColor(reminder.priority))
                    // TWO frames, deliberately not one. The FIRST is exactly
                    // one line tall with DEFAULT (.center) alignment, which
                    // centres the glyph on the title's first line
                    // specifically — not the row as a whole. The SECOND pins
                    // that already-centred result to the TOP of the full
                    // target height, so a wrapped title's extra lines extend
                    // the tappable area downward without dragging the glyph
                    // down with them. A single `.frame(height:, alignment:
                    // .top)` would pin the glyph's own small intrinsic size
                    // to the top edge instead — the "floats between the
                    // lines" failure this avoids.
                    .frame(width: WidgetTheme.rowMarkerSize, height: firstLineHeight)
                    // The bleed above is part of the target, not the glyph's
                    // offset: pad it back so the glyph stays on line 1.
                    .padding(.top, markerBleed)
                    .frame(width: WidgetTheme.rowMarkerSize, height: height + 2 * markerBleed, alignment: .top)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.vertical, -markerBleed)
        }
    }
}

/// One completed reminder in the DONE section (2026-09-23, "show
/// completed") — struck-through title, no time (Reminders never show a due
/// time on an open row either, per this file's header comment). Row grammar
/// mirrors `ReminderRow`'s (title = `Link`, trailing marker = `Button`) —
/// the handoff's decision, picked over "whole row is one button" because
/// it's the smallest diff from the open row and keeps the item's own deep
/// link live even while shown as done.
///
/// Wraps in full like `ReminderRow` (2026-09-24 — it was `.lineLimit(1)`
/// as "secondary content" until realistic data showed "Morning = Focus,
/// Afternoon…" cut off; the never-truncate rule has no exception for done).
/// `lines`/`height`/`shrinks` are what the pager counted.
private struct DoneReminderRow: View {
    let reminder: TaskDTO
    let lines: Int
    let height: CGFloat
    let shrinks: Bool
    /// The marker centres on the FIRST line, like `ReminderRow`'s.
    let firstLineHeight: CGFloat
    /// See `ReminderRow.notesGlyphSize`.
    let notesGlyphSize: CGFloat?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Link(destination: WidgetLink.reminder(reminder.id)) {
                // Struck through, the glyph isn't: `.strikethrough()` on the
                // title alone, before the glyph is appended.
                WidgetTheme.titleText(Text(reminder.title).strikethrough(), notesGlyphSize: notesGlyphSize)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .modifier(RowTitleFit(lines: lines, height: height, shrinks: shrinks))
                    .contentShape(Rectangle())
                    .accessibilityLabel(
                        Text(NotesGlyph.accessibilityLabel(reminder.title, hasNotes: reminder.hasNotes))
                    )
            }

            Button(intent: UncompleteTaskIntent(taskId: reminder.id, kind: RemindersWidget.kind)) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 19, weight: .light))
                    .foregroundStyle(.secondary)
                    .frame(width: WidgetTheme.rowMarkerSize, height: firstLineHeight)
                    .frame(width: WidgetTheme.rowMarkerSize, height: height, alignment: .top)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }
}

// MARK: - Quota prompts (quota reminders, 2026-09-24)

/// The widths a prompt row spends on things that are not its label — the
/// ONE place both the pager's measurement (`RemindersListView.layout(for:)`)
/// and the row's drawing (`PromptRow`) read them from, so the label is
/// measured at exactly the column it is drawn in.
enum PromptRowMetrics {
    /// The quota's label-color stripe — the width a quota chip's stripe is
    /// (`QuotaMetrics.chipStripeWidth`, 3pt) — and the gap after it.
    static let stripeWidth: CGFloat = 3
    static let stripeGap: CGFloat = 6
    /// Row `HStack` spacing between the label and the controls — the same
    /// 10pt `ReminderRow` uses.
    static let controlGap: CGFloat = 10

    /// An open prompt's label column: the card minus the stripe and its gap,
    /// the gap before the controls, and TWO trailing controls — the did-it
    /// square and the consider circle, each on the reminder row's 36pt
    /// finger column (`WidgetTheme.rowMarkerSize`), side by side.
    static func titleWidth(in width: CGFloat) -> CGFloat {
        width - stripeWidth - stripeGap - controlGap - 2 * WidgetTheme.rowMarkerSize
    }

    /// A handled prompt in DONE: one (inert) trailing marker, like
    /// `DoneReminderRow`.
    static func doneTitleWidth(in width: CGFloat) -> CGFloat {
        width - stripeWidth - stripeGap - controlGap - WidgetTheme.rowMarkerSize
    }

    /// The stripe's color: the quota's label color, resolved by the server
    /// (never green), or a faint neutral for no label/no color — the watch
    /// Quotas page's `WatchTheme.labelColor` rule, and the web's
    /// `trackStripeClass`.
    static func stripeColor(_ name: String?) -> Color {
        guard name != nil else { return Color.secondary.opacity(0.35) }
        return WidgetTheme.projectColor(name)
    }
}

/// One waiting quota PROMPT — drawn AS a reminder row (`ReminderRow` is the
/// sibling, and everything not listed here is copied from it: the title
/// `Link`, the full wrap, the trailing marker with its bleed).
///
/// WHAT DIFFERS (Trent's final decisions, 2026-09-24):
/// - A thin LEADING stripe in the quota's label color — the quota chip's own
///   stripe.
/// - The label carries the count, "Piano Scales · 1/2" — one `Text` built from
///   `QuotaPromptDTO.labelText`, the exact string the pager measured.
/// - TWO controls at the trailing edge. The DASHED circle is where every
///   reminder's solid circle is (the outermost column, thumb reach) and means
///   the same thing: CONSIDERED ("seen") for today, nothing logged. Dashed,
///   not solid (2026-09-25): Trent habitually tapped the circle meaning
///   "done", but on a prompt it means "seen" (an eye came first; creepy). The
///   SQUARE, just inside it and beside the
///   count, is DID IT: +1 and considered. Square because it is a different
///   verb, and a checkbox is what "I did this" looks like everywhere else.
///   Both are `ActOnPromptIntent`, keyed by `prompt_key`.
/// - The title links to THIS ROW on the Reminders surface
///   (`WidgetLink.prompt`, by `prompt_key`), highlighted, exactly as a
///   reminder row's title does — it was tapped on the Reminders widget, so it
///   opens the Reminders tab, not the Quotas one (2026-09-27).
private struct PromptRow: View {
    let prompt: QuotaPromptDTO
    let lines: Int
    let height: CGFloat
    var shrinks = false
    let firstLineHeight: CGFloat
    let markerBleed: CGFloat
    /// The notes glyph's size, drawn after the COUNT (the web's
    /// `QuotaPromptRow` order: title · count, then the mark); nil when the
    /// quota has no notes. See `ReminderRow.notesGlyphSize`.
    let notesGlyphSize: CGFloat?

    /// "Piano Scales, 1/2 today" (+ ", has notes") — what VoiceOver reads for
    /// the label and names each control by.
    private var spokenLabel: String {
        NotesGlyph.accessibilityLabel("\(prompt.title), \(prompt.countText)", hasNotes: prompt.hasNotes)
    }

    var body: some View {
        HStack(alignment: .top, spacing: PromptRowMetrics.controlGap) {
            HStack(alignment: .top, spacing: PromptRowMetrics.stripeGap) {
                Capsule()
                    .fill(PromptRowMetrics.stripeColor(prompt.stripeColor))
                    .frame(width: PromptRowMetrics.stripeWidth, height: max(height - 4, 0))
                    .padding(.top, 2)
                Link(destination: WidgetLink.prompt(prompt.promptKey)) {
                    WidgetTheme.titleText(
                        Text(prompt.title).foregroundStyle(.primary)
                            + Text("\(QuotaPromptDTO.countSeparator)\(prompt.countText)").foregroundStyle(.secondary),
                        notesGlyphSize: notesGlyphSize
                    )
                        .font(.subheadline)
                        // A P0 reminder title's weight and opacity.
                        .opacity(WidgetTheme.priorityOpacity(0))
                        .modifier(RowTitleFit(lines: lines, height: height, shrinks: shrinks))
                        .contentShape(Rectangle())
                        .accessibilityLabel(Text(spokenLabel))
                }
            }

            HStack(alignment: .top, spacing: 0) {
                control(
                    intent: ActOnPromptIntent(promptKey: prompt.promptKey, did: true),
                    symbol: "square", label: "Did it: \(spokenLabel)"
                )
                control(
                    intent: ActOnPromptIntent(promptKey: prompt.promptKey, did: false),
                    symbol: "circle.dashed", label: "Considered: \(spokenLabel)"
                )
            }
        }
    }

    /// One trailing control — `ReminderRow`'s circle, framing and bleed
    /// verbatim (see its doc for why two frames): the glyph centres on the
    /// label's FIRST line, the tap area reaches `markerBleed` into the gaps.
    private func control(intent: ActOnPromptIntent, symbol: String, label: String) -> some View {
        Button(intent: intent) {
            Image(systemName: symbol)
                .font(.system(size: 19, weight: .light))
                // A P0 reminder circle's color — a prompt has no priority.
                .foregroundStyle(WidgetTheme.priorityColor(0))
                .frame(width: WidgetTheme.rowMarkerSize, height: firstLineHeight)
                .padding(.top, markerBleed)
                .frame(width: WidgetTheme.rowMarkerSize, height: height + 2 * markerBleed, alignment: .top)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, -markerBleed)
        .accessibilityLabel(Text(label))
    }
}

/// A quota prompt handled today, in the DONE section — `DoneReminderRow`'s
/// look (struck through, muted) AND its put-back (2026-09-25): the marker is
/// a `Button` running `RestorePromptIntent` (`POST
/// /api/quota-prompts/restore`, never `/undone`, which refuses quotas), so
/// the prompt waits again and a did-it's progress comes off. Before this it
/// was an inert glyph, and a tap there fell through to the row's `Link` and
/// opened the app (Trent: "for reminders, tapping the filled circle puts
/// them back"). The glyph is the prompt's own "considered" circle, filled —
/// `PromptRow`'s `circle.dashed` as `circle.dashed.inset.filled`, as a
/// reminder's DONE circle is its circle filled — for a did-it too (the count
/// beside it says what was logged); the web's `ConsideredPromptRow` draws
/// the same.
private struct DonePromptRow: View {
    let prompt: QuotaPromptDTO
    let lines: Int
    let height: CGFloat
    let shrinks: Bool
    let firstLineHeight: CGFloat
    /// See `PromptRow.notesGlyphSize`.
    let notesGlyphSize: CGFloat?

    var body: some View {
        HStack(alignment: .top, spacing: PromptRowMetrics.controlGap) {
            HStack(alignment: .top, spacing: PromptRowMetrics.stripeGap) {
                Capsule()
                    .fill(PromptRowMetrics.stripeColor(prompt.stripeColor).opacity(0.5))
                    .frame(width: PromptRowMetrics.stripeWidth, height: max(height - 4, 0))
                    .padding(.top, 2)
                Link(destination: WidgetLink.prompt(prompt.promptKey)) {
                    WidgetTheme.titleText(Text(prompt.labelText).strikethrough(), notesGlyphSize: notesGlyphSize)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .modifier(RowTitleFit(lines: lines, height: height, shrinks: shrinks))
                        .contentShape(Rectangle())
                        .accessibilityLabel(
                            Text(NotesGlyph.accessibilityLabel(
                                "\(prompt.title), \(prompt.countText)", hasNotes: prompt.hasNotes
                            ))
                        )
                }
            }

            // `DoneReminderRow`'s button, verbatim: the whole marker column
            // is the target, so a tap on it never reaches the row's `Link`.
            Button(intent: RestorePromptIntent(promptKey: prompt.promptKey)) {
                Image(systemName: "circle.dashed.inset.filled")
                    .font(.system(size: 19, weight: .light))
                    .foregroundStyle(.secondary)
                    .frame(width: WidgetTheme.rowMarkerSize, height: firstLineHeight)
                    .frame(width: WidgetTheme.rowMarkerSize, height: height, alignment: .top)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("Put back: \(prompt.title), \(prompt.countText)"))
        }
    }
}

// MARK: - Lock Screen
//
// Lock Screen accessory families don't exist on macOS (see the #if os(iOS)
// guard on `content` above and on RemindersWidget's supportedFamilies), so
// these two views — and AccessoryWidgetBackground, which only compiles on
// iOS — are gated out of the macOS build entirely rather than left as dead
// code that happens to still compile.
#if os(iOS)

/// Lock Screen rectangular: glanceable only.
///
/// §8: interactive widgets are inert on a locked device, so putting a check-off
/// button here would be a control that silently does nothing until the user
/// authenticates. It states the slot, the count and the first item, and stops.
private struct RemindersRectangularView: View {
    let entry: RemindersEntry

    /// The first waiting item — a reminder, else a quota prompt's label
    /// (2026-09-24) — and the count of everything waiting.
    private var firstTitle: String? {
        entry.group?.reminders.first?.title ?? entry.group?.waitingPrompts.first?.labelText
    }

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
                    Text("\(entry.group?.waitingCount ?? 0)")
                        .font(.headline)
                        .widgetAccentable()
                }
                // Shrinks rather than truncating (2026-09-24) — see
                // `RemindersSmallView`'s title.
                Text(firstTitle ?? "All clear")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .minimumScaleFactor(WidgetTheme.overflowTitleScale)
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
                Text("\(entry.group?.waitingCount ?? 0)")
                    .font(.system(size: 17, weight: .semibold, design: .rounded))
                    .minimumScaleFactor(0.7)
            }
        }
        .widgetURL(WidgetLink.reminders)
    }
}

#endif

