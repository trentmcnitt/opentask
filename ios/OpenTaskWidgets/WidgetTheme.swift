import AppIntents
import SwiftUI
import WidgetKit
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// Visual vocabulary shared by both widget kinds.
///
/// The OpenTask web theme is deliberately monochrome (`--primary` is a near
/// black neutral), so the widgets take the same line: neutral chrome, with the
/// only saturated color carrying meaning — priority and project identity. That
/// keeps a Home Screen full of colorful icons from having to compete with a
/// widget that is also shouting.
enum WidgetTheme {

    // MARK: - Priority

    /// Mirrors `PRIORITY_OPTIONS` in `src/lib/priority.ts`
    /// (0 None · 1 Low · 2 Medium · 3 High · 4 Urgent).
    static func priorityColor(_ priority: Int) -> Color {
        switch priority {
        case 4: return .red
        case 3: return .orange
        case 2: return .yellow
        case 1: return Color.secondary
        default: return Color.secondary.opacity(0.45)
        }
    }

    /// §6: "priority is prominence, not interruption" — a high-priority row is
    /// heavier and darker, never louder. The server pre-sorts, so weight only
    /// has to confirm the ordering the eye already sees.
    static func priorityWeight(_ priority: Int) -> Font.Weight {
        switch priority {
        case 4, 3: return .semibold
        case 2: return .medium
        default: return .regular
        }
    }

    static func priorityOpacity(_ priority: Int) -> Double {
        priority >= 2 ? 1.0 : 0.85
    }

    // MARK: - Projects

    /// The eight named palette colors the server allows on a project.
    static func projectColor(_ name: String?) -> Color {
        switch name {
        case "red": return .red
        case "orange": return .orange
        case "yellow": return .yellow
        case "green": return .green
        case "blue": return .blue
        case "purple": return .purple
        case "pink": return .pink
        case "gray": return .gray
        default: return .secondary
        }
    }

    // MARK: - Shared accents

    /// The one indigo used across all three widget kinds for "this is
    /// active / worth noticing right now" — `ReminderSlotStrip`'s "behind,
    /// still waiting" segment fill (`RemindersWidgetViews.swift`), the "show
    /// completed"/"show met" dot's ON state (`CompletedDotToggle` below,
    /// shared by all three kinds since 2026-09-24), and — after merging with
    /// the parallel Quotas widget rebuild (2026-09-23, `feat/quotas-widget`,
    /// PR #58) — every in-progress quota chip/bar. ONE named constant, not several
    /// independently-chosen `Color.indigo` literals, so all three widgets'
    /// accent can never drift apart pixel-by-pixel across files.
    static let indigoAccent = Color.indigo

    // MARK: - Track (§5)

    /// Track's palette sits deliberately OUTSIDE the priority scale above.
    ///
    /// §5: pace "renders but never alarms" — a quota that has slipped behind
    /// must never turn orange or red, because being 1/3 into a weekly quota on
    /// Tuesday is information, not an emergency, and per L1 a low count late in
    /// the period may only mean *unlogged*. So there is exactly one calm tint
    /// for in-progress and green for met, and the only thing pace is allowed to
    /// move is the position of a small neutral tick.
    ///
    /// No named "in-progress" constant here (removed `trackTint`,
    /// `feat/quotas-widget` review pass, 2026-09-23) — the Quotas widget's
    /// in-progress color is the plain SwiftUI `Color.indigo`, referenced
    /// directly at each call site in `TrackWidgetViews.swift`, the SAME
    /// literal `ReminderSlotStrip.color(for:)` already uses for its
    /// `.behind` state (`RemindersWidgetViews.swift`) — the app's one
    /// existing "in progress" accent, not a second hue. `trackTint` briefly
    /// aliased this to `Color.teal`, which was caught in review as an
    /// accidental second accent hue and reverted before merge.
    static let trackMetTint = Color.green

    /// Quotas' Takeback mode (2026-09-24) — the button's ON tint and every
    /// chip's "−1" while the mode is armed. The ONE red on the Quotas card,
    /// and not an exception to §5's "nothing is red" above: that rule is
    /// about STATE (a quota behind pace must never read as an alarm), and
    /// this marks an ACTION — "the next tap subtracts" — the destructive
    /// tint Trent asked for so the armed mode can't be mistaken for the
    /// resting one. It never colors a count, a bar or a pace mark.
    static let takebackTint = Color.red

    // MARK: - Metrics

    static let rowSpacing: CGFloat = 10
    static let headerSpacing: CGFloat = 12
    static let cornerRadius: CGFloat = 8

    /// Breathing room above the title in the Reminders / Tasks headers.
    ///
    /// WidgetKit's default content margin alone left the title sitting almost
    /// on the card's top edge while the rows below it had 10pt gaps, so the
    /// card read as if it had been shoved up under the bezel. Apple's own
    /// Reminders widget drops its title noticeably below the top edge; this is
    /// that drop. Track is deliberately excluded — its 4×4 spends every point
    /// of height on quota rows.
    static let headerTopPadding: CGFloat = 6

    /// Row gap in the 4×2 families, where `rowSpacing`'s 10 costs a whole row.
    ///
    /// A systemMedium card is 128pt of usable height on an iPhone 17 Pro. A
    /// 40pt header (the pager's hit targets set that floor) and two 36pt rows
    /// spend 112 of it, so the gaps get what is left and not a point more —
    /// at 6 the second row did not fit and the card dropped to one.
    static let compactRowSpacing: CGFloat = 4

    // (`rowTitleLineHeight`, a static one-line height read from
    // `UIFont.preferredFont(forTextStyle:)` with no trait collection, lived
    // here until 2026-09-24. It is now `WidgetTextMetrics.titleLineHeight`,
    // built from the widget's OWN `\.dynamicTypeSize` — see that struct's
    // doc for why the static version measured a different text size than
    // SwiftUI actually drew.)

