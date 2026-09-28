import ServiceManagement
import SwiftUI

/// OpenTask → Settings… (⌘,). Launch at login lives here rather than in the
/// menu bar panel (Trent, 2026-09-28); the menu bar item only exists while the
/// app runs, so this is what keeps it there after a restart.
struct MacSettingsView: View {
    @AppStorage(MenuBarPrefs.showKey) private var showInMenuBar = true
    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled
    @State private var loginError: String?

    var body: some View {
        Form {
            Toggle("Show OpenTask in the menu bar", isOn: $showInMenuBar)
            Toggle("Open OpenTask at login", isOn: $launchAtLogin)
                .onChange(of: launchAtLogin) { _, enabled in
                    setLaunchAtLogin(enabled)
                }
            if let loginError {
                Text(loginError).font(.caption).foregroundStyle(.red)
            }
        }
        .formStyle(.grouped)
        .frame(width: 380)
        .fixedSize(horizontal: false, vertical: true)
    }

    private func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            loginError = nil
        } catch {
            loginError = "Couldn't change this: \(error.localizedDescription)"
        }
        // What the system actually did, not what was asked for.
        launchAtLogin = SMAppService.mainApp.status == .enabled
    }
}

enum MenuBarPrefs {
    static let showKey = "showMenuBarItem"
}
