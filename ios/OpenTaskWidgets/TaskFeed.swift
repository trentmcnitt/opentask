import Foundation

/// The one `GET /api/tasks?done=false` (+ `/api/projects`) read, shared by the
/// Tasks and Track widgets.
///
/// Both kinds render different slices of the *same* payload — today's dated
/// work (§7.1) vs. §5's quotas — so exactly one place fetches it, caches it,
/// falls back to the cache, and applies the §8 optimistic staging. Two copies
/// of that sequence would drift apart on the first fix, and a second fetch of
/// the same endpoint would spend two widgets' refresh budgets on identical
/// bytes. Sharing it means a refresh of *either* kind warms the cache both read
/// from, which is strictly more coverage per reload than either had alone.
///
/// Projects are fetched even though Track ignores them: the App Group cache has
/// one shape (`WidgetStore.saveTasks(_:projects:)`), and a Track-only refresh
/// that wrote an empty project list would blank the Tasks widget's chevron ring
/// until the next Tasks refresh. The extra request is concurrent with the tasks
/// one, so it costs latency only if it is the slower of the two.
enum TaskFeed {

    /// A resolved payload: what to draw, and how honest it is.
    struct Snapshot {
        /// Tombstoned completions removed, staged `+1`s applied (§8).
        let tasks: [TaskDTO]
        let projects: [ProjectDTO]
        /// Non-nil when this came from the cache because the fetch failed —
        /// drives the "as of HH:MM" note.
        let staleSince: Date?
        /// No server URL / token in the Keychain — the app is not set up.
        let isSignedOut: Bool
    }

    /// Never throws to the caller: a widget's only honest failure modes are
    /// "signed out" and "stale".
    static func snapshot(now: Date = Date()) async -> Snapshot {
        guard APIClient.shared.isConfigured else {
            return Snapshot(tasks: [], projects: [], staleSince: nil, isSignedOut: true)
        }

        // Interaction fast path (§8 optimistic check-off): a tap landed seconds
        // ago, so repaint straight from cache — waiting on the network here is
        // exactly what makes a widget button read as dead. No staleness note:
        // this data is seconds old by construction.
        if WidgetStore.hasRecentInteraction(now: now), let cached = WidgetStore.loadTasks() {
            return staged(cached.value.tasks, cached.value.projects, staleSince: nil, now: now)
        }

        do {
            async let tasks = APIClient.shared.fetchOpenTasks()
            async let projects = APIClient.shared.fetchProjects()
            let (fetchedTasks, fetchedProjects) = try await (tasks, projects)
            WidgetStore.saveTasks(fetchedTasks, projects: fetchedProjects)
            return staged(fetchedTasks, fetchedProjects, staleSince: nil, now: now)
        } catch {
            print("[OpenTaskWidgets] Tasks fetch failed: \(error)")
            guard let cached = WidgetStore.loadTasks() else {
                return Snapshot(tasks: [], projects: [], staleSince: nil, isSignedOut: false)
            }
            return staged(
                cached.value.tasks,
                cached.value.projects,
                staleSince: cached.fetchedAt,
                now: now
            )
        }
    }

    /// Single choke point for the §8 staging, applied on the fresh-fetch path
    /// too: the server may not have committed the interaction yet, and
    /// resurrecting a checked item — or dropping a logged `+1` — for one
    /// refresh cycle looks exactly like the tap didn't take.
    private static func staged(
        _ tasks: [TaskDTO],
        _ projects: [ProjectDTO],
        staleSince: Date?,
        now: Date
    ) -> Snapshot {
        Snapshot(
            tasks: WidgetStore.applyPendingProgress(
                WidgetStore.filterPending(tasks, now: now),
                now: now
            ),
            projects: projects,
            staleSince: staleSince,
            isSignedOut: false
        )
    }
}