    // MARK: - Row-height truthing (macOS 2026-09-22, iOS 2026-09-23)
    //
    // Trent, photographing the Mac desktop Large widget (2026-09-22):
    // single-line titles ("Kids kazoo") were taking the height of two
    // lines, only 5 rows fit where the card had room for more, and one long
    // title truncated with "…" — "We can't truncate the text" (a standing
    // rule: reminders are never cut off). Diagnosis ruled out two of the
    // candidate causes and confirmed a third that wasn't on the original
    // suspect list:
    //
    // - `rowTitleLineHeight` "too tall on macOS": REFUTED. Measured 14pt on
    //   macOS vs. ~20pt on iOS — macOS's own subheadline metric is smaller,
    //   not larger.
    // - The two-line reservation itself (`titleLineLimit`) is inherent to
    //   how `ViewThatFits` works here (see `rowTitleLineHeight`'s doc) and
    //   isn't macOS-specific.
    // - CONFIRMED, macOS-only AT THE TIME: `ReminderRow`/`TaskRow`'s marker
    //   column ended in a flat `.frame(width: 36, height: 36, alignment:
    //   .top)` — a finger-sized iOS touch target ("26pt missed too often",
    //   that frame's own doc comment). `HStack(alignment: .top)` sizes to
    //   the TALLEST child, and on iOS the text's own two-line reservation
    //   (2 × ~20pt = 40pt) was already taller than 36, so the marker never
    //   mattered there. On macOS the text's two-line reservation (2 × 14pt
    //   = 28pt) was SMALLER than 36 — so the marker, not the text, was
    //   silently setting every row's height. Measured directly
    //   (`NSHostingView.fittingSize` on `ReminderRow`, headless): a
    //   one-line and a two-line title both came back exactly 36.0pt. That
    //   is the "roughly a blank line" Trent saw under a one-line title.
    //
    // Fixing only the marker (matching it to the row's own 2-line
    // reservation) gets macOS's row height down to 28pt — but 28pt is
    // STILL two full lines' worth for a title that only needs one, so on
    // its own that change doesn't reach "a one-line title takes one line."
    // And neither change touches truncation: `lineLimit(2)` on a title that
    // genuinely needs 3 real lines still ellipsizes, on either platform.
    //
    // So the fix replaces the fixed "always reserve 2 lines" budget with a
    // MEASURED one, per title: `measuredLineCount` asks the platform's own
    // text-layout API directly how many lines this exact string needs at
    // the row's real available width (no wrapping surprises — this is the
    // same API family `NSString`/`UILabel`/`UITextView` sizing has used for
    // years), and the row uses that as both `lineLimit` and the `minHeight`
    // reservation (so `ViewThatFits` is measuring the truth, not a guess).
    // A one-line title reserves one real line; a title that needs more
    // simply leaves less of the card for other rows — "as many rows as
    // genuinely fit" already implies that.
    //
    // This needs the row's real width, which `ViewThatFits` candidates don't
    // otherwise have — `RemindersListView`/`TasksListView` wrap their
    // `ViewThatFits` in a `GeometryReader` OUTSIDE it (not inside; a
    // `GeometryReader` inside a `ViewThatFits` candidate reports "fits" at
    // every height and defeats the whole mechanism, the same class of bug
    // the reservation above already exists to avoid) and thread the
    // measured width down into each row.
    //
    // Known imperfection, accepted deliberately: this measurement assumes
    // the row's width (passed down from `GeometryReader`) is what the text
    // engine will actually lay the `Text` out at. If that assumption is
    // ever wrong by enough to matter, the failure mode is a row rendering
    // slightly TALLER than `ViewThatFits` reserved for it (possible
    // clipping at the card's bottom edge on that one refresh) — never an
    // ellipsis. That is the trade Trent asked for ("we can't truncate the
    // text"), not a theoretical guarantee that measurement and final layout
    // always agree to the pixel.
    //
    // ADDENDUM, 2026-09-23 (iOS gets the same measurement, capped): Trent's
    // iPhone screenshots showed the same family of complaints on the Home
    // Screen Large widgets — a visible gap between one-line titles ("Check
    // GitHub issues" / "Do my mobility"), and text truncating at TWO lines when
    // he wanted three before an ellipsis, plus "at least one or two more"
    // reminders visible at once. `measuredLineCount`/`measuredWidth`/
    // `subheadlineFont`/`caption2Font` below, previously macOS-only, are now
    // shared — `PlatformFont` resolves to `UIFont` or `NSFont` per platform,
    // and `NSString.boundingRect` takes the SAME four-argument call on both
    // (confirmed by compiling each standalone: iOS's Swift overlay has no
    // default for `context`, unlike macOS's, so the call passes `context:
    // nil` explicitly — harmless on macOS, required on iOS). Two things stay
    // platform-specific, on purpose:
    //
    // 1. **The cap.** iOS still caps a title at `iOSMaxTitleLines` (3) —
    //    macOS stays unbounded. A reminder is "a thought, not an errand",
    //    but a phone's Home Screen has far less room than a desktop widget,
    //    and an unbounded title on iOS could still eat the whole card for
    //    one row. 3 lines, not macOS's "never", is the compromise: "I don't
    //    want to truncate the text until three lines" (Trent, 2026-09-23).
    // 2. **The marker floor.** iOS's 36pt marker (`rowMarkerSize`) is a
    //    FINGER touch target and stays a hard floor —
    //    `max(measuredHeight, rowMarkerSize)` — where macOS's marker simply
    //    matches the measured height with no floor (a mouse pointer needs no
    //    minimum). This is why the per-row height win on iOS is smaller than
    //    macOS's was: measured directly on an iPhone 17 Pro simulator
    //    (iOS 26.5, default Dynamic Type), `rowTitleLineHeight` is 18pt, so
    //    the OLD flat two-line budget (2 × 18 = 36) already exactly equals
    //    the marker floor for a one-line title — there is no wasted line to
    //    reclaim from THAT title alone once the 36pt floor is kept. Where
    //    this fix actually earns its keep on iOS: (a) genuinely 3-line
    //    titles no longer truncate (a real, previously-invisible bug — see
    //    `RemindersWidgetView`'s doc for the measured before/after), and (b)
    //    critically, `ViewThatFits`'s candidate ceiling is raised from 6 to
    //    10 to match macOS (`RemindersListView`/`TasksListView`'s `content`)
    //    — THAT is what lets "one or two more" rows actually render when
    //    they fit; the old ceiling of 6 could never offer ViewThatFits a
    //    7th-or-later-row candidate no matter how much vertical room a
    //    device had. At a LARGER Dynamic Type size than the simulator's
    //    default, `rowTitleLineHeight` grows past 18pt and the per-title
    //    measurement starts winning back real space from the marker floor
    //    too, the same way it always did on macOS.
    //
    // ADDENDUM, 2026-09-24 (the mechanism above is gone — history only):
    // `ViewThatFits`, its 10-row candidate ladder, the `minHeight`
    // reservations and the flat `rowTitleLineHeight` no longer exist. On
    // Trent's phone (XXX Large text) "7 left" paged as "1/4" with two rows
    // and "26 due" as 13 pages of two, because uniform candidate pages let
    // one page's longest rows set every page's size, and each candidate
    // sliced its own page from the stored index (so page 2 read "2/2" with
    // ONE row). Rows now carry exact heights computed up front — line
    // counts from `measuredLineCount` at SwiftUI's own drawn font size and
    // line pitch (`WidgetTextMetrics`, calibrated by `RenderedTextReader`),
    // every row FRAMED to that height — and `WidgetTheme.pages` fills each
    // page greedily against the card's real remaining height. The platform
    // rules above survive unchanged: iOS caps titles at `iOSMaxTitleLines`,
    // macOS never caps; iOS systemLarge's check-off bleeds its tap target
    // into the row gaps; systemMedium iOS rows are one line on the 36pt
    // finger floor.

    #if os(iOS)
    typealias PlatformFont = UIFont
    #else
    typealias PlatformFont = NSFont
    #endif

    /// Reminders never truncate on iOS until they need a 4th line — see the
    /// "2026-09-23" addendum above. macOS has no equivalent constant: it
    /// never caps at all.
    static let iOSMaxTitleLines = 3

    /// How many lines `text` needs at `maxWidth`, in `font` — real platform
    /// text measurement (`NSString.boundingRect`), not a guess.
    ///
    /// Divided by the font's OWN line height (2026-09-24). It used to divide
    /// by a ceil'd, trait-less `rowTitleLineHeight` — a DIFFERENT number
    /// from the font actually measured whenever the two disagreed about the
    /// text size, and even when they agreed the ceil'd divisor drifts a line
    /// short on a long wrap (30 lines × 25.06pt ÷ 26pt = 28.9). A
    /// line-fragment layout's height is a whole number of `lineHeight`s, so
    /// rounding here recovers that whole number exactly.
    static func measuredLineCount(for text: String, maxWidth: CGFloat, font: PlatformFont) -> Int {
        guard maxWidth > 0, !text.isEmpty else { return 1 }
        let bounds = (text as NSString).boundingRect(
            with: CGSize(width: maxWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font],
            context: nil
        )
        return max(1, Int((bounds.height / lineHeight(of: font)).rounded()))
    }

    /// One line of `font`, as the platform's text system lays it out.
    /// `NSFont` has no `.lineHeight` the way `UIFont` does —
    /// `NSLayoutManager().defaultLineHeight(for:)` is AppKit's equivalent
    /// (the value the layout system itself uses for a line of that font).
    static func lineHeight(of font: PlatformFont) -> CGFloat {
        #if os(iOS)
        font.lineHeight
        #else
        NSLayoutManager().defaultLineHeight(for: font)
        #endif
    }

    /// The single-line width `text` needs in `font` — used to reserve room
    /// for `TaskRow`'s due-time label before measuring the title's own
    /// wrap, since the title's real column is narrower whenever a due time
    /// is shown beside it.
    static func measuredWidth(for text: String, font: PlatformFont) -> CGFloat {
        guard !text.isEmpty else { return 0 }
        return ceil((text as NSString).size(withAttributes: [.font: font]).width)
    }

    #if os(iOS)
    fileprivate static func uiWeight(_ weight: Font.Weight) -> UIFont.Weight {
        switch weight {
        case .semibold: return .semibold
        case .medium: return .medium
        default: return .regular
        }
    }
    #else
    fileprivate static func nsWeight(_ weight: Font.Weight) -> NSFont.Weight {
        switch weight {
        case .semibold: return .semibold
        case .medium: return .medium
        default: return .regular
        }
    }
    #endif

    /// Track's list rows are spaced tighter than everything else.
    ///
    /// A quota row is only as tall as its 36pt buttons, and a typical corpus is
    /// eight or so quotas — all of which must fit a 4×4 at once, because paging
    /// a list that could have been shown whole is the least intuitive thing a
    /// widget can ask of a user. Eight rows plus a header spend the card's whole
    /// height, so the gaps are hairlines. The row's own 36pt frame supplies the
    /// visual breathing room; this is only the gap between those frames.
    /// Reminders and Tasks keep `rowSpacing` — their rows are taller and fewer.
    static let trackRowSpacing: CGFloat = 1

    /// Floor for the `+1` / `−` targets, matching the check-off circles. Chrome
    /// gets compacted to fit more rows; touch targets never do.
    static let progressButtonSize: CGFloat = 36

