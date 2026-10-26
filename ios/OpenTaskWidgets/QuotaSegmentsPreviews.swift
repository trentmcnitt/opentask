#if DEBUG
import SwiftUI
import WidgetKit

// Quota segments (2026-10-13) — one compact corpus that puts every count
// state on the FIRST page of each widget, so one render per family and
// appearance shows them all: nothing logged (0/2), partway (2/3, 2/6), met
// (2/2, in DONE), past the cap (3/2, in DONE), a 1× quota (0/1), the text
// fallback above six (3/7) and a long title the count has to wrap with.
// Invented titles (the mockup's), never an account's.

private enum QuotaSegmentsPreviewData {
    static let slotKey = 9021

    private static func prompt(
        _ id: Int, _ title: String, _ current: Int, _ target: Int, _ period: String, _ stripe: String?,
        considered: Bool = false, done: Bool = false
    ) -> QuotaPromptDTO {
        QuotaPromptDTO(
            promptKey: "q:\(id):0:2026-10-13", taskId: id, title: title, current: current, target: target,
            period: period, stripeColor: stripe, considered: considered, done: done, hasNotes: false
        )
    }

    static var reminders: RemindersEntry {
        let prompts = [
            prompt(9001, "Daily Walks", 0, 2, "DAILY", nil),
            prompt(9003, "Take vitamins", 2, 3, "DAILY", "blue"),
            prompt(9004, "Practice piano", 2, 6, "WEEKLY", "blue"),
            prompt(9005, "Drink a glass of water", 3, 7, "DAILY", nil),
            prompt(9002, "Make sure the MDX battery toggle is off before leaving the house", 0, 1, "MONTHLY", "purple"),
            prompt(9006, "Stretch", 2, 2, "DAILY", nil, considered: true, done: true),
            prompt(9007, "Check water softener", 3, 2, "WEEKLY", "orange", considered: true, done: true),
            prompt(9008, "Read 20 pages", 1, 3, "WEEKLY", nil, considered: true),
        ]
        let group = ReminderGroupDTO(
            slot: TimeSlotDTO(id: slotKey, label: "Morning", startTime: "08:00"),
            reminders: [], considered: 0, consideredItems: [], prompts: prompts
        )
        let now = Calendar.current.date(bySettingHour: 8, minute: 40, second: 0, of: Date()) ?? Date()
        return RemindersEntry(
            date: now, groups: [group], segments: [], slotIndex: 0, segmentIndex: nil, staleSince: nil,
            isSignedOut: false, canUndo: true, canRedo: false, actionDescription: nil
        )
    }

    static func prepareReminders(showCompleted: Bool, page: Int = 0) {
        WidgetStore.setShowCompleted(showCompleted, for: RemindersWidget.kind)
        WidgetStore.setRemindersPage(page, for: slotKey)
    }

    /// NEAR THE WRAP (2026-10-26, the "wee…" hunt): weekly prompts, partly
    /// filled (a filled run and an empty run, two images), whose titles grow
    /// one word at a time — so in some row the boxes and "week" land right
    /// at the column's edge, whatever the text size.
    static func nearTheWrap(longestFirst: Bool = false) -> RemindersEntry {
        let stem = ["Practice", "the", "piano", "scales", "slowly", "with", "the", "metronome", "on"]
        let counts = [(1, 3), (2, 5), (4, 5), (2, 6), (1, 2), (3, 4), (1, 4), (2, 3), (5, 6)]
        let prompts = counts.indices.map { i in
            prompt(9200 + i, stem.prefix(i + 1).joined(separator: " "), counts[i].0, counts[i].1, "WEEKLY", "blue")
        } + [
            // Longer than the 2×2 and the Lock Screen card hold at XXX
            // Large: their one-item line has to give way somewhere.
            prompt(
                9299, "Make sure the MDX battery toggle is off before leaving the house for the week", 2, 6,
                "WEEKLY", "purple"
            ),
        ]
        let group = ReminderGroupDTO(
            slot: TimeSlotDTO(id: slotKey, label: "Morning", startTime: "08:00"),
            reminders: [], considered: 0, consideredItems: [], prompts: longestFirst ? prompts.reversed() : prompts
        )
        let now = Calendar.current.date(bySettingHour: 8, minute: 40, second: 0, of: Date()) ?? Date()
        return RemindersEntry(
            date: now, groups: [group], segments: [], slotIndex: 0, segmentIndex: nil, staleSince: nil,
            isSignedOut: false, canUndo: true, canRedo: false, actionDescription: nil
        )
    }

