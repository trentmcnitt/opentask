# Notifications

Reference for OpenTask's notification system: architecture, platform capabilities, and constraints.

## Architecture

Two channels:

- **Web Push** — primary channel for all overdue task notifications. Browser-native via the Push API and VAPID keys. No third-party relay, no rate limit. Tap opens the PWA directly to the task page.
- **Pushover** — critical alerts only. Emergency priority (2) with 5-minute retry, expires after 1 hour. Bypasses Focus mode and Do Not Disturb on iOS. Tapping opens the Pushover app (not the PWA) — the value is interruption, not navigation.

ntfy was previously used but removed due to rate limiting (250 msg/day free tier via the ntfy.sh upstream relay required for iOS push delivery).

Notifications run as in-process cron jobs via `node-cron` in `src/instrumentation.ts`. Two checks run sequentially every minute:

1. `checkOverdueTasks()` — queries tasks where `due_at < now`, filters by per-task cooldown, sends via Web Push
2. `checkCriticalTasks()` — queries overdue P4 (Urgent) tasks, sends via Pushover (emergency priority)

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
  -> Update last_notified_at

Urgent (P4) tasks — Pushover critical alerts:
  -> Pushover emergency alert (bypasses Focus/DND, 5-min retry, 1-hour expire)
  -> Update last_critical_alert_at (independent cooldown, 60 min)
```

### Repeat intervals (auto-snooze)

| Priority    | Default interval | User-configurable            |
| ----------- | ---------------- | ---------------------------- |
| P4 (Urgent) | 5 min            | `auto_snooze_urgent_minutes` |
| P3 (High)   | 15 min           | `auto_snooze_high_minutes`   |
| P0-P2       | 30 min           | `auto_snooze_minutes`        |

Per-task `auto_snooze_minutes` overrides the user default.

### Files

| File                                                   | Purpose                                                               |
| ------------------------------------------------------ | --------------------------------------------------------------------- |
| `src/core/notifications/overdue-checker.ts`            | Overdue task polling, Web Push delivery                               |
| `src/core/notifications/critical-alerts.ts`            | P4 (Urgent) alerts via Pushover emergency priority                    |
| `src/core/notifications/web-push.ts`                   | Web Push send utility (`sendPushNotification`, `isWebPushConfigured`) |
| `src/hooks/usePushSubscription.ts`                     | Client-side push subscription management hook                         |
| `src/app/api/push/subscribe/route.ts`                  | Push subscription storage endpoint                                    |
| `src/app/api/push/test/route.ts`                       | Quick push test (sends to current user)                               |
| `src/app/api/notifications/actions/route.ts`           | Action callback handler (done, snooze30, snooze, snooze2h)            |
| `src/app/api/notifications/test/route.ts`              | Test notification endpoint (individual, high, bulk, critical)         |
| `src/app/api/notifications/validate-pushover/route.ts` | Pushover key validation                                               |
| `src/instrumentation.ts`                               | Cron scheduling                                                       |

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
- Tap opens PWA directly (unlike Pushover which opens its own app)

### Apple Watch

Web Push notifications show on Apple Watch but are not interactive — no action buttons, tap opens PWA on the paired iPhone.

### Environment variables

| Variable            | Purpose                                                             |
| ------------------- | ------------------------------------------------------------------- |
| `VAPID_PUBLIC_KEY`  | VAPID public key (generate with `npx web-push generate-vapid-keys`) |
| `VAPID_PRIVATE_KEY` | VAPID private key                                                   |
| `VAPID_EMAIL`       | Contact email for VAPID (e.g., `mailto:you@example.com`)            |

Set in systemd service override files on the server (standalone Next.js does NOT read `.env.local`).

## Pushover

Proprietary service. $4.99 one-time per platform. 10,000 messages/month free per application.

### What works on iOS

| Feature                       | Status                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| Push delivery                 | Fast (sub-second typical)                                                          |
| Critical Alerts               | Yes — Pushover has Apple's entitlement. User must enable in Pushover app settings. |
| Emergency priority with retry | Repeats every N seconds until acknowledged                                         |
| Emergency cancellation        | By receipt ID or by tag                                                            |
| Custom sounds per message     | 23 built-in + user-uploaded custom sounds                                          |
| Supplementary URL             | Clickable link below message text (not a button)                                   |
| TTL (auto-expire)             | Messages can auto-delete after N seconds                                           |
| Cross-device dismissal sync   | Supported but throttled on iOS                                                     |

### What does not work

| Feature                | Status                                                                 |
| ---------------------- | ---------------------------------------------------------------------- |
| Open PWA directly      | Tap opens Pushover app; URL link opens Safari, never the installed PWA |
| Action buttons         | Not supported. Only supplementary URL links.                           |
| Per-notification icons | Icons are per-application only                                         |
| Notification grouping  | No API control. All Pushover notifications stack together.             |
| Scheduled delivery     | Not supported. Server must handle timing.                              |

### Priority levels

| Priority | Name      | iOS behavior                                                                                                       |
| -------- | --------- | ------------------------------------------------------------------------------------------------------------------ |
| -2       | Lowest    | No notification generated                                                                                          |
| -1       | Low       | Banner, no sound                                                                                                   |
| 0        | Normal    | Sound + banner per device settings                                                                                 |
| 1        | High      | Bypasses quiet hours, always plays sound. Maps to Time Sensitive.                                                  |
| 2        | Emergency | Repeats until acknowledged. Maps to Critical (if user enabled). Requires `retry` (min 30s) and `expire` (max 3hr). |

### Critical Alerts

Pushover is one of few third-party apps with Apple's Critical Alerts entitlement. Critical Alerts bypass the mute switch, Do Not Disturb, and all Focus modes.

- User must enable in Pushover app settings (separate toggles for high and emergency priority)
- Volume is controlled within Pushover, independent of device volume
- The API cannot force a notification to be a Critical Alert — it sends priority 1 or 2, and the user's settings determine whether iOS treats it as critical

### Current integration

`critical-alerts.ts` sends Pushover emergency (priority 2) for overdue P4 (Urgent) tasks. Uses `last_critical_alert_at` for a 60-minute cooldown independent of Web Push. Requires:

- `PUSHOVER_TOKEN` env var (application API token)
- Per-user `pushover_user_key` in the database, or `PUSHOVER_USER` env var as fallback

Pushover payloads include `url` and `url_title` params pointing to the task page in OpenTask.

### Environment variables

| Variable         | Purpose                                                  |
| ---------------- | -------------------------------------------------------- |
| `PUSHOVER_TOKEN` | Pushover application API token                           |
| `PUSHOVER_USER`  | Default Pushover user key (fallback if not set per-user) |

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

Neither Web Push (PWA) nor Pushover expose `thread-id` to the API. Only a native app can control fine-grained grouping.

### Cross-device notification dismissal

Native apps remove delivered notifications via `removeDeliveredNotifications(withIdentifiers:)`, triggered by a silent push. This is how Todoist and Things clear notifications when a task is completed on another device.

Third-party services cannot reliably do this:

- Pushover's cross-device dismissal sync exists but is throttled by iOS
- Web Push has no mechanism for dismissing delivered notifications

### Notification actions

Native apps can register up to 4 action buttons per notification category. Pushover has no action button support. PWA push notifications on iOS have no custom action support — only a default "View" action.

## User settings

Configured in Settings > Notifications:

- Browser Push toggle (subscribe/unsubscribe per device)
- Pushover user key (with validation)
- Auto-snooze intervals (tiered by priority)
- Test notification buttons (individual, high, bulk, critical)
