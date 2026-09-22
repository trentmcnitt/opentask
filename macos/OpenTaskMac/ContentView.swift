import SwiftUI

/// The window's content: setup until a server is configured, then the web app.
///
/// `AppConfig.isConfigured` is read here rather than in the scene so that
/// connecting and disconnecting swap the view in place, in the same window.
struct RootView: View {
    @Bindable private var config = AppConfig.shared

    var body: some View {
        if config.isConfigured {
            ContentView()
        } else {
            SetupView()
        }
    }
}

/// Hosts the web view, and takes over with a native error view when a
/// navigation fails.
///
/// The error view matters more on the Mac than on the phone: this window has
/// no address bar and no tabs, so without it a wrong URL or a server that has
/// moved leaves the user with a blank rectangle and no way back to setup.
struct ContentView: View {
    @Bindable private var config = AppConfig.shared
    @State private var navigationError: Error?

    var body: some View {
        if let url = URL(string: config.serverURL) {
            if let error = navigationError {
                ConnectionErrorView(
                    serverURL: config.serverURL,
                    error: error,
                    onRetry: {
                        navigationError = nil
                        // The web view survived the failure, so a reload beats
                        // rebuilding it — this keeps the back/forward history
                        // and the cookie store warm.
                        WebViewManager.shared.reload()
                    },
                    onDisconnect: { Task { await AppConfig.shared.disconnect() } }
                )
            } else {
                WebViewHost(url: url, onNavigationError: { navigationError = $0 })
            }
        } else {
            ConnectionErrorView(
                serverURL: config.serverURL,
                error: nil,
                onRetry: nil,
                onDisconnect: { Task { await AppConfig.shared.disconnect() } }
            )
        }
    }
}

private struct ConnectionErrorView: View {
    let serverURL: String
    let error: Error?
    let onRetry: (() -> Void)?
    let onDisconnect: () -> Void

    @State private var showDisconnectConfirm = false

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 44))
                .foregroundStyle(.secondary)

            Text(error == nil ? "Invalid Server URL" : "Unable to Connect")
                .font(.title2)
                .fontWeight(.semibold)

            Text(serverURL.isEmpty ? "No server configured" : serverURL)
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)

            if let error {
                Text(error.localizedDescription)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: 420)
            }

            HStack(spacing: 12) {
                if let onRetry {
                    Button("Retry", action: onRetry)
                        .keyboardShortcut(.defaultAction)
                }
                Button("Disconnect…") { showDisconnectConfirm = true }
            }
            .padding(.top, 4)
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
        .confirmationDialog(
            "Disconnect from this server?",
            isPresented: $showDisconnectConfirm
        ) {
            Button("Disconnect", role: .destructive, action: onDisconnect)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("You'll need to re-enter the server URL to reconnect.")
        }
    }
}
