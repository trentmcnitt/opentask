import SwiftUI

/// The notification checklist's one look (NCL-1, `NotificationChecklist`):
/// the header with its count, the page of rows padded to the page size, the
/// pager (Previous · "2 of 3" · Next), the loading and failure lines, and the row
/// fill. The overdue checklist and the period checklist draw their own rows
/// inside it; everything around the rows is this.
///
/// Every tap here only STAGES (a mark, a page). The request goes out from the
/// notification's action buttons, the only surface iOS guarantees will run.
struct ChecklistFrame<Item: ChecklistItem, RowView: View, SpacerRow: View>: View {
    let title: String
    let state: ChecklistState<Item>
    /// The header's count ("2 of 20 checked", "9 overdue"), worked out by
    /// the caller.
    let count: String?
    /// What the list says when nothing is waiting.
    let emptyText: String
    /// The line under the rows while loading, and after a failed fetch.
    let loadingText: String
    let failedText: String
    let onShowLess: () -> Void
    let onShowMore: () -> Void
    @ViewBuilder let row: (Item) -> RowView
    /// A one-line row, drawn hidden, that pads a short page (NCL-2).
    @ViewBuilder let spacerRow: () -> SpacerRow

    static var rowSpacing: CGFloat { 4 }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            list
        }
        .padding(.horizontal, 12)
        .padding(.top, 12)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "checklist")
                .font(.subheadline)
                .foregroundColor(.secondary)
            Text(title)
                .font(.subheadline.weight(.semibold))
            Spacer()
            if let count {
                Text(count)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
    }

    @ViewBuilder
    private var list: some View {
        if state.isEmpty {
            Text(emptyText)
                .font(.caption)
                .foregroundColor(.secondary)
                .padding(.vertical, 6)
        } else {
            VStack(spacing: Self.rowSpacing) {
                ForEach(state.pageRows, id: \.checklistKey) { item in
                    row(item)
                }
                ForEach(0 ..< state.pageSpacers, id: \.self) { _ in
                    spacerRow().hidden()
                }
                footer
            }
        }
    }

    @ViewBuilder
    private var footer: some View {
        switch state.load {
        case .loading:
            statusLine(loadingText, spinner: true)
        case .failed:
            statusLine(failedText, spinner: false)
        case .loaded:
            if let pageLabel = state.pageLabel {
                // The page in the middle whichever links show: Previous and
                // Next sit at the edges over it, not beside it.
                ZStack {
                    Text(pageLabel)
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .accessibilityLabel("Page \(pageLabel)")
                    HStack {
                        if state.showsLess { pageLink(NotificationWords.previous, action: onShowLess) }
                        Spacer()
                        if state.showsMore { pageLink(NotificationWords.next, action: onShowMore) }
                    }
                }
            }
        }
    }

    private func statusLine(_ text: String, spinner: Bool) -> some View {
        HStack(spacing: 6) {
            if spinner { ProgressView().controlSize(.mini) }
            Text(text)
                .font(.caption)
                .foregroundColor(.secondary)
            Spacer()
        }
        .padding(.top, 2)
    }

    private func pageLink(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.footnote.weight(.medium))
                .foregroundColor(.blue)
                // A finger-sized target around a short word.
                .frame(minWidth: 44, minHeight: 28, alignment: .center)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// A row's fill: green once marked, grey before; the held row (NCL-3) a step
/// stronger in either, so it reads as "the one you pressed" without an icon.
enum ChecklistFill {
    static func color(marked: Bool, held: Bool = false) -> Color {
        (marked ? Color.green : Color.gray).opacity(held ? 0.24 : 0.12)
    }
}
