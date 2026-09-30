import AppKit
import SwiftUI
import WidgetKit
import XCTest

/// Screenshot renders of the real widget views (docs/SCREENSHOTS.md).
///
/// Not a test of anything: an XCTest bundle is just the cheapest scriptable
/// host that compiles the widget sources unchanged (`OpenTaskScreenshotRenders`
/// in macos/project.yml, next to `OpenTaskLogicTests`). It SKIPS unless
/// `SCREENSHOTS_WIDGET_DATA` is set, so a plain test run never writes files.
///
///   SCREENSHOTS_WIDGET_DATA  dir of API responses from the seeded sample account
///                            (`scripts/dump-preview-data.ts --out`, plus
///                            `completions.json`) — the same account as the web shots
///   SCREENSHOTS_NATIVE_OUT   where the PNGs go (the run's `native/` dir)
///   SCREENSHOTS_NOW          the frozen clock, ISO 8601 with offset
///
/// xcodebuild passes each as `TEST_RUNNER_<NAME>` (see
/// scripts/screenshots/capture-native.sh), along with `TZ`.
///
/// What it draws: each widget's own top-level view (`RemindersWidgetView`,
/// `TasksWidgetView`, `TrackWidgetView`) with entries built the way the
/// providers build them, at iPhone 16 Pro widget sizes, @3x, light and dark.
/// Outside WidgetKit two things are the renderer's job: the family
/// (`familyOverride`, since `\.widgetFamily` is get-only) and the card itself —
/// `.containerBackground(for: .widget)` is a no-op here, so the card's
/// background, the day-complete wash, the 16pt content margins and the corner
/// are drawn below, matching what those views ask WidgetKit for.
///
/// LIMIT: this is the macOS build of the views. The few `#if os(iOS)` layout
/// branches (check-off tap bleed, UIKit line metrics) are the Mac's; the
/// Lock Screen (accessory) families don't exist on macOS and aren't drawn.
@MainActor
final class WidgetRenderTests: XCTestCase {

    private struct Env {
        let dataDir: URL
        let outDir: URL
        let now: Date
    }

    /// iPhone 16 Pro (402pt-wide screen) widget sizes, in points.
    private static let sizes: [(WidgetFamily, String, CGSize)] = [
        (.systemSmall, "small", CGSize(width: 170, height: 170)),
        (.systemMedium, "medium", CGSize(width: 364, height: 170)),
        (.systemLarge, "large", CGSize(width: 364, height: 382)),
    ]
    private static let schemes: [(ColorScheme, String)] = [(.light, "light"), (.dark, "dark")]

    private var manifest: [[String: Any]] = []

    private func environment() throws -> Env {
        let env = ProcessInfo.processInfo.environment
        guard let data = env["SCREENSHOTS_WIDGET_DATA"], let out = env["SCREENSHOTS_NATIVE_OUT"],
              let nowText = env["SCREENSHOTS_NOW"]
        else {
            throw XCTSkip("Screenshot renders run only from scripts/screenshots/run.sh")
        }
        guard let now = ISO8601DateFormatter().date(from: nowText) else {
            throw NSError(domain: "renders", code: 1, userInfo: [NSLocalizedDescriptionKey: "bad SCREENSHOTS_NOW \(nowText)"])
        }
        return Env(dataDir: URL(fileURLWithPath: data), outDir: URL(fileURLWithPath: out), now: now)
    }

    private func load<T: Decodable>(_ name: String, as type: T.Type, from dir: URL) throws -> T {
        let data = try Data(contentsOf: dir.appendingPathComponent("\(name).json"))
        return try JSONDecoder().decode(APIEnvelope<T>.self, from: data).data
    }

    override func setUp() {
        super.setUp()
        // Never the installed Mac app's widget cache — see WidgetStore.suiteOverride.
        WidgetStore.suiteOverride = UserDefaults(suiteName: "screenshots.\(UUID().uuidString)")
    }

    override func tearDown() {
        WidgetStore.suiteOverride = nil
        super.tearDown()
    }