    private static func quota(
        _ id: Int, _ title: String, _ current: Int, _ target: Int, _ freq: String, _ labels: [String]
    ) -> TaskDTO {
        TaskDTO(
            id: id, projectId: 1, title: title, priority: 0, rrule: "FREQ=\(freq)", progressTarget: target,
            progressCurrent: current, trackedFlag: true, labels: labels
        )
    }

    static func track(showMet: Bool) -> TrackEntry {
        let quotas = [
            quota(9101, "Daily Walks", 0, 2, "DAILY", ["health"]),
            quota(9102, "Take vitamins", 2, 3, "DAILY", ["health"]),
            quota(9103, "Drink a glass of water", 3, 7, "DAILY", []),
            quota(9104, "Stretch", 2, 2, "DAILY", ["health"]),
            quota(9105, "Practice piano", 2, 6, "WEEKLY", ["family"]),
            quota(9106, "Check water softener", 3, 2, "WEEKLY", ["house"]),
            quota(9107, "Dust the bookshelf", 0, 1, "MONTHLY", ["house"]),
        ]
        let labels = [
            LabelConfigDTO(name: "health", color: "blue"),
            LabelConfigDTO(name: "house", color: "orange"),
            LabelConfigDTO(name: "family", color: "purple"),
        ]
        let now = Date()
        let sections = QuotaSectionBuilder.sections(from: quotas, labelConfig: labels, showMet: showMet, now: now)
        return TrackEntry(
            date: now, sections: sections, totalMet: quotas.filter(\.isProgressMet).count,
            totalCount: quotas.count,
            nextUnmet: sections.flatMap(\.clusters).flatMap(\.chips).first { !$0.isMet },
            showMet: showMet, page: 0, staleSince: nil, isSignedOut: false, canUndo: true, canRedo: false,
            actionDescription: nil
        )
    }
}

#Preview("Quota segments — Reminders Large", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = QuotaSegmentsPreviewData.prepareReminders(showCompleted: true)
    QuotaSegmentsPreviewData.reminders
}

#Preview("Quota segments — Reminders Large, page 2", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = QuotaSegmentsPreviewData.prepareReminders(showCompleted: true, page: 1)
    QuotaSegmentsPreviewData.reminders
}

#Preview("Quota segments — Reminders Medium", as: .systemMedium) {
    RemindersWidget()
} timeline: {
    let _ = QuotaSegmentsPreviewData.prepareReminders(showCompleted: false)
    QuotaSegmentsPreviewData.reminders
}

#Preview("Quota segments — Reminders Small", as: .systemSmall) {
    RemindersWidget()
} timeline: {
    let _ = QuotaSegmentsPreviewData.prepareReminders(showCompleted: false)
    QuotaSegmentsPreviewData.reminders
}

#Preview("Quota segments — near the wrap, page 1", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = QuotaSegmentsPreviewData.prepareReminders(showCompleted: false)
    QuotaSegmentsPreviewData.nearTheWrap()
}

#Preview("Quota segments — near the wrap, page 2", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = QuotaSegmentsPreviewData.prepareReminders(showCompleted: false, page: 1)
    QuotaSegmentsPreviewData.nearTheWrap()
}

#Preview("Quota segments — near the wrap, page 3", as: .systemLarge) {
    RemindersWidget()
} timeline: {
    let _ = QuotaSegmentsPreviewData.prepareReminders(showCompleted: false, page: 2)
    QuotaSegmentsPreviewData.nearTheWrap()
}

#Preview("Quota segments — near the wrap, Medium", as: .systemMedium) {
    RemindersWidget()
} timeline: {
    let _ = QuotaSegmentsPreviewData.prepareReminders(showCompleted: false)
    QuotaSegmentsPreviewData.nearTheWrap()
}

#Preview("Quota segments — near the wrap, Small", as: .systemSmall) {
    RemindersWidget()
} timeline: {
    let _ = QuotaSegmentsPreviewData.prepareReminders(showCompleted: false)
    QuotaSegmentsPreviewData.nearTheWrap(longestFirst: true)
}

#Preview("Quota segments — Quotas Large", as: .systemLarge) {
    TrackWidget()
} timeline: {
    QuotaSegmentsPreviewData.track(showMet: true)
}

#Preview("Quota segments — Quotas Medium", as: .systemMedium) {
    TrackWidget()
} timeline: {
    QuotaSegmentsPreviewData.track(showMet: true)
}

#Preview("Quota segments — Quotas Small", as: .systemSmall) {
    TrackWidget()
} timeline: {
    QuotaSegmentsPreviewData.track(showMet: true)
}
#endif