    /// `ReminderRow`/`TaskRow`'s trailing marker column (the check-off
    /// circle / square) — width always, and iOS's height FLOOR (macOS has
    /// no floor; see the "row-height truthing" note above). Named so the two
    /// rows and their line-count measurement (which has to subtract this
    /// same column back out of the card width) can't drift apart the way two
    /// bare `36`s could.
    static let rowMarkerSize: CGFloat = 36

    /// `TaskRow`'s trailing column width in snooze mode (2026-09-23, Phase
    /// 2) — the ⏭ circle (32) + 6pt spacing + the "+1h" pill's own width,
    /// rounded up generously rather than measured exactly (unlike the due
    /// label, this trailing content is fixed chrome, not variable text, so a
    /// small fixed over-reservation costs nothing and never underestimates).
    static let snoozeRowControlsWidth: CGFloat = 96

    /// `TaskRow`'s trailing column width in select mode — `SelectionMarker`'s
    /// own diameter, smaller than the normal checkbox's `rowMarkerSize`.
    static let selectionMarkerSize: CGFloat = 22

    // MARK: - Formatting

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "h:mm a"
        f.amSymbol = "am"
        f.pmSymbol = "pm"
        return f
    }()

    /// "9:30am". Widgets are narrow; the lowercase meridiem buys a character
    /// and reads quieter next to the task title.
    static func shortTime(_ date: Date) -> String {
        timeFormatter.string(from: date)
    }

    /// The staleness note shown when the widget is rendering from cache.
    static func staleNote(_ fetchedAt: Date) -> String {
        "as of \(shortTime(fetchedAt))"
    }

    // MARK: - Due-date day-naming (2026-09-23)
    //
    // "Anywhere a task time shows" now reads a day word ahead of the time:
    // "8:30 PM" (today, unchanged), "Tomorrow 9:00 AM", "Sun 9:00 AM" (2-6
    // days out), "Oct 1 9:00 AM" (7+ days out), "Oct 2" (date-only, no time
    // at all). Overdue is DELIBERATELY UNCHANGED — always the plain time in
    // red, never a day word (an overdue item is "late", not "coming up",
    // and the red already carries that meaning).
    //
    // Date-only detection is an INVENTED convention, not something the wire
    // format states: `TaskDTO.dueAt`/the server schema carry no date-only
    // flag anywhere (the web's own `DateTimePicker.tsx` defaults an unset
    // time to 9:00 AM, not midnight, so there is no existing signal to key
    // off). A local time-of-day of exactly midnight is treated as
    // date-only — common enough as a convention, but flagged here because
    // nothing in the codebase already does this.
    //
    // `DueLabelParts` is the ONE function both the styled `Text` render
    // (`dueLabelText`) and the plain-string WIDTH MEASUREMENT
    // (`TasksListView.layout(for:)`, via `plainString` or the two halves)
    // build from — the same discipline `measuredLineCount`'s own doc insists
    // on elsewhere in this file: a row's height must be measured from the
    // SAME string it renders, or the pager mismeasures and a title clips or
    // gets an extra blank line.

    struct DueLabelParts {
        /// nil when the due date is today or overdue (no day word in either
        /// case — see this section's header comment).
        let dayWord: String?
        /// nil when the due date is date-only (local time-of-day exactly
        /// midnight).
        let time: String?

        /// The exact string shown — `"\(dayWord) \(time)"`, or whichever
        /// half is present alone, or "" if somehow both are nil (a
        /// date-only task due exactly today: no day word because it's
        /// today, no time because it's date-only — nothing to say).
        var plainString: String {
            switch (dayWord, time) {
            case let (.some(d), .some(t)): return "\(d) \(t)"
            case let (.some(d), nil): return d
            case let (nil, .some(t)): return t
            case (nil, nil): return ""
            }
        }

        /// Both halves present ("Tomorrow" + "4:00 pm") — the only shape that
        /// can STACK onto two lines (see `dueLabelText(for:now:stacked:)`).
        var hasTwoParts: Bool { dayWord != nil && time != nil }
    }

    private static let dueWeekdayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "EEE"
        return f
    }()

    private static let dueMonthDayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f
    }()

    /// The single source of truth for a due date's day word + time — see
    /// this section's header comment. `isOverdue` is passed in rather than
    /// recomputed here (`TaskDTO.isOverdue(now:)` already exists and every
    /// call site already has it or an equivalent `now` to compute it from),
    /// so this function has exactly one clock-reading job (bucketing days
    /// away), not two.
    static func dueLabelParts(for due: Date, now: Date = Date(), isOverdue: Bool) -> DueLabelParts {
        let calendar = Calendar.current
        let isDateOnly =
            calendar.component(.hour, from: due) == 0 && calendar.component(.minute, from: due) == 0

        if isOverdue {
            // A date-only task has no time to show — "12:00 am" would read
            // as a real due TIME, not the absence of one (Trent's review of
            // the first cut). Show the date instead, in the SAME red the
            // time would otherwise draw in (`dueLabelText` below): "Sep 22",
            // or "Yesterday" specifically for exactly one day past — the one
            // relative word worth the recognition win, per Trent's ask.
            // Anything further back is just the date; there is no "3 days
            // ago" ladder here the way `DateHelpers.formatRelativeTime` has
            // for notifications, because a widget row has no room for it
            // and the day-naming feature this belongs to is about WHEN,
            // not HOW LONG AGO.
            guard isDateOnly else {
                return DueLabelParts(dayWord: nil, time: shortTime(due))
            }
            let startOfToday = calendar.startOfDay(for: now)
            let startOfDue = calendar.startOfDay(for: due)
            let daysAgo = calendar.dateComponents([.day], from: startOfDue, to: startOfToday).day ?? 0
            let word = daysAgo == 1 ? "Yesterday" : dueMonthDayFormatter.string(from: due)
            return DueLabelParts(dayWord: word, time: nil)
        }

        let time = isDateOnly ? nil : shortTime(due)

        let startOfToday = calendar.startOfDay(for: now)
        let startOfDue = calendar.startOfDay(for: due)
        let daysAway = calendar.dateComponents([.day], from: startOfToday, to: startOfDue).day ?? 0

        let dayWord: String?
        switch daysAway {
        case ..<1:
            // Today (0) or, in principle, still-negative-but-not-overdue
            // (never reached in practice — `isOverdue` already caught every
            // past instant — kept as a safe fallback rather than an
            // unreachable-crash).
            dayWord = nil
        case 1:
            dayWord = "Tomorrow"
        case 2...6:
            dayWord = dueWeekdayFormatter.string(from: due)
        default:
            dayWord = dueMonthDayFormatter.string(from: due)
        }
        return DueLabelParts(dayWord: dayWord, time: time)
    }

    /// Subtle indigo for the day word — built on `indigoAccent` (the same
    /// hue `ReminderSlotStrip`'s "behind, still waiting" fill and
    /// `CompletedDotToggle`'s ON state use), dimmed to `0.85` since a due
    /// label sits beside body text far more often than a slot strip segment
    /// does and doesn't need the fully saturated version.
    static let dueDayWordTint = indigoAccent.opacity(0.85)

    /// The styled `Text` for wherever a task's due time shows (`TaskRow`,
    /// `TasksSmallView`) — builds on `dueLabelParts` so the day-word tint and
    /// the overdue-red rule can never drift between call sites. Built via
    /// `Text` concatenation (`+`), not a nested `HStack`, so it composes
    /// inline with a `.firstTextBaseline` `HStack` the way a single `Text`
    /// would.
    ///
    /// `stacked` (2026-09-24): the day word and the time on two lines
    /// ("Tomorrow" / "4:00 pm") instead of one. `TaskRow` stacks a
    /// two-part label on systemLarge because at large text sizes a one-line
    /// "Tomorrow 4:00 pm" takes half the row and squeezes the title to three
    /// narrow lines; stacked, the label's column is only as wide as its
    /// longer half. It is an explicit line break, never a wrap, so the
    /// label's width and height are exactly what `TasksListView.layout
    /// (for:)` measured.
    static func dueLabelText(for task: TaskDTO, now: Date = Date(), stacked: Bool = false) -> Text {
        guard let due = task.dueDate else { return Text("") }
        let overdue = task.isOverdue(now: now)
        let parts = dueLabelParts(for: due, now: now, isOverdue: overdue)
        if overdue {
            // `plainString` is safe here even though it's normally the
            // MEASUREMENT-only accessor: for an overdue task `dueLabelParts`
            // always populates exactly ONE of `dayWord`/`time` (never both),
            // so it resolves to whichever one is set — the plain time for
            // an ordinary overdue task, or "Yesterday"/"Sep 22" for a
            // date-only one — with no day-word/time split to color
            // differently, unlike the non-overdue branch below.
            return Text(parts.plainString).foregroundStyle(Color.red.opacity(0.9))
        }
        var text: Text?
        if let dayWord = parts.dayWord {
            text = Text(dayWord).foregroundStyle(dueDayWordTint)
        }
        if let time = parts.time {
            let timeText = Text(time).foregroundStyle(Color.secondary)
            text = text.map { $0 + Text(stacked ? "\n" : " ") + timeText } ?? timeText
        }
        return text ?? Text("")
    }

    // MARK: - List paging (2026-09-24, height-based)

    /// Page boundaries for a list of rows of KNOWN heights — shared by the
    /// Reminders and Tasks lists (`RemindersListView`/`TasksListView`,
    /// each via its own `pages(...)`), with `isDivider` naming the "DONE ·
    /// N" row by index rather than through a common item protocol (the two
    /// lists' item enums are private to their own files).
    ///
    /// GREEDY, BY HEIGHT (2026-09-24, the fill fix): each page takes rows
    /// until the NEXT row genuinely doesn't fit `budget`, then starts the
    /// next page with that row. So every page fills, pages break only
    /// between whole rows, and the partition is a pure function of the list
    /// — the same page count and the same boundaries whichever page happens
    /// to be on screen.
    ///
    /// What this replaced, and why it had to go: each list used to offer
    /// `ViewThatFits` ten candidates ("10 rows", "9 rows"… "1 row") and slice
    /// the list into UNIFORM pages of whatever size won. Two failures fell
    /// out of that, both on Trent's phone on 2026-09-24:
    ///
    /// 1. Uniform pages meant the page that happened to hold the LONGEST
    ///    rows set the size of EVERY page. One three-line reminder on page 1
    ///    dropped the page size to 2, so "7 left" became "1/4", with two
    ///    rows and a card's worth of empty space under them — and 26 tasks
    ///    became 13 pages of 2.
    /// 2. Each candidate sliced ITS OWN page from the stored page index, so
    ///    the winner — and with it the page size and the page count —
    ///    depended on which page was showing. The same 7 reminders read
    ///    "1/4" on page 1 and "2/2" on page 2 (one row, Cold Shower, alone
    ///    on an otherwise empty card): on page 2 the 6-row candidate's
    ///    slice was a single short row, which trivially "fit".
    ///
    /// The divider rule survives from the uniform version (Trent's review:
    /// "never let 'DONE · N' be the last item on a page... if the first
    /// done row spills, the divider moves to the next page too"): a page
    /// that would END on the divider, with done rows still to come, hands
    /// the divider to the next page instead — unless the divider is the
    /// page's only row, where there is nothing to back off to.
    ///
    /// A single row taller than `budget` still gets a page of its own
    /// rather than looping forever; the callers cap a row's lines so that
    /// never actually happens (see `WidgetTextMetrics.titleLines`).
    static func pages(
        heights: [CGFloat], spacing: CGFloat, budget: CGFloat, isDivider: (Int) -> Bool
    ) -> [Range<Int>] {
        guard !heights.isEmpty else { return [0..<0] }
        var pages: [Range<Int>] = []
        var start = 0
        while start < heights.count {
            var end = start
            var used: CGFloat = 0
            while end < heights.count {
                let needed = used + (end > start ? spacing : 0) + heights[end]
                if end > start, needed > budget { break }
                used = needed
                end += 1
            }
            if end - start > 1, end < heights.count, isDivider(end - 1) {
                end -= 1
            }
            pages.append(start..<end)
            start = end
        }
        return pages
    }
}

