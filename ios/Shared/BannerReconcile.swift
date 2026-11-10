import Foundation
import UserNotifications

/**
 * THE BANNER RECONCILE (2026-11-10): ask the server which of this device's
 * delivered banners no longer stand, and remove those.
 *
 * Why: the server's `dismiss` silent push names only the tasks its own
 * mutation touched, and iOS budgets silent pushes to a few an hour, keeping
 * only the newest pending one. Twenty considers in ten seconds sent twenty
 * dismisses; at most one arrived, so most banners stayed on the lock screen
 * (Trent, 11-10). Now every `dismiss` that does arrive — and every move to
 * the background — makes the device send what each delivered banner carries
 * to `POST /api/notifications/stale` and remove what comes back, so one
 * arrival cleans every stale banner, however and wherever it was handled.
 * The rules are the server's (`src/core/notifications/stale.ts`).
 *
 * Not on coming forward: the iPhone and the Mac already clear every banner
 * then. An older server (404) or no network: nothing is removed.
 */
enum BannerReconcile {
    /// The most banners one request asks about (the server's own cap).
    static let maxBanners = 100

    /// What the server's rules read from one banner, or nil for a banner
    /// they can't judge (no task, prompt, kind or period: a summary).
    static func descriptor(identifier: String, userInfo: [AnyHashable: Any]) -> [String: Any]? {
        var out: [String: Any] = ["id": identifier]
        if let taskId = userInfo["taskId"] as? Int { out["task_id"] = taskId }
        if let key = userInfo[QuotaNagKey.promptKey] as? String { out["prompt_key"] = key }
        if let icon = userInfo["icon"] as? String { out["icon"] = icon }
        if let kind = userInfo["kind"] as? String { out["kind"] = kind }
        if let slotId = userInfo["slot_id"] as? Int { out["slot_id"] = slotId }
        let judgeable = out["task_id"] != nil || out["prompt_key"] != nil
            || out["slot_id"] != nil || out["kind"] != nil
        return judgeable ? out : nil
    }

    /// The request's banners, in delivered order, capped.
    static func descriptors(_ delivered: [(identifier: String, userInfo: [AnyHashable: Any])]) -> [[String: Any]] {
        Array(delivered.compactMap { descriptor(identifier: $0.identifier, userInfo: $0.userInfo) }
            .prefix(maxBanners))
    }

    /// The identifiers to remove: the server's answer, limited to banners
    /// this device asked about (an answer never removes anything else).
    static func removable(_ stale: [String], asked banners: [[String: Any]]) -> [String] {
        let asked = Set(banners.compactMap { $0["id"] as? String })
        return stale.filter { asked.contains($0) }
    }
}

/// Reconcile this device's delivered banners with the server; returns how
/// many were removed. Never throws: a failure removes nothing.
@discardableResult
func reconcileDeliveredBanners() async -> Int {
    guard APIClient.shared.isConfigured else { return 0 }
    let center = UNUserNotificationCenter.current()
    let delivered = await center.deliveredNotifications().map {
        (identifier: $0.request.identifier, userInfo: $0.request.content.userInfo)
    }
    let banners = BannerReconcile.descriptors(delivered)
    guard !banners.isEmpty else { return 0 }
    do {
        let stale = try await APIClient.shared.staleBanners(banners)
        let ids = BannerReconcile.removable(stale, asked: banners)
        if !ids.isEmpty {
            center.removeDeliveredNotifications(withIdentifiers: ids)
            print("[OpenTask] Reconcile removed \(ids.count) of \(banners.count) banner(s)")
        }
        return ids.count
    } catch {
        print("[OpenTask] Reconcile failed: \(error)")
        return 0
    }
}
