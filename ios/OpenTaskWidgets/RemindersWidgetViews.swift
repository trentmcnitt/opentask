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
        #if os(iOS)
        case .accessoryCircular:
            RemindersCircularView(entry: entry)
        case .accessoryRectangular:
            RemindersRectangularView(entry: entry)
        #endif
        case .systemSmall:
            RemindersSmallView(entry: entry)
        case .systemMedium:
            RemindersListView(entry: entry, maxRows: 3, isLarge: false)
                .backgroundTapOpens(WidgetLink.reminders)
        default:
            // 6 was tuned against the OLD flat per-row cost (2 lines always
            // reserved). Both platforms now size rows to their real content
            // (see WidgetTheme's "row-height truthing" note — macOS since
            // 2026-09-22, iOS since 2026-09-23), so 6 stops being "as many
            // as fit" well before the card is full on either one. Raised to
            // 10 on both — `listContent`'s candidate list matches.
            RemindersListView(entry: entry, maxRows: 10, isLarge: true)
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
/// so every `lineLimit(2)` title collapsed to one truncated line ("Done is
/// better than p…") and the leftover overflow pushed the header off the top
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

    /// Whether this card measures each row's real title height (needs the
    /// `GeometryReader` below) or uses the flat per-family budget. macOS
    /// always measures (2026-09-22 fix, every family). iOS only measures for
    /// systemLarge (2026-09-23 fix) — systemMedium keeps its flat one-line
    /// budget unconditionally; a 4×2 has no height to spare on wrapped rows
    /// at all (see `header`'s `padding.top` comment). See WidgetTheme's
    /// "row-height truthing" note for the full history.
    private var shouldMeasureRealWidth: Bool {
        #if os(macOS)
        true
        #else
        isLarge
        #endif
    }

    var body: some View {
        if entry.isSignedOut {
            WidgetSignedOutView()
        } else if shouldMeasureRealWidth {
            // GeometryReader OUTSIDE ViewThatFits — never inside a candidate,
            // which would report "fits" at every height and defeat the whole
            // mechanism (see WidgetTheme's "row-height truthing" note).
            // Reports the card's real width so each row can measure its own
            // title instead of assuming a flat budget.
            GeometryReader { geo in
                listContent(width: geo.size.width)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else {
            listContent(width: nil)
                // The candidates carry no Spacer — a flexible child would report
                // "fits" at every height and defeat the measurement — so the card
                // is pinned to the top here instead.
                //
                // No `.widgetURL` here (removed 2026-09-22, the misclick fix):
                // systemMedium/Large used to make the WHOLE card one tap target,
                // so a near-miss on a row's check-off circle deep-linked into the
                // app instead of doing nothing. Now only the header (below) and
                // each row's `Link` are tap targets — see `header`.
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    /// `width`: the row's real available width when `shouldMeasureRealWidth`
    /// is true, else `nil` (rows fall back to their flat per-family budget).
    private func listContent(width: CGFloat?) -> some View {
        // Tallest first — ViewThatFits renders the first that fits. Written
        // out rather than looped: ViewThatFits has to see each candidate as
        // its own child, and a ForEach would hand it one. 10, on both
        // platforms now (see `content`'s comment on why 6 stopped being "as
        // many as fit" once rows measure their real content) —
        // `min(N, maxRows)` still no-ops harmlessly if `maxRows` (3 at
        // systemMedium) is lower.
        ViewThatFits(in: .vertical) {
            card(rows: min(10, maxRows), width: width)
            card(rows: min(9, maxRows), width: width)
            card(rows: min(8, maxRows), width: width)
            card(rows: min(7, maxRows), width: width)
            card(rows: min(6, maxRows), width: width)
            card(rows: min(5, maxRows), width: width)
            card(rows: min(4, maxRows), width: width)
            card(rows: min(3, maxRows), width: width)
            card(rows: min(2, maxRows), width: width)
            card(rows: 1, width: width)
        }
    }

    private func card(rows: Int, width: CGFloat?) -> some View {
        let window = pagedReminders(rows: rows)
        return VStack(alignment: .leading, spacing: rowSpacing) {
            header

            // systemLarge only — see `ReminderSlotStrip`'s doc for why
            // systemMedium skips it entirely rather than just costing it
            // some height.
            if isLarge {
                ReminderSlotStrip(groups: entry.groups, currentIndex: entry.slotIndex, now: entry.date)
            }

            if entry.groups.isEmpty {
                WidgetEmptyView(symbol: "checkmark.circle", message: "No reminders today")
            } else if reminders.isEmpty {
                emptySlotView
            } else {
                VStack(alignment: .leading, spacing: rowSpacing) {
                    ForEach(window.items) { reminder in
                        ReminderRow(
                            reminder: reminder, titleLineLimit: isLarge ? 2 : 1, availableWidth: width
                        )
                    }
                }
                // systemMedium drops this band, as Track's does: at 4×2 it
                // costs a whole row, and the header's "N left" already
                // states the total — there is no pager at that size.
                //
                // The bottom pager (2026-09-23) replacing "+N more" — Trent:
                // "It'd be nice to be able to page through things that are
                // too long to fit... maybe at the bottom." Tapping "+N more"
                // used to open the app; paging through the list in place is
                // strictly more useful, so nothing here is a `Link` anymore.
                if isLarge, window.totalPages > 1 {
                    // Pinned to the card's bottom edge (Trent, 2026-09-23: "the
                    // page switcher should not move"): a short last page used to
                    // pull it up under its one row. A Spacer's ideal height is its
                    // minLength, 0, so `ViewThatFits` still measures each candidate
                    // at its content height and picks the same row count; only the
                    // chosen card, laid out in the full widget height, stretches.
                    Spacer(minLength: 0)
                    ListPager(
                        page: window.page,
                        totalPages: window.totalPages,
                        previous: ShiftReminderPageIntent(offset: -1),
                        next: ShiftReminderPageIntent(offset: 1)
                    )
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

    /// A page window into `reminders`, sized to `rows` — the row count of
    /// WHICHEVER `ViewThatFits` candidate is asking (2026-09-23, "page
    /// through things that are too long to fit"). `page` is read from
    /// `WidgetStore.remindersPage(for:)`, keyed to the on-screen slot so it
    /// self-resets whenever the slot changes (see that function's doc), and
    /// clamped here to `0..<totalPages` so a list that shrank out from under
    /// a stale page (a check-off) never renders an empty window instead of
    /// snapping back into range.
    ///
    /// Known imperfection, accepted deliberately: each `ViewThatFits`
    /// candidate resolves its OWN `rows`/`totalPages` from only the items
    /// its own page slices out, not from the full list — there is no way to
    /// ask ViewThatFits "which candidate won" from outside its own body (see
    /// `RemindersListView`'s "row-height truthing" reference), so a
    /// differently-sized page 2 could in principle resolve a different `rows`
    /// than page 1 did. In practice reminder titles in one list are usually
    /// similar lengths, and the property that matters most — the page
    /// actually shown is always the one THAT candidate verified fits, never
    /// squeezed — holds regardless.
    private func pagedReminders(rows: Int) -> (items: [TaskDTO], page: Int, totalPages: Int) {
        guard rows > 0, !reminders.isEmpty else {
            return (reminders, 0, 1)
        }
        let totalPages = max(1, Int(ceil(Double(reminders.count) / Double(rows))))
        let slotKey = entry.group?.slotKey ?? -1
        let page = min(max(WidgetStore.remindersPage(for: slotKey), 0), totalPages - 1)
        let start = page * rows
        let end = min(start + rows, reminders.count)
        return (Array(reminders[start..<end]), page, totalPages)
    }

    /// The on-screen slot has nothing waiting — three readings, not one
    /// (Trent, 2026-09-23: "I still need an indication and some satisfaction
    /// when I am finished with things", and the complaint that prompted the
    /// slot strip above it — "I didn't even realize I actually did not
    /// finish the things for early morning").
    ///
    /// 1. **Never had anything.** `considered == 0` for this slot — the
    ///    original, unchanged message.
    /// 2. **This slot finished, but something earlier or later is still
    ///    behind.** Named after the slot itself ("Morning done") so the
    ///    label is specific, with the strip above showing where the rest of
    ///    the day stands.
    /// 3. **Every started slot is finished.** The whole-day version — a
    ///    distinct, more emphatic message from #2, gated on `allCaughtUp`
    ///    rather than merely on this one slot, so paging to an
    ///    already-finished slot on a day that ISN'T fully caught up still
    ///    reads as #2, not a false "All caught up".
    @ViewBuilder
    private var emptySlotView: some View {
        if allCaughtUp {
            WidgetEmptyView(symbol: "checkmark.seal.fill", message: "All caught up")
        } else if let group = entry.group, group.considered > 0 {
            WidgetEmptyView(symbol: "checkmark.circle.fill", message: "\(group.label) done")
        } else {
            WidgetEmptyView(symbol: "checkmark.circle", message: "Nothing left here")
        }
    }

    /// How many reminders have been considered (checked off) anywhere today —
    /// gates `allCaughtUp` below so a day with nothing ever configured (every
    /// group's `considered` and `reminders` both empty) reads as the ORIGINAL
    /// "Nothing left here", not a celebratory "All caught up" for work that
    /// was never there to do.
    private var consideredTotal: Int { entry.groups.reduce(0) { $0 + $1.considered } }

    /// Every STARTED slot is finished — no slot whose time has come still has
    /// something waiting. An upcoming slot (time not yet arrived) never
    /// counts against this: its items aren't behind, they're just later.
    private var allCaughtUp: Bool {
        consideredTotal > 0
            && !entry.groups.contains { group in
                RemindersTimeline.hasStarted(group, now: entry.date) && !group.reminders.isEmpty
            }
    }

    /// The header IS the card's tap target now that the whole-card link is
    /// gone (see `RemindersListView.body`). Only the title/count block is a
    /// `Link` — the `ChevronPager` stays a sibling outside it, because a
    /// `Button(intent:)` nested inside a `Link` is a WidgetKit combination
    /// this repo has no way to verify without a device. `.foregroundStyle` on
    /// the title is explicit: `Link` tints an unstyled label with the accent
    /// color, same reason `ReminderRow`'s title overrides it below.
    ///
    /// The tap target is sized to the text, not stretched to the 40pt floor
    /// `ChevronButton` uses elsewhere — forcing a frame here would fight the
    /// `.firstTextBaseline` alignment this header is tuned around, and on
    /// systemMedium there is no headroom to spend on it (`WidgetTheme.
    /// compactRowSpacing`'s comment). It reads as tappable because it is the
    /// same headline text a user already reads as "the current view".
    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: WidgetTheme.headerSpacing) {
            Link(destination: headerDestination) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(entry.group?.label ?? "Reminders")
                        .font(.headline)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                    // "Undid: …" / "Redid: …" for ~60s after an undo/redo
                    // (2026-09-23) — see `WidgetStore`'s "Last-action
                    // indication" doc. Replaces the ordinary count subtitle
                    // rather than sitting beside it: the header has no
                    // spare height for a third line on systemMedium.
                    Text(entry.actionDescription ?? countLabel)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                .contentShape(Rectangle())
            }
            Spacer(minLength: 0)
            // Right-aligned, before the chevrons (2026-09-23) — see
            // `UndoRedoButtons`' doc: always present, dimmed when there is
            // nothing to undo/redo.
            UndoRedoButtons(canUndo: entry.canUndo, canRedo: entry.canRedo)
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

    /// The header title `Link`'s destination (2026-09-23) — Trent: "it
    /// should scroll down to the actual afternoon section." The on-screen
    /// slot's key, or the bare `reminders` link when there is no group at
    /// all (nothing configured today) for this entry to scope to.
    private var headerDestination: URL {
        guard let group = entry.group else { return WidgetLink.reminders }
        return WidgetLink.reminders(slot: group.slotKey)
    }

    private var countLabel: String {
        reminders.isEmpty ? "all clear" : "\(reminders.count) left"
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
/// Segments are EQUAL width here, where the web's are proportional
/// (`flexGrow: total`) — a widget's few dozen points of width has no room to
/// spare on a size-weighted layout for something this glanceable and this
/// small (a few points tall), and equal segments still answer the question
/// this exists for exactly as legibly: "is anything still waiting, and
/// where." An empty slot (nothing ever in it, `reminders` and `considered`
/// both zero) gets no segment at all, same as the web — a segment is a claim
/// that there is something to report.
///
/// systemLarge only (`RemindersListView.card`'s `if isLarge`) — a systemMedium
/// card has no height to spare on a fourth band at all (see
/// `RemindersListView.header`'s `padding.top` comment). Kept deliberately
/// tiny even on systemLarge (a few points, plus one more `rowSpacing` gap
/// the `VStack` adds around it) rather than free: it IS real height the
/// reservation-driven `ViewThatFits` measurement counts like any other
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
    }

    private var segments: [Segment] {
        groups.enumerated().compactMap { index, group -> Segment? in
            let waiting = group.reminders.count
            guard waiting + group.considered > 0 else { return nil }
            let started = RemindersTimeline.hasStarted(group, now: now)
            let state: SlotState
            if started, waiting == 0 { state = .done } else if started { state = .behind } else {
                state = .upcoming
            }
            return Segment(
                id: index, slotKey: group.slotKey, state: state, isCurrent: index == currentIndex,
                fraction: Double(group.considered) / Double(waiting + group.considered)
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

    var body: some View {
        // One segment is not a strip — same rule as the web's ReminderSlotBar
        // ("it would say only 'everything is here', which the header already
        // says better").
        let shown = segments
        if shown.count >= 2 {
            HStack(spacing: 3) {
                ForEach(shown) { segment in
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
                    .padding(.vertical, -segmentBleed)
                    .accessibilityLabel(Text(groups[segment.id].label))
                }
            }
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
                Capsule().fill(Color.primary.opacity(0.13))
                if segment.state != .upcoming, segment.fraction > 0 {
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
        case .behind: return .indigo
        case .upcoming: return Color.secondary.opacity(0.15)
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
/// `WidgetTheme.rowMarkerSize` column doesn't take, the same way it always
/// filled the space beside a LEADING marker; nothing here relies on
/// hit-testing precedence between overlapping views (the community-reported
/// failure mode `ios/CLAUDE.md`'s tap-targets note warns about, and this
/// layout has none of the multi-`Link`-in-one-container shape that report
/// describes).
///
/// A reminder is a THOUGHT, not an errand ("Done is better than perfect. Start
/// small."), and half a thought prompts nothing — so in systemLarge the title
/// wraps rather than ellipsising at one line, capped at `WidgetTheme.
/// iOSMaxTitleLines` (3) on iOS and unbounded on macOS. The list above shows
/// fewer rows to pay for it.
private struct ReminderRow: View {
    let reminder: TaskDTO
    var titleLineLimit = 2
    /// The row's real available width, threaded down from
    /// `RemindersListView`'s `GeometryReader`. `nil` whenever the card isn't
    /// measuring real widths (iOS systemMedium — see `RemindersListView.
    /// shouldMeasureRealWidth`), in which case every computed property below
    /// falls back to the flat `titleLineLimit` budget.
    var availableWidth: CGFloat? = nil

    /// Real per-title line count at this row's actual text column (the card
    /// width minus the marker column and its 10pt `HStack` spacing), falling
    /// back to the flat budget if the width isn't known. Capped on iOS — see
    /// WidgetTheme's "row-height truthing" note, the 2026-09-23 addendum.
    private var measuredLines: Int {
        guard let availableWidth else { return titleLineLimit }
        let font = WidgetTheme.subheadlineFont(weight: WidgetTheme.priorityWeight(reminder.priority))
        let real = WidgetTheme.measuredLineCount(
            for: reminder.title, maxWidth: availableWidth - WidgetTheme.rowMarkerSize - 10, font: font
        )
        #if os(iOS)
        return min(real, WidgetTheme.iOSMaxTitleLines)
        #else
        return real
        #endif
    }

    /// The row's reserved text height: the title's real measured line count
    /// where it's known, else the flat `titleLineLimit` budget.
    private var reservedHeight: CGFloat {
        CGFloat(measuredLines) * WidgetTheme.rowTitleLineHeight
    }

    /// The marker's height: iOS floors it at `rowMarkerSize` (36, a finger
    /// target) even when the measured text is shorter — macOS has no floor,
    /// a mouse pointer needs none. See WidgetTheme's "row-height truthing"
    /// note, the 2026-09-23 addendum, for why this means iOS wins back less
    /// per-row space than macOS did at the default text size.
    private var markerHeight: CGFloat {
        #if os(iOS)
        guard availableWidth == nil else { return reservedHeight + 2 * markerBleed }
        return max(reservedHeight, WidgetTheme.rowMarkerSize)
        #else
        reservedHeight
        #endif
    }

    /// How far the check-off's tap area reaches into the gap above and below
    /// its row, without taking layout space (Trent, 2026-09-23: the gap under
    /// a one-line title). On iOS systemLarge the row is exactly as tall as its
    /// text, and the finger target instead stretches half a `rowSpacing` into
    /// each neighbouring gap — applied as negative vertical padding on the
    /// Button, so adjacent targets meet but never overlap, and a one-line
    /// row's pitch drops from 46pt (the old 36pt floor + 10) to 28pt. Zero
    /// elsewhere: systemMedium keeps the 36pt floor, macOS needs none.
    private var markerBleed: CGFloat {
        #if os(iOS)
        availableWidth == nil ? 0 : WidgetTheme.rowSpacing / 2
        #else
        0
        #endif
    }

    /// iOS caps at 3 lines once `availableWidth` is known (systemLarge);
    /// unlimited on macOS, and unlimited on iOS systemMedium too, where
    /// `availableWidth` is `nil` and `titleLineLimit` (1) already caps it.
    private var lineLimitValue: Int? {
        guard availableWidth != nil else { return titleLineLimit }
        #if os(iOS)
        return WidgetTheme.iOSMaxTitleLines
        #else
        return nil
        #endif
    }

    var body: some View {
        // .top, not .center: on a two-line row a centred circle floats down
        // into the gap between the lines, reading as if it belongs to neither.
        HStack(alignment: .top, spacing: 10) {
            Link(destination: WidgetLink.reminder(reminder.id)) {
                Text(reminder.title)
                    .font(.subheadline)
                    .fontWeight(WidgetTheme.priorityWeight(reminder.priority))
                    .foregroundStyle(.primary)
                    .opacity(WidgetTheme.priorityOpacity(reminder.priority))
                    .lineLimit(lineLimitValue)
                    .multilineTextAlignment(.leading)
                    // fixedSize: the wrapped height is the height, and no
                    // parent gets to squeeze it back to one truncated line.
                    // minHeight: the row RESERVES its lines whether this title
                    // uses them or not, which is what `ViewThatFits` measures.
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(
                        maxWidth: .infinity,
                        minHeight: reservedHeight,
                        alignment: .topLeading
                    )
                    .contentShape(Rectangle())
            }

            Button(intent: CompleteTaskIntent(taskId: reminder.id, kind: RemindersWidget.kind)) {
                Image(systemName: "circle")
                    .font(.system(size: 19, weight: .light))
                    .foregroundStyle(WidgetTheme.priorityColor(reminder.priority))
                    // TWO frames, deliberately not one — this is the same
                    // trick the original leading-edge marker used, preserved
                    // across the 2026-09-23 move to the trailing edge. The
                    // FIRST frame is exactly one line tall
                    // (`rowTitleLineHeight`) with DEFAULT (.center)
                    // alignment, which centres the glyph within the vertical
                    // span of the title's first line specifically — not the
                    // row as a whole. The SECOND frame then takes that
                    // already-centred result and pins it to the TOP of the
                    // full `markerHeight`, so a two-or-three-line title's
                    // extra lines extend the tappable area downward without
                    // dragging the glyph down with them (26pt missed too
                    // often, iOS's finger-sized floor — see `markerHeight`).
                    // Collapsing this to a single
                    // `.frame(height: markerHeight, alignment: .top)` looks
                    // equivalent but isn't: `.top` alignment there would
                    // pin the glyph's own small intrinsic size to the frame's
                    // top edge instead of centring it on the first line,
                    // which is exactly the "floats down between the lines,
                    // reading as if it belongs to neither" failure this
                    // struct's own doc comment warns about avoiding.
                    .frame(width: WidgetTheme.rowMarkerSize, height: WidgetTheme.rowTitleLineHeight)
                    // The bleed above is part of the target, not the glyph's
                    // offset: pad it back so the glyph stays on line 1.
                    .padding(.top, markerBleed)
                    .frame(width: WidgetTheme.rowMarkerSize, height: markerHeight, alignment: .top)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.vertical, -markerBleed)
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

#endif
