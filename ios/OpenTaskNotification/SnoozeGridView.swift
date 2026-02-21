import SwiftUI

/// Interactive 4x3 snooze grid matching the web Quick Action Panel layout.
///
/// Row 1: Preset times (gray) — snap to next occurrence of that wall-clock time
/// Row 2: Increments (green) — +1 min, +30 min, +1 hr, +1 day
/// Row 3: Decrements (amber) — -5 min, -30 min, -1 hr, -1 day
///
/// Tapping a button updates `workingDueAt` and fires `onGridSelection` so the
/// NotificationViewController can update the action button labels dynamically.
struct SnoozeGridView: View {

    let taskTitle: String
    let originalDueAt: String
    let overdueCount: Int

    /// Called when the user taps a grid button. Passes the new working ISO date string.
    var onGridSelection: (String) -> Void

    /// Called when the dirty state changes (preview bar appears/disappears), so the
    /// view controller can update preferredContentSize to avoid clipping.
    var onDirtyStateChanged: ((Bool) -> Void)?

    @State private var workingDueAt: String
    @State private var isDirty = false

    init(
        taskTitle: String,
        originalDueAt: String,
        overdueCount: Int,
        onGridSelection: @escaping (String) -> Void,
        onDirtyStateChanged: ((Bool) -> Void)? = nil
    ) {
        self.taskTitle = taskTitle
        self.originalDueAt = originalDueAt
        self.overdueCount = overdueCount
        self.onGridSelection = onGridSelection
        self.onDirtyStateChanged = onDirtyStateChanged
        self._workingDueAt = State(initialValue: originalDueAt)
    }

    // MARK: - Grid Data

    private struct PresetButton: Identifiable {
        let id: String
        let label: String
        let hour: Int
        let minute: Int
    }

    private struct IncrementButton: Identifiable {
        let id: String
        let label: String
        let minutes: Int?
        let days: Int?
    }

    private let presets: [PresetButton] = [
        PresetButton(id: "p-9", label: "9:00 AM", hour: 9, minute: 0),
        PresetButton(id: "p-12", label: "12:00 PM", hour: 12, minute: 0),
        PresetButton(id: "p-16", label: "4:00 PM", hour: 16, minute: 0),
        PresetButton(id: "p-20", label: "8:30 PM", hour: 20, minute: 30),
    ]

    private let increments: [IncrementButton] = [
        IncrementButton(id: "i-1", label: "+1 min", minutes: 1, days: nil),
        IncrementButton(id: "i-30", label: "+30 min", minutes: 30, days: nil),
        IncrementButton(id: "i-60", label: "+1 hr", minutes: 60, days: nil),
        IncrementButton(id: "i-1d", label: "+1 day", minutes: nil, days: 1),
    ]

    private let decrements: [IncrementButton] = [
        IncrementButton(id: "d-5", label: "-5 min", minutes: -5, days: nil),
        IncrementButton(id: "d-30", label: "-30 min", minutes: -30, days: nil),
        IncrementButton(id: "d-60", label: "-1 hr", minutes: -60, days: nil),
        IncrementButton(id: "d-1d", label: "-1 day", minutes: nil, days: -1),
    ]

    // MARK: - Body

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Task header
            headerSection

            // Resolved time (shown when grid is dirty)
            if isDirty {
                resolvedTimeSection
            }

