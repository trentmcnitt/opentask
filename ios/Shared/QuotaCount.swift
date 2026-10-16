import Foundation
import CoreGraphics

/// A quota's count as SEGMENTS (2026-10-13, Trent: "I like it" — mockup r4,
/// size S4): N small skewed boxes, one per unit of the target, indigo per
/// completion logged, all green (with the period word) once met, then a short
/// period word: "▰▱ today". The pure half — words, fills, the fit rule and the
/// geometry — kept Foundation-only so `OpenTaskLogicTests` covers it; the
/// drawing is `QuotaSegments.swift`. The web twin is `src/lib/quota-segments.ts`
/// and the words, the fills and the rule match it.
///
/// Plain text ("3/7 today") is the deterministic fallback: above
/// `maxSegments`, or where the segments don't fit (`chooseForm`).
enum QuotaCount {
    /// More segments than this and the count is text: seven boxes stop being
    /// countable at a glance (the web's `MAX_SEGMENTS`).
    static let maxSegments = 6

    enum Form: Equatable { case segments, text }

    /// One segment's look: not yet logged, logged while the quota is still
    /// open, or the quota is met.
    enum Fill: Equatable { case empty, filled, met }

    /// The word after the count: "today", "week", "month", "year" — never
    /// "this week" (the segments already say "so far"). Nil for a quota with
    /// no period. Read from the FREQ — unless the server served an interval
    /// quota's end as `label` ("by Oct 24", 2026-10-16), which is the word
    /// then: "week" would be wrong for a fortnight. The web's
    /// `quotaSegmentWord`.
    ///
    /// The label's spaces come back NO-BREAK: "by Oct 24" wraps as one word
    /// (a prompt row in the Reminders widget drew "by" / "Oct 24" otherwise).
    static func word(period: String?, label: String? = nil) -> String? {
        if let label { return label.replacingOccurrences(of: " ", with: "\u{00A0}") }
        switch period {
        case "DAILY": return "today"
        case "WEEKLY": return "week"
        case "MONTHLY": return "month"
        case "YEARLY": return "year"
        default: return nil
        }
    }

    /// The period in natural words for VoiceOver — "1 of 2 week" is not
    /// something a person says.
    static func spokenPeriod(period: String?, label: String? = nil) -> String? {
        if let label { return label }
        switch period {
        case "DAILY": return "today"
        case "WEEKLY": return "this week"
        case "MONTHLY": return "this month"
        case "YEARLY": return "this year"
        default: return nil
        }
    }

    /// The ONE accessibility label of a count, whichever form it draws:
    /// "1 of 2 today", "1 of 2 this week", "1 of 2 this month"; "1 of 2" with
    /// no period. `withPeriod: false` for a surface whose heading names it
    /// (the Track widget's chips).
    static func spokenLabel(
        current: Int, target: Int, period: String?, label: String? = nil, withPeriod: Bool = true
    ) -> String {
        let count = "\(current) of \(target)"
        guard withPeriod, let words = spokenPeriod(period: period, label: label) else { return count }
        return "\(count) \(words)"
    }

    /// "10/24" from a served `period_last_day` ("2026-10-24") — an interval
    /// quota's end where "by Oct 24" doesn't fit (the Smart Stack card's
    /// 30pt column). Plain string slicing: no calendar, no time zone, so it
    /// can't shift a day. Nil for anything not `yyyy-MM-dd`.
    static func compactDay(_ day: String?) -> String? {
        guard let day else { return nil }
        let parts = day.split(separator: "-")
        guard parts.count == 3, let month = Int(parts[1]), let date = Int(parts[2]) else { return nil }
        return "\(month)/\(date)"
    }

    /// The text form: "3/7 today", or "3/7" with no word. Plain spaces — a
    /// caller that needs it unbreakable swaps them (`QuotaPromptDTO.countText`).
    static func text(current: Int, target: Int, word: String?) -> String {
        let count = "\(current)/\(target)"
        guard let word else { return count }
        return "\(count) \(word)"
    }

    /// Met: the count reached its target (over it included).
    static func isMet(current: Int, target: Int) -> Bool { current >= max(1, target) }

    /// One fill per unit of the target. A met quota is ALL green — even when
    /// it got there by overflow ("3/2" draws two green segments) — so "met" is
    /// a colour flip, not a few pixels of length. A 1× quota is one segment.
    static func fills(current: Int, target: Int) -> [Fill] {
        let n = max(1, target)
        if current >= n { return Array(repeating: .met, count: n) }
        return (0..<n).map { $0 < current ? .filled : .empty }
    }

    /// THE FIT RULE — the web's `chooseQuotaCountForm`, the one place a count
    /// decides between segments and text:
    ///
    /// 1. More than `maxSegments` → text, wherever it sits.
    /// 2. No width to fit into (`available` nil: a count in a column of its
    ///    own) → segments.
    /// 3. The segments (with their word) fit in `available` → segments.
    /// 4. They don't, but the text does → text.
    /// 5. Neither fits → segments; the unit is unbreakable and wraps to the
    ///    next line whole.
    ///
    /// Exact comparison, no slack.
    static func chooseForm(
        target: Int, available: CGFloat? = nil, segmentsWidth: CGFloat? = nil, textWidth: CGFloat? = nil
    ) -> Form {
        if target > maxSegments { return .text }
        guard let available, let segmentsWidth, let textWidth else { return .segments }
        if segmentsWidth <= available { return .segments }
        if textWidth <= available { return .text }
        return .segments
    }

    /// The S4 segment geometry, in points, for a host font of `em` points —
    /// the mockup's `--h:0.45em; --w:0.65em; --g:0.11em; --b:1px`, skewed
    /// −16°, radius 1.5px.
    struct Geometry: Equatable {
        let em: CGFloat

        var segmentWidth: CGFloat { 0.65 * em }
        var segmentHeight: CGFloat { 0.45 * em }
        var gap: CGFloat { 0.11 * em }
        /// The empty segment's outline (1pt, whatever the size).
        var border: CGFloat { 1 }
        var cornerRadius: CGFloat { 1.5 }
        /// How far the top edge sits right of the bottom edge: skewX(−16°).
        var skewOffset: CGFloat { segmentHeight * tan(16 * .pi / 180) }
        /// Air before the boxes and between them and the word (the web's
        /// `ml-[0.05em]` and `mr-[0.32em]`).
        var leadingPad: CGFloat { 0.05 * em }
        var wordGap: CGFloat { 0.32 * em }

        /// The width `n` boxes take, overhang of the skew included.
        func runWidth(_ n: Int) -> CGFloat {
            guard n > 0 else { return 0 }
            return CGFloat(n) * segmentWidth + CGFloat(n - 1) * gap + skewOffset
        }
    }
}
