import SwiftUI

/// The drawing half of `LeanRow` (2026-10-28): the colours, the priority mark
/// after the title, the row's tint and the horizon square — shared by the
/// Tasks widget (iOS and Mac), the watch Tasks page and the Mac menu bar
/// panel, so the three can't drift from each other or from the web's lean
/// row (`src/components/lean-row/`).
enum LeanRowStyle {

    static func color(_ hex: UInt32, alpha: Double = 1) -> Color {
        Color(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: alpha
        )
    }

    private static func pick(_ pair: (light: UInt32, dark: UInt32), _ scheme: ColorScheme) -> Color {
        color(scheme == .dark ? pair.dark : pair.light)
    }

    /// The target's time: blue while ahead, the plum "over" tone once passed
    /// (M1, 2026-10-29 — the web's target chip).
    static func target(_ scheme: ColorScheme, isOverdue: Bool) -> Color {
        pick(LeanRow.targetTimeHex(isOverdue: isOverdue), scheme)
    }

    /// A passed deadline's flag.
    static func passed(_ scheme: ColorScheme) -> Color { pick(LeanRow.passedHex, scheme) }

    /// The row's tint, nil for none.
    static func tint(_ state: LeanRow.State?, _ scheme: ColorScheme) -> Color? {
        guard let state else { return nil }
        let pair = LeanRow.tint(state)
        let tone = scheme == .dark ? pair.dark : pair.light
        return color(tone.hex, alpha: tone.alpha)
    }

    // MARK: - The priority mark

    /// Between the title's last word and the mark: a no-break space, so the
    /// mark wraps WITH that word (the web's `whitespace-nowrap` span).
    static let markJoiner = "\u{00A0}"

    /// The words after the title — joiner and mark — or nil for Medium, Low
    /// and None. The ONE string a pager measures (`WidgetTheme.
    /// measuredLineCount(for:priorityMark:…)`), in `markWeight`.
    static func markSuffix(_ tab: RowCorner.PriorityTab?) -> String? {
        tab.map { markJoiner + $0.text }
    }

    /// The mark's weight, pinned so a semibold title can't change its width.
    static let markWeight: Font.Weight = .bold

    /// `title` followed by High "!" / Urgent "!!" in the web tab's orange /
    /// red, bold, at the title's own size — inside the title's `Text`, so it
    /// is bound to the last word and wraps with it. The web draws a solid
    /// tab with white text there; a `Text` run can't carry a background, and
    /// a rendered tab image would need a per-platform rasteriser for the
    /// watch, so native draws the mark as coloured text (the same symbols,
    /// the same hues).
    static func titleWithMark(_ title: Text, priority: Int) -> Text {
        guard let tab = RowCorner.priorityTab(priority), let suffix = markSuffix(tab) else { return title }
        return title
            + Text(suffix)
            .fontWeight(markWeight)
            .foregroundStyle(color(LeanRow.priorityHex(tab)))
    }

    /// The title's spoken words with the mark: "Pay the fine, High priority"
    /// (a row's own `accessibilityLabel` says this rather than "!").
    static func spokenTitle(_ title: String, priority: Int) -> String {
        guard let tab = RowCorner.priorityTab(priority) else { return title }
        return "\(title), \(tab.name)"
    }
}

/// The row's tint behind a row's own content — bled OUTWARD on the fill shape
/// only (the Tasks widget's selection fill's trick), so the row's measured
/// size never changes with its state.
struct LeanRowTint: ViewModifier {
    let color: Color?
    var horizontal: CGFloat = 6
    var vertical: CGFloat = 4
    var cornerRadius: CGFloat = 6

    func body(content: Content) -> some View {
        content.background {
            if let color {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(color)
                    .padding(.horizontal, -horizontal)
                    .padding(.vertical, -vertical)
            }
        }
    }
}

/// THE HORIZON SQUARE (the web's `DoneControl` / `horizon-square.ts`) at the
/// native size (`LeanRow.squareSize`, 16pt): a solid look is the plain
/// rounded square; Weeks long dashes, Months a dash mid-side, Eventually
/// dots (`LeanRow.sidePattern`, half-point runs on the 8pt sides, so every
/// dash lands on the pixel grid at 2x). Patterned looks draw a darker ink
/// than the plain square (the web's 0.42 against 0.25), because a broken
/// line reads lighter.
struct HorizonSquare: View {
    let look: LeanRow.SquareLook
    /// The plain square's colour; a patterned one draws `patternColor`.
    let color: Color
    let patternColor: Color

