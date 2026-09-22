import SwiftUI

/// OpenTask for macOS.
///
/// A small native app — one window over the PWA, a real menu bar, and APNs
/// notifications with action buttons. Explicitly NOT a Mac Catalyst port of
/// `ios/`: see `macos/README.md` for what that would have cost and why this
/// exists instead.
@main
struct OpenTaskMacApp: App {
    @NSApplicationDelegateAdaptor(MacAppDelegate.self) private var appDelegate

    static let mainWindowID = "opentask-main"

    var body: some Scene {
        // `Window`, not `WindowGroup`: one OpenTask window, not a pile of them.
        // It also leaves ⌘N free for New Task, and gives a notification tap
        // exactly one window to bring forward instead of a guess.
        Window("OpenTask", id: Self.mainWindowID) {
            RootView()
                .frame(minWidth: 420, minHeight: 480)
                .registeringWindowOpener()
        }
        .defaultSize(width: 1180, height: 860)
        .commands { OpenTaskCommands() }
    }
}

/// Wraps the window's content so it can register the "reopen the window"
/// action. `openWindow` only exists in the SwiftUI environment, but a
/// notification arriving with the window closed needs it from AppKit — so the
/// action is captured here once and held by `WebViewManager`.
private struct WindowOpener: ViewModifier {
    @Environment(\.openWindow) private var openWindow

    func body(content: Content) -> some View {
        content.task {
            WebViewManager.shared.openMainWindow = {
                openWindow(id: OpenTaskMacApp.mainWindowID)
            }
        }
    }
}

extension View {
    func registeringWindowOpener() -> some View {
        modifier(WindowOpener())
    }
}
