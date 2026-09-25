import Foundation
import OSLog
import WidgetKit

/// `print` from a widget extension reaches no log anyone can read on a device;
/// this does (Console.app, `log show --predicate 'subsystem == "io.mcnitt.opentask.widgets"'`).
private let pushLog = Logger(subsystem: "io.mcnitt.opentask.widgets", category: "push")

/// Registers this widget extension's WidgetKit push token with the server so
/// a mutation made anywhere (web, other device) can trigger a widget reload
/// well inside the ~30 min timeline budget — see docs/NOTIFICATIONS.md
/// "WidgetKit push (widget sync)" and Apple's
/// https://developer.apple.com/documentation/widgetkit/updating-widgets-with-widgetkit-push-notifications
/// (iOS 26 / macOS 26 — hence every symbol here being `@available`-gated
/// rather than raising this extension's deployment target).
///
/// One shared handler type, attached via `.pushHandler(OpenTaskWidgetPushHandler.self)`
/// to all three widget kinds' `WidgetConfiguration` (`TasksWidget.swift`,
/// `RemindersWidget.swift`, `TrackWidget.swift`) — per Apple's own docs: "If
/// you have multiple widget configurations, you can choose to use the same
/// push handler type for those widget configurations." This file is also
/// compiled into the macOS widget extension (`macos/project.yml` references
/// this whole directory, unmodified — see macos/README.md), so one file
/// covers both platforms; only the app bundle id differs, guarded below.
///
/// This file, plus the `#available`-gated `.pushHandler(...)` attachment in
/// each of the three widget kind files' `body` (see the doc comment in
/// TasksWidget.swift for why that needs an `if/else` with explicit `return`,
/// not a one-line addition), are the only Swift changes for widget push sync
/// — `*WidgetViews.swift`, `WidgetIntents.swift`, and `WidgetStore.swift` were
/// under parallel edit and are untouched. That is also why the network call
/// below talks to the server directly instead of adding a method to
/// `APIClient` (ios/Shared/APIClient.swift): its `post`/`request` helpers are
/// `private` (file-scoped in Swift, so unreachable even from an `extension
/// APIClient` in a different file), and changing that access level would be
/// an edit to a file this pass was told to leave alone. `WidgetPushRegistrar`
/// below duplicates the small amount of request-building `post(path:body:)`
/// does, reading the same Keychain-shared `serverURL`/`bearerToken` via
/// `APIClient.shared`'s public accessors.
@available(iOS 26.0, macOS 26.0, *)
struct OpenTaskWidgetPushHandler: WidgetPushHandler {
    init() {}

    func pushTokenDidChange(_ pushInfo: WidgetPushInfo, widgets: [WidgetInfo]) {
        // Same hex-encoding idiom AppDelegate/MacAppDelegate use for the
        // regular APNs device token.
        let token = pushInfo.token.map { String(format: "%02.2hhx", $0) }.joined()
        pushLog.notice("pushTokenDidChange: \(widgets.count, privacy: .public) widget(s), token \(String(token.prefix(8)), privacy: .public)")

        // An EMPTY `widgets` list is NOT taken as "the last widget was
        // removed" any more (2026-09-25, "the Mac has no widget push token").
        // Apple's docs say the call also comes "when [a person's] configured
        // widgets change", and this used to unregister the token then. But
        // the Mac's chronod sends an empty list whenever it starts: after a
        // reboot (2026-09-23 19:02:52 it ran `initial` reloads for all three
        // placed OpenTask widgets, then at 19:03:04 logged "Sending 0
        // WidgetInfo instance(s) to 1 PushHandler instances") and after the
        // reinstall's `killall chronod` (22:09:01, the same). Each one
        // deleted the server's row while the widgets were on the desktop, and
        // the list with the real widgets came back only when chronod next
        // re-evaluated push — 14 hours later that night. A token with no
        // widget behind it costs one ignored push; APNs reports a truly dead
        // one as Unregistered and the server deletes it then
        // (`sendApnsWidgetReload`). So an empty list is just logged.
        guard !widgets.isEmpty else {
            pushLog.notice("pushTokenDidChange with no widgets; keeping the registration")
            return
        }

        // Informational only (schema.sql: widget_kind is not used to decide
        // who gets a push — every token for a user gets one). Joined because
        // WidgetKit can report more than one placed instance to a single
        // handler call.
        let kinds = Set(widgets.map(\.kind)).sorted().joined(separator: ",")

        // Saved BEFORE the network call, then sent. WidgetKit hands a token
        // over once and does not redeliver it on its own schedule, so one
        // lost request used to leave the device unregistered until the
        // widget was removed and re-added (2026-09-23: the Mac's request died
        // with NSURLErrorNetworkConnectionLost, and a second attempt never
        // logged an outcome — the extension was suspended mid-request). The
        // saved token is retried from every timeline reload until the server
        // confirms it — see `WidgetPushRegistration.retryIfNeeded()`.
        //
        // `savePending` also forgets any earlier confirmation, so this
        // delivery is always SENT, even when it's the same token the server
        // once confirmed (2026-09-25). The server can drop a row without the
        // extension ever hearing about it — APNs answering Unregistered or
        // BadDeviceToken while the app was deleted mid-reinstall makes
        // `sendApnsWidgetReload` delete it — and the reinstalled app gets the
        // SAME token back (chronod: "Public token has not changed"; the App
        // Group, and with it the old "registered" mark, survives deleting the
        // app on macOS). The Mac sat exactly there: App Group said
        // `8038d39b…` was registered, prod had no row for it, and
        // `retryIfNeeded()` skipped it on every reload. A delivery from
        // WidgetKit is the one moment it's known the token is live, so it is
        // always worth one POST (the server upserts).
        WidgetPushRegistration.savePending(token: token, widgetKind: kinds)
        Task { await WidgetPushRegistration.retryIfNeeded() }
    }
}

