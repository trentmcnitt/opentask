import SwiftUI

/// App root: a HORIZONTALLY paged `TabView` — swipe left/right between
/// Reminders, Tasks and Quotas, with page dots — where each page scrolls
/// vertically on its own with the Digital Crown.
///
/// Was `.tabViewStyle(.verticalPage)` until 2026-09-24: the crown and a
/// vertical swipe both scrolled the page AND flipped to the next one, so
/// reaching Tasks meant scrolling to the bottom of every reminder first
/// (Trent: "swipe left/right between sections instead of scrolling to the
/// bottom to flip to the next page"). `.page` is the watchOS horizontal
/// pager — the crown is left entirely to the page's own scroll view.
///
/// Falls back to the existing `StatusView` "not connected" message when the
/// Keychain has no server URL/token yet — still reachable by opening the iOS
/// app to pair.
struct WatchRootView: View {
    @StateObject private var model = WatchViewModel()
    @Environment(\.scenePhase) private var scenePhase
    /// Which page the paged `TabView` shows. Driven by the user's swipes, and
    /// by `.onOpenURL` below when the Smart Stack widget opens the app.
    @State private var page: WatchPage = .reminders

    var body: some View {
        Group {
            if !model.isConfigured {
                StatusView()
            } else {
                // ONE `NavigationStack` around the whole paged `TabView`, not
                // one per page. Each page below still sets its own
                // `.navigationTitle`/`.toolbar` and this single stack picks
                // up whichever page is on screen — a NavigationStack per page
                // crashed on first run (verified in the simulator, with the
                // earlier vertical pager):
                // "Layout requested for visible navigation bar ... top item
                // belongs to a different navigation bar ... possibly from a
                // client attempt to nest wrapped navigation controllers." A
                // paged watchOS TabView keeps adjacent pages mounted for the
                // swipe transition, so two independently navigation-stacked
                // pages fight over the same chrome the instant both exist at
                // once — true of the horizontal pager too.
                NavigationStack {
                    TabView(selection: $page) {
                        RemindersPageView(model: model)
                            .tag(WatchPage.reminders)
                        TasksPageView(model: model)
                            .tag(WatchPage.tasks)
                        QuotasPageView(model: model)
                            .tag(WatchPage.quotas)
                    }
                    .tabViewStyle(.page)
                }
            }
        }
        .task {
            await model.load()
        }
        // Smart Stack widget taps (`ReminderStackWidget`'s `.widgetURL`):
        // `opentask://reminders` for a reminder/caught-up card, `opentask://
        // tasks` for an overdue card. Anything else (an older build's link)
        // just opens the app wherever it was.
        .onOpenURL { url in
            if let target = WatchPage(url: url) {
                page = target
            }
        }
        // Refresh on every return to the foreground, not just first launch —
        // a change made on the phone or web while the app sat in the
        // background must not wait for a manual pull-to-refresh. `load()`
        // also reloads the Smart Stack widget's timeline, so opening the app
        // is itself a guaranteed way to bring a stale card up to date.
        //
        // `.background` (not `.inactive`, which a lowered wrist triggers
        // within seconds) disarms Quotas' Takeback mode — see
        // `WatchViewModel.quotasTakebackMode`.
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active {
                Task { await model.load() }
            } else if newPhase == .background {
                model.quotasTakebackMode = false
            }
        }
    }
}

/// The watch app's pages, addressable by the Smart Stack widget's deep links.
enum WatchPage: Hashable {
    case reminders
    case tasks
    case quotas

    /// `opentask://reminders` → Reminders, `opentask://tasks` (or the phone
    /// widgets' `opentask://today`) → Tasks, `opentask://quotas` (or
    /// `opentask://quota/<id>`, the phone Quotas widget's row link) →
    /// Quotas; `nil` for anything else.
    init?(url: URL) {
        guard url.scheme == "opentask" else { return nil }
        switch url.host {
        case "reminders": self = .reminders
        case "tasks", "today": self = .tasks
        case "quotas", "quota": self = .quotas
        default: return nil
        }
    }
}
