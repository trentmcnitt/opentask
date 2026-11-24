import Foundation

/**
 * CLEAN UP AS A BANNER ARRIVES (2026-11-23, Trent: "I completed these items
 * already on the desktop. I don't know why my notifications didn't go away").
 *
 * The server's silent `dismiss` push reached the Mac, but the iPhone never
 * ran it: iOS rations silent pushes (a burst of four in twenty seconds,
 * none delivered), and a banner can be removed only while the app's code
 * runs. A VISIBLE push is different: iOS always runs the Notification
 * Service Extension for one with `mutable-content` (the five kinds with an
 * icon). So that extension now reconciles first (`reconcileDeliveredBanners`,
 * `POST /api/notifications/stale`, the server's rules), then shows its own
 * banner: the next banner to arrive clears every one that no longer stands.
 *
 * This type is the extension's delivery, kept out of it so it can be tested:
 * the cleanup runs, THEN the content goes to iOS, exactly once. When iOS
 * says time is up first (`serviceExtensionTimeWillExpire`), the push as
 * sent goes at once, and the cleanup's late finish delivers nothing more.
 * The cleanup never blocks a banner for longer than its own request's
 * timeout (12 s, under the extension's ~30 s), and never fails one: a
 * failed reconcile removes nothing and the banner still shows.
 */
final class PushDelivery<Content> {
    private let lock = NSLock()
    private var handler: ((Content) -> Void)?
    private let original: Content

    init(original: Content, handler: @escaping (Content) -> Void) {
        self.original = original
        self.handler = handler
    }

    /// Run `cleanup`, then deliver `content` (unless time already ran out).
    func deliver(_ content: Content, after cleanup: @escaping () async -> Void) {
        Task {
            await cleanup()
            self.finish(content)
        }
    }

    /// iOS is out of patience: the push as sent, now.
    func expire() {
        finish(original)
    }

    /// Whether the content has gone to iOS.
    var delivered: Bool {
        lock.lock()
        defer { lock.unlock() }
        return handler == nil
    }

    private func finish(_ content: Content) {
        lock.lock()
        let handler = self.handler
        self.handler = nil
        lock.unlock()
        handler?(content)
    }
}
