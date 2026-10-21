import AppIntents
import SwiftUI
import WidgetKit

/// The Tasks widget's page control (2026-10-12, mockup B-3 "fixed views plus
/// project chip") — `TasksTimeline`'s "Navigation" comment has the why.
///
///     [ Over 6 | Today 5 | Next ]            ( ● Work › )
///
/// - Three FIXED view segments in a 28pt track. They never come or go and
///   never reorder, so a segment is always where the thumb left it. Over
///   target stays at 0, dimmed (still tappable — it lands on "Nothing over
///   target"); its count is the "something went over" signal now that the
///   widget no longer jumps there on its own. Over's count is tinted the
///   over-target hue while it is not the page on screen.
/// - ONE project chip at the trailing edge: "Projects ›" off a project page,
///   the project's own name ("● Work ›") on one. Each tap steps to the next
///   project with something on its page, wrapping (`StepTasksProjectIntent`).
///   It dims when there is nowhere to step to.
///
/// Every control is `Button(intent:)` with a stable page KEY
/// (`JumpToTasksPageIntent(page:)`) or no parameter at all (the chip) —
/// never an index, which would name a different page once the cache moved
/// under a widget drawn earlier.
///
/// TAP TARGETS: every control is `hitHeight` (40pt) tall — the drawn
/// capsule is 28pt and the rest is invisible hit area — and at least 40pt
/// wide. systemLarge bleeds the extra 12pt into the empty row gaps around it
/// (`largeBleed`); systemMedium seats it on the header line, which is 40pt
/// anyway.
struct TasksPageControl: View {
    let entry: TasksEntry
    /// systemMedium: shares its line with Undo/Redo, so it gives up counts
    /// and the chip's words first when the line is short.
    var compact = false
    @Environment(\.colorScheme) private var colorScheme

    /// The tap target's height — see the type's doc.
    static let hitHeight: CGFloat = 40
    /// The drawn capsule's height.
    static let capsuleHeight: CGFloat = 28
    /// How far the systemLarge control reaches into each row gap around it:
    /// it costs the list `hitHeight - 2 * largeBleed` (32pt) of height.
    static let largeBleed: CGFloat = 4
    /// The floor on every control's tap width.
    static let minHitWidth: CGFloat = 40

    var body: some View {
        // Widest first; each later arrangement drops something. The view
        // segments never lose their WORDS. Order of sacrifice: the chip's
        // long name, Today's count, Over's count (the "something went over"
        // signal), and last the project's name (systemMedium has no title,
        // so on a project page the chip is what names it).
        ViewThatFits(in: .horizontal) {
            row(counts: .all, chip: .full)
            row(counts: .all, chip: .short)
            row(counts: .overOnly, chip: .short)
            row(counts: .none, chip: .short)
            row(counts: .none, chip: .glyph)
        }
        .frame(height: Self.hitHeight)
    }

    private enum ChipStyle {
        case full, short, glyph

        /// The most characters of a project's name the chip shows before
        /// an ellipsis — by count rather than a width frame, so the chip
        /// hugs a short name ("Work") and only a long one is cut.
        var nameLimit: Int { self == .full ? 14 : 8 }
    }

    private enum Counts { case all, overOnly, none }

    private func row(counts: Counts, chip: ChipStyle) -> some View {
        HStack(spacing: 6) {
            segments(counts: counts)
                .fixedSize()
            Spacer(minLength: 0)
            projectChip(chip)
        }
    }

    // MARK: View segments

