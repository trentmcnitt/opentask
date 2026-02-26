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
enum KeychainHelper {
    private static let accessGroup = "group.io.mcnitt.opentask"
    private static let service = "io.mcnitt.opentask"

    static func save(key: String, value: String) {
        guard let data = value.data(using: .utf8) else { return }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecAttrAccessGroup as String: accessGroup,
        ]

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
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecAttrAccessGroup as String: accessGroup,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

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
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecAttrAccessGroup as String: accessGroup,
        ]
        let status = SecItemDelete(query as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound {
            print("[OpenTask] Keychain delete failed for \(key): \(status)")
        }
    }
}
