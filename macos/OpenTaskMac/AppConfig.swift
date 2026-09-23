import Observation
import WebKit

/// Shared app state for the Mac app — whether a server is configured, and the
/// APNs device token once one arrives.
///
/// The macOS counterpart of `ios/OpenTask/AppConfig.swift`. Same Keychain keys
/// (`serverURL`, `bearerToken`) and the same contract, minus everything that
/// only exists on a phone: no WatchConnectivity, no launch-environment seeding
/// (there is no simulator to drive), no UIApplication.
@Observable
final class AppConfig {
    static let shared = AppConfig()

    var isConfigured: Bool
    var serverURL: String

    /// Persisted in UserDefaults rather than the Keychain because it is not a
    /// secret and it changes on the system's schedule, not the user's.
    var deviceToken: String? {
        didSet { UserDefaults.standard.set(deviceToken, forKey: "apnsDeviceToken") }
    }

    private init() {
        #if DEBUG
        // Debug-only hook, mirroring the iPhone app's: seed credentials from
        // the launch environment so a build can be verified against a server
        // without anyone typing into the setup form. Release builds always go
        // through SetupView.
        //
        //   OPENTASK_SEED_SERVER_URL=https://tasks-dev.example.com \
        //     build/.../OpenTaskMac.app/Contents/MacOS/OpenTaskMac
        //
        let env = ProcessInfo.processInfo.environment
        // The other half of the hook: wipe the stored credentials at launch.
        // The Keychain lives outside the app's container, so deleting the
        // container does NOT unconfigure the app — this is the way back to a
        // clean first run. `OPENTASK_RESET=1 .../OpenTaskMac`
        if env["OPENTASK_RESET"] == "1" {
            KeychainHelper.delete(key: "serverURL")
            KeychainHelper.delete(key: "bearerToken")
            print("[OpenTask] Reset server config from launch environment")
        }
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
        self.isConfigured = !(url ?? "").isEmpty
        self.deviceToken = UserDefaults.standard.string(forKey: "apnsDeviceToken")
    }

    /// Save the server URL and mark the app configured. The Bearer token is
    /// provisioned later, by the web app, once the user logs in — see
    /// `WebViewHost.Coordinator`'s `provisionToken` bridge message.
    func configure(serverURL: String) {
        KeychainHelper.save(key: "serverURL", value: serverURL)
        self.serverURL = serverURL
        self.isConfigured = true
    }

    /// Full disconnect: unregister the device, clear web data, reset the Keychain.
    /// Every server call is best-effort — disconnecting must work with the
    /// server unreachable, which is one of the reasons someone disconnects.
    func disconnect() async {
        if let token = deviceToken {
            do {
                try await APIClient.shared.unregisterDevice(token: token)
                print("[OpenTask] Device unregistered from server")
            } catch {
                print("[OpenTask] Device unregister failed (continuing): \(error)")
            }
        }

        await MainActor.run {
            let dataStore = WKWebsiteDataStore.default()
            let dataTypes = WKWebsiteDataStore.allWebsiteDataTypes()
            dataStore.fetchDataRecords(ofTypes: dataTypes) { records in
                dataStore.removeData(ofTypes: dataTypes, for: records) {
                    print("[OpenTask] Cleared WebView data")
                }
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
