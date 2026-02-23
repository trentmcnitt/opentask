import SwiftUI
import WebKit

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

        // Sync credentials to Watch app
        if let appDelegate = UIApplication.shared.delegate as? AppDelegate {
            appDelegate.sendCredentialsToWatch()
        }
    }

    /// Full disconnect: unregister device, clear WebView data, clear Watch, reset Keychain.
    /// Best-effort on server calls — disconnect succeeds even if the server is unreachable.
    func disconnect() async {
        // 1. Unregister device token from server (best-effort)
        if let token = deviceToken {
            do {
                try await APIClient.shared.unregisterDevice(token: token)
                print("[OpenTask] Device unregistered from server")
            } catch {
                print("[OpenTask] Device unregister failed (continuing): \(error)")
            }
        }

        // 2. Clear WebView cookies/data, Watch credentials, and Keychain (all MainActor)
        await MainActor.run {
            let dataStore = WKWebsiteDataStore.default()
            let dataTypes = WKWebsiteDataStore.allWebsiteDataTypes()
            dataStore.fetchDataRecords(ofTypes: dataTypes) { records in
                dataStore.removeData(ofTypes: dataTypes, for: records) {
                    print("[OpenTask] Cleared WebView data")
                }
            }

            if let appDelegate = UIApplication.shared.delegate as? AppDelegate {
                appDelegate.clearWatchCredentials()
            }

            reset()
        }
    }

    func reset() {
        KeychainHelper.delete(key: "serverURL")
        KeychainHelper.delete(key: "bearerToken")
        self.serverURL = ""
        self.isConfigured = false
    }
}