// MARK: - Text metrics at the widget's real text size (2026-09-24)

/// What SwiftUI ACTUALLY drew for one text style, read back out of layout
/// by `RenderedTextReader`: the width of a fixed sample line, and one
/// line's height.
struct RenderedTextSample {
    /// The sample every probe draws and every calibration measures —
    /// ten capital Ms, wide enough that a rounding pixel is noise.
    static let sampleLine = String(repeating: "M", count: 10)
    /// Lines in the probe; its height ÷ this is the line pitch.
    static let sampleLines = 10

    let lineWidth: CGFloat
    let lineHeight: CGFloat
}

/// The row-sizing numbers the Reminders/Tasks lists page with, at the text
/// size the widget is ACTUALLY drawn at.
///
/// TWO CORRECTIONS, both found by rendering Trent's real data at his text
/// size (XXX Large) in the Xcode preview, 2026-09-24:
///
/// 1. **The text size.** It is read from the view's `\.dynamicTypeSize`, never
///    from a bare `UIFont.preferredFont(forTextStyle:)`. That trait-less call
///    answers for the PROCESS's content size category, which isn't
///    guaranteed to be the widget's — in the preview it plainly isn't (the
///    Dynamic Type variant changes the environment SwiftUI draws with, and
///    nothing else), and a widget extension is the same kind of process.
///    When the two disagree, every line count and reserved height is
///    computed for one text size while the text is drawn at another.
/// 2. **SwiftUI's own metrics.** Even at the RIGHT text size, UIKit's font
///    for `.subheadline` at XXX Large (21pt, `lineHeight` 25.06) is not what
///    SwiftUI draws in a widget: SwiftUI's line pitch there measured 24.13,
///    and its lines are correspondingly narrower — a title UIKit wrapped to
///    three lines rendered in two, and its row kept an empty third line
///    ("Check if anyone is waiting on me", "Weekly allowance ($8)"). So
///    when a `RenderedTextSample` is supplied, the measuring font is SCALED
///    to SwiftUI's drawn width for the same sample line, and the line
///    height is SwiftUI's drawn pitch. UIKit still does the wrapping — the
///    only text engine a widget can ask "how many lines?" — but at the size
///    SwiftUI actually drew.
///
/// macOS has no Dynamic Type in widgets; there the platform's preferred
/// fonts are the base, calibrated the same way.
struct WidgetTextMetrics {
    /// One `.subheadline` line (row titles) as drawn, unrounded — the line
    /// pitch every row height is built from.
    let titleLineHeight: CGFloat
    private let titlePointSize: CGFloat
    /// The `.caption2` font, at its drawn size, with monospaced digits — due
    /// times render `.monospacedDigit()`, and a proportional "1" is narrower
    /// than the digit actually drawn.
    let caption2Font: WidgetTheme.PlatformFont
    let caption2LineHeight: CGFloat

    /// `title`/`caption2`: what `RenderedTextReader` read back from SwiftUI.
    /// `nil` uses the platform fonts as-is — correct for the text size,
    /// slightly large for SwiftUI's drawing (see this struct's doc).
    init(dynamicTypeSize: DynamicTypeSize, title: RenderedTextSample? = nil, caption2: RenderedTextSample? = nil) {
        #if os(iOS)
        let traits = UITraitCollection(preferredContentSizeCategory: Self.category(for: dynamicTypeSize))
        let baseTitle = UIFont.preferredFont(forTextStyle: .subheadline, compatibleWith: traits)
        let baseCaption = UIFont.preferredFont(forTextStyle: .caption2, compatibleWith: traits)
        #else
        let baseTitle = NSFont.preferredFont(forTextStyle: .subheadline, options: [:])
        let baseCaption = NSFont.preferredFont(forTextStyle: .caption2, options: [:])
        #endif
        titlePointSize = baseTitle.pointSize * Self.scale(of: baseTitle, toMatch: title)
        let captionSize = baseCaption.pointSize * Self.scale(of: baseCaption, toMatch: caption2)
        #if os(iOS)
        caption2Font = UIFont.monospacedDigitSystemFont(ofSize: captionSize, weight: .regular)
        #else
        caption2Font = NSFont.monospacedDigitSystemFont(ofSize: captionSize, weight: .regular)
        #endif
        titleLineHeight = title?.lineHeight ?? WidgetTheme.lineHeight(of: baseTitle)
        caption2LineHeight = caption2?.lineHeight ?? WidgetTheme.lineHeight(of: baseCaption)
    }

    /// The factor that makes `font` draw `RenderedTextSample.sampleLine` as
    /// wide as SwiftUI did; 1 with no sample to match.
    private static func scale(of font: WidgetTheme.PlatformFont, toMatch sample: RenderedTextSample?) -> CGFloat {
        guard let sample, sample.lineWidth > 0 else { return 1 }
        let measured = (RenderedTextSample.sampleLine as NSString).size(withAttributes: [.font: font]).width
        return measured > 0 ? sample.lineWidth / measured : 1
    }

    /// The subheadline font at a given weight, at the drawn size — weight
    /// has to match what's drawn (P3/P4 titles render `.semibold`, which is
    /// measurably wider) or a title near the wrap boundary undercounts its
    /// lines.
    func titleFont(weight: Font.Weight) -> WidgetTheme.PlatformFont {
        #if os(iOS)
        UIFont.systemFont(ofSize: titlePointSize, weight: WidgetTheme.uiWeight(weight))
        #else
        NSFont.systemFont(ofSize: titlePointSize, weight: WidgetTheme.nsWeight(weight))
        #endif
    }

