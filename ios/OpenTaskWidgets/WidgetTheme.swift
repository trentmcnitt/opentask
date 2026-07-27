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

/// The `‹ ›` pair used by both widgets to page through slots / projects.
///
/// §8: widgets get no swipe gestures, so paging has to be an explicit tap
/// target. The buttons are `.plain` so WidgetKit doesn't draw its default
/// capsule around a glyph that is already a control.
struct ChevronPager<Previous: AppIntent, Next: AppIntent>: View {
    let previous: Previous
    let next: Next

    var body: some View {
        // 40pt hit targets (HIG minimum is 44, but widget headers can't spare
        // that height) — the glyph stays small, the tappable area doesn't.
        // At 22pt these were nearly impossible to hit with a casual tap.
        HStack(spacing: 0) {
            Button(intent: previous) {
                Image(systemName: "chevron.left")
                    .font(.caption.weight(.semibold))
                    .frame(width: 40, height: 40)
                    .contentShape(Rectangle())
            }
            Button(intent: next) {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .frame(width: 40, height: 40)
                    .contentShape(Rectangle())
            }
        }
        .buttonStyle(.plain)
        .foregroundStyle(.secondary)
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
