import SwiftUI

/// Bulk-snooze sheet, opened from the Tasks page's "All overdue (N)" banner.
/// Two options, mirroring the notification action set and the phone app's
/// clock button: snooze the whole overdue set to the next time slot, or by a
/// flat +1 hour. Both hit `POST /api/tasks/bulk/snooze-overdue` — the SAME
/// server-side set the notification/clock-button paths act on (P0-P2 always,
/// P3 only once nothing lower is left, P4 never — see `bulkSnooze()`), not
/// merely the tasks currently visible on this page.
struct BulkSnoozeSheetView: View {
    @ObservedObject var model: WatchViewModel
    @Binding var isPresented: Bool

    private var nextPeriodLabel: String {
        guard let date = WatchSlotLogic.nextPeriodDate() else { return "Next period" }
        return "Next period · \(WatchFormatting.dueLine(for: date))"
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                Text("Snooze \(model.overdueTasks.count) overdue")
                    .font(.headline)
                    .multilineTextAlignment(.center)

                Button {
                    model.bulkSnoozeOverdueNextPeriod()
                    isPresented = false
                } label: {
                    Text(nextPeriodLabel)
                        .frame(maxWidth: .infinity)
                }
                .tint(WatchTheme.accent)

                Button {
                    model.bulkSnoozeOverduePlusHour()
                    isPresented = false
                } label: {
                    Text("+1 hour")
                        .frame(maxWidth: .infinity)
                }
                .tint(.gray)

                Text("High and Urgent items are never bulk-snoozed.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, 4)
        }
    }
}