    /// How many lines a row title gets: its real wrapped count at `width`,
    /// capped at `cap` (iOS's 3-line rule; `nil` on macOS, which never caps
    /// — but never more lines than `maxHeight` can hold, so no single row
    /// can outgrow the card the pager pages through).
    func titleLines(
        _ text: String, width: CGFloat, weight: Font.Weight, cap: Int?, maxHeight: CGFloat
    ) -> Int {
        let real = WidgetTheme.measuredLineCount(for: text, maxWidth: width, font: titleFont(weight: weight))
        let fitting = maxHeight.isFinite ? max(1, Int(maxHeight / titleLineHeight)) : real
        return min(real, cap ?? real, fitting)
    }

    /// The exact height `lines` title lines take — the number a row is
    /// FRAMED to, and the number the pager adds up. Rounded up once for the
    /// whole block (not per line), so three 24.13pt lines cost 73, not 75.
    func titleHeight(lines: Int) -> CGFloat {
        ceil(CGFloat(lines) * titleLineHeight)
    }

    /// One `.caption2` line, rounded up — the divider row's height.
    var caption2Height: CGFloat { ceil(caption2LineHeight) }

    /// The list's bottom row (`Select` · `‹ n/N ›` · the completed dot) —
    /// a FIXED height the pager can subtract before it pages: the taller of
    /// a caption2 line and `ListPager`'s 18pt glyph frame. No air of its
    /// own: the `rowSpacing` above it and WidgetKit's content margin below
    /// already separate it, and every point here is a point a row can't
    /// have. Every control in that row is framed to this and bleeds its tap
    /// target past it (see `ListPager`), so its real size never drifts from
    /// what was budgeted.
    var bottomBarHeight: CGFloat { max(18, caption2Height) }

    /// `ActionPill`'s height — a caption2 line plus its 6pt top/bottom
    /// padding. Tasks' snooze/select bars are framed to budgets built on it.
    var actionPillHeight: CGFloat { caption2Height + 12 }

    #if os(iOS)
    private static func category(for size: DynamicTypeSize) -> UIContentSizeCategory {
        switch size {
        case .xSmall: return .extraSmall
        case .small: return .small
        case .medium: return .medium
        case .large: return .large
        case .xLarge: return .extraLarge
        case .xxLarge: return .extraExtraLarge
        case .xxxLarge: return .extraExtraExtraLarge
        case .accessibility1: return .accessibilityMedium
        case .accessibility2: return .accessibilityLarge
        case .accessibility3: return .accessibilityExtraLarge
        case .accessibility4: return .accessibilityExtraExtraLarge
        case .accessibility5: return .accessibilityExtraExtraExtraLarge
        @unknown default: return .large
        }
    }
    #endif
}

/// Lays `content` out in this view's full size, handing it that size and
/// `WidgetTextMetrics` calibrated to what SwiftUI really draws here — see
/// that struct's doc for why UIKit's own numbers aren't good enough.
///
/// How: clear PROBE texts — ten lines of `RenderedTextSample.sampleLine`
/// in `.subheadline`, and again in `.caption2` — sit at the region's
/// top-left, each with a `GeometryReader` over it reading SwiftUI's real
/// size for that text: its width is one sample line's drawn width, its
/// height ÷ 10 is the drawn line pitch. `content` is laid out inside the
/// innermost reader but framed to the REGION's size from its top-left, so
/// it covers exactly the region; it just overflows the probes' own frames,
/// which draw nothing. One layout pass, no preferences, no state — the only
/// kind of measurement a widget's single render allows.
struct RenderedTextReader<Content: View>: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ViewBuilder let content: (CGSize, WidgetTextMetrics) -> Content

    var body: some View {
        GeometryReader { region in
            probe(.subheadline) { title in
                probe(.caption2) { caption in
                    content(
                        region.size,
                        WidgetTextMetrics(dynamicTypeSize: dynamicTypeSize, title: title, caption2: caption)
                    )
                    .frame(width: region.size.width, height: region.size.height, alignment: .topLeading)
                }
            }
        }
    }

    private func probe<Inner: View>(
        _ font: Font, @ViewBuilder inner: @escaping (RenderedTextSample) -> Inner
    ) -> some View {
        let lines = RenderedTextSample.sampleLines
        return Text(Array(repeating: RenderedTextSample.sampleLine, count: lines).joined(separator: "\n"))
            .font(font)
            .lineLimit(lines)
            .fixedSize()
            .foregroundStyle(.clear)
            .accessibilityHidden(true)
            .overlay(alignment: .topLeading) {
                GeometryReader { probe in
                    inner(RenderedTextSample(lineWidth: probe.size.width, lineHeight: probe.size.height / CGFloat(lines)))
                }
            }
    }
}

// MARK: - Deep links

/// `opentask://` URLs the widget hands back to the app.
///
/// The app has no native routes — it is a WKWebView over the PWA — so each
/// link resolves to a web path in `OpenTaskApp.onOpenURL`.
enum WidgetLink {
    static let scheme = "opentask"

    static var dashboard: URL { URL(string: "\(scheme)://today")! }
    static var reminders: URL { URL(string: "\(scheme)://reminders")! }
    /// The quotas surface (§5), for the Track widget's header — see
    /// `TrackListView.header` in `TrackWidgetViews.swift`.
    static var quotas: URL { URL(string: "\(scheme)://quotas")! }

    static func task(_ id: Int) -> URL {
        URL(string: "\(scheme)://task/\(id)") ?? dashboard
    }

    /// The Reminders header title link (2026-09-23) — Trent: "If you tap on
    /// the header, like the thing that says 'afternoon,' it should scroll
    /// down to the actual afternoon section." `slotId` is the on-screen
    /// group's `slotKey` (`TimeSlotDTO.id`, or -1 for the un-slotted
    /// "Anytime" group — the same sentinel `ReminderGroupDTO.slotKey` and
    /// `APIClient.fetchSlotReminders` already use). Resolves to
    /// `/reminders?slot=<slotId>`, which brings that slot into view rather
    /// than just opening the surface at the top. Deliberately separate from
    /// the bare `reminders` above: the 2×2, Lock Screen families, and the
    /// systemMedium/Large background tap all still mean "open Reminders",
    /// not "open Reminders AT this slot" — only the header title Link uses
    /// this.
    static func reminders(slot slotId: Int) -> URL {
        URL(string: "\(scheme)://reminders/slot/\(slotId)") ?? reminders
    }

    /// The Tasks header title link when scoped to one project (2026-09-23) —
    /// the project-page twin of `reminders(slot:)`. "Up next" (the unified
    /// `allProjects` scope) still links to the bare `dashboard` above; only a
    /// project-scoped header uses this, resolving to `/?project=<id>` so the
    /// app opens scoped to that project instead of landing back on the
    /// unified list.
    static func project(_ id: Int) -> URL {
        URL(string: "\(scheme)://project/\(id)") ?? dashboard
    }

    /// One reminder, ON the Reminders surface.
    ///
    /// Deliberately NOT `task(_:)`: that lands on the dashboard with the task's
    /// editor open, which for a reminder is both the wrong tab and more than
    /// was asked for. Tapping a reminder means "let me see that one" — the app
    /// resolves this to `/reminders?reminder=<id>`, which brings the row into
    /// view and highlights it, and opens nothing.
    static func reminder(_ id: Int) -> URL {
        URL(string: "\(scheme)://reminder/\(id)") ?? reminders
    }

    /// One quota, ON the Quotas surface.
    ///
    /// Deliberately NOT `task(_:)`: a quota is tracked (`is_tracked`), and
    /// `task/<id>` sends a tracked id to `/tasks/<id>` — the full detail
    /// page, not a highlight (Trent, 2026-09-22: "quota still opens up the
    /// full detail menu when really it should just highlight it in the
    /// Quotas tab"). This resolves to `/quotas?quota=<id>` instead, which
    /// brings the row into view and highlights it, and opens nothing — the
    /// same shape `reminder(_:)` and the dashboard's `task/<id>` give their
    /// surfaces. Every Track widget row/card that links to a specific quota
    /// (`TrackRow`, `TrackSmallView`) uses this, never `task(_:)`.
    static func quota(_ id: Int) -> URL {
        URL(string: "\(scheme)://quota/\(id)") ?? quotas
    }
}

// MARK: - Shared chrome

