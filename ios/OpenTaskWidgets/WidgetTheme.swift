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
    /// still waiting" segment fill (`RemindersWidgetViews.swift`) and the
    /// "show completed" eye toggle's ON state (`ShowCompletedToggle` below).
    /// ONE named constant, not two independently-chosen indigo literals, so
    /// the Reminders and Track/Tasks/Quotas widgets' accent can never drift
    /// apart pixel-by-pixel across files (2026-09-23, per coordinator note
    /// keeping this consistent with the parallel Quotas widget rebuild).
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

    /// One line of a `.subheadline` row title, at the reader's text size.
    ///
    /// Two jobs, both in `ReminderRow` / `TaskRow`:
    ///
    /// 1. It centres the row's marker on the title's FIRST line. The marker's
    ///    36pt hit target is taller than a line of text, so without this a
    ///    two-line row floats its circle down between the two lines instead of
    ///    beside the words it acts on.
    /// 2. It RESERVES the row's lines, which is what lets `ViewThatFits` count
    ///    rows correctly. ViewThatFits compares each candidate's *ideal* height,
    ///    and a Text's ideal height is one unwrapped line however long the
    ///    string is — so without a reserved height every candidate measured as
    ///    if nothing wrapped, the tallest was chosen, and the card then squeezed
    ///    the wrapping right back out of it. That was the truncation Trent saw.
    ///
    /// Read from the platform's own font metrics rather than hardcoded so it
    /// tracks the system text size, and rounded UP so a reserved two lines is
    /// never a hair short of two real ones (which would silently cost the
    /// second line).
    ///
    /// **macOS**: `NSFont` has no `.lineHeight` property the way `UIFont`
    /// does — `NSLayoutManager().defaultLineHeight(for:)` is AppKit's
    /// equivalent (the same value the layout system itself uses to lay out a
    /// line of that font). This is still the load-bearing per-LINE unit on
    /// both platforms; neither multiplies it by a flat `titleLineLimit`
    /// anymore — see the "row-height truthing" note on `measuredLineCount`
    /// below. **Measured**: at the platform's default text size this is
    /// 14pt on macOS vs. 18pt on iOS (an iPhone 17 Pro simulator, default
    /// Dynamic Type size — see the 2026-09-23 addendum below for why that
    /// number, not the ~20pt first assumed, is what actually matters for
    /// row height on iOS).
    static var rowTitleLineHeight: CGFloat {
        #if os(iOS)
        ceil(UIFont.preferredFont(forTextStyle: .subheadline).lineHeight)
        #else
        let font = NSFont.preferredFont(forTextStyle: .subheadline, options: [:])
        return ceil(NSLayoutManager().defaultLineHeight(for: font))
        #endif
    }

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
    // GitHub issues" / "Do my PRI"), and text truncating at TWO lines when
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
    /// text measurement (`NSString.boundingRect`), not a guess. Ceil'd: a
    /// fractional line still costs the row a whole line of height.
    static func measuredLineCount(for text: String, maxWidth: CGFloat, font: PlatformFont) -> Int {
        guard maxWidth > 0, !text.isEmpty else { return 1 }
        let bounds = (text as NSString).boundingRect(
            with: CGSize(width: maxWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font],
            context: nil
        )
        return max(1, Int(ceil(bounds.height / rowTitleLineHeight)))
    }

    /// The single-line width `text` needs in `font` — used to reserve room
    /// for `TaskRow`'s due-time label before measuring the title's own
    /// wrap, since the title's real column is narrower whenever a due time
    /// is shown beside it.
    static func measuredWidth(for text: String, font: PlatformFont) -> CGFloat {
        guard !text.isEmpty else { return 0 }
        return ceil((text as NSString).size(withAttributes: [.font: font]).width)
    }

    /// The subheadline font at a given weight, matching what `.font(.subheadline)
    /// .fontWeight(weight)` renders — weight has to match what's actually
    /// drawn (P3/P4 titles render `.semibold`, which is measurably wider)
    /// or a title near the wrap boundary undercounts its lines.
    static func subheadlineFont(weight: Font.Weight) -> PlatformFont {
        #if os(iOS)
        let pointSize = UIFont.preferredFont(forTextStyle: .subheadline).pointSize
        return UIFont.systemFont(ofSize: pointSize, weight: uiWeight(weight))
        #else
        let pointSize = NSFont.preferredFont(forTextStyle: .subheadline, options: [:]).pointSize
        return NSFont.systemFont(ofSize: pointSize, weight: nsWeight(weight))
        #endif
    }

    /// The caption2 font, for measuring `TaskRow`'s due-time label.
    static var caption2Font: PlatformFont {
        #if os(iOS)
        UIFont.preferredFont(forTextStyle: .caption2)
        #else
        NSFont.preferredFont(forTextStyle: .caption2, options: [:])
        #endif
    }

    #if os(iOS)
    private static func uiWeight(_ weight: Font.Weight) -> UIFont.Weight {
        switch weight {
        case .semibold: return .semibold
        case .medium: return .medium
        default: return .regular
        }
    }
    #else
    private static func nsWeight(_ weight: Font.Weight) -> NSFont.Weight {
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
    // (`TaskRow.measuredLines`, via `plainString`) build from — the same
    // discipline `measuredLineCount`'s own doc insists on elsewhere in this
    // file: a row's reserved height must measure the SAME string it renders,
    // or `ViewThatFits` silently mismeasures and a title clips or gets an
    // extra blank line.

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
    /// `ShowCompletedToggle`'s ON state use), dimmed to `0.85` since a due
    /// label sits beside body text far more often than a slot strip segment
    /// does and doesn't need the fully saturated version.
    static let dueDayWordTint = indigoAccent.opacity(0.85)

    /// The styled `Text` for wherever a task's due time shows (`TaskRow`,
    /// `TasksSmallView`) — builds on `dueLabelParts` so the day-word tint and
    /// the overdue-red rule can never drift between call sites. Built via
    /// `Text` concatenation (`+`), not a nested `HStack`, so it composes
    /// inline with a `.firstTextBaseline` `HStack` the way a single `Text`
    /// would.
    static func dueLabelText(for task: TaskDTO, now: Date = Date()) -> Text {
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
            text = text.map { $0 + Text(" ") + timeText } ?? timeText
        }
        return text ?? Text("")
    }

    // MARK: - List paging (2026-09-23, "show completed"'s divider-aware pages)

    /// Page boundaries for a combined open+divider+done list — shared by
    /// `RemindersListView.pagedReminders` and `TasksListView.pagedTasks` via
    /// a generic `isDivider` predicate rather than a common item protocol
    /// (the two lists' item enums are private to their own files, matching
    /// this file's established "duplicate the view, share the math" split —
    /// see `TasksListView.shouldMeasureRealWidth`'s identical precedent).
    ///
    /// Never lets the "DONE · N" divider be the LAST item of a page when
    /// there is at least one done row after it — Trent's review of the
    /// first cut: "never let 'DONE · N' be the last item on a page... if
    /// the first done row spills, the divider moves to the next page too."
    /// A naive uniform `rows`-per-page slice can land the divider at the
    /// very end of a page with nothing under it (the done rows all pushed
    /// to the next page, which then starts with no divider of its own) —
    /// an orphaned section header. This walks the list building one page
    /// at a time and, whenever the item that would end a page is the
    /// divider AND something still follows it, backs that page off by one
    /// row so the divider carries at least its first done row along with
    /// it onto the NEXT page instead.
    ///
    /// Only ever WITHDRAWS a row from a page's tail, never adds one back,
    /// so a page can be one row narrower than `rows` exactly at that
    /// boundary — never wider. Since the list has at most one divider,
    /// this can only trigger once, so it adds at most one extra page
    /// versus uniform slicing.
    static func pageBoundaries<Item>(
        for items: [Item], rows: Int, isDivider: (Item) -> Bool
    ) -> [Range<Int>] {
        guard rows > 0, !items.isEmpty else { return [0..<items.count] }
        var pages: [Range<Int>] = []
        var index = 0
        while index < items.count {
            var end = min(index + rows, items.count)
            if end > index, end < items.count, isDivider(items[end - 1]) {
                end -= 1
            }
            // Degenerate floor: `rows == 1` (the smallest `ViewThatFits`
            // candidate) can never keep a divider paired with a done row
            // no matter what — there is no room. Rather than loop forever
            // backing off to `index`, let the divider stand alone on its
            // own page; the next page then starts with its done rows,
            // still divider-less but at least not empty.
            if end <= index { end = index + 1 }
            pages.append(index..<end)
            index = end
        }
        return pages
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

/// The "show completed" eye toggle (2026-09-23), left of `UndoRedoButtons` in
/// the Reminders/Tasks `systemLarge` headers (mockup option A: completed
/// items sit at the bottom of the card, Trent's pick). Self-contained and
/// keyed by an arbitrary `kind` string (`WidgetStore.showCompleted(for:)` /
/// `ToggleShowCompletedIntent`), so a parallel branch building the Track
/// widget's own eye toggle can reuse this exact view — and its storage —
/// without either branch's change colliding with the other's.
///
/// `systemLarge` only — the call sites gate it (mirroring `UndoRedoButtons`'
/// own systemMedium/Large split doc): a systemMedium card has no header
/// height, and no row budget, to spare on a DONE section at all (see
/// `WidgetTheme.compactRowSpacing`'s "6pt costs a whole row" doc).
struct ShowCompletedToggle: View {
    let kind: String
    let isOn: Bool

    /// `eye.slash` (secondary) off, `eye` (indigo, `WidgetTheme.
    /// indigoAccent`) on — matched to the parallel Quotas widget rebuild's
    /// own eye toggle for the same affordance across all three kinds, per
    /// coordinator note (2026-09-23). Deliberately NOT `eye`/`eye.fill`
    /// (this view's first-drafted pair): "slashed" reads as "hidden, tap to
    /// reveal" more clearly than a plain outline does, and the indigo tint
    /// on ON is what makes an active toggle visually distinct from
    /// `UndoRedoButtons`' plain secondary-gray icons beside it, not just a
    /// filled-vs-outline glyph difference.
    var body: some View {
        Button(intent: ToggleShowCompletedIntent(kind: kind)) {
            Image(systemName: isOn ? "eye" : "eye.slash")
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 5)
                .padding(.vertical, 4)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(isOn ? WidgetTheme.indigoAccent : Color.secondary)
        .accessibilityLabel(Text(isOn ? "Hide completed" : "Show completed"))
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
/// once a card's real content outgrows even the tallest `ViewThatFits`
/// candidate (`RemindersListView.card`/`TasksListView.card`).
///
/// `page`/`totalPages` are 0-based internally, shown 1-based, and computed
/// by the CALLER from whichever candidate actually won — this view is dumb
/// chrome, the same division of labor as `ChevronPager`.
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
        HStack(spacing: 6) {
            Spacer(minLength: 0)
            glyphButton(intent: previous, symbol: "chevron.left", enabled: page > 0, label: "Previous page")
            Text("\(page + 1)/\(totalPages)")
                .font(.caption2)
                .monospacedDigit()
                .foregroundStyle(.tertiary)
            glyphButton(intent: next, symbol: "chevron.right", enabled: page < totalPages - 1, label: "Next page")
            Spacer(minLength: 0)
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
