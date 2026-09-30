import Foundation
import OSLog

/// A widget extension's WidgetKit push token and whether the server has it —
/// the state machine behind every `WidgetPushHandler` in the apps (iOS 26 /
/// macOS 26 / watchOS 26). See docs/NOTIFICATIONS.md "WidgetKit push (widget
/// sync)" and Apple's
/// https://developer.apple.com/documentation/widgetkit/updating-widgets-with-widgetkit-push-notifications
///
/// Two extensions use it, each with its own configuration (a `static let` in
/// the extension's handler file):
/// - `.widgets` — the phone's and the Mac's widget extension
///   (`ios/OpenTaskWidgets/WidgetPushHandler.swift`, compiled into both),
///   `widgetPush.*` keys, the phone app's bundle id, platform `ios`/`macos`.
/// - `.watch` — the watch's Smart Stack card
///   (`ios/OpenTaskWatchWidgets/WatchWidgetPushHandler.swift`),
///   `watch.widgetPush.*` keys, the WATCH app's bundle id, platform `watchos`.
///
/// The handlers themselves stay thin `@available`-gated `WidgetPushHandler`
/// conformances that pass the delivered token and the widget kinds here. This
/// file is Foundation-only and not gated, so it compiles into every target
/// that builds `ios/Shared/` (and `OpenTaskLogicTests`): below OS 26 nothing
/// is ever saved, so `retryIfNeeded()` — called from every timeline
/// provider's `getTimeline` — is a cheap no-op there.
///
/// The rules it keeps, each learned the hard way:
///
/// 1. **An empty widget list never unregisters** (2026-09-25, "the Mac has no
///    widget push token"). Apple's docs say `pushTokenDidChange` also comes
///    "when [a person's] configured widgets change", and the handler used to
///    DELETE the token then. But the Mac's chronod sends an empty list
///    whenever it starts: after a reboot (2026-09-23 19:02:52 it ran `initial`
///    reloads for all three placed OpenTask widgets, then at 19:03:04 logged
///    "Sending 0 WidgetInfo instance(s) to 1 PushHandler instances") and after
///    a reinstall's `killall chronod` (22:09:01, the same). Each one deleted
///    the server's row while the widgets were on the desktop, and the list
///    with the real widgets came back only when chronod next re-evaluated
///    push — 14 hours later that night. A token with no widget behind it
///    costs one ignored push; APNs reports a truly dead one as Unregistered
///    and the server deletes it then (`sendApnsWidgetReload`). So an empty
///    list is just logged. Nothing shows watchOS behaves differently, so the
///    watch follows the same rule (2026-09-29) until it does.
///
/// 2. **Saved BEFORE the network call, then sent.** WidgetKit hands a token
///    over once and does not redeliver it on its own schedule, so one lost
///    request used to leave the device unregistered until the widget was
///    removed and re-added (2026-09-23: the Mac's request died with
///    NSURLErrorNetworkConnectionLost, and a second attempt never logged an
///    outcome — the extension was suspended mid-request). The saved token is
///    retried from every timeline reload until the server confirms it.
///    Re-sending an already-registered token is harmless (the server upserts
///    on `push_token`), which is what makes "retry on every reload until
///    confirmed" safe rather than a guess.
///
/// 3. **Every delivery is sent, even of a token the server once confirmed**
///    (2026-09-25). `savePending` forgets the earlier confirmation. The server
///    can drop a row without the extension ever hearing about it — APNs
///    answering Unregistered or BadDeviceToken while the app was deleted
///    mid-reinstall makes `sendApnsWidgetReload` delete it — and the
///    reinstalled app gets the SAME token back (chronod: "Public token has not
///    changed"; the App Group, and with it the old "registered" mark, survives
///    deleting the app on macOS). The Mac sat exactly there: its App Group
///    said `8038d39b…` was registered, prod had no row for it, and
///    `retryIfNeeded()` skipped it on every reload. A delivery from WidgetKit
///    is the one moment it's known the token is live, so it is always worth
///    one POST.
///
/// The APNs environment sent with the token follows the signing entitlement,
/// not the build configuration — `APIClient.registerWidgetToken` reads it
/// from `ApsEnvironment`.
struct WidgetPushRegistration: Sendable {
    /// Sends one registration: `POST /api/push/apns/widget-token`. Injected so
    /// the logic tests never reach `APIClient` (whose Keychain has no seam).
    typealias Sender = @Sendable (_ token: String, _ bundleId: String, _ platform: String, _ widgetKind: String) async throws -> Void

