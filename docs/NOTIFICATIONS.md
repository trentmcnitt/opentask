# Notifications

Reference for OpenTask's notification system: architecture, platform capabilities, and constraints.

## Architecture

Two channels:

- **Web Push** — primary channel for all overdue task notifications. Browser-native via the Push API and VAPID keys. No third-party relay, no rate limit. Tap opens the PWA directly to the task page.
- **APNs** — iOS native app push notifications. Token-based auth with a p8 key file. P4 (Urgent) tasks use Apple Critical Alerts (`interruption-level: critical`) which bypass mute, DND, and all Focus modes with a user-configurable volume. P3 (High) tasks use `time-sensitive` (breaks through Focus mode). Supports notification coalescing via `collapseId` and cross-device dismissal via silent push.

ntfy was previously used but removed due to rate limiting. Pushover was previously used for critical alerts but removed — APNs Critical Alerts handle P4 natively.

Notifications run as an in-process cron job via `node-cron` in `src/instrumentation.ts`. A single unified `checkOverdueTasks()` runs every minute and handles all priorities (P0-P4) in one pass, sending via both Web Push and APNs. The notification cron is independent of the AI enrichment cron — a stuck enrichment process can never block notification delivery.

Consolidation caps prevent notification flooding:

| Bucket  | Priorities | Individual cap | Summary if overflow                  |
| ------- | ---------- | -------------- | ------------------------------------ |
| Regular | P0-P2      | 4              | "N more tasks overdue"               |
| High    | P3         | 5              | "N more high priority tasks overdue" |
| Urgent  | P4         | Unlimited      | None                                 |

Within each bucket, highest priority tasks get individual notification slots first (P2 before P1 before P0), then most overdue. Both Web Push and APNs follow the same consolidation rules.

### Timing precision

The cron pattern `* * * * *` (node-cron) fires at the start of each calendar minute. Notification sends use `Promise.allSettled` for parallelism, so delivery typically completes within 1-2 seconds of the minute boundary.

### Notification flow

```
Task becomes overdue
  → Cron fires at minute boundary
  → Mod-based boundary check: floor((now - due_at) / 60000) % interval === 0
  → Split eligible tasks into 3 buckets (Regular, High, Urgent)
  → Per bucket: send individual Web Push + APNs up to cap
  → If overflow: send 1 summary Web Push + 1 summary APNs
  → No DB writes — boundary detection is stateless
```

### Notification dismissal

When a task is snoozed, completed, or deleted from any device/web UI, `dismissNotificationsForTasks()` sends dismiss signals to both Web Push and APNs. On iOS, APNs sends a silent push (`content-available: 1`) with `type: "dismiss"` and `taskIds`. The app's `didReceiveRemoteNotification` handler removes matching delivered notifications.

### Notification coalescing

APNs notifications include `collapseId: "task-{id}"`. iOS replaces (not stacks) notifications for the same task across cooldown cycles.

### Repeat intervals (auto-snooze)

| Priority    | Default interval | User-configurable            |
| ----------- | ---------------- | ---------------------------- |
| P4 (Urgent) | 5 min            | `auto_snooze_urgent_minutes` |
| P3 (High)   | 15 min           | `auto_snooze_high_minutes`   |
| P0-P2       | 30 min           | `auto_snooze_minutes`        |

Per-task `auto_snooze_minutes` overrides the user default.

### Files

