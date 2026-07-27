import AppIntents
import SwiftUI
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
    /// Name of the page this chevron lands on. Rendered only where the layout
    /// affords it (see `ChevronPager.showsLabels`).
    var label: String?
    /// False when there is nothing further this way — §8: "chevrons must
    /// telegraph their edges", so a dead chevron dims and stops responding
    /// rather than looking live and doing nothing.
    var enabled = true

    /// ~10 chars: a slot or project name still reads ("Early morn…"), and two
    /// of them plus the glyphs still fit a systemLarge header beside the title.
    private var shortLabel: String? {
        guard let label, !label.isEmpty else { return nil }
        return label.count > 10 ? String(label.prefix(9)) + "…" : label
    }

    var body: some View {
        Button(intent: intent) {
            HStack(spacing: 2) {
                if direction == .previous { glyph }
                if let shortLabel {
                    Text(shortLabel)
                        .font(.caption2)
                        .lineLimit(1)
                }
                if direction == .next { glyph }
            }
            // 40pt MINIMUM hit target (HIG says 44, but widget headers can't
            // spare that height) — the glyph stays small, the tappable area
            // doesn't. At 22pt these were nearly impossible to hit with a
            // casual tap. `minWidth` rather than a fixed width so a label can
            // widen the target; it never shrinks it.
            .frame(minWidth: 40, minHeight: 40)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
        .opacity(enabled ? 1 : 0.3)
        .disabled(!enabled)
    }

    private var glyph: some View {
        Image(systemName: direction.symbol)
            .font(.caption.weight(.semibold))
    }
}

/// The `‹ ›` pair used by all three widgets to page through slots / projects /
/// quotas.
///
/// It is told about its *ring*, not just its intents (§8, amended 2026-07-27):
///
/// - `hasPrevious`/`hasNext` are false when the ring has nowhere to go (one
///   project, one quota), and the chevron dims out. All three rings currently
///   wrap, so a live ring keeps both chevrons live — wrapping is unambiguous
///   with a handful of pages and beats a dead end the user can't explain.
/// - `previousLabel`/`nextLabel` name the *adjacent* page, so paging is a
///   choice rather than a gamble. They render only when `showsLabels` — pass it
///   in `systemLarge`, where the header has the width, and not in
///   `systemMedium`, where it would crowd out the title.
struct ChevronPager<Previous: AppIntent, Next: AppIntent>: View {
    let previous: Previous
    let next: Next
    var hasPrevious = true
    var hasNext = true
    var previousLabel: String?
    var nextLabel: String?
    var showsLabels = false

    var body: some View {
        // Zero spacing with bare glyphs (the 40pt targets already separate
        // them); a gap once labels are on, or the two page names read as one
        // run-on word — "RemindersOne-offs".
        HStack(spacing: showsLabels ? 10 : 0) {
            ChevronButton(
                intent: previous,
                direction: .previous,
                label: showsLabels ? previousLabel : nil,
                enabled: hasPrevious
            )
            ChevronButton(
                intent: next,
                direction: .next,
                label: showsLabels ? nextLabel : nil,
                enabled: hasNext
            )
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