/// One half of a `ChevronPager`, also usable alone where the two glyphs have to
/// sit at opposite edges (the Track widget's 2×2).
///
/// §8: widgets get no swipe gestures, so paging has to be an explicit tap
/// target. The button is `.plain` so WidgetKit doesn't draw its default capsule
/// around a glyph that is already a control.
struct ChevronButton<I: AppIntent>: View {
    enum Direction {
        case previous, next

        var symbol: String { self == .previous ? "chevron.left" : "chevron.right" }
    }

    let intent: I
    let direction: Direction
    /// False when there is nothing further this way — §8: "chevrons must
    /// telegraph their edges", so a dead chevron dims and stops responding
    /// rather than looking live and doing nothing.
    var enabled = true

    var body: some View {
        Button(intent: intent) {
            Image(systemName: direction.symbol)
                .font(.caption.weight(.semibold))
                // 40pt hit target (HIG says 44, but widget headers can't spare
                // that height) — the glyph stays small, the tappable area
                // doesn't. At 22pt these were nearly impossible to hit with a
                // casual tap. Fixed, not `minWidth`: both halves of a pager
                // must be exactly the same size as each other.
                .frame(width: 40, height: 40)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .opacity(enabled ? 1 : 0.3)
        .disabled(!enabled)
    }
}

/// The `‹ ›` pair used by all three widgets to page through slots / projects /
/// quotas.
///
/// It is told about its *ring*, not just its intents (§8, amended 2026-07-27):
/// `hasPrevious`/`hasNext` are false when the ring has nowhere to go (one
/// project, one quota), and the chevron dims out. All three rings currently
/// wrap, so a live ring keeps both chevrons live — wrapping is unambiguous with
/// a handful of pages and beats a dead end the user can't explain.
///
/// §8 as first written ALSO had systemLarge name the adjacent page beside each
/// glyph ("‹ Midday   Evening ›"). That is gone (2026-09-11, after Trent's
/// first use of the widgets): page names are page-length, the header is not,
/// and the truncation that followed — "‹ Early mor…" — spent width to tell the
/// reader nothing a tap wouldn't. The header already names the page you are ON,
/// in headline type; the rings wrap and hold a handful of pages; a chevron tap
/// is free and reversible. So a chevron says "there is more this way", which is
/// the whole of its job, and the room it gave back goes to the content.
struct ChevronPager<Previous: AppIntent, Next: AppIntent>: View {
    let previous: Previous
    let next: Next
    var hasPrevious = true
    var hasNext = true

    var body: some View {
        // Zero spacing: the two 40pt hit targets already separate the glyphs.
        HStack(spacing: 0) {
            ChevronButton(intent: previous, direction: .previous, enabled: hasPrevious)
            ChevronButton(intent: next, direction: .next, enabled: hasNext)
        }
    }
}

/// The always-present Undo/Redo pair (2026-09-23), replacing the old
/// time-windowed single "Undo" text button. Trent: "The undo button on the
/// segment I was working on disappeared... undoing it should still be
/// allowed" and "For undo and redo I think we want undo and redo, ideally
/// with an icon… like a U-turn left and U-turn right."
///
/// `canUndo`/`canRedo` come from the server's own undoable/redoable counts
/// (`WidgetStore.canUndo`/`canRedo`, refreshed on every widget fetch via
/// `GET /api/undo/status` — see `RemindersProvider`/`TaskFeed`), not from
/// "did THIS kind just mutate": both buttons are shown in every one of the
/// three kinds' headers, because `/api/undo`/`/api/redo` act on "whatever
/// changed last" server-wide, exactly like the old single button did (see
/// `UndoLastActionIntent`'s doc) — there was never a kind-specific version
/// of this to preserve.
///
/// Sized to its content, like the header's own title `Link`, rather than
/// stretched to `ChevronButton`'s 40pt floor: it sits in the SAME header row
/// as the chevrons, which have no spare height to give up (see
/// `ChevronButton`'s comment on why a systemMedium header can't afford
/// more), so widening this vertically would only shrink something else on
/// the same line. Dims/disables exactly like `ChevronButton` when there is
/// nothing to undo/redo, rather than hiding — a vanishing button here would
/// reintroduce the same disappearing-affordance complaint that killed the
/// old 60s window.
struct UndoRedoButtons: View {
    let canUndo: Bool
    let canRedo: Bool

    var body: some View {
        HStack(spacing: 2) {
            iconButton(intent: UndoLastActionIntent(), symbol: "arrow.uturn.backward", enabled: canUndo, label: "Undo")
            iconButton(intent: RedoLastActionIntent(), symbol: "arrow.uturn.forward", enabled: canRedo, label: "Redo")
        }
    }

    private func iconButton<I: AppIntent>(
        intent: I, symbol: String, enabled: Bool, label: String
    ) -> some View {
        Button(intent: intent) {
            Image(systemName: symbol)
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 5)
                .padding(.vertical, 4)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .opacity(enabled ? 1 : 0.3)
        .disabled(!enabled)
        .accessibilityLabel(Text(label))
    }
}

/// The "show completed" toggle, as a DOT in the list's bottom row
/// (2026-09-24 — Trent: "change the eyeball to a dot and move it to the
/// bottom by the paginator"). Hollow = completed items hidden, filled indigo
/// = shown, with a small word beside it ("done" on Reminders/Tasks, "met" on
/// Quotas) because a bare dot says nothing on its own. It used to be an
/// `eye`/`eye.slash` glyph in the HEADER, which — with the clock, Undo,
/// Redo and ‹ › beside it — squeezed the title down to "Early m…"/"Up…".
///
/// Generic over its intent so all three kinds share one look:
/// `ToggleShowCompletedIntent(kind:)` for Reminders/Tasks,
/// `ToggleQuotasShowMetIntent()` for Quotas (a different state — a met
/// quota stays open — with its own store key).
///
/// Framed to the bottom row's fixed height (`WidgetTextMetrics.
/// bottomBarHeight`) with its tap target bled half a `rowSpacing` above
/// and below — the `ListPager` trick — so it is a comfortable target
/// without costing the row a point of the height the pager budgeted.
struct CompletedDotToggle<I: AppIntent>: View {
    let intent: I
    let isOn: Bool
    let label: String
    let height: CGFloat

    private var bleed: CGFloat { WidgetTheme.rowSpacing / 2 }

    var body: some View {
        Button(intent: intent) {
            HStack(spacing: 4) {
                Circle()
                    .fill(isOn ? WidgetTheme.indigoAccent : Color.clear)
                    .overlay(Circle().strokeBorder(isOn ? Color.clear : Color.secondary, lineWidth: 1.2))
                    .frame(width: 8, height: 8)
                Text(label)
                    .font(.caption2)
                    .foregroundStyle(isOn ? WidgetTheme.indigoAccent : Color.secondary)
                    .lineLimit(1)
                    .fixedSize()
            }
            .frame(height: height + 2 * bleed)
            .padding(.leading, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, -bleed)
        .accessibilityLabel(Text(isOn ? "Hide \(label)" : "Show \(label)"))
    }
}

/// Quotas' "Takeback" button (2026-09-24) — sits at the right end of the
/// bottom row, after the "met" dot, and flips Takeback mode
/// (`ToggleQuotasTakebackModeIntent`; the mode itself is documented on
/// `WidgetStore.quotasTakebackMode`). The `minus.circle` ICON ALONE, no
/// "Takeback" word: the brief was "the word if it fits at XXX Large, else
/// the icon", and it doesn't fit — measured in the row's own drawn
/// `.caption2` on an iPhone 18 Pro Large card, the pager is centred in its
/// own layer (`ListBottomBar`), leaving the right-hand cluster ~110pt,
/// and "○ met" + icon + "Takeback" needs ~120pt even at the DEFAULT text
/// size (more at XXX Large). An adaptive word (shown only when there's one
/// page and no pager) was tried and dropped: the button would change shape
/// the moment a takeback re-hid the met chips and the pages collapsed. The
/// accessibility label carries the name ("Takeback mode").
///
/// Off: secondary, like every other bottom-row control. On:
/// `WidgetTheme.takebackTint`, the FILLED glyph, and a faint red capsule
/// behind it — "armed" must be unmistakable at a glance.
///
/// Framed to the bottom row's fixed height with its tap target bled half a
/// `rowSpacing` above and below — `CompletedDotToggle`'s trick — so it
/// costs the page budget nothing.
struct TakebackModeToggle: View {
    let isOn: Bool
    let height: CGFloat

    private var bleed: CGFloat { WidgetTheme.rowSpacing / 2 }

