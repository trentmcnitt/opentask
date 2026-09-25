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
| `src/core/notifications/slot-reminders.ts`   | Slot-open push for reminders and quota prompts (`pendingSlotNotifications`, `waitingBySlot`)  |
| `src/core/notifications/slot-nags.ts`        | Hourly nag for unfinished slots (`pendingSlotNags`, `slotNagBody`)                            |
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

### Time-slot notifications (reminders and quota prompts)

Reminders never notify individually: a time slot sends one `SLOT_REMINDER` push when it opens (`slot-reminders.ts`), and an hourly nag re-surfaces unfinished slots, at most three a day (`slot-nags.ts`). Both are APNs only, `interruption-level: active`, thread `ot-reminders`, `collapseId: slot-<id>`. The long-press checklist fetches the slot's live group from `GET /api/reminders`.

**Quota prompts count exactly like reminders** (2026-09-24, phase 3 of quota reminders). A slot's waiting items are its reminders plus its quota prompts that are neither considered nor done (`waitingBySlot`, reading `getQuotaPromptsBySlot`). So:

- A slot with only prompts still gets its slot-open push.
- A slot stays unfinished for the nags until every reminder and every prompt is considered or done.
- The body counts both. A zero side is left out:

| Waiting        | Slot-open body                   | Nag body (other unfinished slots appended)         |
| -------------- | -------------------------------- | -------------------------------------------------- |
| Reminders only | `3 reminders waiting`            | `3 reminders waiting, and 1 earlier slot`          |
| Prompts only   | `2 quotas waiting`               | `2 quotas waiting, and 2 earlier slots`            |
| Both           | `3 reminders · 2 quotas waiting` | `1 reminder · 1 quota waiting, and 1 earlier slot` |

- userInfo: `reminder_count` is the total of reminders plus waiting prompts, which is what the checklist header shows while it loads. `prompt_count` is how many of those are prompts.
- Off switches: with the user's `quota_prompts_enabled` off, or `OPENTASK_QUOTA_PROMPTS=off` on the server, prompts are gone from the pushes, the nags and their counts too. They live inside `getQuotaPromptsBySlot`.
- Never in the badge: `countCurrentlyDue` excludes quotas (`is_tracked` / `progress_target > 1`) and reminders.
- Cost: prompts are computed only for a user whose slot opens this minute, or who is awake at the top of the hour with nags left to spend today. That is one quota query per call, never one per minute for every user.
- The native checklist shows at most 8 rows (`maxVisibleRows`), reminders first, then prompts, then "+N more". "Complete all" covers every row, including hidden ones. It considers waiting prompts without logging progress, except prompts staged as "did it", which keep their +1.

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

## WidgetKit push (widget sync)

