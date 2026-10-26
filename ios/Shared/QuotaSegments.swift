import SwiftUI
import CoreGraphics

/// The drawing half of `QuotaCount` (2026-10-13, mockup r4 size S4): a
/// quota's count as N small skewed segments and a period word, "▰▱ today",
/// or its text fallback "3/7 today". Used by every native surface that shows
/// a quota's count inline: the Reminders widget's prompt rows (open and
/// DONE), the Track widget's chips (no word — the section header names the
/// period), the notification checklist's prompt rows and the watch's prompt
/// rows. The web twin is `src/components/QuotaSegments.tsx`.
///
/// WHY A `Text` AND NOT SHAPES. A prompt row's count follows its title in
/// running, wrapping text ("Make sure the battery toggle is / off ▱▱ month")
/// and the widget pager measures that ONE string to size the row. Shapes
/// can't sit inside a `Text`, so the boxes are drawn into small TEMPLATE
/// images (`QuotaSegmentsDrawing`) and joined with `Text(Image)` — the notes
/// glyph's trick (`WidgetTheme.titleText`). Template images take the
/// `Text`'s `foregroundStyle`, so the colors stay semantic (indigo, green,
/// `.secondary`) and follow light/dark without being resolved by hand. The
/// unit can't break: the images (a filled run, an empty run) and their word are joined by word joiners
/// (U+2060), so it wraps to the next line whole.
///
/// THE TWO FORMS. `QuotaCount.chooseForm` decides; a caller with a width to
/// fit (the widget row, which pre-measures) passes the result in, and
/// `QuotaSegments` — the standalone view — lets `ViewThatFits` try the
/// segments first and the text second, so the choice is deterministic for a
/// given width.
enum QuotaSegmentsText {
    /// The colors a count draws with. Defaults are the widgets' own: indigo
    /// (`WidgetTheme.indigoAccent` is `Color.indigo`) per completion, green
    /// (`WidgetTheme.trackMetTint` is `Color.green`) once met.
    struct Palette {
        var fill: Color = .indigo
        var met: Color = .green
        /// The word and the text form once met.
        var metText: Color = .green
    }

    /// The word joiner: no break between the boxes and their word.
    static let joiner = "\u{2060}"

    /// The segments and their word as ONE `Text`. `em` is the HOST font's
    /// point size (the title's, not the word's — the mockup sizes the boxes
    /// in the title's em); `wordSize` the word's. `lead` is extra air before
    /// the first box. `scale` is the display scale the boxes rasterize at.
    static func segments(
        current: Int, target: Int, word: String?, em: CGFloat, wordSize: CGFloat,
        lead: CGFloat = 0, scale: CGFloat, palette: Palette = Palette()
    ) -> Text {
        let geometry = QuotaCount.Geometry(em: em)
        let fills = QuotaCount.fills(current: current, target: target)
        let met = QuotaCount.isMet(current: current, target: target)
        let filled = fills.filter { $0 != .empty }.count
        let empty = fills.count - filled
        let lead = geometry.leadingPad + lead
        let trail = word == nil ? 0 : geometry.wordGap

        var runs: [Text] = []
        if filled > 0 {
            // The filled run ends where the empty run's pitch starts (see
            // `QuotaSegmentsDrawing.run`), or carries the word gap when last.
            let last = empty == 0
            if let image = QuotaSegmentsDrawing.run(
                count: filled, solid: true, geometry: geometry, lead: lead,
                trailing: last ? .overhang(trail) : .pitch, scale: scale
            ) {
                runs.append(Text(image).foregroundStyle(met ? palette.met : palette.fill))
            }
        }
        if empty > 0, let image = QuotaSegmentsDrawing.run(
            count: empty, solid: false, geometry: geometry, lead: filled > 0 ? 0 : lead,
            trailing: .overhang(trail), scale: scale
        ) {
            runs.append(Text(image).foregroundStyle(.secondary))
        }
        // The runs are joined by the word joiner too (2026-10-26): two
        // `Text(Image)`s side by side are a break opportunity, and the drawn
        // unit split there at XXX Large ("Practice the ▰▰" / "▱▱▱ week")
        // while the pager measures it as ONE unbreakable box
        // (`WidgetTextMetrics.promptLines`). Joined, it wraps whole, as
        // measured — and a `.pitch`-trimmed filled run can't end a line.
        var text = runs.enumerated().reduce(Text("")) { text, run in
            run.offset == 0 ? text + run.element : text + Text(joiner) + run.element
        }
        if let word {
            text = text + Text(joiner)
                + Text(word)
                    .font(.system(size: wordSize))
                    .foregroundStyle(met ? AnyShapeStyle(palette.metText) : AnyShapeStyle(.secondary))
        }
        return text
    }

