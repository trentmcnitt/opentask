import Foundation
import Intents
import os
import UserNotifications

let notificationIconLog = Logger(subsystem: "io.mcnitt.opentask", category: "notification-icons")

/// The five push kinds that wear their own icon (the server's `icon`;
/// not `kind`, which the deadlines nag already uses to route a tap).
enum NotificationKind: String, CaseIterable {
    case quota, reminder, period, task, deadline

    /// The avatar PNG, bundled with this extension (`Avatars/<kind>.png`,
    /// written by `ios/scripts/render-notification-avatars.mjs`).
    var avatar: INImage? {
        guard let url = Bundle.main.url(forResource: rawValue, withExtension: "png"),
              let data = try? Data(contentsOf: url)
        else { return nil }
        return INImage(imageData: data)
    }

    /**
     * The push as a communication notification from this kind, or nil (show it
     * as sent). The sender's name is the push's own title, so the banner's
     * first line reads as before; the conversation is the push's thread, so
     * the stacks (`ot-reminders`, `ot-tasks`, `ot-urgent`) stay as they are.
     */
    static func decorated(_ content: UNNotificationContent) -> UNNotificationContent? {
        guard let raw = content.userInfo["icon"] as? String,
              let kind = NotificationKind(rawValue: raw),
              let image = kind.avatar
        else {
            notificationIconLog.info("no kind or no avatar: shown as sent")
            return nil
        }
        let handle = INPersonHandle(value: "opentask-\(kind.rawValue)", type: .unknown)
        let sender = INPerson(
            personHandle: handle,
            nameComponents: nil,
            displayName: content.title,
            image: image,
            contactIdentifier: nil,
            customIdentifier: "opentask-\(kind.rawValue)"
        )
        let body = labelledBody(content)
        let intent = INSendMessageIntent(
            recipients: nil,
            outgoingMessageType: .outgoingMessageText,
            content: body,
            speakableGroupName: nil,
            conversationIdentifier: content.threadIdentifier.isEmpty ? nil : content.threadIdentifier,
            serviceName: nil,
            sender: sender,
            attachments: nil
        )
        #if os(iOS)
        // iOS also reads the image as the intent's parameter image; macOS has
        // no such call and takes the sender's own image.
        intent.setImage(image, forParameterNamed: \.sender)
        #endif
        do {
            let updated = try content.updating(from: intent)
            notificationIconLog.info("decorated a \(kind.rawValue, privacy: .public) push")
            return keepingOriginal(updated, from: content, body: body)
        } catch {
            notificationIconLog.error("could not decorate a \(kind.rawValue, privacy: .public) push: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    /**
     * The label line ("Quota · Health · 1 of 2 today") as the body's first
     * line. iOS draws no `subtitle` on a communication notification (seen on
     * the iOS 26 simulator, 2026-11-07), so the server's subtitle — which an
     * older build, with no extension, still shows as a subtitle — moves into
     * the body here. No subtitle: the body as sent.
     */
    static func labelledBody(_ content: UNNotificationContent) -> String {
        content.subtitle.isEmpty ? content.body : "\(content.subtitle)\n\(content.body)"
    }

    /// `updating(from:)` makes a new content: put back everything the app
    /// depends on that it might not carry over.
    static func keepingOriginal(
        _ updated: UNNotificationContent,
        from original: UNNotificationContent,
        body: String
    ) -> UNNotificationContent {
        guard let copy = updated.mutableCopy() as? UNMutableNotificationContent else { return updated }
        copy.title = original.title
        copy.subtitle = ""
        copy.body = body
        copy.categoryIdentifier = original.categoryIdentifier
        copy.threadIdentifier = original.threadIdentifier
        copy.userInfo = original.userInfo
        copy.badge = original.badge
        copy.sound = original.sound
        copy.interruptionLevel = original.interruptionLevel
        copy.relevanceScore = original.relevanceScore
        copy.targetContentIdentifier = original.targetContentIdentifier
        return copy
    }
}