A third, narrower channel — not for user-facing notifications, for keeping the iOS/macOS home-screen and Lock Screen **widgets** in sync with data changed elsewhere (web app, other device). Uses Apple's WidgetKit push API (iOS 26 / macOS 26 —
[Updating widgets with WidgetKit push notifications](https://developer.apple.com/documentation/widgetkit/updating-widgets-with-widgetkit-push-notifications)),
which sits alongside APNs above but is a distinct token, topic, and push type.

### Why

Without this, a widget only refreshes on its own ~30 min timeline, when the app comes to foreground, or when the widget's own `AppIntent` runs (`docs` in `ios/CLAUDE.md` § Widgets). A change made anywhere else could take up to half an hour to reach a widget. WidgetKit push closes that gap opportunistically — Apple still budgets and may delay delivery, so it is an addition to the timeline policy, not a replacement for it.

### How it works

1. Each widget kind's `WidgetConfiguration` attaches a `WidgetPushHandler` conformance via the `.pushHandler(_:)` modifier (`ios/OpenTaskWidgets/TasksWidget.swift`, `RemindersWidget.swift`, `TrackWidget.swift` — one shared handler type, `OpenTaskWidgetPushHandler` in `WidgetPushHandler.swift`, reused across all three per Apple's docs: "If you have multiple widget configurations, you can choose to use the same push handler type").
2. The system calls `pushTokenDidChange(_ pushInfo: WidgetPushInfo, widgets: [WidgetInfo])` — once for the first token, and again whenever it changes or the user adds/removes a widget. `pushInfo.token: Data` is the widget extension's own push token, hex-encoded (same `%02.2hhx` idiom as the main app's APNs token) before it goes over the wire.
3. The handler POSTs to `POST /api/push/apns/widget-token` (`WidgetPushRegistrar` in `WidgetPushHandler.swift`) — same Keychain-shared Bearer token as the rest of the app, read directly rather than through `APIClient`'s private request helpers (that file was under parallel edit; see the doc comment in `WidgetPushHandler.swift`). If `widgets` comes back **empty** (the user removed the last OpenTask widget), the handler calls `DELETE /api/push/apns/widget-token` instead of registering a token nobody will read.
4. The server stores the token in `widget_push_tokens` (`user_id`, `push_token` unique, `bundle_id`, `platform`, `widget_kind`, `environment`, timestamps — `src/core/db/schema.sql`).
5. Whenever this user's data changes, the same `emitSyncEvent(userId)` that already drives the SSE stream for open browser tabs (`src/lib/sync-events.ts`) also schedules a widget push for each of the user's registered tokens (`src/core/notifications/widget-push.ts`), paced **per token** by the coalescing policy below — not one push per change.
6. When a token's push is due, `sendApnsWidgetReload(tokenId)` (`src/core/notifications/apns.ts`) re-reads that row and sends one push: `apns-push-type: widgets`, topic `<app bundle id>.push-type.widgets` (computed from the stored `bundle_id`, NOT the widget extension's own bundle id — Apple's docs use the containing app's id), body `{"aps": {"content-changed": true}}`. WidgetKit reloads that extension's timelines on receipt, equivalent to a `reloadAllTimelines()` call triggered from the server. Each send logs `Sending widget reload push to token <id> (<platform>) for user <id>`.
7. Stale tokens (`BadDeviceToken`/`Unregistered`, same reasons as `apns_devices`) are deleted automatically on send failure.

### Coalescing (push budget)

Apple budgets widget pushes per device with an undisclosed daily allowance and drops them silently once it is spent (separate from the ~40–70 timeline reloads a day a frequently viewed widget gets). The original 2s-per-user debounce only merged a bulk action's events; a person working down a list on the web (edits 3–15s apart) still sent one push per edit. On 2026-09-25 prod logged 46 pushes (to 2–3 tokens each) between 07:05 and 13:35 — 11 inside one minute — and Trent's iPhone reported its widget push budget at −17, so pushes that mattered stopped arriving.

