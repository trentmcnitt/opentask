# Notifications

Reference for OpenTask's notification system: architecture, platform capabilities, and constraints.

## Architecture

Two channels:

- **Web Push** — primary channel for all overdue task notifications. Browser-native via the Push API and VAPID keys. No third-party relay, no rate limit. Tap opens the PWA directly to the task page.
- **APNs** — iOS native app push notifications. Token-based auth with a p8 key file. Supports `time-sensitive` interruption level for P4 tasks (breaks through Focus mode). Supports notification coalescing via `collapseId` and cross-device dismissal via silent push.

ntfy was previously used but removed due to rate limiting. Pushover was previously used for critical alerts but removed — APNs `time-sensitive` interruption level handles P4 natively.

Notifications run as in-process cron jobs via `node-cron` in `src/instrumentation.ts`. Two checks run sequentially every minute:

1. `checkOverdueTasks()` — queries tasks where `due_at < now`, filters by per-task cooldown, sends via Web Push and APNs (P0-P3 only for APNs)
2. `checkCriticalTasks()` — queries overdue P4 (Urgent) tasks, sends via APNs with `time-sensitive` interruption level (independent cooldown)

P4 tasks get APNs exclusively from `checkCriticalTasks()` to avoid duplicate notifications. They still get Web Push from `checkOverdueTasks()` for desktop coverage.

Both run on a poll-based model: the cron fires every ~60 seconds and looks for tasks that are already overdue.

### Timing precision

The cron pattern `* * * * *` fires once per minute with no sub-second guarantee. A task due at 10:00:00 is first noticed at ~10:00:xx or ~10:01:xx. Sequential execution of both checkers and per-notification HTTP requests add further delay.

Other task apps (Todoist, Things, Apple Reminders) pre-schedule notifications at the exact `due_at` time. A hybrid approach — pre-schedule for exact timing, poll as safety net — would improve precision. See `docs/NOTIFICATION-PLAN.md` for status.

### Notification flow

```
Task becomes overdue
  -> Cron discovers it (up to ~60s delay)
  -> Cooldown check: skip if notified within interval
  -> P2+ tasks: individual Web Push notification
  -> P0-P1 single task: individual Web Push notification
  -> P0-P1 multiple tasks: bulk summary with link to /?filter=overdue
  -> APNs: individual notification per task (P0-P3 only, P4 handled by critical alerts)
  -> Update last_notified_at

Urgent (P4) tasks — critical alerts:
  -> APNs time-sensitive notification (breaks through Focus mode)
  -> Update last_critical_alert_at (independent cooldown, 60 min)
```

### Notification dismissal

When a task is snoozed, completed, or deleted from any device/web UI, `dismissAllNotifications()` sends dismiss signals to both Web Push and APNs. On iOS, APNs sends a silent push (`content-available: 1`) with `type: "dismiss"` and `taskIds`. The app's `didReceiveRemoteNotification` handler removes matching delivered notifications.

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

| File                                         | Purpose                                                               |
| -------------------------------------------- | --------------------------------------------------------------------- |
| `src/core/notifications/overdue-checker.ts`  | Overdue task polling, Web Push + APNs delivery                        |
| `src/core/notifications/critical-alerts.ts`  | P4 (Urgent) alerts via APNs time-sensitive                            |
| `src/core/notifications/web-push.ts`         | Web Push send utility (`sendPushNotification`, `isWebPushConfigured`) |
| `src/core/notifications/apns.ts`             | APNs send utility (`sendApnsNotification`, `isApnsConfigured`)        |
| `src/core/notifications/dismiss.ts`          | Shared dismiss helper (`dismissAllNotifications`)                     |
| `src/hooks/usePushSubscription.ts`           | Client-side push subscription management hook                         |
| `src/app/api/push/subscribe/route.ts`        | Push subscription storage endpoint                                    |
| `src/app/api/push/test/route.ts`             | Quick push test (sends to current user)                               |
| `src/app/api/notifications/actions/route.ts` | Action callback handler (done, snooze30, snooze, snooze2h)            |
| `src/app/api/notifications/test/route.ts`    | Test notification endpoint (individual, high, bulk, critical)         |
| `src/instrumentation.ts`                     | Cron scheduling                                                       |

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

Set in systemd service override files on the server (standalone Next.js does NOT read `.env.local`).

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

- **Interruption levels**: `active` for P0-P2, `time-sensitive` for P3-P4 (breaks Focus mode)
- **Collapse ID**: `task-{id}` prevents stacking — same task replaces its previous notification
- **Silent push dismiss**: Server sends `content-available: 1` with dismiss payload to clear notifications
- **Stale token cleanup**: Automatically removes device tokens on `BadDeviceToken`/`Unregistered` errors

### Environment variables

| Variable         | Purpose                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `APNS_KEY_ID`    | Key ID from Apple Developer portal                                 |
| `APNS_TEAM_ID`   | Team ID from Apple Developer portal                                |
| `APNS_KEY_PATH`  | Path to .p8 key file (e.g., `/opt/opentask/AuthKey_XXXXXXXXXX.p8`) |
| `APNS_BUNDLE_ID` | App bundle ID (e.g., `io.mcnitt.opentask`)                         |

## iOS platform constraints

These apply regardless of which notification service is used.

### Interruption levels (iOS 15+)

| Level          | Behavior                                              | Breaks Focus?        | Breaks DND?  |
| -------------- | ----------------------------------------------------- | -------------------- | ------------ |
| Passive        | Silent delivery, notification center only             | No                   | No           |
| Active         | Standard sound and banner                             | No                   | No           |
| Time Sensitive | Immediate, breaks through Focus and Scheduled Summary | Yes (if user allows) | No           |
| Critical       | Bypasses mute, DND, all Focus modes                   | Yes (always)         | Yes (always) |

Time Sensitive requires the `com.apple.developer.usernotifications.time-sensitive` capability (no Apple review needed). Critical requires `com.apple.developer.usernotifications.critical-alerts` (Apple must approve, restricted to health/safety/security apps).

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
