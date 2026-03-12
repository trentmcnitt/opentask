import UIKit

/// Wraps SwiftUI's internal scene delegate to intercept performActionFor
/// for home screen quick actions on warm launch.
///
/// SwiftUI replaces the scene delegate set in configurationForConnecting
/// with its own internal delegate, which doesn't forward performActionFor
/// to our code. This interceptor wraps SwiftUI's delegate and intercepts
/// only performActionFor — all other delegate methods are forwarded to
/// the original delegate via Objective-C message forwarding.
///
/// Installed by OpenTaskApp's scenePhase observer when the scene becomes active.
class SceneDelegateInterceptor: NSObject, UIWindowSceneDelegate {

    /// Strong reference to keep the interceptor alive (windowScene.delegate is weak)
    static var instance: SceneDelegateInterceptor?

    /// The original SwiftUI scene delegate — receives all forwarded calls
    private var original: AnyObject?

    init(wrapping original: AnyObject?) {
        self.original = original
        super.init()
    }

    // MARK: - Quick Action Handling

    func windowScene(
        _ windowScene: UIWindowScene,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        QuickActionHandler.handle(shortcutItem, completionHandler: completionHandler)
    }

    // MARK: - Message Forwarding

    override func responds(to aSelector: Selector!) -> Bool {
        if super.responds(to: aSelector) { return true }
        return original?.responds(to: aSelector) ?? false
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        if let original, original.responds(to: aSelector) {
            return original
        }
        return super.forwardingTarget(for: aSelector)
    }
}
