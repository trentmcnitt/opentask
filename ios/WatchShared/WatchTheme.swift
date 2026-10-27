import SwiftUI

/// Visual vocabulary for the watchOS app and its Smart Stack widget.
///
/// One accent hue (indigo) for anything interactive/"in progress", green only
/// for "done" — except the strip's bars and the Smart Stack's circular/corner
/// gauge, which fill in the reminders' purple (`dayBarFilling`, 2026-10-26,
/// the rule every progress indicator follows) — mirrors Trent's UI rule from the phone surfaces (see
/// `WidgetTheme.swift`'s "monochrome chrome, color only where it carries
/// meaning") but is NOT a port of that file: `ios/OpenTaskWidgets` is off
/// limits for this target (other agents are editing it tonight on other
/// branches), so this is a deliberately small, independent re-derivation of
/// the same palette rules for the watch's much smaller canvas.
enum WatchTheme {
    /// The one accent hue. Used for any primary action control, toggles
    /// and the in-progress counts. NOT the strip's fill or the Smart Stack
    /// gauge's since 2026-10-26 (`dayBarFilling`, the reminders' purple).
    static let accent = Color.indigo

    /// "Considered"/complete state — the only other color allowed to carry
    /// meaning on this surface.
    static let done = Color.green

    /// A task segment's teal (2026-10-11, mockup task-segment-colors-2
    /// option 3; the web's and the phone widget's exact values,
    /// `TaskHorizon.segmentColorHex`). The watch is always dark, so the dark
    /// shades: the section TITLE only — since 2026-10-26 the strip bar
    /// fills in `dayBarFilling` like a period's. Upcoming (2026-10-12) is
    /// its own blue-teal (`SegmentKind.colorHex`); only a segment this build
    /// doesn't know falls back to Weeks'.
    static func taskSegment(_ kind: SegmentKind?) -> Color {
        rgb((kind ?? .horizon(.weeks)).colorHex.dark)
    }

    /// Every strip bar's fill while it fills — a period's and a task
    /// segment's alike (2026-10-26, the web's PR #383), and the Smart Stack's
    /// circular/corner gauge (`RingContent`, Trent's ruling the same day):
    /// the reminders' purple, the dark value of the one shared source
    /// (`DayBarColors.fillingHex`, the web's dark `--badge-reminders`).
    /// Not `accent`: buttons, toggles and the other indigo stay indigo.
    static let dayBarFilling = rgb(DayBarColors.fillingHex.dark)

    /// A strip bar's fill once finished: `done`, or the segment's own
    /// finished colour (`SegmentKind.doneColorHex`: the deadlines page
    /// finishes in its teal, #2dd4bf — its bar and its "Nothing today ✓").
    static func dayBarDone(_ kind: SegmentKind?) -> Color {
        guard let hex = kind?.doneColorHex else { return done }
        return rgb(hex.dark)
    }

    /// The faint divider between the period bars and the task bars (#55555b).
    static let stripSeparator = rgb(0x55555B)

    private static func rgb(_ hex: UInt32) -> Color {
        Color(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }

    /// Overdue. Matches the web app's `text-destructive` (red) used for every
    /// overdue indicator there — `TaskRow`'s left border, `Header`'s overdue
    /// pill, project/due-date chip badges (`src/components/TaskRow.tsx`,
    /// `Header.tsx`, `chip-due-badges.ts`) — never orange/amber, which this
    /// surface briefly (and wrongly) used for the same meaning.
    /// 2026-10-11: plum, not red — the web's `--over-target`; Trent wants
    /// nothing about an arrived target to signal that anything is wrong.
    static let overdue = Color(red: 0.78, green: 0.45, blue: 0.74)

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
    /// label with no color / a green label (`QuotaRules.stripeColor(of:labelConfig:)`
    /// already maps green to nil — green means "met" on this surface).
    static func labelColor(_ name: String?) -> Color {
        guard name != nil else { return Color.secondary.opacity(0.35) }
        return projectColor(name)
    }

    /// Mirrors `PRIORITY_OPTIONS` in `src/lib/priority.ts`: the title's weight.
    /// Since 2026-10-16 a Tasks page row also wears the corner strip's
    /// "!"/"!!" for High/Urgent (`RowCornerStrip`); Reminders rows stay
    /// weight-only — "priority is prominence" (§6; it also paces the slot's
    /// one nag, server-side, but never marks a row).
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