    private func segments(counts: Counts) -> some View {
        HStack(spacing: 0) {
            segment(
                page: WidgetStore.overdueScope, word: "Over",
                count: counts == .none ? nil : entry.overdueTotalCount,
                countTint: WidgetTheme.overTarget(colorScheme),
                // White text on it, so the solid plum (`overTargetBadge`), not
                // the lifted dark-mode text plum.
                selectedFill: WidgetTheme.overTargetBadge(colorScheme),
                dimmed: entry.overdueTotalCount == 0,
                label: "\(TaskWording.overdue), \(entry.overdueTotalCount)"
            )
            segment(
                page: WidgetStore.allProjects, word: "Today",
                count: counts == .all ? entry.todayTotalCount : nil,
                countTint: nil,
                selectedFill: WidgetTheme.indigoAccent,
                dimmed: false,
                label: "Today, \(entry.todayTotalCount)"
            )
            segment(
                page: WidgetStore.upNextScope, word: "Next",
                count: nil,
                countTint: nil,
                selectedFill: WidgetTheme.indigoAccent,
                dimmed: false,
                label: "Up next"
            )
        }
        .background(
            Capsule()
                .fill(Color.secondary.opacity(0.14))
                .frame(height: Self.capsuleHeight)
        )
    }

    private func segment(
        page: Int, word: String, count: Int?, countTint: Color?, selectedFill: Color, dimmed: Bool, label: String
    ) -> some View {
        let selected = entry.scope == page
        // A 0 count says nothing the dimming doesn't; leave it off.
        let shownCount = count.flatMap { $0 > 0 ? $0 : nil }
        var text = Text(word).fontWeight(selected ? .semibold : .regular)
        if let shownCount {
            let number = Text(" \(shownCount)").fontWeight(.semibold)
            text = text + (selected || countTint == nil ? number : number.foregroundColor(countTint))
        }
        return Button(intent: JumpToTasksPageIntent(page: page)) {
            text
                .font(.caption)
                .lineLimit(1)
                .foregroundStyle(selected ? Color.white : Color.primary)
                .padding(.horizontal, 10)
                .frame(minWidth: Self.minHitWidth)
                .frame(height: Self.capsuleHeight)
                .background(Capsule().fill(selected ? selectedFill : Color.clear))
                .opacity(dimmed && !selected ? 0.4 : 1)
                .frame(height: Self.hitHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(label))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    // MARK: Project chip

    private func projectChip(_ style: ChipStyle) -> some View {
        let project = entry.currentProject
        let enabled = entry.nextProjectId != nil
        let tint = project.map { WidgetTheme.projectColor($0.color) }
        return Button(intent: StepTasksProjectIntent()) {
            HStack(spacing: 4) {
                if let tint {
                    Circle().fill(tint).frame(width: 7, height: 7)
                }
                if style != .glyph {
                    // On a project page the chip names it; elsewhere it says
                    // what it steps through. The short form keeps a project's
                    // name (truncated) and drops the generic word.
                    if let project {
                        Text(Self.shortened(project.name, to: style.nameLimit))
                            .fontWeight(.semibold)
                            .lineLimit(1)
                    } else if style == .full {
                        Text("Projects").lineLimit(1)
                    }
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .opacity(enabled ? 1 : 0.4)
            }
            .font(.caption)
            .foregroundStyle(.primary)
            .padding(.horizontal, 10)
            .frame(minWidth: Self.minHitWidth)
            .frame(height: Self.capsuleHeight)
            .background(
                Capsule().strokeBorder((tint ?? Color.secondary).opacity(project == nil ? 0.45 : 0.8), lineWidth: 1)
            )
            .background(Capsule().fill((tint ?? Color.clear).opacity(0.12)))
            .frame(height: Self.hitHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // Off a project page with no project to go to, the whole chip dims;
        // on the only project with anything, the name stays legible and
        // just the chevron dims.
        .opacity(enabled || project != nil ? 1 : 0.4)
        .disabled(!enabled)
        .accessibilityLabel(Text(project.map { "\($0.name). Next project" } ?? "Projects"))
    }

    /// `name` cut to `limit` characters with a trailing ellipsis.
    static func shortened(_ name: String, to limit: Int) -> String {
        name.count <= limit ? name : String(name.prefix(limit - 1)).trimmingCharacters(in: .whitespaces) + "…"
    }
}
