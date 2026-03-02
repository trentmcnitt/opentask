import UIKit

/// Handles home screen quick actions (long-press app icon) for warm launch.
///
/// SwiftUI's WindowGroup uses the scene-based lifecycle, so quick actions
/// are routed to the scene delegate — not UIApplicationDelegate.performActionFor.
/// This delegate is registered via AppDelegate.configurationForConnecting.
///
/// For cold launch, the shortcut item is captured in configurationForConnecting
/// and processed by OpenTaskApp's scenePhase observer instead.
class QuickActionSceneDelegate: UIResponder, UIWindowSceneDelegate {

    func windowScene(
        _ windowScene: UIWindowScene,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else {
            completionHandler(false)
            return
        }
        appDelegate.handleShortcutItem(shortcutItem, completionHandler: completionHandler)
    }
}
