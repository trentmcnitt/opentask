import SwiftUI

/// The drawing half of `RowCorner` (2026-10-16): the web row corner's strip
/// (`src/components/RowCorner.tsx`) as one small rounded strip, left to right
///
///     [horizon dot][! / !!]
///
/// — the dot on a muted cell (the web's `bg-muted` tab), the priority tab a
/// solid orange/red cell with white "!"/"!!" (the web's orange-500/red-500,
/// its "icons" text: no room for "High"/"Urgent"). Either part may be absent;
/// with neither, nothing is drawn and `width` is 0.
///
/// The web strip sits flush in the card's top-right corner. A widget row has
/// no card of its own, so the strip rides on the row's FIRST line instead,
/// just before the due label (the Tasks widget) or at the row's trailing top
/// (the watch). Labels only: the web dot opens the horizon menu, here the
/// row's own tap opens the task, where the horizon is changed.
///
/// FIXED SIZES, so the Tasks widget's pager can subtract exactly what is
/// drawn (`width`, the "measure what is drawn" rule) — they don't follow
/// Dynamic Type, like the checkbox square beside them.
struct RowCornerStrip: View {
    let dot: TaskHorizon??
    let tab: RowCorner.PriorityTab?

    /// `dot`: nil = no dot; `.some(nil)` = the unset ring.
    init(dot: TaskHorizon??, tab: RowCorner.PriorityTab?) {
        self.dot = dot
        self.tab = tab
    }

    /// The task's own strip: the dot where `RowCorner.showsHorizonDot`, the
    /// tab where `RowCorner.priorityTab`.
    init(task: TaskDTO) {
        self.dot = RowCorner.showsHorizonDot(task) ? .some(RowCorner.horizon(of: task)) : nil
        self.tab = RowCorner.priorityTab(task.priority)
    }

    static let height: CGFloat = 14
    static let dotCellWidth: CGFloat = 16
    static let cornerRadius: CGFloat = 4

    static func tabWidth(_ tab: RowCorner.PriorityTab) -> CGFloat {
        switch tab {
        case .high: return 14
        case .urgent: return 18
        }
    }

    /// Exactly the strip's drawn width (0 when it draws nothing).
    static func width(dot: Bool, tab: RowCorner.PriorityTab?) -> CGFloat {
        (dot ? dotCellWidth : 0) + (tab.map(tabWidth) ?? 0)
    }

    static func width(for task: TaskDTO) -> CGFloat {
        width(dot: RowCorner.showsHorizonDot(task), tab: RowCorner.priorityTab(task.priority))
    }

    var isEmpty: Bool { dot == nil && tab == nil }

    /// The web's orange-500 / red-500, `PRIORITY_OPTIONS`' hues as fills.
    static func tabColor(_ tab: RowCorner.PriorityTab) -> Color {
        switch tab {
        case .high: return Color(red: 0xF9 / 255, green: 0x73 / 255, blue: 0x16 / 255)
        case .urgent: return Color(red: 0xEF / 255, green: 0x44 / 255, blue: 0x44 / 255)
        }
    }

    var body: some View {
        if !isEmpty {
            HStack(spacing: 0) {
                if let horizon = dot {
                    HorizonDotMark(horizon: horizon)
                        .frame(width: Self.dotCellWidth, height: Self.height)
                        .background(Color.secondary.opacity(0.15))
                        .accessibilityElement()
                        .accessibilityLabel(Text(RowCorner.dotAccessibilityLabel(horizon)))
                }
                if let tab {
                    Text(tab.text)
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .fixedSize()
                        .frame(width: Self.tabWidth(tab), height: Self.height)
                        .background(Self.tabColor(tab))
                        .accessibilityLabel(Text(tab.name))
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous))
            .fixedSize()
        }
    }
}

/// The R1 "perspective dot" (`HorizonDotMark` on the web): one dot that
/// shrinks and fades with distance, a hollow Weeks-size ring for unset.
/// Sizes and opacities are `RowCorner.dotStyle`, drawn in the primary colour
/// at 80% (the web's `text-foreground/80`), so it follows the theme.
struct HorizonDotMark: View {
    let horizon: TaskHorizon?

    var body: some View {
        let style = RowCorner.dotStyle(horizon)
        let diameter = CGFloat(style.radius * 2)
        Group {
            if style.ring {
                Circle()
                    .stroke(Color.primary.opacity(0.8), lineWidth: CGFloat(RowCorner.unsetStroke))
                    // The web strokes the r=2.5 circle on its centre line.
                    .frame(width: diameter, height: diameter)
            } else {
                Circle()
                    .fill(Color.primary.opacity(0.8))
                    .frame(width: diameter, height: diameter)
            }
        }
        .opacity(style.opacity)
        .frame(width: CGFloat(RowCorner.dotBox), height: CGFloat(RowCorner.dotBox))
        .accessibilityHidden(true)
    }
}
