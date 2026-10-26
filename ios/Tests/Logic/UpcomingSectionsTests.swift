import XCTest

/// Upcoming's two sections on native (2026-10-26, native catch-up PR 3;
/// the server's and the web's split of 2026-10-25): `upcoming_section` on
/// the wire and in the caches, the split and its per-section "n of m", a
/// Tomorrow row's words, the Smart Stack card's label, and the widget's
/// section headings against the paging (plain and anchored). Invented titles.
final class UpcomingSectionsTests: WidgetStoreTestCase {

    private func row(_ id: Int, _ state: SegmentTaskDTO.State, _ section: UpcomingSection?) -> SegmentTaskDTO {
        SegmentTaskDTO(task: TaskDTO(id: id, title: "Task \(id)"), state: state, upcomingSection: section)
    }

    // MARK: The wire and the caches

    func testSectionDecodesWithAMissingOrUnknownValueReadingAsLater() throws {
        func decode(_ json: String) throws -> SegmentTaskDTO {
            try JSONDecoder().decode(SegmentTaskDTO.self, from: Data(json.utf8))
        }
        let tomorrow = try decode(#"{"id":1,"title":"A","segment_state":"waiting","upcoming_section":"tomorrow"}"#)
        XCTAssertEqual(tomorrow.upcomingSection, .tomorrow)
        XCTAssertEqual(tomorrow.section, .tomorrow)
        let missing = try decode(#"{"id":2,"title":"B","segment_state":"waiting"}"#)
        XCTAssertNil(missing.upcomingSection)
        XCTAssertEqual(missing.section, .later, "a missing section is Later")
        let unknown = try decode(#"{"id":3,"title":"C","segment_state":"waiting","upcoming_section":"someday"}"#)
        XCTAssertEqual(unknown.section, .later)
    }

    func testSectionSurvivesTheCacheAndAStateChange() throws {
        let rows = [row(1, .waiting, .tomorrow), row(2, .considered, .later), row(3, .waiting, nil)]
        let back = try JSONDecoder().decode([SegmentTaskDTO].self, from: JSONEncoder().encode(rows))
        XCTAssertEqual(back.map(\.upcomingSection), [.tomorrow, .later, nil])
        XCTAssertEqual(rows[0].with(state: .considered).upcomingSection, .tomorrow)
        // No section written for a row that had none (other kinds' rows).
        let raw = try JSONSerialization.jsonObject(with: JSONEncoder().encode(rows[2])) as? [String: Any]
        XCTAssertNil(raw?["upcoming_section"])
    }

    // MARK: The split

    func testSplitAlwaysHasBothSectionsTomorrowFirst() {
        let sections = UpcomingSections.split([
            row(1, .waiting, .later), row(2, .considered, .later), row(3, .deferred, .later),
        ])
        XCTAssertEqual(sections.map(\.section), [.tomorrow, .later])
        XCTAssertEqual(sections[0].countText, "0 of 0")
        XCTAssertTrue(sections[0].isEmpty)
        XCTAssertTrue(sections[0].finished, "an empty section is done from the start: 0 of 0 ✓")
        XCTAssertEqual(sections[1].waiting.map(\.id), [1])
        XCTAssertEqual(sections[1].countText, "2 of 3", "considered and deferred both count as handled")
        XCTAssertFalse(sections[1].finished)
        XCTAssertEqual(sections.map(\.section.title), ["Tomorrow", "Later"])
    }

    func testSplitKeepsTheServersOrderWithinASection() {
        let sections = UpcomingSections.split([
            row(5, .waiting, .tomorrow), row(2, .waiting, .tomorrow), row(9, .waiting, nil), row(1, .considered, .tomorrow),
        ])
        XCTAssertEqual(sections[0].waiting.map(\.id), [5, 2])
        XCTAssertEqual(sections[0].countText, "1 of 3")
        XCTAssertEqual(sections[1].waiting.map(\.id), [9])
        XCTAssertEqual(sections[1].countText, "0 of 1")
    }

    // MARK: A Tomorrow row's words (ruling 2)

    func testTomorrowRowsSayTheTimeAloneWithTheNightWord() throws {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "America/Chicago")!
        func at(_ wall: String) -> String {
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.timeZone = cal.timeZone
            f.dateFormat = "yyyy-MM-dd'T'HH:mm"
            return DateHelpers.formatISO(f.date(from: wall)!)
        }
        let nb = "\u{00A0}", dot = TaskDTO.metaJoiner
        let morning = TaskDTO(id: 1, title: "A", dueAt: at("2026-10-27T09:00"), deadlineAt: at("2026-10-30T17:00"))
        XCTAssertEqual(
            morning.upcomingMeta(calendar: cal, dayStart: "03:00", section: .tomorrow),
            "9:00\(nb)am\(dot)deadline\(nb)Fri\(nb)Oct\(nb)30"
        )
        // Later: the date, as before.
        XCTAssertEqual(
            morning.upcomingMeta(calendar: cal, dayStart: "03:00", section: .later),
            "Tue\(nb)Oct\(nb)27\(dot)deadline\(nb)Fri\(nb)Oct\(nb)30"
        )
        // 1:00 AM after tomorrow's date is tomorrow NIGHT's.
        let night = TaskDTO(id: 2, title: "B", dueAt: at("2026-10-28T01:00"))
        XCTAssertEqual(
            night.upcomingMeta(calendar: cal, dayStart: "03:00", section: .tomorrow), "tomorrow\(nb)night\(nb)1:00\(nb)am"
        )
        // The switch off (midnight): no night.
        XCTAssertEqual(night.upcomingMeta(calendar: cal, dayStart: "00:00", section: .tomorrow), "1:00\(nb)am")
        // Every form says the same time.
        for form in UpcomingMetaForm.allCases {
            XCTAssertEqual(
                night.segmentMeta(segmentHorizon: "upcoming", calendar: cal, upcomingForm: form, dayStart: "03:00", upcomingSection: .tomorrow),
                "tomorrow\(nb)night\(nb)1:00\(nb)am"
            )
        }
    }

    // MARK: The Smart Stack card (ruling 4)

    func testSmartStackCardLabels() {
        let upcoming = TaskSegmentDTO(horizon: "upcoming", tasks: [row(1, .waiting, .tomorrow), row(2, .waiting, .later)])
        XCTAssertEqual(upcoming.cardLabel(for: upcoming.tasks[0]), "Upcoming · Tomorrow")
        XCTAssertEqual(upcoming.cardLabel(for: upcoming.tasks[1]), "Upcoming · Later")
        let days = TaskSegmentDTO(horizon: "days", tasks: [row(3, .waiting, nil)])
        XCTAssertEqual(days.cardLabel(for: days.tasks[0]), "Task queue · Daily")
    }

    // MARK: Headings and the paging

    /// A heading row as the widget pages it: a key, no identity, kept with
    /// the next row (`SegmentListItem.pagedRow`).
    private struct Row {
        let key: String
        let height: CGFloat
        var heading = false
    }

    private let budget: CGFloat = 100
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func paged(_ rows: [Row]) -> [PagedRow] {
        rows.map {
            $0.heading
                ? PagedRow(keys: [$0.key], identities: [], staysWithNext: true)
                : PagedRow(keys: [$0.key], identities: ["task:\($0.key)"])
        }
    }

    private func plain(_ rows: [Row]) -> (Range<Int>) -> [Range<Int>] {
        let heights = rows.map(\.height)
        return { range in
            ListPaging.pages(heights: heights, spacing: 0, budget: self.budget, in: range) { rows[$0].heading }
        }
    }

    private func keys(_ pages: [Range<Int>], _ rows: [Row]) -> [[String]] {
        pages.map { $0.map { rows[$0].key } }
    }

    func testAHeadingNeverEndsAPage() {
        // "Later" would fit at the foot of page 1 (90 + 10): it goes to page 2 with its row.
        let rows = [
            Row(key: "hT", height: 10, heading: true), Row(key: "t1", height: 40), Row(key: "t2", height: 40),
            Row(key: "hL", height: 10, heading: true), Row(key: "l1", height: 40),
        ]
        XCTAssertEqual(keys(plain(rows)(0..<rows.count), rows), [["hT", "t1", "t2"], ["hL", "l1"]])
    }

    func testTwoHeadingsTogetherBothMoveOn() {
        // An empty "Tomorrow" right above "Later", both at a page's foot.
        let rows = [
            Row(key: "a", height: 45), Row(key: "b", height: 35),
            Row(key: "hT", height: 10, heading: true), Row(key: "hL", height: 10, heading: true),
            Row(key: "l1", height: 40),
        ]
        XCTAssertEqual(keys(plain(rows)(0..<rows.count), rows), [["a", "b"], ["hT", "hL", "l1"]])
    }

    /// Anchored (the user tapping on page 2, "Later"): considering its first
    /// row keeps the heading at the top of page 2; emptying Tomorrow's rows
    /// takes its heading along onto the anchored page, never leaving a page
    /// of headings alone.
    func testAnchoredPagingKeepsHeadingsWithTheirRows() throws {
        let start = [
            Row(key: "hT", height: 10, heading: true), Row(key: "t1", height: 40), Row(key: "t2", height: 40),
            Row(key: "hL", height: 10, heading: true), Row(key: "l1", height: 40), Row(key: "l2", height: 40),
            Row(key: "l3", height: 40),
        ]
        let first = AnchoredPaging.layout(
            rows: paged(start), pageKey: "reminders:-14", storedPage: 1, anchor: nil,
            lastTap: nil, now: now, plain: plain(start)
        )
        XCTAssertEqual(keys(first.pages, start), [["hT", "t1", "t2"], ["hL", "l1", "l2"], ["l3"]])
        let anchor = try XCTUnwrap(first.anchor)
        XCTAssertEqual(anchor.firstKey, "hL", "a page can start on a heading, and the anchor names it")

        // l1 considered: page 2 still starts at "Later", l3 moves up within it.
        let lessLater = start.filter { $0.key != "l1" }
        let second = AnchoredPaging.layout(
            rows: paged(lessLater), pageKey: "reminders:-14", storedPage: 1, anchor: anchor,
            lastTap: now, now: now, plain: plain(lessLater)
        )
        XCTAssertEqual(keys(second.pages, lessLater), [["hT", "t1", "t2"], ["hL", "l2", "l3"]])
        XCTAssertEqual(second.page, 1)

        // Every Tomorrow row considered (on another surface): page 1 had only
        // them, so it goes, and its heading joins the anchored page.
        let noTomorrow = lessLater.filter { !["t1", "t2"].contains($0.key) }
        let third = AnchoredPaging.layout(
            rows: paged(noTomorrow), pageKey: "reminders:-14", storedPage: 1, anchor: anchor,
            lastTap: now, now: now, plain: plain(noTomorrow)
        )
        XCTAssertEqual(keys(third.pages, noTomorrow), [["hT", "hL", "l2", "l3"]])
    }
}