    var body: some View {
        Button(intent: ToggleQuotasTakebackModeIntent()) {
            Image(systemName: isOn ? "minus.circle.fill" : "minus.circle")
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 6)
                .frame(height: height)
                .background(
                    Capsule().fill(isOn ? WidgetTheme.takebackTint.opacity(0.16) : Color.clear)
                )
                .frame(height: height + 2 * bleed)
                // Space between this and the "met" dot before it.
                .padding(.leading, 6)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, -bleed)
        .foregroundStyle(isOn ? WidgetTheme.takebackTint : Color.secondary)
        .accessibilityLabel(Text("Takeback mode"))
        .accessibilityValue(Text(isOn ? "On" : "Off"))
    }
}

/// The list's bottom row (2026-09-24): `leading` at the left edge (Tasks'
/// "Select"; nothing on Reminders/Quotas), the `‹ n/N ›` pager CENTRED on
/// the card, and `trailing` at the right edge (the completed dot). The pager
/// sits in its own layer so it stays centred on the card whatever the two
/// sides hold — a three-column HStack would drift it off-centre the moment
/// "Select" and "done" differ in width.
///
/// Exactly `height` tall (`WidgetTextMetrics.bottomBarHeight`) — the number
/// the list subtracted from the card before paging, so the pager can never
/// be pushed off the bottom by a row the budget didn't know about.
struct ListBottomBar<Leading: View, Pager: View, Trailing: View>: View {
    let height: CGFloat
    @ViewBuilder let leading: Leading
    @ViewBuilder let pager: Pager
    @ViewBuilder let trailing: Trailing

    var body: some View {
        ZStack {
            pager
            HStack(spacing: 0) {
                leading
                Spacer(minLength: 0)
                trailing
            }
        }
        .frame(height: height)
    }
}

/// The "DONE · N" divider between open and completed rows (2026-09-23, "show
/// completed", mockup option A) — a hairline, not a full section header:
/// completed items are secondary content sitting below the primary list, not
/// a second list of equal visual weight.
struct DoneDivider: View {
    let count: Int

    var body: some View {
        HStack(spacing: 6) {
            Text("DONE · \(count)")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .fixedSize()
            Rectangle()
                .fill(Color.secondary.opacity(0.15))
                .frame(height: 1)
        }
    }
}

/// The bottom-of-card pager (2026-09-23) — Trent: "It'd be nice to be able
/// to page through things that are too long to fit on the widget screen. It
/// should be a number/number to show what page you're on… maybe at the
/// bottom." Replaces "+N more" on the Reminders and Tasks systemLarge lists
/// (and pages the Quotas chip flow) once a card's content outgrows one page
/// (`WidgetTheme.pages` / `QuotaFlow.paginate`). Sits centred in
/// `ListBottomBar`, on EVERY page when there is more than one.
///
/// `page`/`totalPages` are 0-based internally, shown 1-based, and computed
/// by the CALLER — this view is dumb chrome, the same division of labor as
/// `ChevronPager`.
///
/// Dims at the ends like every other pager in this file rather than
/// wrapping (see `ChevronButton`'s doc): a reader paging through a long list
/// has an actual first/last page, unlike the small fixed rings (slots,
/// projects, quotas) that wrap because there is no meaningful "end" to one
/// of a handful of pages.
///
/// Each glyph reuses `ReminderSlotStrip.segmentBleed`'s trick for its own
/// tap target: a caption-sized "‹ 1/3 ›" row would be a poor target at its
/// visual size alone, so it gets a taller invisible `contentShape` and
/// negative vertical padding to bleed into the row gap above/below without
/// costing the card any extra height (see that struct's `segmentBleed` doc
/// for the mechanics).
struct ListPager<Previous: AppIntent, Next: AppIntent>: View {
    let page: Int
    let totalPages: Int
    let previous: Previous
    let next: Next

    private var bleed: CGFloat { WidgetTheme.rowSpacing / 2 }

    var body: some View {
        // Sized to its content (2026-09-24 — it used to pad itself out to
        // the full width with Spacers); `ListBottomBar` centres it on the
        // card in its own layer, beside "Select" and the completed dot.
        HStack(spacing: 6) {
            glyphButton(intent: previous, symbol: "chevron.left", enabled: page > 0, label: "Previous page")
            Text("\(page + 1)/\(totalPages)")
                .font(.caption2)
                .monospacedDigit()
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .fixedSize()
            glyphButton(intent: next, symbol: "chevron.right", enabled: page < totalPages - 1, label: "Next page")
        }
    }

    private func glyphButton<I: AppIntent>(
        intent: I, symbol: String, enabled: Bool, label: String
    ) -> some View {
        Button(intent: intent) {
            Image(systemName: symbol)
                .font(.caption2.weight(.semibold))
                // Real visual size, then a taller invisible frame purely for
                // the tap target — see `segmentBleed`'s doc.
                .frame(width: 26, height: 18)
                .frame(width: 26, height: 18 + 2 * bleed)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, -bleed)
        .foregroundStyle(.secondary)
        .opacity(enabled ? 1 : 0.3)
        .disabled(!enabled)
        .accessibilityLabel(Text(label))
    }
}

/// The state shown when the Keychain has no server URL / token.
///
/// Never a spinner and never an error dump: an unconfigured widget is a setup
/// problem, and the only useful thing it can say is where to go fix it.
///
/// Tap target follows the same family split as everywhere else (2026-09-23,
/// the background-tap fix — see `ios/CLAUDE.md`'s tap-targets note):
/// `compact` (systemSmall, and the Lock Screen families' own custom signed-out
/// text) is glanceable-only with nothing else to hit, so the whole card stays
/// a `.widgetURL`. Non-compact (systemMedium/systemLarge's signed-out state,
/// used by all three list views) drops the card-wide link — the message TEXT
/// itself becomes a `Link` instead, mirroring the header title `Link` every
/// other systemMedium/systemLarge state uses. Found via the same audit as the
/// rest of that fix: this struct was the one remaining background tap target
/// on those two families, only reachable while signed out.
struct WidgetSignedOutView: View {
    var compact = false

    var body: some View {
        if compact {
            content.widgetURL(WidgetLink.dashboard)
        } else {
            content
        }
    }

