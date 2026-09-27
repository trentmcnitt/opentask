import XCTest

/// `ApsEnvironment` — the APNs environment reported with every push-token
/// registration, read from the embedded provisioning profile rather than
/// `#if DEBUG` (a Release build signed for development gets sandbox tokens).
/// The fixtures are synthetic: a fake binary envelope around a minimal
/// plist, standing in for a CMS-signed profile.
final class ApsEnvironmentTests: XCTestCase {

    /// Wraps `entitlements` (raw plist XML for the dict body) in a
    /// profile-shaped blob: binary bytes before and after the XML, like the
    /// CMS signature around a real profile.
    private func profile(entitlements: String) -> Data {
        let xml = """
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0">
            <dict>
            \t<key>Name</key>
            \t<string>Synthetic Test Profile</string>
            \t<key>Entitlements</key>
            \t<dict>
            \(entitlements)
            \t</dict>
            </dict>
            </plist>
            """
        var data = Data([0x30, 0x82, 0x32, 0xE0, 0x06, 0x09, 0x2A, 0x86, 0x48, 0x00, 0xFF])
        data.append(Data(xml.utf8))
        data.append(Data([0xA0, 0x82, 0x0D, 0x3C, 0x00, 0xFE, 0x2F]))
        return data
    }

    func testNoProfileIsProduction() {
        XCTAssertEqual(ApsEnvironment.resolve(profileData: nil), "production")
    }

    func testDevelopmentProfile() {
        let data = profile(entitlements: "<key>aps-environment</key><string>development</string>")
        XCTAssertEqual(ApsEnvironment.apsEnvironment(inProfile: data), "development")
        XCTAssertEqual(ApsEnvironment.resolve(profileData: data), "development")
    }

    func testProductionProfile() {
        // Ad hoc / enterprise profiles embed a production entitlement.
        let data = profile(entitlements: "<key>aps-environment</key><string>production</string>")
        XCTAssertEqual(ApsEnvironment.resolve(profileData: data), "production")
    }

    func testMacPrefixedKey() {
        let data = profile(
            entitlements: "<key>com.apple.developer.aps-environment</key><string>development</string>"
        )
        XCTAssertEqual(ApsEnvironment.apsEnvironment(inProfile: data), "development")
    }

    func testProfileWithoutKeyFallsBackToDevelopment() {
        let data = profile(entitlements: "<key>get-task-allow</key><true/>")
        XCTAssertNil(ApsEnvironment.apsEnvironment(inProfile: data))
        XCTAssertEqual(ApsEnvironment.resolve(profileData: data), "development")
    }

    func testGarbageProfileFallsBackToDevelopment() {
        let data = Data([0x30, 0x82, 0x00, 0x01, 0x02, 0x03])
        XCTAssertNil(ApsEnvironment.apsEnvironment(inProfile: data))
        XCTAssertEqual(ApsEnvironment.resolve(profileData: data), "development")
    }
}
