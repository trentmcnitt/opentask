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

    /// Overdue. Matches the web app's `text-destructive` (red) used for every
    /// overdue indicator there — `TaskRow`'s left border, `Header`'s overdue
    /// pill, project/due-date chip badges (`src/components/TaskRow.tsx`,
    /// `Header.tsx`, `chip-due-badges.ts`) — never orange/amber, which this
    /// surface briefly (and wrongly) used for the same meaning.
    static let overdue = Color.red

    /// Quotas' Takeback mode (`QuotasPageView`): the armed ⊖ toggle and each
    /// row's "−1". Same value as the phone widget's `WidgetTheme.
    /// takebackTint` — an ACTION color (this tap removes one), not a state
    /// color, so it doesn't compete with indigo "in progress" / green "met".
    static let takebackTint = Color.red

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

    /// A quota row's stripe: its label's `label_config` color (same eight-name
    /// palette as projects), or a faint neutral for an unlabeled quota / a
    /// label with no color / a green label (`WatchQuotaLogic.color(of:)`
    /// already maps green to nil — green means "met" on this surface).
    static func labelColor(_ name: String?) -> Color {
        guard name != nil else { return Color.secondary.opacity(0.35) }
        return projectColor(name)
    }

    /// Mirrors `PRIORITY_OPTIONS` in `src/lib/priority.ts`. The watch has no
    /// room for a priority glyph, so this only ever drives font weight — "priority
    /// is prominence, not interruption" applies here even more than on the phone.
    static func priorityWeight(_ priority: Int) -> Font.Weight {
        priority >= 3 ? .semibold : .regular
    }

    /// `title` followed by the small notes glyph when `hasNotes` (2026-09-25)
    /// — the phone widget's `WidgetTheme.titleText(_:notesGlyphSize:)`,
    /// minus its measurement: the watch page scrolls, so nothing pages by
    /// row height here. Inline after the last word, joined by a no-break
    /// space so it wraps with it; `.footnote` keeps it a step smaller than
    /// the `.body` title while following Dynamic Type; muted, never a
    /// priority color. See `NotesGlyph`.
    static func titleText(_ title: Text, hasNotes: Bool) -> Text {
        guard hasNotes else { return title }
        let glyph = Text(Image(systemName: NotesGlyph.symbol))
            .font(.footnote)
            .fontWeight(.regular)
            .foregroundStyle(.secondary)
        return title + Text("\u{00A0}") + glyph
    }
}
