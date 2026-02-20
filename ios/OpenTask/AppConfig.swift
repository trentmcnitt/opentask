import SwiftUI

/// Shared app state — whether the app is configured and the device token.
///
/// Uses @Observable (iOS 17+) for reactive SwiftUI updates.
/// Reads initial state from Keychain on init.
@Observable
final class AppConfig {
    static let shared = AppConfig()

    var isConfigured: Bool
    var serverURL: String
    var deviceToken: String?

    private init() {
        let url = KeychainHelper.read(key: "serverURL")
        let token = KeychainHelper.read(key: "bearerToken")
        self.serverURL = url ?? ""
        self.isConfigured = url != nil && token != nil
    }

    func configure(serverURL: String, bearerToken: String) {
        KeychainHelper.save(key: "serverURL", value: serverURL)
        KeychainHelper.save(key: "bearerToken", value: bearerToken)
        self.serverURL = serverURL
        self.isConfigured = true

        // If we already have an APNs token from before setup, register it now
        if let token = deviceToken {
            let bundleId = Bundle.main.bundleIdentifier ?? "io.mcnitt.opentask"
            Task {
                do {
                    try await APIClient.shared.registerDevice(token: token, bundleId: bundleId)
                    print("[OpenTask] Device registered with server (deferred)")
                } catch {
                    print("[OpenTask] Deferred device registration failed: \(error)")
                }
            }
        }
    }

    func reset() {
        KeychainHelper.delete(key: "serverURL")
        KeychainHelper.delete(key: "bearerToken")
        self.serverURL = ""
        self.isConfigured = false
    }
}
