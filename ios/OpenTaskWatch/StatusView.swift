import SwiftUI

/// Minimal status display for the watchOS companion app.
///
/// The Watch app's only purpose is handling notification actions.
/// This view shows whether the API connection is configured (credentials
/// are read from the shared App Group keychain, set up in the iOS app).
struct StatusView: View {
    private let isConfigured = APIClient.shared.isConfigured
    private let serverURL = APIClient.shared.serverURL

    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                Image(systemName: isConfigured ? "checkmark.circle.fill" : "xmark.circle.fill")
                    .font(.system(size: 36))
                    .foregroundColor(isConfigured ? .green : .red)

                Text(isConfigured ? "Connected" : "Not Connected")
                    .font(.headline)

                if isConfigured, let url = serverURL {
                    Text(url)
                        .font(.caption2)
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }

                Text("Notification actions are handled directly on your Watch.")
                    .font(.caption2)
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)

                if !isConfigured {
                    Text("Open OpenTask on your iPhone to configure.")
                        .font(.caption2)
                        .foregroundColor(.orange)
                        .multilineTextAlignment(.center)
                }
            }
            .padding()
        }
    }
}
