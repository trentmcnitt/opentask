import XCTest

/// `ServerURL.normalize`, shared by the iPhone's and the Mac's setup screens.
final class ServerURLTests: XCTestCase {

    func testAddsHttpsWhenNoSchemeWasTyped() {
        XCTAssertEqual(ServerURL.normalize("tasks.example.com"), "https://tasks.example.com")
        XCTAssertEqual(ServerURL.normalize("tasks.example.com:8443"), "https://tasks.example.com:8443")
    }

    func testKeepsATypedScheme() {
        XCTAssertEqual(ServerURL.normalize("https://tasks.example.com"), "https://tasks.example.com")
        XCTAssertEqual(ServerURL.normalize("http://192.168.1.20:3000"), "http://192.168.1.20:3000")
    }

    func testTrimsWhitespaceAndTrailingSlashes() {
        XCTAssertEqual(ServerURL.normalize("  tasks.example.com//  \n"), "https://tasks.example.com")
        XCTAssertEqual(ServerURL.normalize("https://tasks.example.com/"), "https://tasks.example.com")
    }

    func testEmptyStaysEmpty() {
        XCTAssertEqual(ServerURL.normalize("   "), "")
    }
}
