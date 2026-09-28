import AppKit

/// The menu bar item's image: a checklist glyph, with a red badge holding the
/// overdue count when there is one (Trent, 2026-09-28: "a little badge on it
/// for things that are overdue").
///
/// With nothing overdue it is a plain template image, so macOS tints it like
/// every other menu bar icon. With a badge it can't be a template (a template
/// is one colour), so the glyph is drawn in `labelColor` inside a drawing
/// handler — resolved each time the image draws, i.e. in the menu bar's own
/// light or dark appearance — and only the badge is red.
enum MenuBarIcon {

    private static let glyphSize: CGFloat = 13
    private static let badgeHeight: CGFloat = 12
    /// Room around the glyph. The symbol draws a little past its own reported
    /// size, and a status item clips an image at its bounds — so drawn at its
    /// bare size the top of the checkmark disc was cut off (Trent, 2026-09-28).
    private static let inset: CGFloat = 2

    static func image(count: Int) -> NSImage {
        let config = NSImage.SymbolConfiguration(pointSize: glyphSize, weight: .regular)
        guard let glyph = NSImage(systemSymbolName: "checklist", accessibilityDescription: "OpenTask")?
            .withSymbolConfiguration(config)
        else { return NSImage() }

        let glyphBox = NSSize(width: glyph.size.width + 2 * inset, height: glyph.size.height + 2 * inset)
        let text = count > 99 ? "99+" : "\(count)"
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 9, weight: .bold),
            .foregroundColor: NSColor.white,
        ]
        let textSize = (text as NSString).size(withAttributes: attributes)
        let badgeWidth = count > 0 ? max(badgeHeight, ceil(textSize.width) + 6) : 0
        let gap: CGFloat = count > 0 ? 1 : 0
        let height = max(glyphBox.height, badgeHeight)
        let size = NSSize(width: glyphBox.width + gap + badgeWidth, height: height)
        let glyphRect = NSRect(
            x: inset, y: (height - glyph.size.height) / 2,
            width: glyph.size.width, height: glyph.size.height
        )

        // Nothing overdue: a plain template, tinted by macOS like every other
        // menu bar icon.
        guard count > 0 else {
            let image = NSImage(size: size, flipped: false) { _ in
                glyph.draw(in: glyphRect)
                return true
            }
            image.isTemplate = true
            image.accessibilityDescription = "OpenTask"
            return image
        }

        let image = NSImage(size: size, flipped: false) { _ in
            // The glyph, in the menu bar's text colour.
            let tinted = NSImage(size: glyph.size, flipped: false) { rect in
                glyph.draw(in: rect)
                NSColor.labelColor.set()
                rect.fill(using: .sourceAtop)
                return true
            }
            tinted.draw(in: glyphRect)

            // The badge.
            let badgeRect = NSRect(
                x: glyphBox.width + gap, y: (height - badgeHeight) / 2,
                width: badgeWidth, height: badgeHeight
            )
            NSColor.systemRed.setFill()
            NSBezierPath(roundedRect: badgeRect, xRadius: badgeHeight / 2, yRadius: badgeHeight / 2).fill()
            (text as NSString).draw(
                at: NSPoint(
                    x: badgeRect.midX - textSize.width / 2,
                    y: badgeRect.midY - textSize.height / 2
                ),
                withAttributes: attributes
            )
            return true
        }
        image.isTemplate = false
        image.accessibilityDescription = "OpenTask, \(count) overdue"
        return image
    }
}
