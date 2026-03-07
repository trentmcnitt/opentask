import SwiftUI

/// Main content view — hosts the WKWebView that loads the OpenTask PWA.
///
/// Shows a native error view with Retry/Disconnect buttons if the page
/// fails to load (wrong URL, server unreachable). This prevents the user
/// from being stuck with no way to reconfigure the app.
struct ContentView: View {
    let config = AppConfig.shared
    @State private var navigationError: Error?

    var body: some View {
        if let url = URL(string: config.serverURL) {
            if let error = navigationError {
                ErrorView(
                    serverURL: config.serverURL,
                    error: error,
                    onRetry: { navigationError = nil },
                    onDisconnect: {
                        Task { await AppConfig.shared.disconnect() }
                    }
                )
            } else {
                WebView(url: url, onNavigationError: { error in
                    navigationError = error
                })
                .ignoresSafeArea()
            }
        } else {
            Text("Invalid server URL")
                .foregroundStyle(.secondary)
        }
    }
}

/// Native fallback shown when the WebView fails to load.
private struct ErrorView: View {
    let serverURL: String
    let error: Error
    let onRetry: () -> Void
    let onDisconnect: () -> Void

    @State private var showDisconnectConfirm = false

    var body: some View {
        VStack(spacing: 20) {
            Spacer()

            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 48))
                .foregroundColor(.secondary)

            Text("Unable to Connect")
                .font(.title2)
                .fontWeight(.semibold)

            Text(serverURL)
                .font(.caption)
                .foregroundColor(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .padding(.horizontal, 40)

            Text(error.localizedDescription)
                .font(.callout)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            VStack(spacing: 12) {
                Button(action: onRetry) {
                    Text("Retry")
                        .fontWeight(.medium)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }
                .buttonStyle(.borderedProminent)
                .padding(.horizontal, 40)

                Button(action: { showDisconnectConfirm = true }) {
                    Text("Disconnect")
                        .fontWeight(.medium)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }
                .buttonStyle(.bordered)
                .tint(.red)
                .padding(.horizontal, 40)
            }
            .padding(.top, 8)

            Spacer()
        }
        .confirmationDialog(
            "Disconnect from this server?",
            isPresented: $showDisconnectConfirm,
            titleVisibility: .visible
        ) {
            Button("Disconnect", role: .destructive, action: onDisconnect)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("You'll need to re-enter the server URL to reconnect.")
        }
    }
}
