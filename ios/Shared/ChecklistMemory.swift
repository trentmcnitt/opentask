import Foundation

/**
 * A CHECKLIST LEFT OPEN COMES BACK AS IT WAS (2026-11-25, Trent: "If I take
 * too long it will just dismiss automatically"). iOS closes an expanded
 * notification when the phone locks (Auto-Lock), and an extension can't keep
 * the screen awake; what it can do is not lose the work. The marks and the
 * page of a notification's checklist are kept in the App Group, keyed by the
 * notification's identifier, and reopening the same notification restores
 * them (the rows are still fetched live; a restored mark on a row that has
 * gone falls away, and the page is clamped to the list that came back).
 *
 * Kept only for the OpenTask day it was made on: a save prunes every entry
 * from another day, and a read ignores one, so a set from yesterday never
 * comes back. Forgotten after a commit and on Cancel. No timer.
 */
enum ChecklistMemory {
    struct Entry: Codable, Equatable {
        /// The OpenTask date the marks were made on ("2026-11-25").
        var day: String
        var marks: [String: ChecklistMark]
        var page: Int
    }

    #if os(macOS)
    private static let appGroup = "GEL3VGTUJX.group.io.mcnitt.opentask"
    #else
    private static let appGroup = "group.io.mcnitt.opentask"
    #endif
    private static let key = "checklist.memory"

    #if DEBUG
    /// Test seam: every read and write goes here instead of the App Group.
    static var suiteOverride: UserDefaults?
    #endif

    private static var defaults: UserDefaults? {
        #if DEBUG
        if let suiteOverride { return suiteOverride }
        #endif
        return UserDefaults(suiteName: appGroup)
    }

    private static func all() -> [String: Entry] {
        guard let data = defaults?.data(forKey: key) else { return [:] }
        return (try? JSONDecoder().decode([String: Entry].self, from: data)) ?? [:]
    }

    private static func write(_ entries: [String: Entry]) {
        if entries.isEmpty {
            defaults?.removeObject(forKey: key)
        } else if let data = try? JSONEncoder().encode(entries) {
            defaults?.set(data, forKey: key)
        }
    }

    /// The marks and page left on `id` today, or nil.
    static func recall(_ id: String, today: LocalDate) -> Entry? {
        guard let entry = all()[id], entry.day == today.description else { return nil }
        return entry
    }

    /// Keep `id`'s marks and page for today, dropping every other day's.
    /// Nothing marked on the first page is the default: kept as nothing.
    static func remember(_ id: String, marks: [String: ChecklistMark], page: Int, today: LocalDate) {
        var entries = all().filter { $0.value.day == today.description }
        if marks.isEmpty && page == 0 {
            entries[id] = nil
        } else {
            entries[id] = Entry(day: today.description, marks: marks, page: page)
        }
        write(entries)
    }

    /// After a commit or Cancel.
    static func forget(_ id: String) {
        var entries = all()
        guard entries.removeValue(forKey: id) != nil else { return }
        write(entries)
    }
}