    private static let size = CGFloat(LeanRow.squareSize)
    private static let radius = CGFloat(LeanRow.squareRadius)
    private static let stroke = CGFloat(LeanRow.squareStroke)

    var body: some View {
        Group {
            if let side = LeanRow.sidePattern(look) {
                patterned(side: side.map { CGFloat($0) })
            } else {
                RoundedRectangle(cornerRadius: Self.radius, style: .continuous)
                    .strokeBorder(color, lineWidth: Self.stroke)
            }
        }
        .frame(width: Self.size, height: Self.size)
    }

    private func patterned(side: [CGFloat]) -> some View {
        let s = Self.size, r = Self.radius, w = Self.stroke
        let inset = w / 2, far = s - inset
        let style = StrokeStyle(lineWidth: w, lineCap: .butt, dash: side)
        // The four sides, each from one corner's arc to the next, clockwise —
        // so a pattern runs the same way round every side (the web's paths).
        let sides: [(CGPoint, CGPoint)] = [
            (CGPoint(x: r, y: inset), CGPoint(x: s - r, y: inset)),
            (CGPoint(x: far, y: r), CGPoint(x: far, y: s - r)),
            (CGPoint(x: s - r, y: far), CGPoint(x: r, y: far)),
            (CGPoint(x: inset, y: s - r), CGPoint(x: inset, y: r)),
        ]
        let dots = LeanRow.cornerDots(look)
        return ZStack {
            ForEach(0..<4, id: \.self) { i in
                Path { p in
                    p.move(to: sides[i].0)
                    p.addLine(to: sides[i].1)
                }
                .stroke(patternColor, style: style)
            }
            if dots {
                // One stroke-wide dot on each corner's curve (at 45°).
                ForEach(0..<4, id: \.self) { i in
                    let lo: CGFloat = 1, hi = s - 1 - w
                    let origin = [CGPoint(x: lo, y: lo), CGPoint(x: hi, y: lo), CGPoint(x: hi, y: hi), CGPoint(x: lo, y: hi)][i]
                    Rectangle()
                        .fill(patternColor)
                        .frame(width: w, height: w)
                        .position(x: origin.x + w / 2, y: origin.y + w / 2)
                }
            } else {
                Path { p in
                    let rr = r - inset
                    p.addArc(center: CGPoint(x: r, y: r), radius: rr, startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false)
                    p.move(to: CGPoint(x: s - r, y: inset))
                    p.addArc(center: CGPoint(x: s - r, y: r), radius: rr, startAngle: .degrees(270), endAngle: .degrees(360), clockwise: false)
                    p.move(to: CGPoint(x: far, y: s - r))
                    p.addArc(center: CGPoint(x: s - r, y: s - r), radius: rr, startAngle: .degrees(0), endAngle: .degrees(90), clockwise: false)
                    p.move(to: CGPoint(x: r, y: far))
                    p.addArc(center: CGPoint(x: r, y: s - r), radius: rr, startAngle: .degrees(90), endAngle: .degrees(180), clockwise: false)
                }
                .stroke(patternColor, style: StrokeStyle(lineWidth: w, lineCap: .butt))
            }
        }
    }
}

#if DEBUG
// The horizon square's four looks, drawn alone at 4x: no row the Tasks
// widget lists is governed by its horizon (they are all dated), so this is
// the only place they show. Here, not in the widget's files: a widget
// extension can host widget previews only (render it with the app's scheme).
#Preview("Horizon squares") {
    HStack(spacing: 24) {
        ForEach([TaskHorizon.days, .weeks, .months, .eventually], id: \.self) { horizon in
            VStack(spacing: 8) {
                HorizonSquare(
                    look: LeanRow.squareLook(horizon),
                    color: Color.secondary.opacity(0.45),
                    patternColor: Color.secondary.opacity(0.75)
                )
                .scaleEffect(4)
                .frame(width: 64, height: 64)
                Text(horizon.label).font(.caption)
            }
        }
    }
    .padding()
}
#endif