    /// The text form, "3/7 today": the count's own number in the
    /// foreground at medium weight, the rest muted; all green once met. The
    /// spaces are no-break, so it wraps as one unit.
    static func text(
        current: Int, target: Int, word: String?, size: CGFloat, palette: Palette = Palette()
    ) -> Text {
        let met = QuotaCount.isMet(current: current, target: target)
        let rest = "/\(target)" + (word.map { "\u{00A0}\($0)" } ?? "")
        let number = Text("\(current)")
            .font(.system(size: size, weight: .medium))
            .foregroundStyle(met ? AnyShapeStyle(palette.metText) : AnyShapeStyle(.primary))
        let tail = Text(rest)
            .font(.system(size: size))
            .foregroundStyle(met ? AnyShapeStyle(palette.metText) : AnyShapeStyle(.secondary))
        return number + tail
    }

    /// Either form, as `form` says.
    static func count(
        _ form: QuotaCount.Form, current: Int, target: Int, word: String?, em: CGFloat, wordSize: CGFloat,
        lead: CGFloat = 0, scale: CGFloat, palette: Palette = Palette()
    ) -> Text {
        switch form {
        case .segments:
            return segments(
                current: current, target: target, word: word, em: em, wordSize: wordSize,
                lead: lead, scale: scale, palette: palette
            )
        case .text:
            return text(current: current, target: target, word: word, size: wordSize, palette: palette)
        }
    }
}

/// A quota's count as its own view — segments and word, or the text
/// fallback. `ViewThatFits` tries the segments first and the text second
/// (both at their ideal width), so the choice is deterministic for the width
/// it is given; a target above `QuotaCount.maxSegments` is always text. One
/// accessibility element whichever form draws: "1 of 2 today".
struct QuotaSegments: View {
    let current: Int
    let target: Int
    /// `DAILY`/`WEEKLY`/`MONTHLY`/`YEARLY`, or nil.
    let period: String?
    /// The host font's point size — the boxes are sized in it.
    let em: CGFloat
    /// The word and the text form's size; defaults to 0.85em (the mockup's `.qc`).
    var wordSize: CGFloat? = nil
    /// Off where a heading already names the period (the Track chip).
    var showsWord = true
    var palette = QuotaSegmentsText.Palette()
    /// An interval quota's served end, "by Oct 24" (2026-10-16) — the word in
    /// place of `period`'s ("week"), and in the spoken label. Nil at interval 1.
    var periodLabel: String? = nil

    @Environment(\.displayScale) private var displayScale

    private var word: String? {
        showsWord ? QuotaCount.word(period: period, label: periodLabel).map(Self.unbreakable) : nil
    }

    /// "by Oct 24" never splits across lines.
    private static func unbreakable(_ word: String) -> String {
        word.replacingOccurrences(of: " ", with: "\u{00A0}")
    }
    private var size: CGFloat { wordSize ?? em * 0.85 }

    var body: some View {
        Group {
            if QuotaCount.chooseForm(target: target) == .segments {
                ViewThatFits(in: .horizontal) {
                    segments.fixedSize()
                    text.fixedSize()
                }
            } else {
                text.fixedSize()
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(
            QuotaCount.spokenLabel(
                current: current, target: target, period: period, label: periodLabel, withPeriod: showsWord
            )
        ))
    }

    private var segments: Text {
        QuotaSegmentsText.segments(
            current: current, target: target, word: word, em: em, wordSize: size,
            scale: displayScale, palette: palette
        )
    }

    private var text: Text {
        QuotaSegmentsText.text(current: current, target: target, word: word, size: size, palette: palette)
    }
}

/// Rasterizes runs of segments into template masks (alpha only; the `Text`
/// tints them). A run is `count` boxes at the S4 pitch, each a parallelogram
/// skewed −16° with 1.5pt corners, bottom edge on the image's bottom — which
/// is the text baseline when set inline, the mockup's `vertical-align:
/// baseline`.
///
/// Solid boxes are filled. Empty ones get a 1pt outline at 80% and a 20%
/// fill — the mockup's `--segE`/`--segEF` at `opacity .8`, expressed as alpha
/// so one tint (`.secondary`) draws both.
enum QuotaSegmentsDrawing {
    enum Trailing {
        /// The image ends at the next run's first box: exactly one pitch per
        /// box. The skew's overhang past the last box's top edge (0.02em,
        /// under a third of a point at row size) is cut — two images can't
        /// overlap inside a `Text`, and the next box starts in that overhang.
        case pitch
        /// The image ends past the last box's overhang, plus `extra` points.
        case overhang(CGFloat)
    }