            // 4x3 Grid
            gridSection
        }
        .padding(12)
    }

    // MARK: - Header

    private var headerSection: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(taskTitle)
                .font(.subheadline.weight(.semibold))
                .lineLimit(2)

            Text(DateHelpers.formatRelativeTime(originalDueAt))
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }

    // MARK: - Resolved Time

    private var resolvedTimeSection: some View {
        HStack(spacing: 4) {
            Image(systemName: "clock.arrow.circlepath")
                .font(.caption)
                .foregroundColor(.blue)
            Text(formattedWorkingDate)
                .font(.caption.weight(.medium))
                .foregroundColor(.blue)
            Text(DateHelpers.formatDeltaBetween(from: originalDueAt, to: workingDueAt))
                .font(.caption)
                .foregroundColor(.blue)
            Text("(\(DateHelpers.formatRelativeTime(workingDueAt)))")
                .font(.caption)
                .foregroundColor(.secondary)
        }
    }

    // MARK: - Grid

    private var gridSection: some View {
        VStack(spacing: 6) {
            // Row 1: Presets (gray)
            HStack(spacing: 6) {
                ForEach(presets) { preset in
                    gridButton(label: preset.label, color: .gray) {
                        handlePreset(preset)
                    }
                }
            }

            // Row 2: Increments (green)
            HStack(spacing: 6) {
                ForEach(increments) { inc in
                    gridButton(label: inc.label, color: .green) {
                        handleIncrement(inc)
                    }
                }
            }

            // Row 3: Decrements (amber)
            HStack(spacing: 6) {
                ForEach(decrements) { dec in
                    gridButton(label: dec.label, color: .orange) {
                        handleIncrement(dec)
                    }
                }
            }

            // Row 4: Reset (when dirty) + Next Hour
            HStack(spacing: 6) {
                if isDirty {
                    gridButton(label: "Reset", color: .gray) {
                        handleReset()
                    }
                }
                gridButton(label: nextHourLabel, color: .blue) {
                    handleNextHour()
                }
            }
        }
    }

    /// "Next Hour · 3:00 PM" — computed fresh on each render so the time stays current.
    private var nextHourLabel: String {
        let snapped = DateHelpers.snapToNextHour()
        return "Next Hour · \(DateHelpers.formatShortTime(snapped))"
    }

    private func gridButton(label: String, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.caption.weight(.medium))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .background(color.opacity(0.15))
                .foregroundColor(color == .gray ? .primary : color)
                .cornerRadius(6)
        }
        .buttonStyle(.plain)
    }

    // MARK: - Actions

    private func handlePreset(_ preset: PresetButton) {
        let snapped = DateHelpers.snapToNextPreset(hour: preset.hour, minute: preset.minute)
        workingDueAt = DateHelpers.formatISO(snapped)
        commitChange()
    }

    private func handleReset() {
        workingDueAt = originalDueAt
        let wasDirty = isDirty
        isDirty = false
        onGridSelection(workingDueAt)
        if wasDirty { onDirtyStateChanged?(false) }
    }

    private func handleNextHour() {
        let snapped = DateHelpers.snapToNextHour()
        workingDueAt = DateHelpers.formatISO(snapped)
        commitChange()
    }

    private func handleIncrement(_ inc: IncrementButton) {
        if let days = inc.days, inc.minutes == nil {
            workingDueAt = DateHelpers.adjustByDays(workingDueAt, days: days)
        } else if let minutes = inc.minutes {
            workingDueAt = DateHelpers.adjustByMinutes(workingDueAt, minutes: minutes)
        }
        commitChange()
    }

    /// Shared post-action handler: fires callbacks and manages dirty state.
    /// Net-zero changes (working time == original time) reset to clean.
    private func commitChange() {
        let isNetZero = isEffectivelyEqual(workingDueAt, originalDueAt)
        let wasDirty = isDirty
        isDirty = !isNetZero

        onGridSelection(workingDueAt)

        if isDirty != wasDirty {
            onDirtyStateChanged?(isDirty)
        }
    }

    /// Compare two ISO date strings by their minute-level value (ignoring sub-minute precision).
    private func isEffectivelyEqual(_ a: String, _ b: String) -> Bool {
        guard let dateA = DateHelpers.parseISO(a),
              let dateB = DateHelpers.parseISO(b) else { return a == b }
        let delta = abs(dateA.timeIntervalSince(dateB))
        return delta < 60
    }

    // MARK: - Formatting

    private static let displayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "E, MMM d, h:mm a"
        f.timeZone = TimeZone.current
        return f
    }()

    private var formattedWorkingDate: String {
        guard let date = DateHelpers.parseISO(workingDueAt) else { return workingDueAt }
        return Self.displayFormatter.string(from: date)
    }
}
