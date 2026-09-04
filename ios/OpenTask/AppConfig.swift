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
    var deviceToken: String? {
        didSet { UserDefaults.standard.set(deviceToken, forKey: "apnsDeviceToken") }
    }

    private init() {
        #if DEBUG
        // Simulator/UI-test hook: seed credentials from the launch environment so
        // automated runs can configure the app without driving the setup UI.
        // Debug builds only — release builds always go through SetupView.
        let env = ProcessInfo.processInfo.environment
        if let seedURL = env["OPENTASK_SEED_SERVER_URL"], !seedURL.isEmpty {
            KeychainHelper.save(key: "serverURL", value: seedURL)
            if let seedToken = env["OPENTASK_SEED_BEARER_TOKEN"], !seedToken.isEmpty {
                KeychainHelper.save(key: "bearerToken", value: seedToken)
            }
            print("[OpenTask] Seeded server config from launch environment")
        }
        #endif

        let url = KeychainHelper.read(key: "serverURL")
        self.serverURL = url ?? ""
        self.isConfigured = url != nil && !url!.isEmpty
        self.deviceToken = UserDefaults.standard.string(forKey: "apnsDeviceToken")
    }

    /// Save server URL and mark as configured. Bearer token is provisioned
    /// automatically after the user logs in via the WebView (see PreferencesProvider).
    func configure(serverURL: String) {
        KeychainHelper.save(key: "serverURL", value: serverURL)
        self.serverURL = serverURL
        self.isConfigured = true
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
