import SwiftUI

/// Visual vocabulary for the watchOS app and its Smart Stack widget.
///
/// One accent hue (indigo) for anything interactive/"in progress", green only
/// for "done" — mirrors Trent's UI rule from the phone surfaces (see
/// `WidgetTheme.swift`'s "monochrome chrome, color only where it carries
/// meaning") but is NOT a port of that file: `ios/OpenTaskWidgets` is off
/// limits for this target (other agents are editing it tonight on other
/// branches), so this is a deliberately small, independent re-derivation of
/// the same palette rules for the watch's much smaller canvas.
enum WatchTheme {
    /// The one accent hue. Used for the current slot segment, the "still
    /// waiting" strip fill, and any primary action control.
    static let accent = Color.indigo

    /// "Considered"/complete state — the only other color allowed to carry
    /// meaning on this surface.
    static let done = Color.green

    /// The eight named palette colors a project can carry server-side
    /// (`src/lib/project-colors.ts`). Kept in sync by hand since this target
    /// cannot import `OpenTaskWidgets/WidgetTheme.swift`.
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

    /// Mirrors `PRIORITY_OPTIONS` in `src/lib/priority.ts`. The watch has no
    /// room for a priority glyph, so this only ever drives font weight — "priority
    /// is prominence, not interruption" applies here even more than on the phone.
    static func priorityWeight(_ priority: Int) -> Font.Weight {
        priority >= 3 ? .semibold : .regular
    }
}
