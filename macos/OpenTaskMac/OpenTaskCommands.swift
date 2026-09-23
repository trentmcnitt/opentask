import SwiftUI

/// The menu bar.
///
/// The point of a Mac app over a browser tab: the things you do to a list of
/// overdue tasks are one keystroke away whether or not the window is even
/// focused on the right element.
///
/// ⌘N and ⌘R are free to take — the web app binds ⌘K, ⌘S and ⌘Z but neither of
/// these — and the menu wins over the page either way. The Snooze All items
/// take ⌃⌘1/2/3 rather than plain ⌘1/2/3, which pages commonly use for tab or
/// view switching.
struct OpenTaskCommands: Commands {
    var body: some Commands {
        // `Window` (not `WindowGroup`) means there is no "New Window" item
        // occupying ⌘N, but .newItem is still where a Mac user looks for
        // "make a new thing", so New Task takes its place in the File menu.
        CommandGroup(replacing: .newItem) {
            Button("New Task…") { MenuActions.newTask() }
                .keyboardShortcut("n")
        }

        CommandMenu("Tasks") {
            Button("Reload") { MenuActions.reload() }
                .keyboardShortcut("r")

            Divider()

            Button("Snooze All +1hr") {
                MenuActions.snoozeAll(deltaMinutes: 60, label: "Snooze All +1hr")
            }
            .keyboardShortcut("1", modifiers: [.command, .control])

            Button("Snooze All +2hr") {
                MenuActions.snoozeAll(deltaMinutes: 120, label: "Snooze All +2hr")
            }
            .keyboardShortcut("2", modifiers: [.command, .control])

            Button("Snooze All to Tomorrow") {
                MenuActions.snoozeAllToDefault(label: "Snooze All to Tomorrow")
            }
            .keyboardShortcut("3", modifiers: [.command, .control])
        }
    }
}
