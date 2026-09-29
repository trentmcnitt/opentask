import XCTest

/// `WebBridge` — the JavaScript the iOS and macOS apps inject into the web
/// view, and the /login-rescue URL rules they share. The Keychain-reading
/// `tokenFlagsJS()` is never called here (no test seam); its pure
/// `tokenFlagsJS(token:)` half is.
final class WebBridgeTests: XCTestCase {

    // MARK: - jsStringLiteral

    func testNilRendersAsNull() {
        XCTAssertEqual(WebBridge.jsStringLiteral(nil), "null")
    }

    func testPlainStringIsSingleQuoted() {
        XCTAssertEqual(WebBridge.jsStringLiteral("abc12345"), "'abc12345'")
        XCTAssertEqual(WebBridge.jsStringLiteral(""), "''")
    }

    func testQuotesAndBackslashAreEscaped() {
        XCTAssertEqual(WebBridge.jsStringLiteral("it's"), "'it\\'s'")
        XCTAssertEqual(WebBridge.jsStringLiteral("a\\b"), "'a\\\\b'")
        // Backslash first, so an escaped quote isn't double-escaped.
        XCTAssertEqual(WebBridge.jsStringLiteral("\\'"), "'\\\\\\''")
        // Double quotes can't end a single-quoted literal: left as-is.
        XCTAssertEqual(WebBridge.jsStringLiteral("say \"hi\""), "'say \"hi\"'")
    }

    /// The characters JS forbids raw inside a string literal.
    func testLineTerminatorsAreEscaped() {
        XCTAssertEqual(WebBridge.jsStringLiteral("a\nb\rc"), "'a\\nb\\rc'")
        XCTAssertEqual(WebBridge.jsStringLiteral("a\u{2028}b"), "'a\\u2028b'")
        XCTAssertEqual(WebBridge.jsStringLiteral("a\u{2029}b"), "'a\\u2029b'")
    }

    /// The literal goes to `evaluateJavaScript`/a user script, never into
    /// HTML, so `</script>` can't close anything and passes through intact.
    func testScriptCloseTagPassesThroughUnchanged() {
        XCTAssertEqual(WebBridge.jsStringLiteral("</script>"), "'</script>'")
    }

    // MARK: - tokenFlagsJS

    func testTokenFlagsCarryOnlyTheLastEightCharacters() {
        let js = WebBridge.tokenFlagsJS(token: "secret-prefix-ABCD1234")
        XCTAssertTrue(js.contains("window.__OPENTASK_HAS_TOKEN = true;"))
        XCTAssertTrue(js.contains("window.__OPENTASK_TOKEN_PREVIEW = 'ABCD1234';"))
        XCTAssertFalse(js.contains("secret-prefix"))
    }

    func testTokenFlagsWithoutATokenAreFalseAndNull() {
        let js = WebBridge.tokenFlagsJS(token: nil)
        XCTAssertTrue(js.contains("window.__OPENTASK_HAS_TOKEN = false;"))
        XCTAssertTrue(js.contains("window.__OPENTASK_TOKEN_PREVIEW = null;"))
    }

    func testTokenPreviewIsEscaped() {
        let js = WebBridge.tokenFlagsJS(token: "xxxx'abc\\def")
        XCTAssertTrue(js.contains("window.__OPENTASK_TOKEN_PREVIEW = '\\'abc\\\\def';"))
    }

    // MARK: - deviceInfoJS

    func testDeviceInfoCarriesTokenBundleAndEnvironment() {
        let js = WebBridge.deviceInfoJS(token: "a1b2c3")
        XCTAssertTrue(js.hasPrefix("window.__OPENTASK_DEVICE_INFO = { token: 'a1b2c3', bundleId: '"))
        XCTAssertTrue(js.hasSuffix("environment: '\(ApsEnvironment.current)' };"))
    }

    // MARK: - isLoginPath

    func testLoginPathMatchesWithOrWithoutQueryAndTrailingSlash() throws {
        for link in [
            "https://tasks.example.com/login",
            "https://tasks.example.com/login/",
            "https://tasks.example.com/login?callbackUrl=%2Freminders",
        ] {
            XCTAssertTrue(WebBridge.isLoginPath(try XCTUnwrap(URL(string: link))), link)
        }
    }

    func testOtherPathsAreNotLogin() throws {
        XCTAssertFalse(WebBridge.isLoginPath(nil))
        for link in [
            "https://tasks.example.com/",
            "https://tasks.example.com/login-help",
            "https://tasks.example.com/api/login",
            "https://tasks.example.com/reminders?next=/login",
        ] {
            XCTAssertFalse(WebBridge.isLoginPath(try XCTUnwrap(URL(string: link))), link)
        }
    }

    // MARK: - resumePath

    private func login(_ query: String) throws -> URL {
        try XCTUnwrap(URL(string: "https://tasks.example.com/login\(query)"))
    }

    func testSameOriginCallbackUrlIsTrusted() throws {
        let url = try login("?callbackUrl=%2F%3Ftask%3D5%26highlight%3D1")
        XCTAssertEqual(
            WebBridge.resumePath(fromLoginURL: url, wasPreempted: false, fallback: "/fallback"),
            "/?task=5&highlight=1"
        )
    }

    func testMissingCallbackUrlFallsBack() throws {
        XCTAssertEqual(
            WebBridge.resumePath(fromLoginURL: try login(""), wasPreempted: false, fallback: "/quotas"),
            "/quotas"
        )
    }

    /// Only same-origin relative paths: an absolute URL, a protocol-relative
    /// `//host` or a bare word would navigate somewhere the app doesn't own.
    func testOffOriginCallbackUrlsFallBack() throws {
        for query in [
            "?callbackUrl=https%3A%2F%2Fevil.example%2F",
            "?callbackUrl=%2F%2Fevil.example%2Fx",
            "?callbackUrl=reminders",
            "?callbackUrl=",
        ] {
            XCTAssertEqual(
                WebBridge.resumePath(fromLoginURL: try login(query), wasPreempted: false, fallback: "/"),
                "/",
                query
            )
        }
    }

    /// iOS's foreground-resume race: a preempted navigation's callbackUrl names
    /// the OLD page, so the last requested path wins even over a valid one.
    func testPreemptedIgnoresEvenAValidCallbackUrl() throws {
        let url = try login("?callbackUrl=%2Freminders")
        XCTAssertEqual(
            WebBridge.resumePath(fromLoginURL: url, wasPreempted: true, fallback: "/?task=5&highlight=1"),
            "/?task=5&highlight=1"
        )
    }
}