| File                                         | Purpose                                                                                       |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/core/notifications/overdue-checker.ts`  | Unified overdue checker with consolidation (all priorities)                                   |
| `src/core/notifications/web-push.ts`         | Web Push send utility (`sendPushNotification`, `isWebPushConfigured`)                         |
| `src/core/notifications/apns.ts`             | APNs send utility (`sendApnsNotification`, `sendApnsSummaryNotification`, `isApnsConfigured`) |
| `src/core/notifications/dismiss.ts`          | Shared dismiss helper (`dismissNotificationsForTasks`)                                        |
| `src/hooks/usePushSubscription.ts`           | Client-side push subscription management hook                                                 |
| `src/app/api/push/subscribe/route.ts`        | Push subscription storage endpoint                                                            |
| `src/app/api/push/test/route.ts`             | Quick push test (sends to current user)                                                       |
| `src/app/api/notifications/actions/route.ts` | Action callback handler (done, snooze30, snooze, snooze2h)                                    |
| `src/app/api/notifications/test/route.ts`    | Test notification endpoint (individual, high, bulk, critical)                                 |
| `src/instrumentation.ts`                     | Cron scheduling                                                                               |

## Web Push

Browser-native push via the W3C Push API. Uses VAPID (Voluntary Application Server Identification) keys for authentication between the app server and the browser's push service.

### How it works

1. Client calls `PushManager.subscribe()` with the VAPID public key
2. Browser returns a `PushSubscription` with an endpoint URL and encryption keys
3. Server stores the subscription in `push_subscriptions` table
4. To send: server encrypts the payload and POSTs to the subscription endpoint
5. Browser's push service delivers to the device
6. Service worker (`public/sw.js`) receives the `push` event and shows the notification
7. On tap: `notificationclick` handler opens/focuses the PWA to the task URL

### iOS constraints (Safari)

- No action buttons — silently ignored
- No `tag` replacement — broken, stacks instead of replacing (open WebKit bug)
- No `icon` — always shows PWA icon
- No silent push — every push must show a notification
- `notification.data` works on iOS 18+
- `notification.close()` works on iOS 18.3+
- Tap opens PWA directly

### Apple Watch

Web Push notifications show on Apple Watch but are not interactive — no action buttons, tap opens PWA on the paired iPhone.

### Environment variables

| Variable            | Purpose                                                             |
| ------------------- | ------------------------------------------------------------------- |
| `VAPID_PUBLIC_KEY`  | VAPID public key (generate with `npx web-push generate-vapid-keys`) |
| `VAPID_PRIVATE_KEY` | VAPID private key                                                   |
| `VAPID_EMAIL`       | Contact email for VAPID (e.g., `mailto:you@example.com`)            |

Set as environment variables on the server (standalone Next.js does NOT read `.env.local`).

## APNs (iOS Native App)

Token-based authentication with Apple's Push Notification service. Requires an Apple Developer Program membership and a p8 key file.

### How it works

1. Server authenticates with APNs using a JWT signed with the p8 key
2. Device registers for notifications and sends its device token to the server
3. Server stores the device token in `apns_devices` table
4. To send: server constructs a notification payload and POSTs to APNs
5. APNs delivers to the device
6. iOS shows the notification with registered action buttons (Done, +1hr, All +1hr)

### Features

- **Interruption levels**: `active` for P0-P2, `time-sensitive` for P3, `critical` for P4 (bypasses mute/DND with configurable volume)
- **Collapse ID**: `task-{id}` prevents stacking — same task replaces its previous notification
- **Silent push dismiss**: Server sends `content-available: 1` with dismiss payload to clear notifications
- **Stale token cleanup**: Automatically removes device tokens on `BadDeviceToken`/`Unregistered` errors

### Environment variables

| Variable         | Purpose                                                       |
| ---------------- | ------------------------------------------------------------- |
| `APNS_KEY_ID`    | Key ID from Apple Developer portal                            |
| `APNS_TEAM_ID`   | Team ID from Apple Developer portal                           |
| `APNS_KEY_PATH`  | Path to .p8 key file (e.g., `/path/to/AuthKey_XXXXXXXXXX.p8`) |
| `APNS_BUNDLE_ID` | App bundle ID (e.g., `io.mcnitt.opentask`)                    |

## iOS platform constraints

These apply regardless of which notification service is used.

### Interruption levels (iOS 15+)

| Level          | Behavior                                              | Breaks Focus?        | Breaks DND?  |
| -------------- | ----------------------------------------------------- | -------------------- | ------------ |
| Passive        | Silent delivery, notification center only             | No                   | No           |
| Active         | Standard sound and banner                             | No                   | No           |
| Time Sensitive | Immediate, breaks through Focus and Scheduled Summary | Yes (if user allows) | No           |
| Critical       | Bypasses mute, DND, all Focus modes                   | Yes (always)         | Yes (always) |

Time Sensitive requires the `com.apple.developer.usernotifications.time-sensitive` capability (no Apple review needed). Critical requires `com.apple.developer.usernotifications.critical-alerts` (Apple must approve for App Store apps; works without approval for personal/ad-hoc builds). OpenTask uses Critical for P4 (Urgent) overdue notifications with the user's `critical_alert_volume` preference (0.0-1.0, default 1.0).

### Notification grouping

Users can configure per-app in Settings > Notifications > [App] > Notification Grouping:

- **Automatic**: App controls grouping via `thread-id`
- **By App**: All notifications from the app in one stack
- **Off**: Every notification separate

### Cross-device notification dismissal

Native apps remove delivered notifications via `removeDeliveredNotifications(withIdentifiers:)`, triggered by a silent push. This is how OpenTask clears notifications when a task is snoozed/completed from the web UI.

Requires the `remote-notification` background mode in the app's entitlements.

### Notification actions

Native apps can register up to 4 action buttons per notification category. OpenTask registers: Done, +1hr, All +1hr. The content extension (Phase 4) can dynamically replace these with a snooze grid.

## User settings

Configured in Settings > Notifications:

- Browser Push toggle (subscribe/unsubscribe per device)
- Auto-snooze intervals (tiered by priority)
- Test notification buttons (individual, high, bulk, critical)