    /// UserDefaults key namespace: `widgetPush` (phone/Mac) or
    /// `watch.widgetPush` (watch). Stored names must not change — an
    /// installed extension's pending/registered state lives under them.
    let keyPrefix: String
    /// The CONTAINING APP's bundle id, not the extension's own: the server
    /// computes the APNs topic as `<bundle_id>.push-type.widgets`.
    let bundleId: String
    /// `ios`, `macos` or `watchos` — the route rejects anything else.
    let platform: String
    /// The App Group suite the state is kept in, so it survives the
    /// extension being suspended or relaunched between a delivery and a
    /// successful request.
    let suiteName: String
    let log: Logger
    var send: Sender = { token, bundleId, platform, widgetKind in
        try await APIClient.shared.registerWidgetToken(
            token: token, bundleId: bundleId, platform: platform, widgetKind: widgetKind
        )
    }

    private var pendingTokenKey: String { "\(keyPrefix).pendingToken" }
    private var pendingKindsKey: String { "\(keyPrefix).pendingKinds" }
    private var registeredTokenKey: String { "\(keyPrefix).registeredToken" }

    private var defaults: UserDefaults? { UserDefaults(suiteName: suiteName) }

    /// What a handler's `pushTokenDidChange` does with WidgetKit's delivery:
    /// hex-encode the token (the same idiom the apps use for the regular APNs
    /// device token), ignore an empty widget list (rule 1), then save and
    /// send (rules 2 and 3). Returns the send's task, `nil` when nothing was
    /// saved; the handler ignores it, tests await it.
    @discardableResult
    func tokenDelivered(_ tokenData: Data, widgetKinds: [String]) -> Task<Void, Never>? {
        let token = tokenData.map { String(format: "%02.2hhx", $0) }.joined()
        log.notice("pushTokenDidChange: \(widgetKinds.count, privacy: .public) widget(s), token \(String(token.prefix(8)), privacy: .public)")

        guard !widgetKinds.isEmpty else {
            log.notice("pushTokenDidChange with no widgets; keeping the registration")
            return nil
        }

        // Informational only (schema.sql: widget_kind is not used to decide
        // who gets a push — every token for a user gets one). Joined because
        // WidgetKit can report more than one placed instance to a single
        // handler call.
        let kinds = Set(widgetKinds).sorted().joined(separator: ",")
        savePending(token: token, widgetKind: kinds)
        return Task { await retryIfNeeded() }
    }

    /// A token WidgetKit just delivered: saved, and marked unconfirmed so the
    /// next `retryIfNeeded()` sends it even if an earlier delivery of the same
    /// token was confirmed (rule 3).
    func savePending(token: String, widgetKind: String) {
        defaults?.set(token, forKey: pendingTokenKey)
        defaults?.set(widgetKind, forKey: pendingKindsKey)
        defaults?.removeObject(forKey: registeredTokenKey)
    }

    /// Send the saved token if the server hasn't confirmed it yet.
    func retryIfNeeded() async {
        guard let defaults,
              let token = defaults.string(forKey: pendingTokenKey),
              defaults.string(forKey: registeredTokenKey) != token
        else { return }
        let kinds = defaults.string(forKey: pendingKindsKey) ?? ""
        do {
            try await send(token, bundleId, platform, kinds)
            defaults.set(token, forKey: registeredTokenKey)
            log.notice("registered widget push token for [\(kinds, privacy: .public)]")
        } catch {
            // Left pending: the next timeline reload tries again. Also the
            // path for a widget placed before the app ever connected to a
            // server (no Bearer token in the Keychain yet — APIError.notConfigured).
            log.error("registration failed for [\(kinds, privacy: .public)], will retry on next reload: \(String(describing: error), privacy: .public)")
        }
    }
}
