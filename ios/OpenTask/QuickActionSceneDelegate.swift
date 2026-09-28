import UIKit

/// Receives Home Screen quick actions for the app's one window scene.
///
/// Registered as the scene configuration's `delegateClass` in
/// `AppDelegate.application(_:configurationForConnecting:options:)` — Apple's
/// documented route for a SwiftUI-lifecycle app. SwiftUI still owns the
/// window (this class never creates one); it only adds the two quick-action
/// entry points:
/// - cold launch: the item arrives in `connectionOptions.shortcutItem`;
/// - warm launch: `windowScene(_:performActionFor:)`.
///
/// It replaces `SceneDelegateInterceptor` (2026-09-28), which swapped itself
/// in for SwiftUI's own scene delegate on each activation and relied on the
/// `scenePhase` observer for cold launches. Trent's "Snooze All +1hr" from
/// the icon menu reached neither: the server saw no request at all.
final class QuickActionSceneDelegate: NSObject, UIWindowSceneDelegate {

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let item = connectionOptions.shortcutItem else { return }
        QuickActionHandler.log.notice("Quick action (cold launch): \(item.type, privacy: .public)")
        QuickActionHandler.handle(item) { _ in }
    }

    func windowScene(
        _ windowScene: UIWindowScene,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        QuickActionHandler.log.notice("Quick action (warm launch): \(shortcutItem.type, privacy: .public)")
        QuickActionHandler.handle(shortcutItem, completionHandler: completionHandler)
    }
}
