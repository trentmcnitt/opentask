import Intents
import UserNotifications

/**
 * THE KIND'S ICON ON THE LEFT (Trent, 2026-11-07, round 4 of the mockups): a
 * push the server marks with `icon` — quota, reminder, period, task,
 * deadline — is shown as a COMMUNICATION notification whose "sender" is
 * that kind, so iOS draws the kind's avatar in the app icon's place and the
 * app icon as the small corner badge.
 *
 * How (Apple's communication notifications): an `INSendMessageIntent` whose
 * sender `INPerson` carries the avatar (`NotificationKind.avatar`, a PNG
 * bundled in this extension, never downloaded), then
 * `content.updating(from:)`. The intent is NOT donated: a donated sender
 * would turn up in the share sheet's suggestions as a contact named "Quota".
 *
 * Everything else the push carries is kept exactly — category (the action
 * buttons, the content extension's checklist), thread, `userInfo` (the
 * action runner reads `taskId`, `prompt_key`, `reminder_day`), badge, sound
 * (critical included) and interruption level: `updating(from:)` returns a new
 * content, so they are written back onto it (`NotificationKind.keepingOriginal`).
 *
 * No `icon`, an unknown one, or any failure: the push is shown as sent —
 * today's look. The server only asks for this extension (`mutable-content`)
 * on the five kinds, so every other push never reaches it.
 *
 * AND IT CLEANS UP FIRST, on the iPhone (2026-11-23, `PushDelivery`): before
 * its own banner shows, the delivered banners that no longer stand are
 * removed (`reconcileDeliveredBanners`) — iOS rations the silent `dismiss`
 * push, but always runs this extension for a visible one. Not on the Mac:
 * its app is always running and gets every silent push, and this sandboxed
 * extension has no access to the stored credentials there.
 */
final class NotificationService: UNNotificationServiceExtension {
    #if os(iOS)
    private var delivery: PushDelivery<UNNotificationContent>?
    #else
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var original: UNNotificationContent?
    #endif

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        let content = NotificationKind.decorated(request.content) ?? request.content
        #if os(iOS)
        let delivery = PushDelivery(original: request.content, handler: contentHandler)
        self.delivery = delivery
        delivery.deliver(content) { await reconcileDeliveredBanners() }
        #else
        self.contentHandler = contentHandler
        original = request.content
        contentHandler(content)
        #endif
    }

    /// Out of time: the push as sent.
    override func serviceExtensionTimeWillExpire() {
        #if os(iOS)
        delivery?.expire()
        #else
        if let contentHandler, let original { contentHandler(original) }
        #endif
    }
}
