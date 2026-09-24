import Foundation
import OSLog
import WidgetKit

/// `print` from a widget extension reaches no log anyone can read on a device;
/// this does (`log show --predicate 'subsystem == "io.mcnitt.opentask.watchapp.widgets"'`).
private let pushLog = Logger(subsystem: "io.mcnitt.opentask.watchapp.widgets", category: "push")

/// WidgetKit push for the Smart Stack card (watchOS 26): registers this
/// extension's widget push token with the server so a change made anywhere
/// else — Trent checking something off on his phone — reloads the card
/// within seconds instead of waiting out its own refresh schedule.
///
/// A copy of the phone/Mac widgets' `OpenTaskWidgetPushHandler`
/// (`ios/OpenTaskWidgets/WidgetPushHandler.swift` — not shared: that
/// directory is the phone extension's private code, and this target can't
/// compile it), including its two hard-won lessons: the token is persisted
/// BEFORE the network call and retried from every `getTimeline` until the
/// server confirms it (WidgetKit hands a token over once and a single lost
/// request used to leave a device unregistered indefinitely), and the APNs
/// environment follows the signing entitlement, not the build configuration.
/// The server side is unchanged apart from accepting `platform: "watchos"`:
/// the same `widget_push_tokens` row, the same debounced
/// `<bundle_id>.push-type.widgets` send on every mutation
/// (`src/core/notifications/widget-push.ts`, `apns.ts`).
///
/// Availability checked against the watchOS SDK's WidgetKit interface, not
/// assumed: `WidgetPushHandler`, `WidgetPushInfo` and
/// `WidgetConfiguration.pushHandler(_:)` are all
/// `@available(iOS 26.0, macOS 26.0, visionOS 26.0, watchOS 26.0, *)` —
/// hence the gate here and the `#available` branch in `ReminderStackWidget`
/// rather than raising the extension's watchOS 10 floor.
@available(watchOS 26.0, *)
struct WatchWidgetPushHandler: WidgetPushHandler {
    init() {}

    func pushTokenDidChange(_ pushInfo: WidgetPushInfo, widgets: [WidgetInfo]) {
        let token = pushInfo.token.map { String(format: "%02.2hhx", $0) }.joined()
        pushLog.notice("pushTokenDidChange: \(widgets.count, privacy: .public) widget(s), token \(String(token.prefix(8)), privacy: .public)")

        // Empty `widgets`: the last OpenTask card was removed from the Smart
        // Stack / watch face. Nothing reads this token any more — unregister
        // it rather than leave the server spending push budget on it.
        guard !widgets.isEmpty else {
            WatchWidgetPushRegistration.clear()
            Task {
                do {
                    try await WatchWidgetPushRegistrar.unregister(token: token)
                } catch {
                    pushLog.error("unregister failed: \(String(describing: error), privacy: .public)")
                }
            }
            return
        }

        let kinds = Set(widgets.map(\.kind)).sorted().joined(separator: ",")
        WatchWidgetPushRegistration.savePending(token: token, widgetKind: kinds)
        Task { await WatchWidgetPushRegistration.retryIfNeeded() }
    }
}

/// The token this extension was given and whether the server has confirmed
/// it, kept in the App Group so it survives the extension being suspended
/// mid-request. `watch.widgetPush.*` keys — the phone extension's
/// `widgetPush.*` keys are a different device's storage in practice, but the
/// namespaces stay disjoint anyway (see `WatchCache`'s doc).
///
/// Not `@available`-gated: below watchOS 26 nothing is ever saved, so
/// `retryIfNeeded()` — called from every `getTimeline` — is a cheap no-op.
/// Re-sending an already-registered token is harmless (the server upserts on
/// `push_token`).
enum WatchWidgetPushRegistration {
    private static let pendingTokenKey = "watch.widgetPush.pendingToken"
    private static let pendingKindsKey = "watch.widgetPush.pendingKinds"
    private static let registeredTokenKey = "watch.widgetPush.registeredToken"

    private static var defaults: UserDefaults? { UserDefaults(suiteName: "group.io.mcnitt.opentask") }

    static func savePending(token: String, widgetKind: String) {
        defaults?.set(token, forKey: pendingTokenKey)
        defaults?.set(widgetKind, forKey: pendingKindsKey)
    }

    static func clear() {
        defaults?.removeObject(forKey: pendingTokenKey)
        defaults?.removeObject(forKey: pendingKindsKey)
        defaults?.removeObject(forKey: registeredTokenKey)
    }

    /// Send the saved token if the server hasn't confirmed it yet.
    static func retryIfNeeded() async {
        guard let defaults,
              let token = defaults.string(forKey: pendingTokenKey),
              defaults.string(forKey: registeredTokenKey) != token
        else { return }
        let kinds = defaults.string(forKey: pendingKindsKey) ?? ""
        do {
            try await WatchWidgetPushRegistrar.register(token: token, widgetKind: kinds)
            defaults.set(token, forKey: registeredTokenKey)
            pushLog.notice("registered widget push token for [\(kinds, privacy: .public)]")
        } catch {
            // Left pending: the next timeline reload tries again (also the
            // path for a card placed before the watch app has credentials).
            pushLog.error("registration failed for [\(kinds, privacy: .public)], will retry on next reload: \(String(describing: error), privacy: .public)")
        }
    }
}

/// `POST`/`DELETE /api/push/apns/widget-token`, talking to the server directly
/// for the same reason the phone handler does: `APIClient`'s request helpers
/// are `private` to its file.
private enum WatchWidgetPushRegistrar {
    /// The CONTAINING WATCH APP's bundle id, not this extension's own
    /// (`io.mcnitt.opentask.watchapp.widgets`): the server computes the APNs
    /// topic as `<bundle_id>.push-type.widgets`, and Apple's docs (and the
    /// phone/Mac handlers) use the app's id there. The watch app is its own
    /// app with its own id — NOT the iPhone app's `io.mcnitt.opentask`.
    private static let appBundleId = "io.mcnitt.opentask.watchapp"
    private static let platform = "watchos"

    static func register(token: String, widgetKind: String) async throws {
        // Fixed by the signing entitlement (`aps-environment: development`
        // in project.yml for BOTH watch targets, Release included), not by
        // `#if DEBUG` — the phone/Mac lesson: a Release build registered as
        // "production" gets `BadDeviceToken` from APNs and the server then
        // deletes the row. Change together with the entitlement.
        let environment = "development"

        try await send(method: "POST", body: [
            "push_token": token,
            "bundle_id": appBundleId,
            "platform": platform,
            "environment": environment,
            "widget_kind": widgetKind,
        ])
    }

    static func unregister(token: String) async throws {
        try await send(method: "DELETE", body: ["push_token": token])
    }

    private static func send(method: String, body: [String: Any]) async throws {
        guard let serverURLString = APIClient.shared.serverURL,
              let bearerToken = APIClient.shared.bearerToken,
              let url = URL(string: "\(serverURLString)/api/push/apns/widget-token")
        else {
            throw APIError.notConfigured
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 15
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode)
        else {
            throw APIError.invalidResponse
        }
    }
}