    @ViewBuilder
    private var content: some View {
        VStack(spacing: compact ? 4 : 8) {
            Image(systemName: "person.crop.circle.badge.questionmark")
                .font(compact ? .body : .title2)
                .foregroundStyle(.secondary)
            if compact {
                Text("Open OpenTask to sign in")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .minimumScaleFactor(0.8)
            } else {
                Link(destination: WidgetLink.dashboard) {
                    Text("Open OpenTask to sign in")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .minimumScaleFactor(0.8)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// The all-clear state. §7.3 calls the empty day out as explicitly desired —
/// it is a result, so it gets a real illustration rather than blank space.
struct WidgetEmptyView: View {
    let symbol: String
    let message: String
    var compact = false

    var body: some View {
        VStack(spacing: compact ? 4 : 8) {
            Image(systemName: symbol)
                .font(compact ? .body : .title2)
                .foregroundStyle(.green.opacity(0.85))
            Text(message)
                .font(compact ? .caption2 : .footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Small right-aligned "as of 9:31am" footnote for cache-backed renders.
struct StalenessNote: View {
    let fetchedAt: Date

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "arrow.clockwise")
                .font(.system(size: 8))
            Text(WidgetTheme.staleNote(fetchedAt))
                .font(.system(size: 9))
        }
        .foregroundStyle(.tertiary)
    }
}

extension View {
    /// Where a tap on a Medium/Large widget's BACKGROUND goes — its own
    /// section, not wherever the app happened to be left.
    ///
    /// iOS always opens the app for a tap that lands on no Link or Button;
    /// there is no way to make it do nothing. With no `.widgetURL` the app
    /// simply came forward on its last tab, so a background tap on Reminders
    /// could land on the dashboard (Trent, 2026-09-23: "If we can't stop
    /// tapping on the widget from opening the app, can we at least make it so
    /// that each widget… takes you to the correct tab?"). So on iOS the
    /// background opens the widget's own section — the same place its header
    /// title links to. macOS gets nothing: there a background click really is
    /// inert, which is what he asked for first.
    @ViewBuilder
    func backgroundTapOpens(_ url: URL) -> some View {
        #if os(iOS)
        self.widgetURL(url)
        #else
        self
        #endif
    }
}

// MARK: - Tasks snooze mode / bulk select (2026-09-23, Phase 2)
//
// Mockups: `bulk.png` (bulk select) / `bulk2.png` (snooze mode's "All
// overdue" bottom bar), option 1 — bulk2.png's own further revision ADDING a
// "select all" toggle to select mode's bottom-left slot was tried and then
// REJECTED (Trent, 2026-09-23 review: "'All overdue' in snooze mode covers
// everything-at-once, and Select is for hand-picked sets" — see
// `SelectModeActionBar`'s doc), so select mode's bottom-left is simply empty
// here. Tasks-only — see `WidgetStore`'s "Tasks snooze mode / bulk select"
// section doc for why these views take no `kind` parameter the way
// `CompletedDotToggle`'s intent does.

/// Shared capsule chrome for every text-labeled snooze/select-mode action
/// button — factored once so the half-dozen call sites below don't each
/// redeclare the same padding/corner/opacity values. `isPrimary` is the
/// mockup's ONE emphasized action per bar ("Next period", filled indigo);
/// everything else ("+1h", "Cancel"-adjacent pills) stays the neutral
/// secondary fill.
private struct ActionPill<I: AppIntent>: View {
    let intent: I
    let label: String
    var systemImage: String? = nil
    var isPrimary = false
    var isEnabled = true

    var body: some View {
        Button(intent: intent) {
            HStack(spacing: 4) {
                if let systemImage {
                    Image(systemName: systemImage).font(.system(size: 10, weight: .semibold))
                }
                Text(label)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .font(.caption2.weight(.semibold))
            .foregroundStyle(isPrimary ? Color.white : Color.primary)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                Capsule().fill(isPrimary ? WidgetTheme.indigoAccent : Color.secondary.opacity(0.18))
            )
            .opacity(isEnabled ? 1 : 0.4)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
    }
}

/// The icon-only circular twin of `ActionPill` — the mockup's "⏭" (snooze to
/// next period) and select-mode's icon-only "✓" (Done).
private struct ActionCircle<I: AppIntent>: View {
    let intent: I
    let systemImage: String
    var isPrimary = false
    var isEnabled = true
    var diameter: CGFloat = 32

    var body: some View {
        Button(intent: intent) {
            Image(systemName: systemImage)
                .font(.system(size: diameter * 0.4, weight: .semibold))
                .foregroundStyle(isPrimary ? Color.white : Color.primary)
                .frame(width: diameter, height: diameter)
                .background(
                    Circle().fill(isPrimary ? WidgetTheme.indigoAccent : Color.secondary.opacity(0.18))
                )
                .opacity(isEnabled ? 1 : 0.4)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
    }
}

/// The header clock toggle — flips Tasks' snooze mode. Same icon-button
/// chrome as `UndoRedoButtons`, tinted indigo when on. Tasks-only and wired
/// to its own intent — see `WidgetStore`'s doc for why it doesn't share a
/// store key with "show completed".
struct SnoozeModeToggle: View {
    let isOn: Bool

    var body: some View {
        Button(intent: ToggleTasksSnoozeModeIntent()) {
            Image(systemName: "clock")
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 5)
                .padding(.vertical, 4)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(isOn ? WidgetTheme.indigoAccent : Color.secondary)
        .accessibilityLabel(Text(isOn ? "Exit snooze mode" : "Snooze mode"))
    }
}

/// Per-row snooze buttons (⏭ circle, +1h pill) replacing the checkbox in
/// snooze mode — mockup: "Each row gets its own ⏭ / +1h." The ⏭ circle
/// disables (dimmed, non-interactive) when `TimeSlotStore` has no cached
/// slots to resolve "next period" from — see `SnoozeTaskRowIntent`'s doc for
/// why this is a client-side computation for the per-row/select-mode path,
/// unlike the "All overdue" bar's server-resolved "next".
struct SnoozeRowButtons: View {
    let taskId: Int

    /// The ⏭ circle's diameter — the floor a snooze-mode row's height is
    /// paged with (`TasksListView.layout(for:)`), so a one-line row never
    /// lets the circle hang past what the pager counted.
    static let height: CGFloat = 32

    var body: some View {
        HStack(spacing: 6) {
            ActionCircle(
                intent: SnoozeTaskRowIntent(taskId: taskId, target: .nextPeriod),
                systemImage: "forward.end.fill",
                isPrimary: true,
                isEnabled: !TimeSlotStore.cachedSlots.isEmpty,
                diameter: Self.height
            )
            .accessibilityLabel(Text("Snooze to next period"))
            ActionPill(intent: SnoozeTaskRowIntent(taskId: taskId, target: .plusOneHour), label: "+1h")
                .accessibilityLabel(Text("Snooze one hour"))
        }
    }
}

/// Select-mode's trailing selection indicator — an outline circle, filled
/// indigo with a checkmark once picked (mockup: "the check-off circle
/// becomes a selection circle").
struct SelectionMarker: View {
    let isSelected: Bool

    var body: some View {
        ZStack {
            Circle().fill(isSelected ? WidgetTheme.indigoAccent : Color.clear)
            Circle().strokeBorder(isSelected ? Color.clear : Color.secondary.opacity(0.5), lineWidth: 1.5)
            if isSelected {
                Image(systemName: "checkmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(.white)
            }
        }
        .frame(width: 22, height: 22)
    }
}

/// Resting mode's bottom-LEFT "Select" entry point — Trent's pick between
/// the two positions the mockup showed side by side: "bottom-left opposite
/// the pager; the thumb-friendly right side stays for check-offs."
///
/// Framed to the bottom row's fixed `height` with its tap target bled half
/// a `rowSpacing` past it (2026-09-24) — it used to pad itself 6pt top and
/// bottom, which made the bottom row taller than anything the list's pager
/// budgeted for (see `ListBottomBar`).
struct SelectEntryButton: View {
    let height: CGFloat

    private var bleed: CGFloat { WidgetTheme.rowSpacing / 2 }

    var body: some View {
        Button(intent: EnterTasksSelectModeIntent()) {
            Text("Select")
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .fixedSize()
                .frame(height: height + 2 * bleed)
                .padding(.trailing, 8)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, -bleed)
    }
}

/// The snooze-mode "All overdue (N)" bottom bar — acts on the WHOLE server-
/// side overdue set via `SnoozeAllOverdueIntent`, not just what's on screen
/// (see that intent's doc). The CALLER hides this entirely when `count == 0`
/// — a bar offering to snooze zero tasks has nothing honest to say.
struct SnoozeAllOverdueBar: View {
    let count: Int
    /// `nil` when `TimeSlotStore` has no cached slots — unlike the per-row/
    /// select-mode buttons, the "Next period" pill here still WORKS (its
    /// target is resolved server-side for the sweep — `slot: "next"` on
    /// `POST /api/tasks/bulk/snooze-overdue`), it just can't preview a time
    /// in its own label.
    let nextPeriodLabel: String?

    var body: some View {
        HStack(spacing: 6) {
            Text("All overdue (\(count)):")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .fixedSize()
            Spacer(minLength: 4)
            ActionPill(
                intent: SnoozeAllOverdueIntent(target: .nextPeriod),
                label: nextPeriodLabel.map { "Next period · \($0)" } ?? "Next period",
                systemImage: "forward.end.fill",
                isPrimary: true
            )
            ActionPill(intent: SnoozeAllOverdueIntent(target: .plusOneHour), label: "+1h")
        }
    }
}

/// The select-mode bottom action bar — "⏭ Next period · +1h · ✓ · Cancel"
/// (`bulk.png`'s layout). Deliberately NO "select all" (Trent, reviewing
/// `bulk2.png`'s revision which had added one: "'All overdue' in snooze mode
/// covers everything-at-once, and Select is for hand-picked sets" — the
/// bottom-left slot "Select" occupied in resting mode is simply empty here,
/// which is also why this bar's own leading edge starts with a `Spacer`
/// rather than a control). `hasSelection` disables every action but Cancel
/// when nothing is picked yet — tapping "Done" on an empty selection would
/// otherwise silently no-op with no explanation.
struct SelectModeActionBar: View {
    let hasSelection: Bool

    /// The icon circles' diameter — with `ActionPill`'s height, what
    /// `TasksListView.bottomHeight(withPager:)` budgets this bar at.
    static let circleDiameter: CGFloat = 28

    var body: some View {
        HStack(spacing: 6) {
            Spacer(minLength: 4)

            ActionCircle(
                intent: SnoozeSelectedTasksIntent(target: .nextPeriod),
                systemImage: "forward.end.fill",
                isPrimary: true,
                isEnabled: hasSelection && !TimeSlotStore.cachedSlots.isEmpty,
                diameter: Self.circleDiameter
            )
            .accessibilityLabel(Text("Snooze selected to next period"))
            ActionPill(
                intent: SnoozeSelectedTasksIntent(target: .plusOneHour), label: "+1h", isEnabled: hasSelection
            )
            .accessibilityLabel(Text("Snooze selected one hour"))
            ActionCircle(
                intent: CompleteSelectedTasksIntent(), systemImage: "checkmark",
                isEnabled: hasSelection, diameter: Self.circleDiameter
            )
            .accessibilityLabel(Text("Complete selected"))
            Button(intent: CancelTasksSelectModeIntent()) {
                Text("Cancel")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }
}
