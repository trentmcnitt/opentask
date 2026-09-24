import SwiftUI

/// Bulk-snooze sheet, opened from the Tasks page's "All overdue (N)" banner.
/// Two options, mirroring the notification action set and the phone app's
/// clock button: snooze the whole overdue set to the next time slot, or by a
/// flat +1 hour. Both hit `POST /api/tasks/bulk/snooze-overdue` — the SAME
/// server-side set the notification/clock-button paths act on (P0-P2 always,
/// P3 only once nothing lower is left, P4 never — see `bulkSnooze()`), not
/// merely the tasks currently visible on this page.
///
/// Shows the server's REAL result after it runs (2026-09-24, coordinator
/// review on PR #60) rather than closing immediately on tap: the endpoint
/// can legitimately snooze fewer tasks than `model.overdueTasks.count`
/// implied (a High task included this round, an Urgent one that never
/// moves), and closing blind would hide exactly the case a user most needs
/// to see — "I tapped the button and it didn't do what I expected."
struct BulkSnoozeSheetView: View {
    @ObservedObject var model: WatchViewModel
    @Binding var isPresented: Bool

    private enum Phase {
        case choosing
        case running
        case result(APIClient.BulkSnoozeResult)
        case failed
    }

    @State private var phase: Phase = .choosing

    private var isRunning: Bool {
        if case .running = phase { return true }
        return false
    }

    /// The sweep resolves "next" server-side from NOW (every task it moves
    /// is overdue), so the label previews the next slot start from now —
    /// `TimeSlotStore.nextPeriodStart`, the server's `nextPeriodStart` twin.
    private var nextPeriodLabel: String {
        guard let date = TimeSlotStore.nextPeriodStart() else { return "Next period" }
        return "Next period · \(WatchFormatting.dueLine(for: date))"
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                switch phase {
                case .choosing, .running:
                    choosingContent
                case .result(let result):
                    resultContent(result)
                case .failed:
                    failedContent
                }
            }
            .padding(.horizontal, 4)
        }
    }

    @ViewBuilder
    private var choosingContent: some View {
        Text("Snooze \(model.overdueTasks.count) overdue")
            .font(.headline)
            .multilineTextAlignment(.center)

        Button {
            run(model.bulkSnoozeOverdueNextPeriod)
        } label: {
            Text(nextPeriodLabel)
                .frame(maxWidth: .infinity)
        }
        .tint(WatchTheme.accent)
        .disabled(isRunning)

        Button {
            run(model.bulkSnoozeOverduePlusHour)
        } label: {
            Text("+1 hour")
                .frame(maxWidth: .infinity)
        }
        .tint(.gray)
        .disabled(isRunning)

        if isRunning {
            ProgressView()
        }

        // Correct rule (docs/TASK-MODEL.md's due-date philosophy): Urgent
        // (P4) is NEVER bulk-snoozed; High (P3) is swept only once nothing
        // lower-priority is left overdue in the same batch — this footer
        // used to say "High and Urgent items are never bulk-snoozed", which
        // is wrong for High (coordinator review, PR #60: a task genuinely
        // does get included on, e.g., the second press of a double snooze).
        Text("Urgent never snoozes · High only if nothing lower is overdue")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
    }

    @ViewBuilder
    private func resultContent(_ result: APIClient.BulkSnoozeResult) -> some View {
        let snoozed = result.tasksAffected > 0

        Image(systemName: snoozed ? "checkmark.circle.fill" : "xmark.circle")
            .font(.title2)
            .foregroundStyle(snoozed ? WatchTheme.done : .secondary)

        Text(snoozed ? "Snoozed \(result.tasksAffected)" : "Nothing to snooze")
            .font(.headline)

        // Only the counts that actually apply this run — a batch with no
        // High or Urgent items shows neither line, so the result reads as
        // clean confirmation rather than a checklist of zeros.
        if result.snoozedHigh > 0 {
            Text("Included \(result.snoozedHigh) High")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        if result.skippedUrgent > 0 {
            Text("\(result.skippedUrgent) Urgent still overdue")
                .font(.caption2)
                .foregroundStyle(WatchTheme.overdue)
        }

        Button("Done") {
            isPresented = false
        }
        .tint(WatchTheme.accent)
        .padding(.top, 4)
    }

    @ViewBuilder
    private var failedContent: some View {
        Image(systemName: "wifi.exclamationmark")
            .font(.title2)
            .foregroundStyle(WatchTheme.overdue)
        Text("Couldn't snooze")
            .font(.subheadline)
        Text("Check your connection and try again.")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
        Button("Close") {
            isPresented = false
        }
        .padding(.top, 4)
    }

    private func run(_ action: @escaping () async -> APIClient.BulkSnoozeResult?) {
        phase = .running
        Task {
            if let result = await action() {
                phase = .result(result)
            } else {
                phase = .failed
            }
        }
    }
}
