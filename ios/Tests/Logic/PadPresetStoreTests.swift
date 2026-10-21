import XCTest

/// `PadPresetStore`'s pure halves (the cache itself is the real App Group,
/// never touched here — see ios/AGENTS.md § Tests): what the snooze grid
/// draws from a cached `pad_presets` list, and the button words.
final class PadPresetStoreTests: XCTestCase {
    private let custom = [
        PadPresetDTO(time: "07:15", slotId: 3),
        PadPresetDTO(time: "11:30"),
        PadPresetDTO(time: "17:00", slotId: 5),
        PadPresetDTO(time: "21:45"),
    ]

    func testNoCacheGivesTheDefaults() {
        XCTAssertEqual(PadPresetStore.presets(from: nil), PadPresetStore.defaultPresets)
        XCTAssertEqual(PadPresetStore.defaultPresets.map(\.time), ["09:00", "12:00", "16:00", "20:30"])
    }

    func testGarbageGivesTheDefaults() {
        for raw in ["", "not json", "{}", "[]", #"[{"slot_id":null}]"#] {
            XCTAssertEqual(PadPresetStore.presets(from: Data(raw.utf8)), PadPresetStore.defaultPresets, raw)
        }
    }

    func testWrongCountGivesTheDefaults() {
        let three = PadPresetStore.data(for: Array(custom.prefix(3)))
        XCTAssertEqual(PadPresetStore.presets(from: three), PadPresetStore.defaultPresets)
        let five = PadPresetStore.data(for: custom + [PadPresetDTO(time: "08:00")])
        XCTAssertEqual(PadPresetStore.presets(from: five), PadPresetStore.defaultPresets)
    }

    func testAMalformedTimeGivesTheDefaults() {
        for bad in ["24:00", "9:60", "9", "09:5", "ab:cd", ""] {
            var list = custom
            list[2] = PadPresetDTO(time: bad)
            XCTAssertEqual(PadPresetStore.presets(from: PadPresetStore.data(for: list)), PadPresetStore.defaultPresets, bad)
        }
    }

    func testRoundTripKeepsOrderAndLinks() {
        let back = PadPresetStore.presets(from: PadPresetStore.data(for: custom))
        XCTAssertEqual(back, custom)
        XCTAssertEqual(back.map(\.slotId), [3, nil, 5, nil])
    }

    func testDecodesTheServerShape() throws {
        let json = #"[{"slot_id":2,"time":"08:30"},{"slot_id":null,"time":"12:00"},{"slot_id":null,"time":"16:00"},{"slot_id":null,"time":"20:30"}]"#
        let presets = PadPresetStore.presets(from: Data(json.utf8))
        XCTAssertEqual(presets.first, PadPresetDTO(time: "08:30", slotId: 2))
        XCTAssertEqual(presets.map(\.time), ["08:30", "12:00", "16:00", "20:30"])
    }

    func testHourMinute() {
        XCTAssertEqual(PadPresetDTO(time: "20:30").hourMinute?.hour, 20)
        XCTAssertEqual(PadPresetDTO(time: "20:30").hourMinute?.minute, 30)
        XCTAssertEqual(PadPresetDTO(time: "7:05").hourMinute?.hour, 7)
        XCTAssertNil(PadPresetDTO(time: "23:59:00").hourMinute)
    }

    /// The words the hardcoded row drew, whatever the device locale.
    func testLabels() {
        let labels = PadPresetStore.defaultPresets.compactMap(PadPresetStore.label(for:))
        XCTAssertEqual(labels, ["9:00 AM", "12:00 PM", "4:00 PM", "8:30 PM"])
        XCTAssertEqual(PadPresetStore.label(for: PadPresetDTO(time: "00:00")), "12:00 AM")
        XCTAssertEqual(PadPresetStore.label(for: PadPresetDTO(time: "07:15")), "7:15 AM")
        XCTAssertEqual(PadPresetStore.label(for: PadPresetDTO(time: "12:05")), "12:05 PM")
        XCTAssertEqual(PadPresetStore.label(for: PadPresetDTO(time: "23:59")), "11:59 PM")
        XCTAssertNil(PadPresetStore.label(for: PadPresetDTO(time: "25:00")))
    }
}