    func testRenderWidgets() throws {
        let env = try environment()
        try FileManager.default.createDirectory(at: env.outDir, withIntermediateDirectories: true)

        let groups = try load("reminders", as: RemindersPayload.self, from: env.dataDir).groups
        let tasks = try load("tasks", as: TasksPage.self, from: env.dataDir).tasks
        let projects = try load("projects", as: ProjectsPage.self, from: env.dataDir).projects
        let labelConfig = try load("label-config", as: UserPreferencesLabelConfigPage.self, from: env.dataDir).labelConfig
        let completions = (try? load("completions", as: CompletionsPage.self, from: env.dataDir))?.completions ?? []

        // Reminders: the clock's period, and "day complete" that evening.
        let reminders = RemindersEntry(
            date: env.now, groups: groups,
            slotIndex: RemindersTimeline.naturalSlotIndex(in: groups, now: env.now),
            staleSince: nil, isSignedOut: false, canUndo: true, canRedo: false, actionDescription: nil
        )
        let evening = Calendar.current.date(bySettingHour: 21, minute: 48, second: 0, of: env.now)!
        let allHandled = groups.map(Self.handledAll)
        let remindersDone = RemindersEntry(
            date: evening, groups: allHandled,
            slotIndex: RemindersTimeline.naturalSlotIndex(in: allHandled, now: evening),
            staleSince: nil, isSignedOut: false, canUndo: true, canRedo: false, actionDescription: nil
        )

        // Tasks: the default page (Overdue while anything is), Today, and a
        // finished day (every task due today completed, nothing overdue).
        let provider = TasksProvider()
        let snapshot = TaskFeed.Snapshot(
            tasks: tasks, projects: projects, completions: completions, staleSince: nil, isSignedOut: false
        )
        let tasksDefault = provider.makeEntry(snapshot, now: env.now)
        WidgetStore.setTasksScopeChoice(WidgetStore.allProjects, naturalScope: tasksDefault.scope)
        let tasksToday = provider.makeEntry(snapshot, now: env.now)
        WidgetStore.clearTasksScopeChoice()
        let endOfDay = Calendar.current.date(bySettingHour: 18, minute: 5, second: 0, of: env.now)!
        let finishing = TasksTimeline.todaysTasks(from: tasks, now: endOfDay)
        let finishedIds = Set(finishing.map(\.id))
        let doneSnapshot = TaskFeed.Snapshot(
            tasks: tasks.filter { !finishedIds.contains($0.id) },
            projects: projects,
            completions: completions + finishing.enumerated().map { index, task in
                CompletionDTO(
                    id: 100_000 + index, taskId: task.id,
                    completedAt: ISO8601DateFormatter().string(from: endOfDay.addingTimeInterval(Double(-600 * (index + 1)))),
                    taskTitle: task.title, projectId: task.projectId
                )
            },
            staleSince: nil, isSignedOut: false
        )
        let tasksDone = provider.makeEntry(doneSnapshot, now: endOfDay)

        // Quotas, as TrackProvider.currentEntry builds them (met hidden).
        let quotas = tasks.filter(\.isTracked)
        let sections = QuotaSectionBuilder.sections(from: quotas, labelConfig: labelConfig, showMet: false, now: env.now)
        let track = TrackEntry(
            date: env.now, sections: sections,
            totalMet: quotas.filter(\.isProgressMet).count, totalCount: quotas.count,
            nextUnmet: sections.flatMap(\.clusters).flatMap(\.chips).first { !$0.isMet },
            showMet: false, takebackMode: false, page: 0,
            staleSince: nil, isSignedOut: false, canUndo: true, canRedo: false, actionDescription: nil
        )

        for (scheme, theme) in Self.schemes {
            for (family, familyName, size) in Self.sizes {
                try render(
                    RemindersWidgetView(entry: reminders, familyOverride: family), size: size, scheme: scheme,
                    wash: ReminderDayProgress.isDayComplete(reminders.groups),
                    name: "widget-reminders-\(familyName)-\(theme)",
                    shows: "Reminders widget, \(familyName), the 9:41 AM period", theme: theme, env: env
                )
                try render(
                    RemindersWidgetView(entry: remindersDone, familyOverride: family), size: size, scheme: scheme,
                    wash: ReminderDayProgress.isDayComplete(remindersDone.groups),
                    name: "widget-reminders-\(familyName)-day-complete-\(theme)",
                    shows: "Reminders widget, \(familyName), day complete", theme: theme, env: env
                )
                try render(
                    TasksWidgetView(entry: tasksDefault, familyOverride: family), size: size, scheme: scheme,
                    wash: tasksDefault.isDayComplete,
                    name: "widget-tasks-\(familyName)-\(theme)",
                    shows: "Tasks widget, \(familyName), default page (Overdue while anything is)", theme: theme, env: env
                )
                try render(
                    TasksWidgetView(entry: tasksToday, familyOverride: family), size: size, scheme: scheme,
                    wash: tasksToday.isDayComplete,
                    name: "widget-tasks-\(familyName)-today-\(theme)",
                    shows: "Tasks widget, \(familyName), Today page", theme: theme, env: env
                )
                try render(
                    TasksWidgetView(entry: tasksDone, familyOverride: family), size: size, scheme: scheme,
                    wash: tasksDone.isDayComplete,
                    name: "widget-tasks-\(familyName)-day-complete-\(theme)",
                    shows: "Tasks widget, \(familyName), day complete", theme: theme, env: env
                )
                try render(
                    TrackWidgetView(entry: track, familyOverride: family), size: size, scheme: scheme,
                    wash: false,
                    name: "widget-quotas-\(familyName)-\(theme)",
                    shows: "Quotas widget, \(familyName)", theme: theme, env: env
                )
            }
        }

        let partDir = env.outDir.deletingLastPathComponent().appendingPathComponent("manifest.parts")
        try FileManager.default.createDirectory(at: partDir, withIntermediateDirectories: true)
        let json = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys])
        try json.write(to: partDir.appendingPathComponent("widgets.json"))
    }

    /// Every reminder considered and every prompt handled — the day's end.
    private static func handledAll(_ group: ReminderGroupDTO) -> ReminderGroupDTO {
        ReminderGroupDTO(
            slot: group.slot,
            reminders: [],
            considered: group.considered + group.reminders.count,
            consideredItems: group.consideredItems + group.reminders,
            prompts: group.prompts.map { $0.isWaiting ? $0.handled(did: true) : $0 }
        )
    }

    /// The card WidgetKit would draw around the view, then a PNG at 3x.
    private func render<V: View>(
        _ view: V, size: CGSize, scheme: ColorScheme, wash: Bool,
        name: String, shows: String, theme: String, env: Env
    ) throws {
        let card = view
            // A macOS app draws `Link` as an AppKit-backed hyperlink, which
            // ImageRenderer can't rasterize (it leaves a placeholder); in a
            // widget it is just its label. The plain style gives the widget look.
            .buttonStyle(.plain)
            .padding(16)
            .frame(width: size.width, height: size.height)
            .background {
                ZStack {
                    scheme == .dark ? Color(white: 0.11) : Color.white
                    Rectangle().fill(.fill.tertiary)
                    if wash { Rectangle().fill(WidgetTheme.dayCompleteWash) }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .environment(\.colorScheme, scheme)
        let renderer = ImageRenderer(content: card)
        renderer.scale = 3
        guard let image = renderer.cgImage,
              let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
        else {
            throw NSError(domain: "renders", code: 2, userInfo: [NSLocalizedDescriptionKey: "render failed: \(name)"])
        }
        let file = env.outDir.appendingPathComponent("\(name).png")
        try png.write(to: file)
        manifest.append([
            "file": "native/\(name).png",
            "shows": shows + " (rendered from the SwiftUI views, macOS build)",
            "theme": theme,
            "destinations": ["docs:public/images/ios/\(name).png"],
        ])
    }
}
