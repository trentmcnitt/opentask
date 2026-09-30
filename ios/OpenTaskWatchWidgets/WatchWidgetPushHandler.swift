import Foundation
import OSLog
import WidgetKit

/// WidgetKit push for the Smart Stack card (watchOS 26): registers this
/// extension's widget push token with the server so a change made anywhere
/// else — checking something off on the phone — reloads the card within
/// seconds instead of waiting out its own refresh schedule.
///
/// A thin wrapper over `WidgetPushRegistration` (ios/Shared), the same state
/// machine the phone/Mac widgets' `OpenTaskWidgetPushHandler` uses: the token
/// is persisted BEFORE the network call and retried from every `getTimeline`
/// until the server confirms it; an empty widget list never unregisters; and
/// the APNs environment follows the signing entitlement, not the build
/// configuration. That type's doc has the history behind each rule. The
/// server side is unchanged apart from accepting `platform: "watchos"`: the
/// same `widget_push_tokens` row, the same debounced
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
        WidgetPushRegistration.watch.tokenDelivered(pushInfo.token, widgetKinds: widgets.map(\.kind))
    }
}

extension WidgetPushRegistration {
    /// The watch's Smart Stack card. Not `@available`-gated: `getTimeline`
    /// calls `retryIfNeeded()` on every watchOS.
    ///
    /// `watch.widgetPush.*` keys — the phone extension's `widgetPush.*` keys
    /// are a different device's storage in practice, but the namespaces stay
    /// disjoint anyway (see `WatchCache`'s doc).
    ///
    /// `bundleId` is the CONTAINING WATCH APP's id, not this extension's own
    /// (`io.mcnitt.opentask.watchapp.widgets`): the server computes the APNs
    /// topic as `<bundle_id>.push-type.widgets`, and Apple's docs (and the
    /// phone/Mac configuration) use the app's id there. The watch app is its
    /// own app with its own id — NOT the iPhone app's `io.mcnitt.opentask`.
    ///
    /// Logs: `log show --predicate 'subsystem == "io.mcnitt.opentask.watchapp.widgets"'`.
    static let watch = WidgetPushRegistration(
        keyPrefix: "watch.widgetPush",
        bundleId: "io.mcnitt.opentask.watchapp",
        platform: "watchos",
        suiteName: "group.io.mcnitt.opentask",
        log: Logger(subsystem: "io.mcnitt.opentask.watchapp.widgets", category: "push")
    )
}
