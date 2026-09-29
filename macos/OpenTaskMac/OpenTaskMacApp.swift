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
                // `onOpenURL` is a View modifier, not a Scene modifier — see
                // ios/OpenTask/OpenTaskApp.swift's identical comment. Required
                // now that OpenTaskMacWidgets exists: WidgetKit hands a tapped
                // widget's URL to the containing app via onOpenURL regardless
                // of whether the scheme is registered in Info.plist (it is
                // deliberately NOT registered here — see README's "No
                // opentask:// URL scheme" note). Without this handler the app
                // opens on a widget tap and lands on nothing, which is the
                // exact "opened but didn't know what to do with it" bug the
                // 2026-09-16 Mac widget session hit on the Designed-for-iPad
                // build — this exists so it doesn't happen again here.
                .onOpenURL { url in
                    handleWidgetLink(url)
                }
        }
        .defaultSize(width: 1180, height: 860)
        .commands { OpenTaskCommands() }

        // The menu bar item (2026-09-28) is AppKit — `StatusItemController`,
        // started by `MacAppDelegate` — not a `MenuBarExtra` scene: see its
        // doc for why.
        Settings {
            MacSettingsView()
        }
    }

    /// Resolve an `opentask://` deep link from OpenTaskMacWidgets to a web path.
    ///
    /// The route table is `DeepLinkRouter` (ios/Shared), shared with the iOS
    /// app — same cases, same fallback — because the widget extension's own
    /// `WidgetLink` enum (`ios/OpenTaskWidgets/WidgetTheme.swift`) always
    /// emits `opentask://`, unchanged between platforms. Uses
    /// `WebViewManager`, not `AppConfig`/`ContentView` directly, so a tap
    /// before the window exists still parks the path and opens one (see
    /// `WebViewManager.navigate(path:)`).
    private func handleWidgetLink(_ url: URL) {
        guard let path = DeepLinkRouter.webPath(for: url) else { return }
        WebViewManager.shared.navigate(path: path)
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