/// The token this extension has been given and whether the server has it,
/// kept in the App Group so it survives the extension being suspended or
/// relaunched between `pushTokenDidChange` and a successful request.
///
/// Not `@available`-gated: on an OS without widget push nothing is ever
/// saved, so `retryIfNeeded()` — called from all three timeline providers'
/// `getTimeline` — is a cheap no-op there. Re-sending an already-registered
/// token is harmless (the server upserts on `push_token`), which is what makes
/// "retry on every reload until confirmed" safe rather than a guess.
enum WidgetPushRegistration {
    private static let pendingTokenKey = "widgetPush.pendingToken"
    private static let pendingKindsKey = "widgetPush.pendingKinds"
    private static let registeredTokenKey = "widgetPush.registeredToken"

    private static var defaults: UserDefaults? { UserDefaults(suiteName: WidgetStore.appGroup) }

    /// A token WidgetKit just delivered: saved, and marked unconfirmed so the
    /// next `retryIfNeeded()` sends it even if an earlier delivery of the same
    /// token was confirmed — see the call site in `pushTokenDidChange`.
    static func savePending(token: String, widgetKind: String) {
        defaults?.set(token, forKey: pendingTokenKey)
        defaults?.set(widgetKind, forKey: pendingKindsKey)
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
            try await WidgetPushRegistrar.register(token: token, widgetKind: kinds)
            defaults.set(token, forKey: registeredTokenKey)
            pushLog.notice("registered widget push token for [\(kinds, privacy: .public)]")
        } catch {
            // Left pending: the next timeline reload tries again. Also the
            // path for a widget placed before the app ever connected to a
            // server (no Bearer token in the Keychain yet — APIError.notConfigured).
            pushLog.error("registration failed for [\(kinds, privacy: .public)], will retry on next reload: \(String(describing: error), privacy: .public)")
        }
    }
}

/// The server side of the widget push token lifecycle:
/// `POST /api/push/apns/widget-token` (the extension no longer sends the
/// route's `DELETE` — see the empty-`widgets` guard above; mirrors
/// `APIClient.registerDevice`/`unregisterDevice` for the app's own APNs
/// token, but for the WIDGET EXTENSION's push token — see the doc comment on
/// `OpenTaskWidgetPushHandler` above for why this isn't just added to
/// `APIClient` itself).
private enum WidgetPushRegistrar {
    #if os(macOS)
    /// The CONTAINING APP's bundle id — NOT this extension's own
    /// (`io.mcnitt.opentask.mac.widgets`). Apple's docs give the APNs topic
    /// for a widget push as `<your bundleID>.push-type.widgets`, and the
    /// sample there (`com.example.CaffeineTracker.push-type.widgets`, no
    /// extension suffix) reads as the app's id, not the extension's — the
    /// server computes the full topic by appending that suffix to whatever
    /// `bundle_id` is registered here. Unverified without a real send: see
    /// docs/NOTIFICATIONS.md § WidgetKit push, "Known gaps."
    private static let appBundleId = "io.mcnitt.opentask"
    private static let platform = "macos"
    #else
    private static let appBundleId = "io.mcnitt.opentask"
    private static let platform = "ios"
    #endif

    static func register(token: String, widgetKind: String) async throws {
        // The APNs environment a token belongs to is fixed by the SIGNING
        // entitlement (`aps-environment`), not the build configuration. Both
        // project.yml files grant `development` to every build, Release
        // included — the Mac app is installed as a Release build — so a
        // `#if DEBUG` switch registered Release tokens as "production", whose
        // pushes APNs rejects (BadDeviceToken), and the server then deleted
        // them. Change this together with `aps-environment` if the apps are
        // ever distributed with a production entitlement.
        let environment = "development"

        try await send(method: "POST", body: [
            "push_token": token,
            "bundle_id": appBundleId,
            "platform": platform,
            "environment": environment,
            "widget_kind": widgetKind,
        ])
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
