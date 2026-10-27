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
    @Environment(\.widgetFamily) private var environmentFamily

    let entry: RemindersEntry

    /// Render-only: the family to draw when there is no WidgetKit host to set
    /// `\.widgetFamily` (it is get-only), i.e. the screenshot renderer
    /// (`ios/Tests/Renders/`, docs/SCREENSHOTS.md). Always nil in the widget
    /// extension, where the environment's family is used unchanged.
    var familyOverride: WidgetFamily? = nil

    private var family: WidgetFamily { familyOverride ?? environmentFamily }

    var body: some View {
        // No change animation (Trent, 2026-10-03): WidgetKit animates from
        // one timeline entry to the next, and a checked-off row made every
        // row below it warp into its neighbour's text — disorienting at 3–4
        // taps a second. Rows are also keyed by item, not position (the
        // `ForEach` in `listBody`).
        //
        // Motion was tried and dropped the same day, on the phone: keyed rows
        // with a 0.2s slide still showed the leaving row's text doubled under
        // the rows moving up; an instant removal made WidgetKit skip the
        // slide entirely; a 0.05s removal fade still read as doubled text.
        // WidgetKit's entry-to-entry animation doesn't give the control a
        // clean slide needs, so the list snaps.
        content
            .contentTransition(.identity)
            .transaction { $0.animation = nil }
            .containerBackground(for: .widget) {
                switch family {
                case .systemSmall, .systemMedium, .systemLarge:
                    // Day complete (2026-09-29): the green wash on EVERY
                    // period's view, not just the clock's — see
                    // `ReminderDayProgress`. Lock Screen families keep the
                    // system's own background.
                    ZStack {
                        Rectangle().fill(.fill.tertiary)
                        if showsDayCompleteWash {
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
            listView(isLarge: false)
                .backgroundTapOpens(WidgetLink.reminders)
        default:
            // No row ceiling (2026-09-24): the list pages by real row
            // height, as many as fit — see `RemindersListView`'s doc.
            listView(isLarge: true)
                .backgroundTapOpens(WidgetLink.reminders)
        }
    }

    /// A task segment page (2026-10-10) or a time slot's list. The 2×2 and
    /// the Lock Screen stay slot-only: they are glanceable reminder counts,
    /// and segment rows count toward no reminders number (amendment 8).
    @ViewBuilder
    private func listView(isLarge: Bool) -> some View {
        if let segment = entry.segment {
            TaskSegmentListView(entry: entry, segment: segment, isLarge: isLarge)
        } else {
            RemindersListView(entry: entry, isLarge: isLarge)
        }
    }

    /// On every page, task segment pages included (2026-10-11): day complete
    /// now asks the task segments too, so a segment with rows still waiting
    /// keeps the wash off everywhere, and a finished one doesn't hold it back.
    private var showsDayCompleteWash: Bool {
        ReminderDayProgress.isDayComplete(entry.groups, segments: entry.segments)
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
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.displayScale) private var displayScale

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
                    // ("Breakfast ( Oatmeal, Berri…" at XXX Large). A
                    // drop-the-word ladder was tried for the "wee…" report
                    // (2026-10-26) and rejected on the render: `ViewThatFits`
                    // can't see that a slight shrink fits, so it dropped the
                    // count where this shrink keeps it whole.
                    firstItemText(firstItem.text)
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

    /// The first item's line. A quota prompt draws its count as segments
    /// (2026-10-13) in the caption2 line's em — the rows' look in small —
    /// or "3/7 today" above six. Text alone for a reminder.
    private func firstItemText(_ text: String) -> Text {
        guard entry.group?.reminders.first == nil, let prompt = entry.group?.waitingPrompts.first else {
            return Text(text)
        }
        let em = WidgetTextMetrics(dynamicTypeSize: dynamicTypeSize).caption2Font.pointSize
        let count = QuotaSegmentsText.count(
            QuotaCount.chooseForm(target: prompt.target), current: prompt.current, target: prompt.target,
            word: prompt.segmentWord, em: em, wordSize: em, scale: displayScale
        )
        return (Text(prompt.title) + Text(" ") + count)
            .accessibilityLabel(Text("\(prompt.title), \(prompt.spokenCount)"))
    }

    /// Nothing waiting in the on-screen period — the 2×2 keeps its one
    /// compact line, in the same words as the larger cards (2026-09-29):
    /// "Day complete" on any period once the whole day is done (the card
    /// also takes the green wash), "Complete" for a finished period. There
    /// is no room here for the big seal or "Congratulations".
    @ViewBuilder
    private var emptyState: some View {
        let state = ReminderDayProgress.emptyBody(
            groups: entry.groups, segments: entry.segments, displayedIndex: entry.slotIndex
        )
        switch state {
        case .noReminders:
            WidgetEmptyView(symbol: "checkmark.circle", message: "No reminders today", compact: true)
        case .dayComplete:
            WidgetEmptyView(symbol: "checkmark.seal.fill", message: "Day complete", compact: true)
        case .periodDone:
            WidgetEmptyView(symbol: "checkmark.seal.fill", message: "Complete", compact: true)
        case .nothingHere, .nothingToday:
            WidgetEmptyView(symbol: "checkmark.circle", message: "Nothing left here", compact: true)
        }
    }
}

/// The Reminders widget's pages through its page anchor
/// (`WidgetStore.anchoredPages`) — shared by a period's list and a task
/// segment's, which share one stored page index (`remindersPage(for:)`,
/// paired with the page key so it resets on a period change) and so one
/// anchor. Records only from the systemLarge card drawing its CURRENT entry
/// (see `anchoredPages`' `records`), and then stores the page drawn as the
/// page index, so ‹ › counts from what is on screen.
private func remindersPaging(
    rows: [PagedRow], pageKey: Int, isLarge: Bool, entryDate: Date,
    plain: (Range<Int>) -> [Range<Int>]
) -> AnchoredPaging.Result {
    guard isLarge else {
        return AnchoredPaging.Result(pages: plain(0..<rows.count), page: 0, anchor: nil)
    }
    let now = Date()
    let records = entryDate <= now
    let stored = WidgetStore.remindersPage(for: pageKey)
    let result = WidgetStore.anchoredPages(
        list: .reminders, pageKey: "reminders:\(pageKey)", rows: rows, storedPage: stored,
        records: records, now: now, plain: plain
    )
    if records, result.page != stored {
        WidgetStore.setRemindersPage(result.page, for: pageKey)
    }
    return result
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
/// A row's position on the page plus its item's stable id: the `ForEach`
/// identity, so a checked-off row's neighbours keep their own identity
/// instead of inheriting its slot (see the widget view's `body`).
private struct ListRowRef: Identifiable {
    let index: Int
    let id: String
}

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

    /// The row as the page anchor sees it (`PagedRow`): keyed by `id` (open
    /// and done rows differ), identified by the task id or `prompt_key` (the
    /// same for both — handling a row is not a new item).
    var pagedRow: PagedRow {
        switch self {
        case .open(let reminder): return PagedRow(keys: [id], identities: ["task:\(reminder.id)"])
        case .prompt(let prompt): return PagedRow(keys: [id], identities: ["prompt:\(prompt.promptKey)"])
        case .divider: return PagedRow(keys: [], identities: [], staysWithNext: true)
        case .done(let reminder): return PagedRow(keys: [id], identities: ["task:\(reminder.id)"])
        case .donePrompt(let prompt): return PagedRow(keys: [id], identities: ["prompt:\(prompt.promptKey)"])
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
    /// Where a task segment row's small words go (2026-10-12): after the
    /// title, on their own line, or one part per line — whichever leaves no
    /// "·" at either end of a line (`SegmentMetaPlacement`).
    var metaPlacement: SegmentMetaPlacement = .inline
    /// How short an Upcoming row's words are (2026-10-12): the first
    /// `UpcomingMetaForm` whose words fit ONE line at the row's width.
    var upcomingForm: UpcomingMetaForm = .full
    /// A quota prompt row's count form (2026-10-13): segments or the text
    /// fallback, decided before measuring (`WidgetTextMetrics.promptCountForm`).
    var countForm: QuotaCount.Form = .segments
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
    private var canPage: Bool { entry.groups.count + entry.segments.count > 1 }

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
                    ReminderSlotStrip(
                        groups: entry.groups, segments: entry.segments,
                        currentKey: entry.group?.slotKey, now: entry.date
                    )
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
        // Anchored while the user is tapping (2026-10-14, `PageAnchor.swift`):
        // a handled row's neighbours move up within the page on screen and
        // never slide back onto the page before it. systemMedium has no
        // pager, so it always shows the first page and records nothing — the
        // stored page and its anchor belong to the systemLarge card's pager.
        let slotKey = entry.group?.slotKey ?? -1
        let paging = remindersPaging(
            rows: items.map(\.pagedRow), pageKey: slotKey, isLarge: isLarge, entryDate: entry.date
        ) { range in
            WidgetTheme.pages(heights: layouts.map(\.height), spacing: rowSpacing, budget: budget, in: range) {
                if case .divider = items[$0] { return true }
                return false
            }
        }
        let pages = paging.pages
        let page = paging.page
        let range = pages[page]

        return VStack(alignment: .leading, spacing: 0) {
            if entry.groups.isEmpty {
                WidgetEmptyView(symbol: "checkmark.circle", message: "No reminders today")
            } else if items.isEmpty {
                emptySlotView
            } else {
                VStack(alignment: .leading, spacing: rowSpacing) {
                    // Keyed by the item, not its position — see `body`.
                    ForEach(range.map { ListRowRef(index: $0, id: items[$0].id) }) { ref in
                        row(items[ref.index], layout: layouts[ref.index], metrics: metrics)
                            .frame(height: layouts[ref.index].height, alignment: .top)
                            .transition(.identity)
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
            // The label is ONE run, title then count (segments and word, or
            // "3/7 today" — 2026-10-13), measured at the column the row
            // really gives it: the card minus the stripe, and minus BOTH
            // trailing controls — the did-it square and the consider circle
            // (`PromptRowMetrics.titleWidth`). Same floor as a reminder row.
            let column = PromptRowMetrics.titleWidth(in: width)
            let form = metrics.promptCountForm(prompt, width: column)
            let fit = metrics.promptLines(prompt, form: form, width: column, maxHeight: budget)
            if fit.shrinks {
                return ReminderRowLayout(lines: fit.lines, height: budget, shrinks: true, countForm: form)
            }
            return ReminderRowLayout(
                lines: fit.lines, height: max(metrics.titleHeight(lines: fit.lines), rowFloor), countForm: form
            )
        case .donePrompt(let prompt):
            // DONE rows have one trailing marker, like `DoneReminderRow`.
            let column = PromptRowMetrics.doneTitleWidth(in: width)
            let form = metrics.promptCountForm(prompt, width: column)
            let fit = metrics.promptLines(prompt, form: form, width: column, maxHeight: budget)
            if fit.shrinks {
                return ReminderRowLayout(lines: fit.lines, height: budget, shrinks: true, countForm: form)
            }
            return ReminderRowLayout(lines: fit.lines, height: metrics.titleHeight(lines: fit.lines), countForm: form)
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
                label: PromptLabel(prompt: prompt, form: layout.countForm, metrics: metrics)
            )
        case .donePrompt(let prompt):
            DonePromptRow(
                prompt: prompt, lines: layout.lines, height: layout.height, shrinks: layout.shrinks,
                firstLineHeight: metrics.titleHeight(lines: 1),
                label: PromptLabel(prompt: prompt, form: layout.countForm, metrics: metrics)
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
    ///    waiting and something was handled: a big seal, "Congratulations",
    ///    "Day complete" on EVERY period, under the green wash
    ///    (`RemindersWidgetView`'s background). #191 congratulated on the
    ///    clock's period alone; Trent wanted it "on every segment".
    /// 2. **This period is finished**: the seal and "Complete". No count
    ///    line — the bottom-left "7 of 7" carries the count. The header
    ///    already names the period, so the body doesn't.
    /// 3. **Never had anything** — the original "Nothing left here".
    ///
    /// No finish time and no "Next …" line: the strip above already shows
    /// what's left of the day (Trent's review of the mockups).
    @ViewBuilder
    private var emptySlotView: some View {
        let state = ReminderDayProgress.emptyBody(
            groups: entry.groups, segments: entry.segments, displayedIndex: entry.slotIndex
        )
        switch state {
        case .noReminders:
            WidgetEmptyView(symbol: "checkmark.circle", message: "No reminders today")
        case .dayComplete:
            DayCompleteView(isLarge: isLarge)
        case .periodDone:
            PeriodDoneView(isLarge: isLarge)
        case .nothingHere, .nothingToday:
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
        guard let group = entry.group, let minutes = group.slot?.startMinutes else { return countLabel }
        let day = DayStartStore.current
        let time = WidgetTheme.shortTime(day.periodOpensAt(day.openTaskDay(of: entry.date), startMinutes: minutes))
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

/// "Congratulations / Day complete" (2026-09-29, mockups r3-c/e/f): any
/// period once EVERY period of the day has nothing waiting
/// (`ReminderDayProgress.isDayComplete`). The seal is ~1.6x
/// `PeriodDoneView`'s on systemLarge (35pt vs `.title2`'s 22). It was ~2x
/// (44pt seal, `.title2` title, `.footnote` line) until Trent's "a tad too
/// big": each of the three came down one step and still clearly outranks
/// "Complete". systemMedium sizes everything down so the three lines fit its
/// ~80pt body. No tint here — the green wash is the whole card's background
/// (`RemindersWidgetView`).
private struct DayCompleteView: View {
    let isLarge: Bool

    var body: some View {
        VStack(spacing: isLarge ? 6 : 2) {
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: isLarge ? 35 : 26))
                .foregroundStyle(.green.opacity(0.85))
                .padding(.bottom, isLarge ? 4 : 2)
            Text("Congratulations")
                .font(isLarge ? .title3.weight(.semibold) : .callout.weight(.semibold))
                .foregroundStyle(.primary)
            Text("Day complete")
                .font(isLarge ? .caption : .caption2)
                .foregroundStyle(.secondary)
        }
        .multilineTextAlignment(.center)
        .minimumScaleFactor(0.8)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }
}

/// A finished period (2026-09-29, mockup r3-b1): the seal at
/// `WidgetEmptyView`'s size and "Complete" (semibold, primary). No count
/// line under it — the bottom-left "7 of 7" carries the count (Trent's
/// follow-up; #191 read "All done / 7 reminders"). It replaced
/// "<Period> done" and "All caught up".
private struct PeriodDoneView: View {
    let isLarge: Bool

    var body: some View {
        VStack(spacing: isLarge ? 8 : 4) {
            Image(systemName: "checkmark.seal.fill")
                .font(isLarge ? .title2 : .title3)
                .foregroundStyle(.green.opacity(0.85))
            Text("Complete")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
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
/// for STATE and COLOR, not layout: `.behind` (started, still waiting) fills
/// in the reminders' purple (`WidgetTheme.dayBarFilling`, indigo until
/// 2026-10-26), `.done` (started, nothing waiting, something WAS considered)
/// draws green, `.upcoming` (time hasn't come) draws a barely-there neutral — "the
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
///
/// TASK SEGMENTS ARE BARS TOO (2026-10-11): after the periods, one bar per
/// task segment shown today — sized by its rows today, filled by its "X of
/// Y" (considered + deferred), purple while a row waits and green once none
/// does (2026-10-26; each filled in its horizon's teal before), never the
/// faint "not yet" track. Trent: "it's really bizarre that
/// it doesn't have segments for the tasks. you have to <- and -> to get to
/// it and there is no indication that it's there or how complete it is."
/// A task page's own bar grows like the on-screen period's (no outline),
/// and tapping a task bar jumps to its page.
private struct ReminderSlotStrip: View {
    let groups: [ReminderGroupDTO]
    /// Today's LISTED task segments — a bar each, after the periods
    /// (2026-10-11, "segments as slots").
    let segments: [TaskSegmentDTO]
    /// The page on screen — a period's `slotKey` or a segment's `pageKey`,
    /// one key space — whose bar wears the ring.
    let currentKey: Int?
    let now: Date

    /// The bars, from the Foundation-only model `ReminderDayProgress.
    /// stripBars` (tested in `ReminderDayProgressTests`): which bars, their
    /// order, state, fill and width weight. This view only draws them.
    private var bars: [ReminderDayProgress.StripBar] {
        ReminderDayProgress.stripBars(groups: groups, segments: segments, now: now, day: DayStartStore.current)
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

    @Environment(\.colorScheme) private var colorScheme

    /// The faint divider between the period bars and the task bars
    /// (2026-10-11, option 3): 1pt wide, 12pt tall, with 6pt of air each side
    /// — the `HStack`'s 3pt spacing plus 3pt of its own padding.
    private static let separatorWidth: CGFloat = 1
    private static let separatorHeight: CGFloat = 12
    private static let separatorPadding: CGFloat = 3

    /// Where the divider goes: before the first task bar, only when a period
    /// bar comes before it (task segments exist today AND periods do).
    private func separatorBefore(_ position: Int, in shown: [ReminderDayProgress.StripBar]) -> Bool {
        position > 0 && shown[position].kind == .taskSegment && shown[position - 1].kind == .period
    }

    var body: some View {
        // One bar is not a strip — same rule as the web's ReminderSlotBar
        // ("it would say only 'everything is here', which the header already
        // says better"). Task segment bars count (2026-10-11): one period and
        // one task segment is two pages, and the strip is how you find the
        // second.
        let shown = bars
        if shown.count >= 2 {
            GeometryReader { geo in
                let hasSeparator = shown.indices.contains { separatorBefore($0, in: shown) }
                // The divider is one more `HStack` child: its width, its own
                // padding, and one more spacing.
                let separatorCost = hasSeparator
                    ? Self.separatorWidth + 2 * Self.separatorPadding + segmentSpacing : 0
                let gaps = segmentSpacing * CGFloat(shown.count - 1) + separatorCost
                let widths = SegmentWidths.widths(
                    weights: shown.map { Double($0.total) },
                    available: Double(max(geo.size.width - gaps, 0)),
                    minimum: Self.minimumSegmentWidth
                )
                HStack(spacing: segmentSpacing) {
                    ForEach(Array(shown.enumerated()), id: \.element.key) { position, bar in
                        if separatorBefore(position, in: shown) {
                            Rectangle()
                                .fill(WidgetTheme.stripSeparator(scheme: colorScheme))
                                .frame(width: Self.separatorWidth, height: Self.separatorHeight)
                                // Taller than the strip's 8pt row on purpose
                                // (the mockup's 12px); drawn centred over it,
                                // inside the card, so nothing clips.
                                .frame(height: maxSegmentHeight)
                                .padding(.horizontal, Self.separatorPadding)
                                .accessibilityHidden(true)
                        }
                        // A task segment's bar jumps to its page exactly as a
                        // period's does: the intent takes any page key.
                        Button(intent: JumpToReminderSlotIntent(slotKey: bar.key)) {
                            segmentBar(for: bar)
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
                        .accessibilityLabel(Text(bar.label))
                        .accessibilityValue(Text("\(bar.handled) of \(bar.total)"))
                    }
                }
            }
            .frame(height: maxSegmentHeight)
            .padding(.bottom, WidgetTheme.reminderSlotStripHeight - maxSegmentHeight)
        }
    }

    /// One slot: a faint track, filled PURPLE as far as it has been
    /// considered and GREEN end to end once it is done — the web's
    /// `ReminderSlotBar` (Trent, 2026-09-23: "when it's partially full, it's
    /// either showing full indigo or full green when really the indigo should
    /// be filling up"; the indigo became the reminders' purple on
    /// 2026-10-26). A slot whose time has not come shows only the track.
    ///
    /// THE CURRENT SLOT IS TWICE AS THICK (option A of five he was shown,
    /// rendered side by side). Option B — current at full strength, the rest
    /// dimmed — was tried first and dropped the same day: "I'm not a huge fan
    /// of the dimness", and a current slot with nothing considered is a gray
    /// track that barely stood out from dimmed gray ones. Thickness reads the
    /// same whatever the fill. Both replaced a 1pt white ring he found hard to
    /// look at, which the widget also clipped at both rounded ends. Nothing is
    /// drawn outside the bar's own frame, so nothing can be clipped.
    ///
    /// TASK SEGMENT BARS (2026-10-11): filled exactly like a period's —
    /// purple while a row waits, green once none does — on the same gray
    /// track. Until 2026-10-26 each filled in its horizon's teal; Trent:
    /// "Have them all just use the purple and green except for the
    /// deadlines, which finish the teal color that they currently finish at.
    /// That's the special one." — the deadlines page (native PR E) finishes
    /// in its teal, through `SegmentKind.doneColorHex`; an EMPTY segment is
    /// finished from the start, a full bar). The task page's own bar grows exactly as the
    /// on-screen period's does — no outline (Trent, 2026-10-11: "The
    /// reminder segments don't have an outline and neither should this. It
    /// should just grow, same as Reminders.").
    private func segmentBar(for bar: ReminderDayProgress.StripBar) -> some View {
        barBody(for: bar)
            .frame(height: bar.key == currentKey ? 8 : 4)
    }

    private func barBody(for bar: ReminderDayProgress.StripBar) -> some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                // Fainter for a period whose time hasn't come — which is
                // what makes the clock's period read as "now" (type doc). A
                // task segment is shown today, so it is never `.upcoming`.
                Capsule().fill(Color.primary.opacity(bar.state == .upcoming ? 0.055 : 0.14))
                // Any progress fills, started or not — purple while something
                // waits, green once nothing does (`color(for:)`), as on the web.
                if bar.fraction > 0 {
                    Capsule()
                        .fill(color(for: bar))
                        .frame(width: max(geo.size.height, geo.size.width * bar.fraction))
                }
            }
        }
    }

    /// One rule for every bar, period or task segment (2026-10-26, the
    /// web's PR #383): the reminders' purple while filling, green once
    /// finished — or the segment's own finished colour
    /// (`SegmentKind.doneColorHex`: the deadlines page's teal).
    private func color(for bar: ReminderDayProgress.StripBar) -> Color {
        switch bar.state {
        case .done: return WidgetTheme.stripDoneColor(bar.segment, scheme: colorScheme)
        // A period not yet started but with some already considered fills
        // purple too, as far as it goes (its faint track says "not yet").
        case .behind, .upcoming: return WidgetTheme.dayBarFilling(colorScheme)
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

/// A prompt row's label (2026-10-13, quota segments): the title, then the
/// count — N skewed segments and the period word ("▰▱ today"), or the text
/// fallback "3/7 today" when `form` says so — then the notes glyph. The ONE
/// builder both rows draw with, and it draws exactly what
/// `WidgetTextMetrics.promptLines` measured: same breaking space, same box
/// width (`QuotaSegmentsDrawing.boxesWidth`), same word joiner and sizes.
/// The " · " separator went with the old "· 1/2 today" (the web drops it
/// too: the segments set the count apart on their own).
struct PromptLabel {
    let prompt: QuotaPromptDTO
    let form: QuotaCount.Form
    let metrics: WidgetTextMetrics

    /// "1 of 2 today" / "1 of 2 this week".
    var spokenCount: String {
        prompt.spokenCount
    }

    /// "Piano Scales, 1 of 2 today" (+ ", has notes").
    var spoken: String {
        NotesGlyph.accessibilityLabel("\(prompt.title), \(spokenCount)", hasNotes: prompt.hasNotes)
    }

    /// `struck`: a DONE row — the TITLE is struck through and muted; the
    /// count keeps its colors (a handled did-it reads green when met), so the
    /// strike never runs through the boxes.
    func text(struck: Bool) -> Text {
        let title = struck
            ? Text(prompt.title).strikethrough().foregroundStyle(.secondary)
            : Text(prompt.title).foregroundStyle(.primary)
        let count = QuotaSegmentsText.count(
            form, current: prompt.current, target: prompt.target, word: prompt.segmentWord,
            em: metrics.titlePointSize, wordSize: metrics.promptCountWordSize,
            lead: form == .segments ? metrics.promptCountLead : 0, scale: metrics.displayScale
        )
        return WidgetTheme.titleText(
            title + Text(" ") + count, notesGlyphSize: metrics.notesGlyphSize(hasNotes: prompt.hasNotes)
        )
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
    /// Title, count (segments or text) and notes glyph — exactly what the
    /// pager measured (`PromptLabel`).
    let label: PromptLabel

    /// "Piano Scales, 1 of 2 today" (+ ", has notes") — what VoiceOver reads
    /// for the label and names each control by.
    private var spokenLabel: String { label.spoken }

    var body: some View {
        HStack(alignment: .top, spacing: PromptRowMetrics.controlGap) {
            HStack(alignment: .top, spacing: PromptRowMetrics.stripeGap) {
                Capsule()
                    .fill(PromptRowMetrics.stripeColor(prompt.stripeColor))
                    .frame(width: PromptRowMetrics.stripeWidth, height: max(height - 4, 0))
                    .padding(.top, 2)
                Link(destination: WidgetLink.prompt(prompt.promptKey)) {
                    label.text(struck: false)
                        .font(.subheadline)
                        // A P0 reminder title's weight and opacity.
                        .opacity(WidgetTheme.priorityOpacity(0))
                        .modifier(RowTitleFit(lines: lines, height: height, shrinks: shrinks, scalesToFit: true))
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
    /// See `PromptRow.label`.
    let label: PromptLabel

    var body: some View {
        HStack(alignment: .top, spacing: PromptRowMetrics.controlGap) {
            HStack(alignment: .top, spacing: PromptRowMetrics.stripeGap) {
                Capsule()
                    .fill(PromptRowMetrics.stripeColor(prompt.stripeColor).opacity(0.5))
                    .frame(width: PromptRowMetrics.stripeWidth, height: max(height - 4, 0))
                    .padding(.top, 2)
                Link(destination: WidgetLink.prompt(prompt.promptKey)) {
                    label.text(struck: true)
                        .font(.subheadline)
                        .modifier(RowTitleFit(lines: lines, height: height, shrinks: shrinks, scalesToFit: true))
                        .contentShape(Rectangle())
                        .accessibilityLabel(Text(label.spoken))
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
            .accessibilityLabel(Text("Put back: \(prompt.title), \(label.spokenCount)"))
        }
    }
}

// MARK: - Task segments (2026-10-10, docs/TASK-MODEL.md § Task segments)

/// One row of a task segment page: a waiting task, the "CONSIDERED · N"
/// divider, or a task considered today (shown only with the "done" dot on).
private enum SegmentListItem {
    /// An Upcoming section's heading (2026-10-26, the Upcoming split):
    /// "Tomorrow  0 of 2", "Later  1 of 1 ✓".
    case sectionHeader(UpcomingSections.Section)
    case waiting(SegmentTaskDTO)
    case divider(count: Int)
    case considered(SegmentTaskDTO)

    var id: String {
        switch self {
        case .sectionHeader(let s): return "seg-section-\(s.section.rawValue)"
        case .waiting(let row): return "seg-\(row.id)"
        case .divider: return "seg-divider"
        case .considered(let row): return "seg-considered-\(row.id)"
        }
    }

    /// See `ReminderListItem.pagedRow`. A section heading stays with the row
    /// after it (a page never ends on one) and is no ITEM — it has no
    /// identity, so it never lapses an anchor — but it has a key: a page can
    /// start on it ("Later" heads page 2), so an anchor can name it.
    var pagedRow: PagedRow {
        switch self {
        case .sectionHeader: return PagedRow(keys: [id], identities: [], staysWithNext: true)
        case .waiting(let row): return PagedRow(keys: [id], identities: ["task:\(row.id)"])
        case .divider: return PagedRow(keys: [], identities: [], staysWithNext: true)
        case .considered(let row): return PagedRow(keys: [id], identities: ["task:\(row.id)"])
        }
    }

    /// Rows that must share a page with the next one (the plain partition's
    /// rule; the anchored one reads `pagedRow.staysWithNext`).
    var staysWithNext: Bool { pagedRow.staysWithNext }
}

/// The widths a task segment row spends on things that are not its label —
/// the one place the pager's measurement and the row's drawing read them.
enum SegmentRowMetrics {
    /// The reminder row's one gap, between the title and its controls.
    static let gap: CGFloat = 10

    /// "Target today" (2026-10-11): an icon-only button, narrower than the
    /// 36pt check columns (the title needs the width more) but still a 28pt
    /// finger column.
    static let targetTodayWidth: CGFloat = 28

    /// The reminder row's geometry (2026-10-11, Trent: "The task ones should
    /// mimic that but put the consideration circle in the same position as
    /// the Reminders have it"): title from the card's leading edge, then the
    /// 10pt gap, then the controls flush right — Target today, the done
    /// checkbox, and the consider circle in the reminder circle's own
    /// trailing 36pt column. A row with no Target today would give that
    /// column to its title — the row and the pager pass the same
    /// `showsTargetToday` (every row offers it since 2026-10-12; repeating
    /// Upcoming rows were the one exception until then).
    static func titleWidth(in width: CGFloat, showsTargetToday: Bool = true) -> CGFloat {
        width - 2 * WidgetTheme.rowMarkerSize - (showsTargetToday ? targetTodayWidth : 0) - gap
    }

    /// A row that LEFT its segment today (native PR E, `segment_left`): no
    /// Today, no done checkbox — only the filled circle in its column (the
    /// web's `ConsideredSegmentRow`) — so its title takes the rest.
    static func leftTitleWidth(in width: CGFloat) -> CGFloat {
        width - WidgetTheme.rowMarkerSize - gap
    }

    /// The width a row's label wraps in — the row and the pager use the same.
    static func titleWidth(in width: CGFloat, row: SegmentTaskDTO) -> CGFloat {
        row.left != nil ? leftTitleWidth(in: width) : titleWidth(in: width, showsTargetToday: row.offersTargetToday)
    }
}

/// A task segment page of the Reminders widget (2026-10-10): one horizon's
/// one-off tasks that are up for a look today, after the time slots in the
/// page ring (`RemindersTimeline`'s page ring). A sibling of
/// `RemindersListView`, copying its machinery — the real header above a
/// `RenderedTextReader`, every row's height measured up front and paged by
/// `WidgetTheme.pages`, the bottom row with its pager and "done" dot — so a
/// segment page pages, measures and taps exactly like a period does.
///
/// What differs (spec §3, amendment 16):
/// - Rows are TASKS, never reminders: the circle on the LEFT considers ("I
///   saw it", `ConsiderSegmentTaskIntent`), the checkbox on the RIGHT
///   completes (`CompleteTaskIntent`, the ordinary completion). The title
///   carries small secondary words, the web row's rule (`TaskDTO.
///   segmentMeta`): the task's set horizon only when it differs from the
///   page's, a future target's day, the deadline ("Fix the gate · Nov 1 ·
///   deadline Nov 4"); an unset horizon shows nothing; then the server's
///   badge, "3×" in plum or an undated task's ">1 mo" (2026-10-12, label
///   only — no in-widget offer). The title links to the task on the dashboard, where its
///   horizon and target can be changed (deep link in place of in-widget
///   controls, amendment 16).
/// - Order is the server's (priority, then id) and fixed: a considered row
///   leaves the open list but nothing else moves.
/// - The bottom row reads the segment's "X of Y" in the leading spot (a
///   period's "N of M" spot), then "Defer all" (`DeferSegmentIntent`) while
///   anything waits: the whole segment's rest goes to tomorrow (2026-10-12;
///   it was "Defer all" first).
///
/// What reads like a period (2026-10-11, "segments as slots"): the strip
/// draws this segment's own bar (grown, as the on-screen period's is — no ring), the
/// header subtitle is "N left" in the period's place and style, the bottom
/// row carries "X of Y" (considered + deferred of today's rows, the web
/// header's count), and a finished segment shows the period's seal and
/// "Complete" (or "Congratulations / Day complete" once the whole day is
/// — `ReminderDayProgress.emptyBody(segment:…)`). Its rows still count
/// toward no PERIOD's number (amendment 8).
private struct TaskSegmentListView: View {
    @Environment(\.colorScheme) private var colorScheme

    let entry: RemindersEntry
    let segment: TaskSegmentDTO
    let isLarge: Bool

    private var showCompleted: Bool {
        isLarge && WidgetStore.showCompleted(for: RemindersWidget.kind)
    }

    /// UPCOMING IN TWO SECTIONS (2026-10-26, ruling 1; the web's
    /// `UpcomingSections`): while anything waits, each section is a compact
    /// heading — "Tomorrow  0 of 2", "Later  1 of 1 ✓", the ✓ inline once
    /// nothing in it waits — then its waiting rows. BOTH headings always
    /// show, an empty one too ("Tomorrow  0 of 0 ✓"), with no separate
    /// "Nothing today" row. Headings are rows: measured, paged, and kept with
    /// the row after them. The page's "X of Y", strip bar, "Defer all" and
    /// the CONSIDERED list stay the segment's. Nothing waiting: the finished
    /// seal, as every page.
    private var openItems: [SegmentListItem] {
        guard segment.isUpcoming, segment.hasWaiting else {
            return segment.waitingTasks.map { SegmentListItem.waiting($0) }
        }
        return UpcomingSections.split(segment.tasks).flatMap { section in
            [SegmentListItem.sectionHeader(section)] + section.waiting.map { SegmentListItem.waiting($0) }
        }
    }

    private var items: [SegmentListItem] {
        let open = openItems
        let considered = segment.consideredTasks
        guard showCompleted, !considered.isEmpty else { return open }
        return open + [.divider(count: considered.count)] + considered.map { .considered($0) }
    }

    private var rowSpacing: CGFloat {
        isLarge ? WidgetTheme.rowSpacing : WidgetTheme.compactRowSpacing
    }

    /// See `RemindersListView.rowFloor`/`markerBleed`.
    private var rowFloor: CGFloat {
        #if os(iOS)
        isLarge ? 0 : WidgetTheme.rowMarkerSize
        #else
        0
        #endif
    }

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
            VStack(alignment: .leading, spacing: rowSpacing) {
                header
                if isLarge {
                    ReminderSlotStrip(
                        groups: entry.groups, segments: entry.segments,
                        currentKey: segment.pageKey, now: entry.date
                    )
                }
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

    /// `RemindersListView.listBody`'s layout, verbatim in its arithmetic.
    private func listBody(size: CGSize, metrics: WidgetTextMetrics) -> some View {
        let items = items
        let barHeight = metrics.bottomBarHeight
        let budget = max(size.height - (isLarge ? barHeight + rowSpacing : 0), 0)
        // A row right under Upcoming's section headings (2026-10-26) has to
        // share a page with them — a heading never ends a page — so it is
        // measured against what's left of a page after them: a heading run
        // and its first row always fit one page. Without this, at XXX Large
        // an empty "Tomorrow" heading was left alone on page 1 when "Later"
        // and its tall first row didn't fit beside it. Only an extreme row
        // (taller than that) is affected, and then its title shrinks to fit
        // rather than truncating (`ReminderRowLayout.shrinks`).
        let headingRun = metrics.caption2Height + rowSpacing
        let layouts = items.indices.map { index -> ReminderRowLayout in
            var headings = 0
            while index - headings - 1 >= 0, case .sectionHeader = items[index - headings - 1] { headings += 1 }
            let rowBudget = max(budget - CGFloat(headings) * headingRun, 0)
            return layout(for: items[index], width: size.width, budget: rowBudget, metrics: metrics)
        }
        // Anchored like a period's list (`RemindersListView.listBody`).
        let paging = remindersPaging(
            rows: items.map(\.pagedRow), pageKey: segment.pageKey, isLarge: isLarge, entryDate: entry.date
        ) { range in
            WidgetTheme.pages(heights: layouts.map(\.height), spacing: rowSpacing, budget: budget, in: range) {
                items[$0].staysWithNext
            }
        }
        let pages = paging.pages
        let page = paging.page
        let range = pages[page]

        return VStack(alignment: .leading, spacing: 0) {
            if items.isEmpty {
                finishedView
            } else {
                VStack(alignment: .leading, spacing: rowSpacing) {
                    ForEach(range.map { ListRowRef(index: $0, id: items[$0].id) }) { ref in
                        row(items[ref.index], layout: layouts[ref.index], metrics: metrics)
                            .frame(height: layouts[ref.index].height, alignment: .top)
                            .transition(.identity)
                    }
                }
            }

            Spacer(minLength: 0)

            if isLarge {
                ListBottomBar(height: barHeight) {
                    bottomLeading(width: size.width, pages: pages.count, page: page, metrics: metrics)
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

    private func label(_ row: SegmentTaskDTO, placement: SegmentMetaPlacement, form: UpcomingMetaForm) -> String {
        if row.left != nil { return row.leftLabelText }
        return row.task.segmentLabelText(
            segmentHorizon: segment.horizon, now: entry.date, placement: placement, upcomingForm: form,
            upcomingSection: row.upcomingSection
        )
    }

    /// WHERE THE SMALL WORDS GO (2026-10-12, "· Target Wed Oct 14 · repeats"
    /// on Trent's phone): a `Text` can't say where it wrapped, so the row
    /// measures instead. If the title alone takes k lines and title + words
    /// still takes k, the words fit on the title's last line and follow it
    /// after " · ". Otherwise they start their own line, with no separator;
    /// and if even alone they'd take more than one line, each part gets a
    /// line of its own and no dot is drawn at all. The chosen string is the
    /// one measured ("title\nwords", "title\npart\npart"), so the row's
    /// height is still exactly what it draws. The title and the words alone
    /// are measured without the notes glyph, which is drawn after the words.
    /// The measuring font is the title's weight for the whole string, a
    /// little wider than the regular-weight words: any error leans toward
    /// more lines, never toward a wrap mid-line (and `TaskDTO.metaJoiner`
    /// can only break AFTER a dot, so even then no line starts with one).
    ///
    /// ONE LINE ON UPCOMING (2026-10-12, Trent's review of #251): before the
    /// placement, an Upcoming row picks the first `UpcomingMetaForm` whose
    /// words ALONE measure one line at the title's width — "Wed Oct 14 ·
    /// deadline Sat Oct 17", then the schedule without its time, then
    /// without its "on …", then no weekdays ("Oct 14 · deadline Oct 17"),
    /// then no "(deadline first)". At the default Large text size one of them
    /// fits (a long one-off with a deadline usually loses its weekdays in a
    /// three-control row); only at the accessibility sizes does even the
    /// shortest wrap, and the placement
    /// below then gives each part its own line. The chosen form travels in
    /// the layout, so the row draws exactly the measured words.
    private func layout(
        for item: SegmentListItem, width: CGFloat, budget: CGFloat, metrics: WidgetTextMetrics
    ) -> ReminderRowLayout {
        switch item {
        case .divider, .sectionHeader:
            // One caption2 line each — what `DoneDivider` and
            // `UpcomingSectionHeading` draw.
            return ReminderRowLayout(lines: 1, height: metrics.caption2Height)
        case .waiting(let row), .considered(let row):
            let task = row.task
            let isWaiting: Bool
            if case .waiting = item { isWaiting = true } else { isWaiting = false }
            let titleWidth = SegmentRowMetrics.titleWidth(in: width, row: row)
            let weight = isWaiting ? WidgetTheme.priorityWeight(task.priority) : .regular
            func lines(_ text: String, hasNotes: Bool) -> (lines: Int, shrinks: Bool) {
                metrics.titleLines(text, width: titleWidth, weight: weight, maxHeight: budget, hasNotes: hasNotes)
            }
            // A CONSIDERED row (the web's `ConsideredSegmentRow`, 2026-10-27):
            // its title and only the web's words ("· done", "· on deck Sat"),
            // nothing else — one string, measured as drawn
            // (`SegmentTaskDTO.consideredLabelText`).
            if !isWaiting {
                let fit = lines(row.consideredLabelText(now: entry.date), hasNotes: task.hasNotes)
                if fit.shrinks { return ReminderRowLayout(lines: fit.lines, height: budget, shrinks: true) }
                return ReminderRowLayout(lines: fit.lines, height: metrics.titleHeight(lines: fit.lines))
            }
            func meta(_ form: UpcomingMetaForm) -> String? {
                task.segmentMeta(
                    segmentHorizon: segment.horizon, now: entry.date, upcomingForm: form,
                    upcomingSection: row.upcomingSection
                )
            }
            var form = UpcomingMetaForm.full
            if segment.horizon == SegmentKind.upcomingRaw {
                form = UpcomingMetaForm.allCases.first { candidate in
                    guard let words = meta(candidate) else { return true }
                    return lines(words, hasNotes: false).lines == 1
                } ?? .shortest
            }
            var placement = SegmentMetaPlacement.inline
            var fit = lines(label(row, placement: .inline, form: form), hasNotes: task.hasNotes)
            if let words = meta(form), fit.lines > lines(task.title, hasNotes: false).lines {
                placement = lines(words, hasNotes: false).lines > 1 ? .partsOnOwnLines : .ownLine
                fit = lines(label(row, placement: placement, form: form), hasNotes: task.hasNotes)
            }
            if fit.shrinks {
                return ReminderRowLayout(
                    lines: fit.lines, height: budget, shrinks: true, metaPlacement: placement, upcomingForm: form
                )
            }
            return ReminderRowLayout(
                lines: fit.lines, height: max(metrics.titleHeight(lines: fit.lines), isWaiting ? rowFloor : 0),
                metaPlacement: placement, upcomingForm: form
            )
        }
    }

    @ViewBuilder
    private func row(_ item: SegmentListItem, layout: ReminderRowLayout, metrics: WidgetTextMetrics) -> some View {
        switch item {
        case .sectionHeader(let section):
            UpcomingSectionHeading(section: section)
        case .divider(let count):
            DoneDivider(count: count, label: "CONSIDERED")
        case .waiting(let row):
            SegmentTaskRow(
                task: row.task, showsTargetToday: row.offersTargetToday, segmentHorizon: segment.horizon,
                upcomingSection: row.upcomingSection, left: nil, seenInSafetyNet: row.isSeenInSafetyNet,
                considered: false, now: entry.date, metaPlacement: layout.metaPlacement,
                upcomingForm: layout.upcomingForm, lines: layout.lines, height: layout.height,
                shrinks: layout.shrinks, firstLineHeight: metrics.titleHeight(lines: 1), markerBleed: markerBleed,
                notesGlyphSize: metrics.notesGlyphSize(hasNotes: row.task.hasNotes)
            )
        case .considered(let row):
            SegmentTaskRow(
                task: row.task, showsTargetToday: row.offersTargetToday, segmentHorizon: segment.horizon,
                upcomingSection: row.upcomingSection, left: row.left,
                consideredLabel: row.consideredLabelText(now: entry.date),
                seenInSafetyNet: false,
                considered: true, now: entry.date, metaPlacement: layout.metaPlacement,
                upcomingForm: layout.upcomingForm, lines: layout.lines, height: layout.height,
                shrinks: layout.shrinks, firstLineHeight: metrics.titleHeight(lines: 1), markerBleed: 0,
                notesGlyphSize: metrics.notesGlyphSize(hasNotes: row.task.hasNotes)
            )
        }
    }

    /// A segment with nothing left in its list — the slot page's finished
    /// states (`RemindersListView.emptySlotView`), not "All considered".
    @ViewBuilder
    private var finishedView: some View {
        switch ReminderDayProgress.emptyBody(segment: segment, groups: entry.groups, segments: entry.segments) {
        case .dayComplete:
            DayCompleteView(isLarge: isLarge)
        case .periodDone:
            PeriodDoneView(isLarge: isLarge)
        case .nothingToday:
            // An empty segment (native PR E, `?fill=1`): done from the start,
            // the web's "Nothing today ✓", its check in the done colour (the
            // deadlines page's teal).
            WidgetEmptyView(
                symbol: "checkmark.circle", message: "Nothing today",
                tint: WidgetTheme.stripDoneColor(segment.kind, scheme: colorScheme)
            )
        case .noReminders, .nothingHere:
            WidgetEmptyView(symbol: "checkmark.circle", message: "Nothing left here")
        }
    }

    /// Left of the pager: the segment's "X of Y" FIRST — in the leading spot
    /// where a period page's "4 of 7" sits, in its font and color — then
    /// "Defer all" while anything waits (2026-10-12, Trent: "'1 of 3' needs
    /// to swap with 'Defer all'"; it was the Tasks widget's "Select" then
    /// "N of M" order). Same order on every task segment page (Days … Upcoming),
    /// so the count reads in one place across the whole ring. Measured
    /// together; the action still outranks the count: the count is left out
    /// while both wouldn't clear the pager — never truncated, never at the
    /// cost of the action — and "Defer all" only when it alone wouldn't fit.
    /// The count is `monospacedDigit`, so "Defer all" moves only when the
    /// count gains a digit ("9 of 12" → "10 of 12").
    @ViewBuilder
    private func bottomLeading(width: CGFloat, pages: Int, page: Int, metrics: WidgetTextMetrics) -> some View {
        let pagerText: String? = pages > 1 ? "\(page + 1)/\(pages)" : nil
        let deferWidth = WidgetTheme.measuredWidth(for: "Defer all", font: metrics.caption2Font(weight: .semibold))
        // Never on the queue's panels or the deadlines page (native PR E, the
        // web's `offersDeferAll`): the deadlines page's Defer is one row's
        // lead day, which native leaves to the app (the row's link).
        let showsDefer = segment.hasWaiting && segment.offersDeferAll && WidgetTheme.fitsLeftOfPager(
            width: deferWidth, cardWidth: width, pagerText: pagerText, metrics: metrics
        )
        let count = ReminderDayProgress.PeriodCount(segment)
        // An EMPTY segment reads "0 of 0 ✓" (native PR E, the web's): done
        // from the start; the check is measured as a space plus a glyph.
        let checked = segment.isEmpty
        let countWidth = WidgetTheme.measuredWidth(
            for: checked ? count.text + "\u{00A0}\u{2713}" : count.text, font: metrics.caption2Font
        )
        let showsCount = (count.total > 0 || checked) && WidgetTheme.fitsLeftOfPager(
            width: (showsDefer ? deferWidth + Self.bottomGap : 0) + countWidth,
            cardWidth: width, pagerText: pagerText, metrics: metrics
        )
        HStack(spacing: Self.bottomGap) {
            if showsCount {
                countText(count, checked: checked)
                    .font(.caption2)
                    .monospacedDigit()
                    .lineLimit(1)
                    .fixedSize()
                    .accessibilityLabel(Text("\(count.handled) of \(count.total) considered in \(segment.label)"))
            }
            if showsDefer {
                deferAllButton(metrics: metrics)
            }
        }
    }

    /// "Defer all" and the count: the Tasks row's "Select" gap.
    private static let bottomGap: CGFloat = 8

    /// "4 of 7" in the period's quiet secondary; an empty segment's "0 of 0 ✓"
    /// with the check in its done colour.
    private func countText(_ count: ReminderDayProgress.PeriodCount, checked: Bool) -> Text {
        let words = Text(count.text).foregroundStyle(.secondary)
        guard checked else { return words }
        return words + Text("\u{00A0}\u{2713}")
            .fontWeight(.bold)
            .foregroundStyle(WidgetTheme.stripDoneColor(segment.kind, scheme: colorScheme))
    }

    /// "Defer all", measured in the semibold caption2 it is drawn in.
    private func deferAllButton(metrics: WidgetTextMetrics) -> some View {
        Button(intent: DeferSegmentIntent(horizon: segment.horizon)) {
            Text("Defer all")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(WidgetTheme.indigoAccent)
                .lineLimit(1)
                .fixedSize()
                .frame(height: metrics.bottomBarHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("Defer all \(segment.label) tasks to tomorrow"))
    }

    // MARK: Header — `RemindersListView.header`'s layout

    private var header: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: WidgetTheme.headerSpacing) {
                titleLink.layoutPriority(1)
                Spacer(minLength: 0)
                undoRedo
                chevrons
            }
            HStack(alignment: .top, spacing: WidgetTheme.headerSpacing) {
                VStack(alignment: .leading, spacing: 1) {
                    Link(destination: WidgetLink.reminders) { title.contentShape(Rectangle()) }
                    HStack(alignment: .center, spacing: WidgetTheme.headerSpacing) {
                        Link(destination: WidgetLink.reminders) { subtitle.contentShape(Rectangle()) }
                        Spacer(minLength: 0)
                        undoRedo.padding(.vertical, -UndoRedoButtons.verticalPadding)
                    }
                }
                .layoutPriority(1)
                chevrons
            }
            // Last (2026-10-26): "Task queue · Quarterly" beside the
            // chevrons at XXX Large doesn't fit even with undo/redo moved
            // down, and a title that may not truncate would push the card
            // sideways — so it goes to two lines. The header is laid out for
            // real above the list's `RenderedTextReader`, so the second line
            // comes out of the list's height, never off the card.
            HStack(alignment: .top, spacing: WidgetTheme.headerSpacing) {
                VStack(alignment: .leading, spacing: 1) {
                    Link(destination: WidgetLink.reminders) { wrappingTitle.contentShape(Rectangle()) }
                    HStack(alignment: .center, spacing: WidgetTheme.headerSpacing) {
                        Link(destination: WidgetLink.reminders) { subtitle.contentShape(Rectangle()) }
                        Spacer(minLength: 0)
                        undoRedo.padding(.vertical, -UndoRedoButtons.verticalPadding)
                    }
                }
                .layoutPriority(1)
                chevrons
            }
        }
        .padding(.top, isLarge ? WidgetTheme.headerTopPadding : 0)
    }

    private var titleLink: some View {
        Link(destination: WidgetLink.reminders) {
            VStack(alignment: .leading, spacing: 1) {
                title
                subtitle
            }
            .contentShape(Rectangle())
        }
    }

    /// "Task queue · Daily" (2026-10-26, the web's `segmentTitle`; "Tasks ·
    /// Days" before) — never truncates (the period title's rule).
    private var title: some View {
        titleText
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
    }

    /// The header's last resort: the title on up to two lines.
    private var wrappingTitle: some View {
        titleText
            .lineLimit(2)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var titleText: Text {
        Text(segment.wrappingTitle)
            .font(.headline)
            // Its horizon's teal (2026-10-11): the page's accent. Its strip
            // bar no longer matches it — every bar fills purple since
            // 2026-10-26 — the teals live on in the titles.
            .foregroundStyle(WidgetTheme.taskSegmentTitleColor(segment.kind, scheme: colorScheme))
    }

    /// "5 left", "all clear" — a period's subtitle words (2026-10-11; it
    /// said "all considered"); over the nudge threshold it suggests Process
    /// instead of a tap-through (spec §3, ~50 items). The "X of Y" sits in
    /// the bottom row, where a period's "N of M" does.
    private var subtitle: some View {
        Text(entry.actionDescription ?? subtitleText)
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
    }

    private var subtitleText: String {
        let waiting = segment.waitingCount
        let count = waiting == 0 ? "all clear" : "\(waiting) left"
        return segment.nudge ? "\(count) · try Process" : count
    }

    private var undoRedo: some View {
        UndoRedoButtons(canUndo: entry.canUndo, canRedo: entry.canRedo, kind: RemindersWidget.kind)
    }

    private var chevrons: some View {
        ChevronPager(
            previous: ShiftReminderSlotIntent(offset: -1),
            next: ShiftReminderSlotIntent(offset: 1),
            hasPrevious: entry.groups.count + entry.segments.count > 1,
            hasNext: entry.groups.count + entry.segments.count > 1,
            previousLabel: "Previous page",
            nextLabel: "Next page"
        )
    }
}

/// An Upcoming section's compact heading (2026-10-26, ruling 1): "Tomorrow
/// 0 of 2", and once nothing in the section waits, the count in green with
/// an inline ✓ — "Later  1 of 1 ✓", "Tomorrow  0 of 0 ✓" for an empty one
/// (done from the start; there is no separate "Nothing today" row on the
/// widget). The web's `SectionHeading`: the word muted and not uppercased
/// (the page title above carries the accent), the count the slot header's.
/// ONE caption2 line — the height the list measures it at.
private struct UpcomingSectionHeading: View {
    @Environment(\.colorScheme) private var colorScheme

    let section: UpcomingSections.Section

    /// The web's green-700 / green-400 (`text-green-700 dark:text-green-400`):
    /// small green text needs the deeper shade on the light card.
    private var finishedGreen: Color {
        colorScheme == .dark
            ? Color(red: 0x4A / 255, green: 0xDE / 255, blue: 0x80 / 255)
            : Color(red: 0x15 / 255, green: 0x80 / 255, blue: 0x3D / 255)
    }

    private var count: Text {
        let words = Text(section.countText).monospacedDigit()
        guard section.finished else { return words }
        return words + Text("\u{00A0}") + Text(Image(systemName: "checkmark")).fontWeight(.bold)
    }

    var body: some View {
        HStack(spacing: 8) {
            Text(section.section.title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            count
                .font(.caption2)
                .foregroundStyle(section.finished ? finishedGreen : Color.secondary)
            Spacer(minLength: 0)
        }
        .lineLimit(1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(
            "\(section.section.title), \(section.handledCount) of \(section.total) considered"
                + (section.finished ? ", nothing waiting" : "")
        ))
    }
}

/// One task segment row: circle (consider) · title · checkbox (done).
///
/// `ReminderRow`'s grammar — the title is a `Link`, the controls are
/// `Button(intent:)` siblings in their own fixed 36pt columns, never
/// overlapping, each centred on the title's FIRST line with its tap target
/// bled half a row gap into the gaps (see `ReminderRow`'s two-frame doc).
///
/// Considered rows (the "done" dot's list) draw the circle filled and inert:
/// there is no un-consider — the header's Undo takes a misfire back. Their
/// checkbox stays live: a considered task is still open, and done is done.
private struct SegmentTaskRow: View {
    @Environment(\.colorScheme) private var colorScheme

    let task: TaskDTO
    /// `SegmentTaskDTO.offersTargetToday` — every row since 2026-10-12
    /// (repeating Upcoming rows included: Today moves only the target, the
    /// schedule is kept in `occurrence_at`). False would give the 28pt
    /// column to the title; the row and the pager pass the same value.
    let showsTargetToday: Bool
    /// The page's horizon — the row names its own only when it differs.
    let segmentHorizon: String
    /// An Upcoming row's section: a Tomorrow row's target is its time alone.
    let upcomingSection: UpcomingSection?
    /// How the row LEFT its segment today (native PR E): drawn with its
    /// words and no controls but the filled circle (the web's
    /// `ConsideredSegmentRow`). Nil for every other row.
    let left: SegmentLeft?
    /// A considered row's whole label (`SegmentTaskDTO.consideredLabelText`:
    /// the web's `ConsideredSegmentRow` words — "· done", "· on deck Sat" —
    /// or the title alone). Unused on a waiting row.
    var consideredLabel: String = ""
    /// A deadlines-page safety-net row seen today: still waiting, its circle
    /// drawn filled and inert (a tap would change nothing).
    let seenInSafetyNet: Bool
    let considered: Bool
    let now: Date
    /// Where the small words go (`ReminderRowLayout.metaPlacement`, measured
    /// by the list) — never a "·" at either end of a line.
    let metaPlacement: SegmentMetaPlacement
    /// The Upcoming words' form the list measured (`ReminderRowLayout.upcomingForm`).
    let upcomingForm: UpcomingMetaForm
    let lines: Int
    let height: CGFloat
    let shrinks: Bool
    let firstLineHeight: CGFloat
    let markerBleed: CGFloat
    let notesGlyphSize: CGFloat?

    private var meta: String? {
        task.segmentMeta(
            segmentHorizon: segmentHorizon, now: now, upcomingForm: upcomingForm, upcomingSection: upcomingSection
        )
    }

    private var spoken: String {
        if considered {
            return NotesGlyph.accessibilityLabel(
                consideredLabel.replacingOccurrences(of: "\u{00A0}", with: " "), hasNotes: task.hasNotes
            )
        }
        let meta = meta.map { ", \($0.replacingOccurrences(of: "\u{00A0}", with: " "))" } ?? ""
        return NotesGlyph.accessibilityLabel("\(task.title)\(meta)", hasNotes: task.hasNotes)
    }

    /// `ReminderRow`'s layout (2026-10-11): the title `Link` first, at the
    /// reminder row's leading inset and font, then the 10pt gap, then the
    /// controls flush right with the consider circle LAST — the exact column
    /// a reminder's circle sits in — and Target today and the done checkbox
    /// to its left. `SegmentRowMetrics.titleWidth` subtracts exactly these.
    var body: some View {
        HStack(alignment: .top, spacing: SegmentRowMetrics.gap) {
            Link(destination: WidgetLink.task(task.id)) {
                WidgetTheme.titleText(titleText, notesGlyphSize: notesGlyphSize)
                    .font(.subheadline)
                    .opacity(considered ? 1 : WidgetTheme.priorityOpacity(task.priority))
                    .modifier(RowTitleFit(lines: lines, height: height, shrinks: shrinks))
                    .contentShape(Rectangle())
                    .accessibilityLabel(Text(spoken))
            }

            HStack(alignment: .top, spacing: 0) {
                // A row that LEFT today has nothing to act on (native PR E):
                // done is done, a deck or Today moved it on; its way back is
                // Undo. Only the filled circle, as on the web.
                if left == nil {
                    if showsTargetToday {
                        targetTodayButton
                    }

                    // Both markers take the priority colour for High/Urgent only
                    // (`WidgetTheme.rowMarkColor`, 2026-10-16): a Medium row's
                    // yellow read as a priority mark, which the rule gives none.
                    Button(intent: CompleteTaskIntent(taskId: task.id, kind: RemindersWidget.kind)) {
                        marker(Image(systemName: "square"), color: considered ? .secondary : WidgetTheme.rowMarkColor(task.priority))
                    }
                    .buttonStyle(.plain)
                    .padding(.vertical, -markerBleed)
                    .accessibilityLabel(Text("Done: \(spoken)"))
                }

                if considered {
                    marker(Image(systemName: "circle.inset.filled"), color: .secondary)
                        .accessibilityLabel(Text("Considered today: \(spoken)"))
                } else if seenInSafetyNet {
                    // Seen in the safety net (the web's seen ring): the
                    // deadline is close, so it stays on the page, waiting —
                    // and another tap would change nothing.
                    marker(Image(systemName: "circle.inset.filled"), color: WidgetTheme.rowMarkColor(task.priority))
                        .accessibilityLabel(Text("Seen today, the deadline is close, so it stays: \(spoken)"))
                } else {
                    Button(intent: ConsiderSegmentTaskIntent(taskId: task.id)) {
                        marker(Image(systemName: "circle"), color: WidgetTheme.rowMarkColor(task.priority))
                    }
                    .buttonStyle(.plain)
                    .padding(.vertical, -markerBleed)
                    .accessibilityLabel(Text("Considered: \(spoken)"))
                }
            }
        }
    }

    /// "Target today": an icon-only 28pt column (`SegmentRowMetrics.
    /// targetTodayWidth`), left of the done checkbox.
    private var targetTodayButton: some View {
        Button(intent: TargetSegmentTodayIntent(taskId: task.id)) {
            Image(systemName: "calendar.badge.clock")
                .font(.system(size: 14, weight: .regular))
                .foregroundStyle(.secondary)
                .frame(width: SegmentRowMetrics.targetTodayWidth, height: firstLineHeight)
                .padding(.top, markerBleed)
                .frame(
                    width: SegmentRowMetrics.targetTodayWidth, height: height + 2 * markerBleed,
                    alignment: .top
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, -markerBleed)
        .accessibilityLabel(Text("Target today: \(spoken)"))
    }

    /// Title in the row's weight, then the horizon / target words small and
    /// secondary — the exact string `segmentLabelText` measured. On Upcoming
    /// (2026-10-12) the words are the target date, a repeating task's
    /// schedule and the deadline (`TaskDTO.upcomingMeta`, in the measured
    /// `upcomingForm`). The attempts badge ("3×", always LAST in the words)
    /// is drawn plum, the web's `BadgeChips`; colour only, so the measured
    /// characters and weight are unchanged. The age label stays secondary.
    private var titleText: Text {
        let title = Text(task.title)
            .fontWeight(considered ? .regular : WidgetTheme.priorityWeight(task.priority))
            .foregroundStyle(considered ? Color.secondary : Color.primary)
        // A considered row: its title, then only the web's words ("· done",
        // "· on deck Sat"), secondary.
        if considered {
            return title + Text(String(consideredLabel.dropFirst(task.title.count))).foregroundStyle(.secondary)
        }
        guard let meta else { return title }
        let words = metaPlacement.joined(meta: meta)
        if let badge = TargetAge.attemptsBadge(task), words.hasSuffix(badge) {
            let rest = String(words.dropLast(badge.count))
            return title + Text(rest).foregroundStyle(.secondary)
                + Text(badge).foregroundStyle(WidgetTheme.overTarget(colorScheme))
        }
        return title + Text(words).foregroundStyle(.secondary)
    }

    /// `ReminderRow`'s two frames: centred on line 1, target the row's full
    /// height plus the bleed.
    private func marker(_ image: Image, color: Color) -> some View {
        image
            .font(.system(size: 19, weight: .light))
            .foregroundStyle(color)
            .frame(width: WidgetTheme.rowMarkerSize, height: firstLineHeight)
            .padding(.top, markerBleed)
            .frame(width: WidgetTheme.rowMarkerSize, height: height + 2 * markerBleed, alignment: .top)
            .contentShape(Rectangle())
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
                // `RemindersSmallView`'s title (and why a drop-the-word
                // ladder was rejected there, 2026-10-26).
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

#if DEBUG
/// The Lock Screen card in a plain host (2026-10-26): an accessory-family
/// `#Preview` renders blank in RenderPreview, and a widget extension hosts
/// widget previews only — so a preview-only widget draws the card's view in
/// the Lock Screen rectangle's size (iPhone Pro, 172 × 76 pt): the one-item
/// line with a long weekly prompt, at the default size and XXX Large.
/// Invented title. Never in the widget bundle.
struct LockScreenCardPreviewWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "preview.lockScreenCard", provider: RemindersProvider()) { _ in
            VStack(spacing: 12) {
                LockScreenCardPreview(size: .large)
                LockScreenCardPreview(size: .xxxLarge)
            }
            .containerBackground(Color.gray, for: .widget)
        }
        .supportedFamilies([.systemLarge])
    }
}

private struct LockScreenCardPreview: View {
    let size: DynamicTypeSize

    static var entry: RemindersEntry {
        let prompt = QuotaPromptDTO(
            promptKey: "q:9299:0:2026-10-26", taskId: 9299,
            title: "Make sure the MDX battery toggle is off before leaving the house for the week, and close the garage door",
            current: 2, target: 6, period: "WEEKLY", stripeColor: "purple", considered: false, done: false,
            hasNotes: false
        )
        let group = ReminderGroupDTO(
            slot: TimeSlotDTO(id: 9021, label: "Morning", startTime: "08:00"),
            reminders: [], considered: 0, consideredItems: [], prompts: [prompt]
        )
        return RemindersEntry(
            date: Date(), groups: [group], segments: [], slotIndex: 0, segmentIndex: nil, staleSince: nil,
            isSignedOut: false, canUndo: false, canRedo: false, actionDescription: nil
        )
    }

    var body: some View {
        RemindersRectangularView(entry: Self.entry)
            .frame(width: 172, height: 76)
            .background(Color.black)
            .foregroundStyle(.white)
            .environment(\.colorScheme, .dark)
            .dynamicTypeSize(size)
    }
}

#Preview("Lock Screen card — long weekly prompt", as: .systemLarge) {
    LockScreenCardPreviewWidget()
} timeline: {
    LockScreenCardPreview.entry
}
#endif

#endif

