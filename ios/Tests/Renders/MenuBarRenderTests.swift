import AppKit
import SwiftUI
import XCTest

/// Screenshot renders of the Mac menu bar item: its icon (with the overdue
/// badge) on a menu bar strip, and its panel. See `WidgetRenderTests` for the
/// environment and why this is a test bundle. SKIPS without
/// `SCREENSHOTS_WIDGET_DATA`.
///
/// The panel holds a TextField (AppKit-backed), which `ImageRenderer` can't
/// rasterize, so it is drawn by a real `NSHostingView` in an off-screen
/// window instead — at the window's backing scale (2x on a Retina Mac).
@MainActor
final class MenuBarRenderTests: XCTestCase {

    func testRenderMenuBar() throws {
        let env = ProcessInfo.processInfo.environment
        guard let data = env["SCREENSHOTS_WIDGET_DATA"], let out = env["SCREENSHOTS_NATIVE_OUT"],
              let nowText = env["SCREENSHOTS_NOW"], let now = ISO8601DateFormatter().date(from: nowText)
        else {
            throw XCTSkip("Screenshot renders run only from scripts/screenshots/run.sh")
        }
        let dataDir = URL(fileURLWithPath: data)
        let outDir = URL(fileURLWithPath: out)
        try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

        func load<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
            let data = try Data(contentsOf: dataDir.appendingPathComponent("\(name).json"))
            return try JSONDecoder().decode(APIEnvelope<T>.self, from: data).data
        }
        let tasks = try load("tasks", as: TasksPage.self).tasks
        let projects = try load("projects", as: ProjectsPage.self).projects
        let slots = try load("time-slots", as: TimeSlotsPage.self).timeSlots
        let model = MenuBarModel.snapshot(tasks: tasks, projects: projects, slots: slots, now: now)

        var manifest: [[String: Any]] = []
        for (appearanceName, theme) in [(NSAppearance.Name.aqua, "light"), (.darkAqua, "dark")] {
            let appearance = NSAppearance(named: appearanceName)!

            let panelName = "mac-menu-bar-panel-\(theme)"
            try snapshot(MenuBarPanel(model: model), appearance: appearance, to: outDir.appendingPathComponent("\(panelName).png"))
            manifest.append([
                "file": "native/\(panelName).png",
                "shows": "Mac menu bar panel: quick add, overdue tasks, bulk snooze (the Mac app's SwiftUI view)",
                "theme": theme,
                "destinations": ["docs:public/images/ios/\(panelName).png"],
            ])

            let iconName = "mac-menu-bar-icon-\(theme)"
            let icon = MenuBarIcon.image(count: model.overdue.count)
            let strip = HStack(spacing: 14) {
                Image(systemName: "wifi")
                Image(systemName: "battery.100")
                Image(nsImage: icon)
                Text("Tue Sep 15  9:41 AM").font(.system(size: 13))
            }
            .padding(.horizontal, 14)
            .frame(height: 24)
            .background(theme == "dark" ? Color(white: 0.16) : Color(white: 0.93))
            try snapshot(strip, appearance: appearance, to: outDir.appendingPathComponent("\(iconName).png"))
            manifest.append([
                "file": "native/\(iconName).png",
                "shows": "Mac menu bar item with its overdue badge, on a menu bar strip",
                "theme": theme,
                "destinations": ["docs:public/images/ios/\(iconName).png"],
            ])
        }

        let partDir = outDir.deletingLastPathComponent().appendingPathComponent("manifest.parts")
        try FileManager.default.createDirectory(at: partDir, withIntermediateDirectories: true)
        let json = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
        try json.write(to: partDir.appendingPathComponent("menu-bar.json"))
    }

    /// Lay the view out at its ideal size in an off-screen window and save
    /// what AppKit draws.
    private func snapshot<V: View>(_ view: V, appearance: NSAppearance, to url: URL) throws {
        let host = NSHostingView(rootView: view.environment(\.colorScheme, appearance.name == .darkAqua ? .dark : .light))
        host.appearance = appearance
        let size = host.fittingSize
        host.frame = NSRect(origin: .zero, size: size)
        let window = NSWindow(
            contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false
        )
        window.appearance = appearance
        window.contentView = host
        host.layoutSubtreeIfNeeded()
        host.displayIfNeeded()
        // 2x whatever the test host's screen is: a rep with twice the pixels
        // of its point size makes AppKit draw at Retina resolution.
        let scale: CGFloat = 2
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(size.width * scale), pixelsHigh: Int(size.height * scale),
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ) else {
            throw NSError(domain: "renders", code: 3, userInfo: [NSLocalizedDescriptionKey: "no bitmap for \(url.lastPathComponent)"])
        }
        rep.size = size
        host.cacheDisplay(in: host.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else {
            throw NSError(domain: "renders", code: 4, userInfo: [NSLocalizedDescriptionKey: "no PNG for \(url.lastPathComponent)"])
        }
        try png.write(to: url)
    }
}
