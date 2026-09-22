import Foundation
import Security

/// Keychain wrapper using App Group for sharing between main app and notification content extension.
///
/// All items use `kSecAttrAccessGroup` with the App Group ID so the content extension
/// can read the Bearer token without the main app being active.
///
/// Uses `kSecAttrAccessibleAfterFirstUnlock` so credentials are readable from background
/// contexts (lock screen notification actions, Watch actions, content extension) even when
/// the device is locked. The default (`kSecAttrAccessibleWhenUnlocked`) blocks keychain
/// reads when the device is locked, which silently breaks notification action handlers.
///
/// **macOS (`OpenTaskMac`).** Two things differ on a genuinely native macOS process:
///
///  1. No access group is applied. App Groups on macOS must be team-ID-prefixed and
///     require a provisioning profile, and the Mac app currently ships without one (see
///     `macos/project.yml`). Items therefore belong to the app alone, which is exactly
///     right while the Mac app is the only process reading them. When a macOS extension
///     arrives, give both targets `GEL3VGTUJX.group.io.mcnitt.opentask` and set
///     `accessGroup` for macOS too — it will work, because a profile is a prerequisite
///     for that app group anyway, and a profile is also what switches the code below to
///     the data protection keychain, the only one where access groups mean anything.
///  2. `kSecUseDataProtectionKeychain` is conditional rather than always true — see
///     `hasKeychainEntitlement` below for why, and for what changes when the Mac app
///     finally gets a provisioning profile.
enum KeychainHelper {
    private static let accessGroup = "group.io.mcnitt.opentask"
    private static let service = "io.mcnitt.opentask"

    #if os(macOS)
    /// Whether this binary carries an entitlement that gives it a keychain
    /// access group — which on macOS is what a provisioning profile grants.
    ///
    /// Three keys qualify, and all three are checked because the spelling is a
    /// trap: macOS profiles write `com.apple.application-identifier`, NOT the
    /// bare `application-identifier` that iOS uses (verified against signed
    /// apps on this machine — Xcode, Notes and Claude all carry the prefixed
    /// form). Checking only the iOS spelling would leave this permanently
    /// false, and the app would stay on the legacy keychain even once it was
    /// properly provisioned.
    ///
    /// It decides which keychain to use, and the choice is not cosmetic:
    ///
    /// - **With** the entitlement the data protection keychain works and is the
    ///   right one — it is the only keychain where `kSecAttrAccessGroup` is
    ///   honoured, so it is what a future macOS extension would need to share
    ///   credentials with the app.
    /// - **Without** it every data protection keychain call returns -34018
    ///   (`errSecMissingEntitlement`) — verified, not assumed: a sandboxed
    ///   build with no profile could not save a single item, which left the
    ///   app unable even to remember its server URL. The legacy file-based
    ///   keychain has no such requirement and is used instead.
    ///
    /// Items do not move between the two keychains. Adding a provisioning
    /// profile therefore looks like a one-off "not configured" on the next
    /// launch: the user re-enters the server URL, and the Bearer token
    /// re-provisions itself from the web session.
    private static let hasKeychainEntitlement: Bool = {
        guard let task = SecTaskCreateFromSelf(nil) else { return false }
        let keys = [
            "com.apple.application-identifier",  // macOS provisioning profile
            "application-identifier",            // iOS spelling, checked for safety
            "keychain-access-groups",
        ]
        return keys.contains { key in
            SecTaskCopyValueForEntitlement(task, key as CFString, nil) != nil
        }
    }()
    #endif

    /// The item identity every query shares. Built in one place so the save,
    /// read and delete queries cannot drift apart — a mismatched attribute
    /// here does not error, it just silently fails to find the item.
    private static func baseQuery(key: String) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        #if os(macOS)
        query[kSecUseDataProtectionKeychain as String] = hasKeychainEntitlement
        #else
        query[kSecUseDataProtectionKeychain as String] = true
        query[kSecAttrAccessGroup as String] = accessGroup
        #endif
        return query
    }

    static func save(key: String, value: String) {
        guard let data = value.data(using: .utf8) else { return }

        let query = baseQuery(key: key)

        // Delete existing item first (errSecItemNotFound is expected on first save)
        let deleteStatus = SecItemDelete(query as CFDictionary)
        if deleteStatus != errSecSuccess && deleteStatus != errSecItemNotFound {
            print("[OpenTask] Keychain delete failed for \(key): \(deleteStatus)")
        }

        var addQuery = query
        addQuery[kSecValueData as String] = data
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        if addStatus != errSecSuccess {
            print("[OpenTask] Keychain save failed for \(key): \(addStatus)")
        }
    }

    static func read(key: String) -> String? {
        var query = baseQuery(key: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess, let data = result as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    /// Re-save existing keychain items with `kSecAttrAccessibleAfterFirstUnlock`.
    ///
    /// Items previously saved without an explicit accessibility attribute defaulted to
    /// `kSecAttrAccessibleWhenUnlocked`, which blocks reads when the device is locked
    /// (breaking lock screen notification actions and Watch actions). Call once on app
    /// launch while the device is unlocked — the read succeeds, then save re-writes
    /// with the correct accessibility.
    static func migrateAccessibility(keys: [String]) {
        for key in keys {
            if let value = read(key: key) {
                save(key: key, value: value)
            }
        }
    }

    static func delete(key: String) {
        let query = baseQuery(key: key)
        let status = SecItemDelete(query as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound {
            print("[OpenTask] Keychain delete failed for \(key): \(status)")
        }
    }
}
