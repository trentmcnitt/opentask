import Foundation
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// An inline box `width` points wide and 1pt tall for a MEASURING string —
/// the stand-in for something SwiftUI draws inline (the notes glyph, a quota
/// count's boxes) when the widget pager counts a row's lines
/// (`WidgetTheme.measuredLineCount(for:notesGlyphSize:…)`,
/// `WidgetTextMetrics.promptLines`). Only its width can move a line break; 1pt
/// tall so it never makes a measured line taller than SwiftUI's.
///
/// It carries an IMAGE of that size, not just `bounds` (2026-10-26, the
/// "wee…" in the docs' Medium Reminders shot): on macOS an image-less
/// `NSTextAttachment` ignores its `bounds` width — a 60pt box measured as
/// 1pt — so on the Mac widget (and the screenshot pipeline, which draws the
/// macOS build) a prompt row's boxes measured as nothing, the row was sized
/// one line short, and the label ended "▰▰▱▱▱ wee…". UIKit honours `bounds`.
/// Foundation + UIKit/AppKit only, so `OpenTaskLogicTests` (macOS) pins it.
enum MeasuringBox {
    static func attachment(width: CGFloat) -> NSTextAttachment {
        let box = NSTextAttachment()
        let size = CGSize(width: max(width, 0), height: 1)
        #if os(macOS)
        box.image = NSImage(size: size)
        #endif
        box.bounds = CGRect(origin: .zero, size: size)
        return box
    }
}
