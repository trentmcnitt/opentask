import SwiftUI

/// App root: a vertically paged `TabView` (Digital Crown / swipe scrolls
/// between pages, the watchOS-native pattern — see `.tabViewStyle(.verticalPage)`
/// below), Reminders first then Tasks. Quotas (§ the task brief's optional
/// third page) is deliberately NOT built tonight — see the PR description and
/// the morning report for why (everything else needed to be built, tested on
/// a real dev server, and verified before it was worth starting a third
/// surface from scratch).
///
/// Falls back to the existing `StatusView` "not connected" message when the
/// Keychain has no server URL/token yet — unchanged from before this task,
/// still reachable by opening the iOS app to pair.
struct WatchRootView: View {
    @StateObject private var model = WatchViewModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if !model.isConfigured {
                StatusView()
            } else {
                // ONE `NavigationStack` around the whole paged `TabView`, not
                // one per page. Each page below still sets its own
                // `.navigationTitle`/`.toolbar` and this single stack picks
                // up whichever page is on screen — a NavigationStack per page
                // crashed on first run (verified in the simulator):
                // "Layout requested for visible navigation bar ... top item
                // belongs to a different navigation bar ... possibly from a
                // client attempt to nest wrapped navigation controllers." A
                // vertically-paged watchOS TabView keeps adjacent pages
                // mounted for the swipe transition, so two independently
                // navigation-stacked pages fight over the same chrome the
                // instant both exist at once.
                NavigationStack {
                    TabView {
                        RemindersPageView(model: model)
                        TasksPageView(model: model)
                    }
                    .tabViewStyle(.verticalPage)
                }
            }
        }
        .task {
            await model.load()
        }
        // Refresh on every return to the foreground, not just first launch.
        // `WatchAppDelegate.applicationDidBecomeActive` already exists for
        // slot-action cache refresh but was never wired to THIS view's data
        // — without this, reopening the app after it's been backgrounded
        // shows whatever was on screen when it was last active, however
        // stale, until a manual pull-to-refresh.
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active {
                Task { await model.load() }
            }
        }
    }
}
