import Foundation

/// Widths for a row of segments sized by what each holds, with a floor — the
/// web's `ReminderSlotBar` flexbox (`flexGrow: total; flexBasis: 0;
/// minWidth`) done by hand, since a widget has no flexbox.
///
/// Each segment's share of the space is proportional to its weight, except
/// that none drops below `minimum`: a segment whose share would be smaller is
/// frozen at the minimum, and the rest share what remains by weight — the
/// same answer flexbox's min-width resolution gives. If even the minimums
/// don't fit, every segment is the same width.
///
/// Pure and Foundation-only, so `OpenTaskLogicTests` covers it
/// (`SegmentWidthsTests`).
enum SegmentWidths {

    static func widths(weights: [Double], available: Double, minimum: Double) -> [Double] {
        guard !weights.isEmpty, available > 0 else { return weights.map { _ in 0 } }
        let count = Double(weights.count)
        if minimum * count >= available { return weights.map { _ in available / count } }

        var frozen = Array(repeating: false, count: weights.count)
        var result = Array(repeating: 0.0, count: weights.count)
        // Each pass freezes every segment whose proportional share falls
        // under the floor; at most `count` passes.
        while true {
            let space = available - Double(frozen.filter { $0 }.count) * minimum
            let weight = zip(weights, frozen).filter { !$0.1 }.map { max($0.0, 0) }.reduce(0, +)
            var newlyFrozen = false
            for index in weights.indices where !frozen[index] {
                let share = weight > 0
                    ? space * max(weights[index], 0) / weight
                    : space / Double(frozen.filter { !$0 }.count)
                if share < minimum {
                    frozen[index] = true
                    newlyFrozen = true
                } else {
                    result[index] = share
                }
            }
            if !newlyFrozen { break }
        }
        for index in weights.indices where frozen[index] { result[index] = minimum }
        return result
    }
}
