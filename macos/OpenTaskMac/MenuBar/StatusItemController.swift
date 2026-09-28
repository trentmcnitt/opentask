import AppKit
import Combine
import SwiftUI

/// The menu bar item itself: an `NSStatusItem` whose button opens
/// `MenuBarPanel` in a popover.
///
/// AppKit rather than SwiftUI's `MenuBarExtra` (2026-09-28): `MenuBarExtra`
/// draws its label image as a one-colour template, so the red overdue badge
/// (`MenuBarIcon`) never showed. A status item's button draws a non-template
/// image as drawn.
@MainActor
final class StatusItemController: NSObject {

    static let shared = StatusItemController()

    private var statusItem: NSStatusItem?
    private let popover = NSPopover()
    private var cancellables: Set<AnyCancellable> = []
    private var defaultsObserver: NSObjectProtocol?

    func start() {
        popover.behavior = .transient
        popover.animates = false
        popover.contentViewController = NSHostingController(rootView: MenuBarPanel(model: MenuBarModel.shared))

        applyVisibility()
        // Settings' "Show OpenTask in the menu bar" writes this key.
        defaultsObserver = NotificationCenter.default.addObserver(
            forName: UserDefaults.didChangeNotification, object: nil, queue: .main
        ) { _ in
            Task { @MainActor in StatusItemController.shared.applyVisibility() }
        }

        let model = MenuBarModel.shared
        model.$tasks.combineLatest(model.$now, model.$hasLoaded)
            .receive(on: RunLoop.main)
            .sink { _ in
                Task { @MainActor in StatusItemController.shared.updateImage() }
            }
            .store(in: &cancellables)
    }

    private func applyVisibility() {
        let show = UserDefaults.standard.object(forKey: MenuBarPrefs.showKey) as? Bool ?? true
        if show, statusItem == nil {
            let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            item.button?.target = self
            item.button?.action = #selector(togglePopover(_:))
            statusItem = item
            updateImage()
        } else if !show, let item = statusItem {
            popover.performClose(nil)
            NSStatusBar.system.removeStatusItem(item)
            statusItem = nil
        }
    }

    private func updateImage() {
        let model = MenuBarModel.shared
        statusItem?.button?.image = MenuBarIcon.image(count: model.hasLoaded ? model.overdue.count : 0)
    }

    @objc private func togglePopover(_ sender: NSStatusBarButton) {
        if popover.isShown {
            popover.performClose(sender)
        } else {
            // Activate FIRST: a popover from an inactive app doesn't take keys
            // (the quick add field couldn't be typed into), and activating
            // after showing it made the main window key, which closes a
            // transient popover at once.
            NSApp.activate()
            popover.show(relativeTo: sender.bounds, of: sender, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
        }
    }
}
