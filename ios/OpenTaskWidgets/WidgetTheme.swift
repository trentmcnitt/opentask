import AppIntents
import SwiftUI
import UIKit
import WidgetKit

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

    // MARK: - Track (§5)

    /// Track's palette sits deliberately OUTSIDE the priority scale above.
    ///
    /// §5: pace "renders but never alarms" — a quota that has slipped behind
    /// must never turn orange or red, because being 1/3 into a weekly quota on
    /// Tuesday is information, not an emergency, and per L1 a low count late in
    /// the period may only mean *unlogged*. So there is exactly one calm tint
    /// for in-progress and green for met, and the only thing pace is allowed to
    /// move is the position of a small neutral tick.
    static let trackTint = Color.teal
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
    /// Read from UIKit rather than hardcoded so it tracks the system text size,
    /// and rounded UP so a reserved two lines is never a hair short of two real
    /// ones (which would silently cost the second line).
    static var rowTitleLineHeight: CGFloat {
        ceil(UIFont.preferredFont(forTextStyle: .subheadline).lineHeight)
    }

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

    static func task(_ id: Int) -> URL {
        URL(string: "\(scheme)://task/\(id)") ?? dashboard
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

/// The state shown when the Keychain has no server URL / token.
///
/// Never a spinner and never an error dump: an unconfigured widget is a setup
/// problem, and the only useful thing it can say is where to go fix it.
struct WidgetSignedOutView: View {
    var compact = false

    var body: some View {
        VStack(spacing: compact ? 4 : 8) {
            Image(systemName: "person.crop.circle.badge.questionmark")
                .font(compact ? .body : .title2)
                .foregroundStyle(.secondary)
            Text("Open OpenTask to sign in")
                .font(compact ? .caption2 : .footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .widgetURL(WidgetLink.dashboard)
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
