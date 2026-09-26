#if DEBUG
import Foundation

/// Optional LOCAL data for `#Preview`s — never committed, never in a shipped
/// binary (the whole file is `#if DEBUG`).
///
/// Every committed preview corpus (`RemindersWidget.swift`'s
/// `ReminderPreviewData`, `TasksWidget.swift`, `TrackWidget.swift`,
/// `NotesGlyphPreviews.swift`, `WatchPreviewData.swift`,
/// `ReminderStackPreviewData.swift`) is realistic SAMPLE data: invented
/// titles with the same lengths, counts, periods, label colors and notes
/// flags as a real account, so the renders still hit the same layout stress.
/// This repo is public, so no real account's titles live in it.
///
/// To render against a real account locally, run
/// `scripts/dump-preview-data.ts` (see `ios/CLAUDE.md` § Previews with local
/// data). It writes raw API responses into `ios/Previews.local/`, which is
/// gitignored and sits outside every target's `sources` path, so xcodegen
/// never picks it up and nothing about the project changes. Each corpus asks
/// here first and falls back to its sample data when a file is missing.
///
/// Why a runtime read and not a gitignored `.swift` file: the Xcode projects
/// are committed, and a source file that exists on one machine and not
/// another either breaks the build or has to be baked into the committed
/// project. A file read at preview time needs neither. The path comes from
/// `#filePath`, i.e. this source file's location on the machine that built
/// the preview; iOS and watchOS preview hosts (simulator processes) can read
/// it. A sandboxed macOS preview host can't, and silently gets the sample
/// data.
enum PreviewLocalData {
    /// `ios/Previews.local/`, resolved from this file (`ios/Shared/`).
    static let directory: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appendingPathComponent("Previews.local", isDirectory: true)

    /// `<name>.json` decoded as the API's own `{ "data": ... }` envelope, or
    /// nil when the file is missing or doesn't decode.
    static func load<T: Decodable>(_ name: String, as type: T.Type) -> T? {
        let url = directory.appendingPathComponent("\(name).json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(APIEnvelope<T>.self, from: data).data
    }

    /// `GET /api/reminders` → `reminders.json`.
    static var reminderGroups: [ReminderGroupDTO]? {
        load("reminders", as: RemindersPayload.self)?.groups
    }

    /// `GET /api/tasks?done=false` → `tasks.json`.
    static var openTasks: [TaskDTO]? {
        load("tasks", as: TasksPage.self)?.tasks
    }

    /// `GET /api/projects` → `projects.json`.
    static var projects: [ProjectDTO]? {
        load("projects", as: ProjectsPage.self)?.projects
    }

    /// `GET /api/time-slots` → `time-slots.json`.
    static var timeSlots: [TimeSlotDTO]? {
        load("time-slots", as: TimeSlotsPage.self)?.timeSlots
    }

    /// `label_config` from `GET /api/user/preferences` → `label-config.json`.
    static var labelConfig: [LabelConfigDTO]? {
        load("label-config", as: UserPreferencesLabelConfigPage.self)?.labelConfig
    }
}
#endif