    static func run(
        count: Int, solid: Bool, geometry g: QuotaCount.Geometry, lead: CGFloat, trailing: Trailing,
        scale: CGFloat
    ) -> Image? {
        guard count > 0, g.em > 0 else { return nil }
        let scale = max(scale, 1)
        let height = g.segmentHeight
        let pixelWidth = pixelWidth(count: count, geometry: g, lead: lead, trailing: trailing, scale: scale)
        let pixelHeight = Int((height * scale).rounded(.up))
        guard pixelWidth > 0, pixelHeight > 0,
              let context = CGContext(
                data: nil, width: pixelWidth, height: pixelHeight, bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
              )
        else { return nil }
        context.scaleBy(x: scale, y: scale)
        // Snap the boxes' height to whole pixels, bottom on the baseline.
        let boxHeight = CGFloat(pixelHeight) / scale

        for index in 0..<count {
            let x = lead + CGFloat(index) * (g.segmentWidth + g.gap)
            let path = parallelogram(
                x: x, width: g.segmentWidth, height: boxHeight, skew: g.skewOffset, radius: g.cornerRadius
            )
            if solid {
                context.setFillColor(CGColor(gray: 0, alpha: 1))
                context.addPath(path)
                context.fillPath()
            } else {
                context.setFillColor(CGColor(gray: 0, alpha: 0.2))
                context.addPath(path)
                context.fillPath()
                // The outline INSIDE the box: stroke twice the width, clipped
                // to the box, so the box keeps its size.
                context.saveGState()
                context.addPath(path)
                context.clip()
                context.setStrokeColor(CGColor(gray: 0, alpha: 0.8))
                context.setLineWidth(g.border * 2)
                context.addPath(path)
                context.strokePath()
                context.restoreGState()
            }
        }
        guard let image = context.makeImage() else { return nil }
        return Image(decorative: image, scale: scale).renderingMode(.template)
    }

    /// A run image's width in pixels — rounded up to whole pixels, so it is
    /// what the drawn image really advances.
    private static func pixelWidth(
        count: Int, geometry g: QuotaCount.Geometry, lead: CGFloat, trailing: Trailing, scale: CGFloat
    ) -> Int {
        let width: CGFloat
        switch trailing {
        case .pitch: width = lead + CGFloat(count) * (g.segmentWidth + g.gap)
        case .overhang(let extra): width = lead + g.runWidth(count) + extra
        }
        return Int((width * max(scale, 1)).rounded(.up))
    }

    /// The advance of the boxes `QuotaSegmentsText.segments` draws for this
    /// count — every run image's drawn width, leading air and the gap before
    /// the word included, the word itself not. The widget pager measures
    /// with exactly this, so a row is sized for the images it draws.
    static func boxesWidth(
        current: Int, target: Int, hasWord: Bool, em: CGFloat, lead: CGFloat, scale: CGFloat
    ) -> CGFloat {
        let g = QuotaCount.Geometry(em: em)
        let fills = QuotaCount.fills(current: current, target: target)
        let filled = fills.filter { $0 != .empty }.count
        let empty = fills.count - filled
        let lead = g.leadingPad + lead
        let trail = hasWord ? g.wordGap : 0
        let scale = max(scale, 1)
        var pixels = 0
        if filled > 0 {
            pixels += pixelWidth(
                count: filled, geometry: g, lead: lead, trailing: empty == 0 ? .overhang(trail) : .pitch, scale: scale
            )
        }
        if empty > 0 {
            pixels += pixelWidth(
                count: empty, geometry: g, lead: filled > 0 ? 0 : lead, trailing: .overhang(trail), scale: scale
            )
        }
        return CGFloat(pixels) / scale
    }

    /// A parallelogram, bottom edge from `x` to `x + width` at y = 0, top
    /// edge shifted right by `skew`, corners rounded by `radius`.
    private static func parallelogram(
        x: CGFloat, width: CGFloat, height: CGFloat, skew: CGFloat, radius: CGFloat
    ) -> CGPath {
        let bl = CGPoint(x: x, y: 0)
        let br = CGPoint(x: x + width, y: 0)
        let tr = CGPoint(x: x + width + skew, y: height)
        let tl = CGPoint(x: x + skew, y: height)
        let r = min(radius, height / 2, width / 2)
        let path = CGMutablePath()
        path.move(to: CGPoint(x: (bl.x + br.x) / 2, y: 0))
        path.addArc(tangent1End: br, tangent2End: tr, radius: r)
        path.addArc(tangent1End: tr, tangent2End: tl, radius: r)
        path.addArc(tangent1End: tl, tangent2End: bl, radius: r)
        path.addArc(tangent1End: bl, tangent2End: br, radius: r)
        path.closeSubpath()
        return path
    }
}
