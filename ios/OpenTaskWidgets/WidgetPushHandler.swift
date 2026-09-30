import Foundation
import OSLog
import WidgetKit

/// Registers this widget extension's WidgetKit push token with the server so
/// a mutation made anywhere (web, other device) can trigger a widget reload
/// well inside the ~30 min timeline budget — see docs/NOTIFICATIONS.md
/// "WidgetKit push (widget sync)". iOS 26 / macOS 26, hence the
/// `@available` gate rather than raising this extension's deployment target.
///
/// One shared handler type, attached via `.pushHandler(OpenTaskWidgetPushHandler.self)`
/// to all three widget kinds' `WidgetConfiguration` (`TasksWidget.swift`,
/// `RemindersWidget.swift`, `TrackWidget.swift`) — per Apple's own docs: "If
/// you have multiple widget configurations, you can choose to use the same
/// push handler type for those widget configurations." This file is also
/// compiled into the macOS widget extension (`macos/project.yml` references
/// this whole directory, unmodified — see macos/README.md), so one file
/// covers both platforms; only the platform differs, guarded below. Each
/// kind's `body` attaches the handler in an `#available` branch (see the doc
/// comment in TasksWidget.swift for why that needs an `if/else` with explicit
/// `return`).
///
/// The handler is a thin wrapper: the token's state machine (save before
/// send, retry from every reload until confirmed, never unregister on an
/// empty widget list) is `WidgetPushRegistration` in ios/Shared, which the
/// watch's Smart Stack handler uses too.
@available(iOS 26.0, macOS 26.0, *)
struct OpenTaskWidgetPushHandler: WidgetPushHandler {
    init() {}

    func pushTokenDidChange(_ pushInfo: WidgetPushInfo, widgets: [WidgetInfo]) {
        WidgetPushRegistration.widgets.tokenDelivered(pushInfo.token, widgetKinds: widgets.map(\.kind))
    }
}

extension WidgetPushRegistration {
    /// The phone's and the Mac's widget extension. Not `@available`-gated:
    /// the three timeline providers call `retryIfNeeded()` on every OS.
    ///
    /// `bundleId` is the CONTAINING APP's id on both platforms — NOT the Mac
    /// extension's own (`io.mcnitt.opentask.mac.widgets`). Apple's docs give
    /// the APNs topic for a widget push as `<your bundleID>.push-type.widgets`,
    /// and the sample there (`com.example.CaffeineTracker.push-type.widgets`,
    /// no extension suffix) reads as the app's id, not the extension's. Still
    /// unverified on the Mac without a real send: see docs/NOTIFICATIONS.md
    /// § WidgetKit push, "Known gaps."
    ///
    /// The log subsystem is where `print` can't reach on a device
    /// (Console.app, `log show --predicate 'subsystem == "io.mcnitt.opentask.widgets"'`).
    static let widgets: WidgetPushRegistration = {
        #if os(macOS)
        let platform = "macos"
        #else
        let platform = "ios"
        #endif
        return WidgetPushRegistration(
            keyPrefix: "widgetPush",
            bundleId: "io.mcnitt.opentask",
            platform: platform,
            suiteName: WidgetStore.appGroup,
            log: Logger(subsystem: "io.mcnitt.opentask.widgets", category: "push")
        )
    }()
}
