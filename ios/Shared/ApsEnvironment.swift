import Foundation

/// The APNs environment ("development" = sandbox, "production") this build's
/// push tokens belong to, as reported to the server with every token
/// registration (device tokens and WidgetKit push tokens alike).
///
/// WHY NOT `#if DEBUG`: a token's environment is fixed by the SIGNING
/// entitlement (`aps-environment`, `com.apple.developer.aps-environment` on
/// macOS), not by the build configuration. The Release builds installed
/// straight onto devices are signed with a development profile, so they get
/// SANDBOX tokens. The old `#if DEBUG` switch registered those as
/// "production"; the server pushed to the production host, APNs answered
/// `BadDeviceToken`, and the server deleted the registration — push silently
/// stopped. Hardcoding "development" instead would break the day the app is
/// distributed through TestFlight/the App Store. So read the truth from the
/// provisioning profile embedded in the bundle:
///
/// - iOS / watchOS: `<bundle>/embedded.mobileprovision`
/// - macOS: `<bundle>/Contents/embedded.provisionprofile`
///
/// Extensions (widgets, notification content) carry their own profile inside
/// their `.appex`, and `Bundle.main` is the `.appex` there, so the same lookup
/// works in every target.
///
/// The profile is a CMS-signed envelope around an XML plist; the plist is
/// stored uncompressed, so it is sliced out between `<?xml` and `</plist>`
/// and parsed without needing the Security framework's CMS decoder (which
/// iOS does not expose).
///
/// No profile at all: App Store / TestFlight distribution (iOS strips the
/// profile) → "production". The simulator has no profile either but always
/// gets sandbox tokens → "development".
enum ApsEnvironment {
    static let development = "development"
    static let production = "production"

    /// Resolved once per process; the bundle cannot change underneath us.
    static let current: String = {
        #if targetEnvironment(simulator)
        return development
        #else
        return resolve(profileData: embeddedProfileData())
        #endif
    }()

    /// Pure decision, separated from the file read so it can be unit tested
    /// with synthetic profiles.
    ///
    /// - `nil` (no profile embedded) → "production".
    /// - A profile whose entitlements name an environment → that value.
    /// - A profile present but unreadable, or without the key → "development":
    ///   an embedded profile in these builds means development signing, and
    ///   a sandbox token reported as "production" is exactly the failure this
    ///   type exists to prevent.
    static func resolve(profileData: Data?) -> String {
        guard let data = profileData else { return production }
        return apsEnvironment(inProfile: data) ?? development
    }

    /// The `aps-environment` entitlement from a provisioning profile's bytes,
    /// or nil if the plist can't be found/parsed or doesn't carry the key.
    /// Accepts both the iOS/watchOS key and the macOS-prefixed key.
    static func apsEnvironment(inProfile data: Data) -> String? {
        guard let start = data.range(of: Data("<?xml".utf8)),
              let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex)
        else { return nil }
        let plistData = data.subdata(in: start.lowerBound..<end.upperBound)
        guard let plist = try? PropertyListSerialization.propertyList(
                from: plistData, options: [], format: nil
              ) as? [String: Any],
              let entitlements = plist["Entitlements"] as? [String: Any]
        else { return nil }
        let value = entitlements["aps-environment"]
            ?? entitlements["com.apple.developer.aps-environment"]
        return value as? String
    }

    private static func embeddedProfileData() -> Data? {
        #if os(macOS)
        let url = Bundle.main.bundleURL
            .appendingPathComponent("Contents/embedded.provisionprofile")
        #else
        let url = Bundle.main.bundleURL
            .appendingPathComponent("embedded.mobileprovision")
        #endif
        return try? Data(contentsOf: url)
    }
}