The policy, per token (each token is one device's widget extension, with its own budget):

| Rule                                        | Behavior                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Prompt first push                           | A change after a quiet spell goes out after a 2s settle, which still merges a bulk action's many sync events.                                                                                                                                                                                                                                                                                                      |
| Minimum interval + guaranteed trailing push | After a push, that token gets no other push for `OPENTASK_WIDGET_PUSH_MIN_INTERVAL_SECONDS` (default **300**). Changes inside the window collapse into ONE push at the window's end, so the widget always ends on the final state. Worst-case cross-device lag is the window (vs the widget's own 30 min timeline).                                                                                                |
| Quiet hours                                 | A push due between the user's `sleep_time` and `wake_time` (their timezone, same waking window as the hourly slot nag) is held until `wake_time`; overnight changes ride that one push. Tradeoff: a late-night edit on another device reaches the phone's widget by push only in the morning (the widget's timeline or opening the app still refresh it). `OPENTASK_WIDGET_PUSH_QUIET_HOURS=false` turns this off. |
| Widget-visible changes only                 | An emit marked `emitSyncEvent(userId, { widgets: false })` pushes nothing: a notes-only edit (`isWidgetVisibleEdit` in `src/core/tasks/update.ts`), an `ai-*`-only label change, re-queuing or failing AI enrichment. Unmarked emits count as visible.                                                                                                                                                             |
| macOS exempt                                | chronod logs a Mac widget push as free (`ios/CLAUDE.md` § Widgets "Budget"), so `macos` tokens keep settle-only pacing and no quiet hours. iOS and watchOS get the full policy.                                                                                                                                                                                                                                    |

Why 300s: replaying the 2026-09-25 morning through the policy gives 46 → 16 pushes (180s → 18, 600s → 14 — past 5 min the cut flattens while the lag keeps growing). That extrapolates to roughly 35 a day on a heavy day and far fewer on a normal one, under even the low end of Apple's reload guidance. `0` restores settle-only behavior (useful on a dev server). Both env vars are read at startup; on the standalone server they go in the systemd unit, not `.env.local`.

Not done: skipping the push to the device that made the change. Nothing in a request says which device sent it — the apps and widgets share one Keychain Bearer token and send no client header, and `widget_push_tokens` has no link to `api_tokens`. It would need the apps to send e.g. `X-OpenTask-Client` plus a device id, and to register that id with the widget token. It would not have helped the 2026-09-25 bursts, which were web `[session]` edits.

### Never sent to the demo user

`widget-push.ts` excludes `is_demo` users when it picks the tokens to push — the demo account resets every 4 hours and nobody has a demo widget placed.

### Entitlement

Both widget extension targets need the capability Apple's docs describe as "Add the capability to use remote push notifications to your widget extension target" — a widget extension's own push entitlement, distinct from (and in addition to) the containing app's. The key itself differs by platform, and getting this wrong fails **silently** (the build succeeds; the entitlement is just missing from the signed binary, with no error anywhere):

- **iOS** (`ios/OpenTaskWidgets/project.yml`): bare `aps-environment`, same key the main app and watch app already carry.
- **watchOS** (`ios/project.yml`, `OpenTaskWatchWidgets`, 2026-09-24): bare `aps-environment`, like the watch app. The Smart Stack card's handler is `WatchWidgetPushHandler` (`ios/OpenTaskWatchWidgets/`), registering `platform: "watchos"` with the WATCH app's bundle id, `io.mcnitt.opentask.watchapp` (the watch app is its own app, not `io.mcnitt.opentask`), so the topic is `io.mcnitt.opentask.watchapp.push-type.widgets`. Verified in the watchOS 26.5 simulator: APNs sandbox accepted that topic and the simulator's `apsd` delivered `content-changed`, followed by a timeline reload.
- **macOS** (`macos/OpenTaskMacWidgets/project.yml`): `com.apple.developer.aps-environment` (prefixed) — confirmed empirically during this work: a Mac provisioning profile only grants the prefixed form, and Xcode silently drops any entitlement key the profile doesn't grant. The bare key signed and built cleanly while `codesign -d --entitlements -` showed it simply missing; switching to the prefixed key fixed it. This mirrors the existing landmine documented in `macos/OpenTaskMac/OpenTaskMac-Push.entitlements`, which already carries this exact prefix for the main Mac app's own push entitlement.

Both were verified by building each widget extension target directly (`xcodebuild ... -scheme OpenTaskWidgets` / `-scheme OpenTaskMacWidgets`) and inspecting `codesign -d --entitlements -` on the built `.appex`.

### Known gaps (unverified without a real device)

- If a widget is placed before the user has connected the app (no Bearer token in the Keychain yet), `pushTokenDidChange`'s registration POST fails silently — `APIError.notConfigured` is caught and logged, not retried. The token is not durably lost: `pushTokenDidChange` fires again for "the first push token you receive" the next time WidgetKit decides to re-deliver it (e.g. next widget reload), which self-heals but on no guaranteed schedule.
- Apple's docs say the topic is `<your bundleID>.push-type.widgets` without stating explicitly whether that is the containing app's bundle id or the extension's own. This implementation uses the **app's** bundle id (`io.mcnitt.opentask` / `io.mcnitt.opentask.mac`), inferred from Apple's own sample (`com.example.CaffeineTracker.push-type.widgets`, no extension suffix). A `BadTopic`/`TopicDisallowed` APNs error in the server log on a real send would mean this guess is wrong.
- Actual delivery — a push landing on a device and a widget visibly reloading — needs a real device on iOS 26 / macOS 26 and cannot be verified in this environment.

## User settings

Configured in Settings > Notifications:

- Browser Push toggle (subscribe/unsubscribe per device)
- Auto-snooze intervals (tiered by priority)
- Test notification buttons (individual, high, bulk, critical)
