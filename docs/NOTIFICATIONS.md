# Notifications

Reference for OpenTask's notification system: architecture, platform capabilities, and constraints.

**Overdue** (2026-10-21). From 2026-10-10 to 2026-10-21 the UI said "over target"; Trent ruled it back to "overdue". Either way it means a task whose target (`due_at`) has arrived. The notifier, the badge and the sweeps always used the code names (`checkOverdueTasks`, `getOverdueCount`, `snooze-overdue`). What reaches the user reads from the `OVERDUE_WORD` / `OVERDUE_LOWER` constants (`src/lib/task-model-words.ts`): "Overdue task", "N more tasks overdue", "2 High still overdue". Two things changed beyond the word, both below: a deadline with no target nags from its stored automatic target (since 2026-10-12; until then an implied one) — with the task-queue switch on (2026-10-22) it has none and the deadlines page's own nag speaks for it instead (§ The deadlines-page nag), and task segments never notify. See `docs/TASK-MODEL.md` § Deadline, target, horizon.

## Architecture

Two channels:

- **Web Push** — primary channel for all overdue task notifications. Browser-native via the Push API and VAPID keys. No third-party relay, no rate limit. Tap opens the PWA directly to the task page.
- **APNs** — iOS native app push notifications. Token-based auth with a p8 key file. P4 (Urgent) tasks use Apple Critical Alerts (`interruption-level: critical`) which bypass mute, DND, and all Focus modes with a user-configurable volume. Everything else, P3 (High) included, is `active`: a banner and a sound that respect Focus (since 2026-10-26, Trent: only Urgent breaks through; nights are the phone's Sleep mode's to handle — until then High was `time-sensitive`). Supports notification coalescing via `collapseId` and cross-device dismissal via silent push.

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
  → Cron fires at minute boundary (the minute tick, minute-tick.ts)
  → Boundary check: the first push at the due minute, then repeats on clock
    marks (`isNotificationBoundary` → `isRepeatMinute`, nag-marks.ts)
  → Split eligible tasks into 3 buckets (Regular, High, Urgent)
  → Per bucket: one send per task up to cap, plus 1 summary if overflow
  → The tick picks ONE alerting push per user; the rest go out passive (tick.ts)
  → Deliver on Web Push + APNs
  → No DB writes — boundary detection is stateless
```

### Notification dismissal

When a task is deferred, completed, skipped, deleted or has its date moved, from any device, the web UI or the API, `dismissNotificationsForTasks()` sends dismiss signals to both Web Push and APNs. The core mutation makes the call (`markDone`, `updateTask`, `bulkSnooze`, …), not the route, so every caller gets it; the header of `src/core/notifications/dismiss.ts` lists them. On iOS, APNs sends a silent push (`content-available: 1`) with `type: "dismiss"` and `taskIds`. The app's `didReceiveRemoteNotification` handler removes matching delivered notifications.

### Notification coalescing

APNs notifications include `collapseId: "task-{id}"` (the overflow summary: `overdue-summary`). iOS replaces (not stacks) notifications for the same task across cooldown cycles. Since 2026-10-22 (nag-map fix #6) the overdue Web Push carries the same string as its `tag`, so the browser replaces too instead of stacking a banner per repeat, with `renotify: true` so the replacement still alerts (a tagged replacement is otherwise shown silently). `public/sw.js` passes `renotify` only with a tag and never with `silent` — the browser throws a TypeError for either. Every other push already had a tag equal to its collapse id.

### Repeat intervals (nag)

| Priority    | Default interval | User-configurable            |
| ----------- | ---------------- | ---------------------------- |
| P4 (Urgent) | 5 min            | `auto_snooze_urgent_minutes` |
| P3 (High)   | 15 min           | `auto_snooze_high_minutes`   |
| P2 (Medium) | 60 min           | `auto_snooze_medium_minutes` |
| P1 (Low)    | 240 min          | `auto_snooze_low_minutes`    |
| P0 (Unset)  | 30 min           | `auto_snooze_minutes`        |

Per-task `auto_snooze_minutes` overrides the user default. The tier rung comes from the one nag ladder (`src/core/notifications/nag-ladder.ts`, below), whose `overdue` row is these columns as set.

The first notification goes out on the checker's tick at the due minute (the query takes `due_at <= now`), exactly, and only once — see `isNotificationBoundary()` in `overdue-checker.ts`. Since 2026-10-26 every **repeat lands on a clock mark** (§ Clock marks, below): a P3 task due at 8:07 notifies at 8:07, 8:15, 8:30, 8:45 (until 10-26: 8:07, 8:22, 8:37). The checker stays stateless: the first repeat is `nextNagAt(first push)`, every later one a fixed step on, all derived from the due time.

**With the task-queue switch on (2026-10-22) a deadline with no target has no automatic target any more**: it sits on the deadlines page from its lead day and the page's own nag speaks for it (§ The deadlines-page nag, below); it is never overdue and never in the badge until a target is picked. The paragraph that follows is the switch-off behaviour, kept for one release (plan A1).

**A deadline's target is stored, so it nags like any target** (spec §8, 2026-10-12; `docs/TASK-MODEL.md` § Deadline). A one-off with a deadline and no target the user picked carries a real **automatic target** (`target_auto`): the user's `morning_time` 3 days before the deadline's local day (4 when the deadline was set 16 or more days out; now, if that moment has already passed — overdue at once). The checker reads `due_at` alone (`getCurrentlyDueTaskIds`, `src/core/tasks/currently-due.ts`), so a deadline task starts nagging at that target at its priority's interval, exactly like a picked one. There is no read-time implied target, no `deadline_nag_off` and no deadline-day re-arm any more: an automatic target moves with its deadline, and Remove target on a deadline task is "Back to auto" (the automatic target again), never silence. **Every snooze stops at a deadline that is still ahead** — a single snooze, a notification button, a quick snooze, a sweep (`capAtDeadline`) — so no snooze can carry a task past its cutoff; to go later, change or remove the deadline. Once the deadline has passed the cap is off (any target can be picked), nagging continues at the same cadence, the row carries a past-deadline marker in the app, and a sweep treats the task like High. The badge (`getOverdueCount` → `countCurrentlyDue`) counts the same tasks.

### Clock marks (2026-10-26)

`src/core/notifications/nag-marks.ts`. A first push is exact (a period at 9:15 pushes at 9:15, a target deferred to 10:07 fires at 10:07); every **repeat** of every nag — overdue, the slot nag, the deadlines nag — snaps to the user's local clock (Trent, 2026-10-26):

- **The grid.** G = 60 for an interval I of 60 or more; below that, the largest divisor of 60 that is ≤ I (5 → 5, 10 → 10, 15 → 15, 30 → 30, 45 → 30). Marks are local wall-clock minutes divisible by G, so G = 60 is the top of the local hour in a half-hour zone too.
- **The next send** is the mark nearest `last + I`; a tie goes to the earlier mark (`nextNagAt`). From a 16:30 push at I = 60 the nag comes at 17:00; from 20:15 at 21:00; from 8:15 at I = 120 at 10:00.
- **The gap** that gives between one send and the next: I 5 → 3–7 min, 10 → 5–14, 30 → 15–44, 60 → 30–89, 120 → 90–149, 240 → 210–269, 480 → 450–509. Never under half the interval (G ≤ I).
- **On a mark the step is fixed**: S = I rounded to the nearest multiple of G (60 → 60, 90 → 60, 150 → 120). That keeps the overdue checker stateless (`isRepeatMinute`): the k-th repeat is the mark nearest `first repeat + k·S`.
- **Every mark in its own offset.** A candidate mark is judged in the UTC offset that holds at it, not at the target. In a zone whose DST change isn't a whole hour (Australia/Lord_Howe moves 30 minutes) a fixed UTC step would leave every later repeat at :30 local; snapping each step to the nearest real local mark keeps them on :00 (a skipped local time is no mark, a repeated one is a mark twice). In whole-hour zones the step's target is already a mark, so repeats keep their real-time spacing through spring forward and fall back (Chicago, hourly: 01:00 CST, 03:00 CDT, 04:00 …; 01:00 CDT, 01:00 CST, 02:00 …). `tests/behavioral/dn-nag-marks.test.ts` pins both.
- **A missed minute is a missed repeat.** The overdue checker is stateless, so a minute the cron does not run (downtime, a stuck check) loses that minute's repeat; the next one comes at the next step. Accepted, as before marks. The `nag_sends`-paced nags send at the first tick after downtime instead.
- **Several rungs at once** (the slot nag's waiting items, the deadlines page's rows): the rung whose next mark comes **first** sets the pace (`nagPace` in `nag-sends.ts`) — "the shortest interval wins" made exact, since with marks a shorter interval does not always land sooner (from 10:07, I 15 → 10:15 but I 10 → 10:20).

### One alert per tick (2026-10-26)

`src/core/notifications/tick.ts`, run by `runMinuteTick()` (`minute-tick.ts`). Each minute every sender — the overdue checker, the slot-open push, the slot nag, the named reminder pushes, the named quota-prompt pushes, the deadlines nag, in that order — **plans** its sends instead of sending them. The coordinator then, per user:

1. **Claims** the minute, per sender and user (`claimTickMinute`: a compare-and-swap in `nag_sends` under the sender's `tick-overdue` / `tick-slot-open` / `tick-slot-nag` / `tick-reminder-nags` / `tick-prompt-nags` / `tick-deadlines` key, holding the minute it last sent), so a second run of the same minute sends nothing that sender already sent — the startup check beside the cron, or a deploy's new process overlapping the old one's last tick. Then each send's own claim, in source order (the nags' `nag_sends` compare-and-swap; the slot-open push's stamp of the slot nag's clock). A lost claim drops the send.
2. **Picks the lead**: the highest-ranked send that would **sound** on its own. A send that is silent by its own rule — the slot-open push and the slot nag, a Medium named reminder or quota-prompt push, the deadlines nag and its safety net (ruling 5: sound only on overdue) — never takes the lead in a minute where something would sound (Trent, 2026-10-26, on #362). Only when nothing in the minute would sound does the highest-ranked silent send lead, silently, still with the suffix. The ranking — Urgent overdue › High overdue › Urgent reminder or prompt › High reminder or prompt › deadlines safety net › Medium overdue › other overdue › Medium reminder or prompt › period (the slot-open push and the slot nag) › deadlines nag; a tie goes to the sender's own order. The reminder kinds are the named reminder pushes (§ Named reminder pushes), the prompt kinds the named quota-prompt pushes (§ Named quota-prompt pushes): a prompt ranks WITH the reminder of its quota's priority (`prompt_high` shares `reminder_high`'s rank, `SAME_RANK` in `tick.ts`; the tie goes to the reminder, planned first). High and Urgent sound, so a High reminder or prompt leads a Medium overdue; a Medium one is silent and only leads a minute in which nothing sounds. An overflow summary ranks with its bucket.
3. **The lead keeps its level and sound**, and its body gets **" · N more waiting"**, N being everything the tick's other banners speak for (1 per overdue banner, a summary's overflow, a period push's or nag's waiting items, the deadlines nag's rows). A snapshot; it can go stale (accepted, Trent).
4. **The rest still go out, the silent ones included, one banner each with its own actions, but passive**: APNs `interruption-level: passive` with no `sound` (the overflow summary gains an `aps.interruption-level` then), Web Push `silent: true` instead of `renotify`. **Except Urgent overdue: critical always**, lead or not.
5. **Delivers the lead first**, then the rest as planned, then the overdue checker's badge-only pushes. If the lead reached no device on any channel (every APNs device and Web Push subscription it was sent to failed, or the send threw), the next send that would sound is **promoted**: delivered as the alert, with its own " · N more waiting", and so on until one gets through. Nothing is delivered twice, and an Urgent overdue still waiting ends the search (it is critical anyway). A channel the user has nothing registered on is not a failure.

A user with one send this minute gets exactly what the sender built. Slot pushes are APNs only and the deadlines nag and a Medium reminder or prompt push are always silent on the web, so in a minute where only those are planned the browser gets no alert at all — one alert per user, not per channel. With an overdue push in the same minute, the overdue push always leads (it sounds), on both channels. (The tick itself, PR #362, changed no `data` field: nothing native or in `public/sw.js` needed to change for it; `sw.js` already passed `silent` through.)

Each sender's old `check*` entry point (`checkOverdueTasks`, `checkSlotReminders`, `checkSlotNags`, `checkReminderNags`, `checkPromptNags`, `checkDeadlineNags`) still exists and runs a tick with its own source alone (tests). The startup check (5 s after boot) runs the whole minute tick, through the same one-at-a-time guard as the cron (`makeNotificationTick` in `src/instrumentation.ts`).

**Measuring it: `scripts/count-pushes.ts`.** `npx tsx scripts/count-pushes.ts <db> --user <id> [--day yyyy-MM-dd] [--queue on|off] [--channels apns,web] [--json]` runs the real planners minute by minute over one OpenTask day on a temporary copy (never the input; delivery tables emptied; only that user notified) and prints counts only — per hour, alerting vs passive, by kind. Nothing is considered or done during the projected day; badge-only and non-tick pushes are not counted. Run it on a `.backup` copy of production.

**Task segments never notify.** Tasks whose target hasn't arrived sit in task segments on the reminders screen. They send no push, never count in a slot's push or the slot nag, and are never in the badge (`docs/TASK-MODEL.md` § Task segments).

### Files

| File                                                 | Purpose                                                                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/core/notifications/overdue-checker.ts`          | Unified overdue checker with consolidation (all priorities)                                                          |
| `src/core/notifications/web-push.ts`                 | Web Push send utility (`sendPushNotification`, `isWebPushConfigured`)                                                |
| `src/core/notifications/apns.ts`                     | APNs send utility (`sendApnsNotification`, `sendApnsSummaryNotification`, `isApnsConfigured`)                        |
| `src/core/notifications/dismiss.ts`                  | Shared dismiss helper (`dismissNotificationsForTasks`) and `syncBadgeCount`                                          |
| `src/core/notifications/badge-state.ts`              | Last badge sent per user — the overdue checker's change gate                                                         |
| `src/core/notifications/slot-reminders.ts`           | Slot-open push for reminders and quota prompts (`pendingSlotNotifications`, `waitingBySlot`)                         |
| `src/core/notifications/slot-nags.ts`                | Nag for unfinished slots, paced by priority (`pendingSlotNags`, `slotNagBody`)                                       |
| `src/core/notifications/reminder-nags.ts`            | Named pushes for Medium+ reminders (`pendingReminderNags`, `reminderWaitingOn`, `purgeGoneReminderNags`)             |
| `src/core/notifications/reminder-nag-rule.ts`        | Which reminders and prompts are pushed by name, not counted in their period (`getsNamedPush`, `promptGetsNamedPush`) |
| `src/core/notifications/prompt-nags.ts`              | Named pushes for Medium+ quotas' prompts (`pendingPromptNags`, `promptPushEndCheck`, `purgeOldPromptNags`)           |
| `src/core/notifications/enrichment-notify.ts`        | Quiet "AI finished" push for a just-added task (`notifyEnrichmentFinished`)                                          |
| `src/core/notifications/enrichment-failed-notify.ts` | Quiet "AI failed to process" push when enrichment fails for good (`notifyEnrichmentFailed`)                          |
| `src/core/notifications/sweep-feedback.ts`           | Quiet bulk defer feedback push (`planSweepFeedback`, `sendSweepFeedback`)                                            |
| `src/core/notifications/deadline-cap-feedback.ts`    | Quiet "Deferred to deadline 6:00 PM" push when a notification button's defer stopped at the deadline (ruling A3)     |
| `src/core/notifications/deadline-nags.ts`            | The deadlines-page nag (`pendingDeadlineNags`, `checkDeadlineNags`, `claimNagSend`)                                  |
| `src/core/notifications/nag-ladder.ts`               | The nag ladder: every nag's interval, keyed (kind, priority) (`NAG_LADDER`, `nagIntervalMinutes`)                    |
| `src/core/notifications/nag-marks.ts`                | Clock marks: where every repeat lands (`nextNagAt`, `isRepeatMinute`, `markGridMinutes`)                             |
| `src/core/notifications/nag-sends.ts`                | `nag_sends`: when a nag last went out (`claimNagSend`, `nagSendDue`, `nagPace`)                                      |
| `src/core/notifications/tick.ts`                     | The tick coordinator: one alerting push per user per minute (`planTick`, `runTick`, `LEAD_ORDER`)                    |
| `src/core/notifications/minute-tick.ts`              | The minute tick's senders, in order (`MINUTE_TICK_SOURCES`, `runMinuteTick`)                                         |
| `src/core/notifications/delivery-result.ts`          | What a push reached (`attempted` / `delivered`): the tick promotes a lead that reached nothing                       |
| `scripts/count-pushes.ts`                            | Projects one user's pushes over one OpenTask day, counts only, on a copy                                             |
| `src/core/notifications/notifiable-users.ts`         | Who the cron senders notify: notifications on and not demo (`notifiableUsers`, `notifiableUserSql`)                  |
| `src/hooks/usePushSubscription.ts`                   | Client-side push subscription management hook                                                                        |
| `src/app/api/push/subscribe/route.ts`                | Push subscription storage endpoint                                                                                   |
| `src/app/api/push/test/route.ts`                     | Quick push test (sends to current user)                                                                              |
| `src/app/api/notifications/actions/route.ts`         | Action callback handler (done — with `day`, the Considered button — snooze30, snooze, snooze2h, delete)              |
| `src/core/auth/same-origin.ts`                       | The cookie POST's same-origin check (`isSameOriginRequest`, `isCrossSiteCookieRequest`): actions, quota prompts      |
| `src/app/api/notifications/test/route.ts`            | Test notification endpoint (individual, high, bulk, critical)                                                        |
| `src/instrumentation.ts`                             | Cron scheduling                                                                                                      |

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

- No action buttons — silently ignored (the named reminder push's Considered button does not show there)
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

- **Interruption levels**: `active` for P0-P3, `critical` for P4 (bypasses mute/DND with configurable volume). P3 was `time-sensitive` until 2026-10-26; only Urgent breaks through Focus now
- **Collapse ID**: `task-{id}` prevents stacking — same task replaces its previous notification
- **Silent push dismiss**: Server sends `content-available: 1` with dismiss payload to clear notifications
- **Stale token cleanup**: Automatically removes device tokens on `BadDeviceToken`/`Unregistered` errors
- **App icon badge**: the overdue count, on the iPhone icon and the Mac Dock tile — see below

### App icon badge

The badge is the user's overdue count (`getOverdueCount` in `dismiss.ts`: open tasks past their effective target, no reminders, no quotas, no task-segment rows — those have not reached a target).

**The push.** A badge-only APNs notification (`buildBadgeNotification` in `apns.ts`):

```json
{ "aps": { "badge": 2 } }
```

Push type `alert`, priority 10, `apns-collapse-id: badge-update`, topic = the device's `bundle_id`. It has no `alert`, no `sound` and no `content-available`, so iOS and macOS apply the number themselves: no banner, no sound, no app wake-up. It goes to every `apns_devices` row except watch apps (`deviceShowsBadge`: bundle ids ending `.watchapp`/`.watchkitapp`; watchOS has no icon badge). Widget push tokens never get one. Overdue alerts carry the same number in their own `aps.badge`.

**Why not a silent push.** Until 2026-09-29 the badge went out as a silent push (`content-available: 1`, type `background`) that the app applied in `didReceiveRemoteNotification`. iOS delivers only a few of those an hour, and none while the app isn't running. The overdue checker sent one every minute to every device of a user with anything overdue (about 95 in 100 minutes to 5 devices one morning), so the one that mattered — the drop to 0 after a completion from a widget or the Mac — was dropped, and the icon kept saying 2.

**When it's sent.**

| Trigger                                                                        | Sends                                                                                                             |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| A mutation that can change the count (`syncBadgeCount`)                        | Always: done, snooze, delete, due-date edit, bulk ops, undo/redo, notification actions, device registration       |
| An overdue alert                                                               | Its `aps.badge`                                                                                                   |
| The overdue checker (every minute), badge-only                                 | Only when the user's count differs from the last badge sent to them — in practice, a task has just become overdue |
| The checker, for a user last sent a non-zero badge who now has nothing overdue | The 0, even if no user action sent it                                                                             |

The last value sent per user is kept in memory (`badge-state.ts`, on `globalThis`). A restart empties it, so the first tick re-sends each user's count once. A send that fails on any device clears the user's value, so the next tick retries.

**On the device.**

- `willPresent` returns `.badge` (iOS always; macOS in both branches). In the foreground iOS and macOS apply `aps.badge` only when asked, so without it the badge would go stale whenever the app is open.
- On activation the apps do NOT zero the badge any more. They fetch `GET /api/tasks/counts` (the Tasks page's own `countTasks`, the red pill's number) and set the badge from `overdue` (`refreshBadgeFromServer()` in `NotificationConstants.swift`). A failed fetch leaves the badge alone.
- After a notification action handled by the app delegate (Done, +1hr, All +1hr, a slot snooze), the app does the same fetch, instead of guessing "the payload's count minus one" (a count that was never the badge total). The content extension doesn't fetch: that would add a second round trip before the notification dismisses, and the server's badge push lands about a second later anyway.
- The legacy `type: "badge-update"` handler stays in both app delegates, for servers older than this change.

**Badge vs the Overdue pill.** Same population and the same answer for every task with a due date. Two edges differ: a recurring task with no `due_at` counts in the badge once today's scheduled time passes (the pill never counts an undated task), and the pill also counts other users' overdue tasks in a shared project. Neither existed on prod on 2026-09-29.

### Environment variables

| Variable         | Purpose                                                       |
| ---------------- | ------------------------------------------------------------- |
| `APNS_KEY_ID`    | Key ID from Apple Developer portal                            |
| `APNS_TEAM_ID`   | Team ID from Apple Developer portal                           |
| `APNS_KEY_PATH`  | Path to .p8 key file (e.g., `/path/to/AuthKey_XXXXXXXXXX.p8`) |
| `APNS_BUNDLE_ID` | App bundle ID (e.g., `io.mcnitt.opentask`)                    |

### Time-slot notifications (reminders and quota prompts)

None and Low reminders never notify individually: a time slot sends one `SLOT_REMINDER` push when it opens (`slot-reminders.ts`), and a nag re-surfaces unfinished slots (`slot-nags.ts`, § The slot nag below). Both are APNs only, `interruption-level: active`, thread `ot-reminders`, `collapseId: slot-<id>`. Both are silent banners, with no `sound` (ruling 5, Trent 2026-10-22: sound only on overdue). The long-press checklist fetches the slot's live group from `GET /api/reminders`.

**Medium and above are pushed by name** since 2026-10-26 (§ Named reminder pushes and § Named quota-prompt pushes, below) and are left out of both: `waitingBySlot` counts only the None and Low reminders (`getsNamedPush`) and the None and Low quota prompts, by their quota's priority (`promptGetsNamedPush`, Push PR 4), so a period with only Medium+ items waiting sends no period push and no period nag, and those never pace the nag. `reminder_count` in the slot push's userInfo counts the same, while the long-press checklist (live from `GET /api/reminders`) still lists every reminder in the slot, Medium+ included: the count is only the header's placeholder while it loads.

**Quota prompts count exactly like reminders** (2026-09-24, phase 3 of quota reminders). A slot's waiting items are its None/Low reminders plus its None/Low quota prompts that are neither considered nor done (`waitingBySlot`, reading `getQuotaPromptsBySlot`; a Medium+ quota's prompt has its own push since Push PR 4, as a Medium+ reminder does). So:

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
- Task segments (2026-10-10) are not slot items: `waitingBySlot` never reads them, so they never keep a slot unfinished, never add to a body's count and never trigger a push.
- On deck (2026-10-20, docs/TASK-MODEL.md § On deck): a slot-open push that already fires appends today's undone on-deck count — `3 reminders waiting · 5 on deck` — and carries it as `deck_count` in userInfo. Decks never make a slot fire (a slot with nothing but decks waiting stays silent), never keep a slot unfinished, never reach the slot nag or its body, and never count toward `reminder_count`. Task queue switch on only. Slot pushes are APNs-only, so a user with no periods, or with Web Push only, gets no count (accepted).
- Cost: prompts are computed only for a user whose slot opens this minute, or whose slot nag could be due by `nag_sends` (any rung's mark has come). That is one quota query per call (each prompt carries its quota's priority, which paces the nag), never one per minute for every user.
- The native checklist shows at most 8 rows (`maxVisibleRows`), reminders first, then prompts, then "+N more". "Complete all" covers every row, including hidden ones. It considers waiting prompts without logging progress, except prompts staged as "did it", which keep their +1.

## "AI finished" notification (just-added tasks)

Added 2026-09-29: "a notification whenever a task or a reminder is enriched. Kind of does the same thing as the Just added list, but you don't actually have to open the app at all." One quiet push per new task, sent when AI enrichment finishes. The code and its full rationale are in `src/core/notifications/enrichment-notify.ts`.

**Content** mirrors the Just added card (`JustAddedCard`), built from the task's state after enrichment, with the card's formatting helpers:

| Field | Value                                                                                                                                                                                                                             |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title | The task's cleaned title                                                                                                                                                                                                          |
| Body  | `Added to <project>`, then due (`formatDueTimeParts`, relative · absolute, user's timezone), priority label, recurrence (`formatRRule`), labels (not `ai-*`), joined by `·`. A reminder: `Added to <period>` instead, no due date |

Examples: `Added to Work · Tomorrow 9:00 AM · High`, `Added to Inbox · Mon 9:00 AM · Weekly on Monday at 9:00 AM`, `Added to Evening · Daily at 8:30 PM` (a reminder), and `Added to Inbox` when the AI filled in nothing.

**Delivery.** A banner without sound (passive — Notification Center only — until 2026-09-30):

- APNs (`buildEnrichedNotification` in `apns.ts`): `interruption-level: active`, no `sound`, APNs priority 10, `category: TASK_ADDED`, no `badge`, `thread-id` and `apns-collapse-id` `enriched-<id>`, `taskId` in the payload. A tap takes the apps' individual-task path and loads `/?task=<id>` (see [Tapping a task notification](#tapping-a-task-notification)); the `dismiss` silent push for that task (done, snooze, delete) clears it too.
- **Buttons (`TASK_ADDED`, added 2026-09-29):** **Done** and **Delete** (Delete is `.destructive`, drawn red, and not `.authenticationRequired` — it is the app's undoable soft delete, the same weight as Done). Registered by every app in `registerNotificationCategories()` (`ios/Shared/NotificationConstants.swift` — iPhone, Watch and Mac) and run by the shared `NotificationActionRunner`: Done posts `action: "done"` and Delete `action: "delete"` to `POST /api/notifications/actions` (token in the body), which calls `markDone` / `deleteTask` — undo-logged, notifications dismissed on every device, tabs and widgets synced. No snooze buttons: a task added a minute ago isn't overdue. `TASK_ADDED` is not in the content extension's `UNNotificationExtensionCategory` list, so iOS shows its own expanded view. A build older than this change hasn't registered the category and shows the notification with no buttons, as before.
- Web Push: `urgency: normal`, `tag: enriched-<id>`, `silent: true` (passed through by `public/sw.js`), tap URL `/?task=<id>`. No buttons — `public/sw.js` shows no `actions` for any notification, overdue included. Like every Web Push, it is not shown while an app window is visible.
- Devices: every `apns_devices` row, the watch app included (the same set overdue alerts go to; only the badge push skips the watch), and every Web Push subscription. Never widget push tokens.

```json
{
  "aps": {
    "alert": { "title": "Call the dentist", "body": "Added to Work · Tomorrow 9:00 AM · High" },
    "category": "TASK_ADDED",
    "thread-id": "enriched-42",
    "interruption-level": "active"
  },
  "taskId": 42
}
```

### Tapping a task notification

Tapping any task notification — overdue, "AI finished", "AI failed to process", or the test notification — opens the dashboard at the bare `/?task=<id>`: the iPhone and Mac apps load it through `WebViewManager.navigateToTask` (`DeepLinkRouter.notificationTaskPath`), and Web Push carries it as `data.url`. Since 2026-09-29 the dashboard answers it by bringing the task's row on screen, flashing it and **selecting** it, so the floating action bar is up for it. Nothing opens: no quick panel, no sheet. Before, the same URL opened the quick panel. The steps are in `src/lib/task-link.ts`; in short:

- A folded group is unfolded and a "Show all" cap lifted.
- A search, filter chip or AI chip that hides the task is cleared, and only then.
- If the view leaves it out (Today keeps only what is due by the end of today), the page shows All for that visit, without saving it as the view preference.
- A reminder goes to `/reminders?reminder=<id>&select=1` (selected there too), a quota to `/quotas?quota=<id>`.
- A task that is done, in the trash, or gone gets a toast saying which.

The URL stayed the bare `/?task=<id>` on purpose: every producer of it is a notification, and the installed app builds already load exactly that, so the change needed only a server deploy. The widget's task link is `/?task=<id>&highlight=1`: it flashes the row and selects nothing.

**When.** Both enrichment entry points in `src/core/ai/enrichment.ts` — the fire-and-forget `enrichSingleTask` on create and the per-minute `processEnrichmentQueue` safety net — call it after a successful model run, outside their error handling (a push failure is never an enrichment failure). It sends only when:

- the task was created inside the Just added window (`JUST_ADDED_WINDOW_MS`, 15 minutes). The queue also enriches old tasks (a user re-adding `ai-to-process`, a reprocessed `ai-failed`); those get nothing.
- it has not already sent for that task. An in-memory map on `globalThis`, checked and set synchronously before any await, so a retry, a re-enrichment inside the window, or the second bundle's copy of the module cannot double-send. A restart empties it.
- the task is not done, deleted, or a quota.
- the user has `notifications_enabled` and `enrichment_notifications_enabled`, and is not the demo user.

Nothing is sent when the user's enrichment mode is off (no model ran). An enrichment that fails for good (the `ai-failed` path) gets its own push instead — see the next section.

**Setting.** Settings → Notifications → "Notify when AI finishes a new task" (`users.enrichment_notifications_enabled`, default on; `enrichment_notifications_enabled` on `GET`/`PATCH /api/user/preferences`). Shown only when AI is available, greyed out while notifications are off.

## "AI failed to process" notification (enrichment failures)

Added 2026-10-05. Until then a failed enrichment was silent: the task kept the raw text as its title and a red `ai-failed` label, and the user found out only by opening the app. Now the failure sends one quiet push. Code and rationale: `src/core/notifications/enrichment-failed-notify.ts`.

| Field | Value                                                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title | `AI failed to process a task` (`… a reminder`, `… a quota`)                                                                                                         |
| Body  | The text the user typed, as the AI was given it (`original_title`, else `title`), cut at 200 characters with `…` (titles allow 10,000; APNs caps a payload at 4 KB) |

**When.** `handleFailure` in `src/core/ai/enrichment.ts` is the only code that writes `ai-failed`: on the second failed attempt (`MAX_ATTEMPTS`) it swaps `ai-to-process` → `ai-failed`. Both entry points (the fire-and-forget `enrichSingleTask` on create or retry, and the per-minute `processEnrichmentQueue`) announce that attempt after their own cleanup, outside their error handling. A first failure is retried and sends nothing. Unlike "AI finished", there is no Just added window: a retry of an old task that fails again is announced too. It sends only when:

- this failure has not been announced yet. An in-memory set on `globalThis`, checked and filled synchronously before any await. A task's entry is released when the task is claimed for enrichment again (`claimTask` → `releaseEnrichmentFailedNotice`), so a retried task that fails again gets a new alert. Tasks already `ai-failed` before this shipped are never announced: only the transition calls it.
- the task is still there and still `ai-failed`, not done, not deleted.
- the user has `notifications_enabled` and is not the demo user. **Not** governed by `enrichment_notifications_enabled` ("Notify when AI finishes a new task"); there is no switch of its own.

**Delivery** is the "AI finished" push's, with its own ids: APNs (`buildEnrichmentFailedNotification`) `interruption-level: active`, no `sound`, priority 10, no `badge`, `category: TASK_ADDED` (Done and Delete; the apps route it by `taskId` like any task notification, so they needed no change), `thread-id` and `apns-collapse-id` `ai-failed-<id>`, `taskId` in the payload. Web Push `urgency: normal`, `tag: ai-failed-<id>`, `silent: true`. Tap → `/?task=<id>` ([Tapping a task notification](#tapping-a-task-notification); a reminder is forwarded to `/reminders`, a quota to `/quotas`). The distinct id means it never replaces, and is never replaced by, an "AI finished" push for the same task. Same devices as "AI finished".

**Outages.** When the model is unreachable (the warm slot `dead` and in its re-init backoff, or the API failing), every pending task reaches `ai-failed` within two attempts, so each one gets its own alert — one per task, never more. The enrichment circuit breaker (5 failures in a minute pauses the queue 5 minutes) spaces them out.

## Bulk defer feedback ("what was left overdue")

`src/core/notifications/sweep-feedback.ts`, added 2026-10-04. "Defer all overdue" (`POST /api/tasks/bulk/snooze-overdue`) leaves tasks behind on purpose: P0–P2 always move, P3 (High) only once nothing lower is left in the batch (so a second press takes them), P4 (Urgent) never. The web app's toast says what stayed. Sweeps run from outside the app (the "All +1hr" / "All → <period>" notification buttons on the phone, watch and Mac, the widgets, the watch, the Mac menus, Apple Shortcuts) gave no word about it. This push is that word.

**When.** All of these must hold:

- The request was authenticated with a **Bearer token**. A session cookie (or proxy-header auth) is the web UI, which shows the toast.
- The request did not send `notify: false`. The rule: **a surface that shows the sweep's result itself sends `notify: false`**, so the user doesn't get the same news twice. Those are the iPhone's Home Screen quick actions (iOS opens the app and the page shows the toast; `QuickActionHandler.swift`), the watch's bulk snooze sheet (`WatchViewModel.bulkSnoozeOverdue`) and Smart Stack card (`WatchWidgetIntents.swift`), and the Mac menu-bar panel (`MenuBarModel.snoozeAll`), all through `APIClient.snoozeOverdue*(notify:)`. Surfaces that don't show the result keep the push: the notification buttons on every device (this push is how they report), the iPhone widget's "All overdue" bar, and the Mac's Snooze menu items (`MenuActions`, which alert only when nothing moved).
- Something High or Urgent is **still overdue** after the sweep. If nothing was left, nothing is sent.
- The user has `notifications_enabled` and `sweep_feedback_notifications_enabled`, and is not the demo user.

The route decides after the sweep commits (`planSweepFeedback`) and sends without awaiting (`void sendSweepFeedback(...)`), so the response isn't held up. `feedback_notification` in the response says whether this call sent one, so a Shortcut can show `data.message` only when no notification is coming.

**What it says.** Counts only, never titles (Trent asked for no Urgent titles on the lock screen). The title follows `bulkSnoozeMessage`, the web toast's wording; the body uses the watch and Mac wording for what stayed (`SweepLine`, `ios/Shared/SweepSummary.swift`); `until` is in the user's timezone (`formatSnoozeTarget`). Tasks held back because their deadline has passed (the High tier, 2026-10-12) are named like High — "1 past deadline still overdue. Defer again to move it" — and counted in the response's `skipped_deadline`:

| Left behind                      | Title                                                 | Body                                                                 |
| -------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------- |
| High (first press)               | Deferred 8 tasks until 3:00 PM                        | 2 High still overdue. Defer again to move the High ones              |
| High and Urgent                  | Deferred 8 tasks until 3:00 PM                        | 2 High and 1 Urgent still overdue. Defer again to move the High ones |
| Urgent (something moved)         | Deferred 4 tasks until 3:00 PM                        | 1 Urgent still overdue. Urgent can't be bulk deferred                |
| Urgent (second press moved High) | Deferred 2 high-priority tasks until tomorrow 9:00 AM | 1 Urgent still overdue. Urgent can't be bulk deferred                |
| Urgent only, nothing deferrable  | Nothing deferred                                      | 3 Urgent can't be bulk deferred                                      |
| High and Urgent, nothing moved   | Nothing deferred                                      | 2 High and 1 Urgent still overdue                                    |
| Nothing High or Urgent           | (not sent)                                            |                                                                      |

The last "Nothing deferred" row has no "defer again" hint because another press would do the same (it happens only in relative mode, when the lower tasks left have no due date).

**How it is delivered.** A banner without sound, like the "AI finished" push: APNs `interruption-level: active`, no `sound`, priority 10, no `badge` (the sweep already re-synced the badge); Web Push `urgency: normal`, `silent: true`, tag `sweep-result`, tap opens the dashboard. APNs category `TASK_SUMMARY` on thread `ot-tasks`, so it carries the "All +1hr" and period buttons, and long-press opens the content extension's bulk snooze grid (header "N overdue tasks" from `totalOverdueCount`; `overflowCount` carries the same number). Collapse id `sweep-result`: a newer result **replaces** the older one instead of stacking. APNs payload:

```json
{
  "aps": {
    "alert": {
      "title": "Deferred 8 tasks until 3:00 PM",
      "body": "2 High still overdue. Defer again to move the High ones"
    },
    "category": "TASK_SUMMARY",
    "thread-id": "ot-tasks",
    "interruption-level": "active"
  },
  "kind": "sweep-result",
  "totalOverdueCount": 2,
  "overflowCount": 2,
  "priority": 3
}
```

**How it goes away (the lifecycle).** It has no `taskId`, so the per-task `dismiss` push (`dismissNotificationsForTasks`) never clears it, and since 2026-10-26 no sweep does either: a native sweep clears only the banners of the tasks it moved (the response's `moved_ids`, `ios/Shared/SweepDismissal.swift`; see § Which banners a sweep clears). It goes when a newer result replaces it (collapse id `sweep-result`), when the user taps or acts on it (the action runner removes a summary's own banner; a body tap clears all), or with the `dismiss-all` sent when the app is opened.

It still carries `priority` (the highest tier it names, 4 if any Urgent was left, else 3) for builds before 2026-10-26, whose sweeps cleared every banner at or below a priority ceiling and read a missing priority as 0 — this push goes out while the response to that same sweep is on its way back, so without one it could be cleared by the sweep it reports. On those builds the sweep that produced it leaves it standing, a later sweep that moves the High tier clears a "High still overdue" banner, and one that names Urgent is never cleared by a sweep.

When the user later clears every overdue task some other way (one at a time, in the app), a lingering result banner is not dismissed by the server. That is deliberate and consistent with the overdue summary push: opening the app sends `dismiss-all`, which clears it on every device.

**Setting.** Settings → Notifications → "Bulk defer results" (`users.sweep_feedback_notifications_enabled`, default on; `sweep_feedback_notifications_enabled` on `GET`/`PATCH /api/user/preferences`). Always shown (it doesn't depend on AI), greyed out while notifications are off. One call can opt out with `notify: false` (documented in `docs/openapi.yaml`).

**Deadline cap (2026-10-11, `deadline-cap-feedback.ts`).** A quick defer from a notification button (or the content extension's custom time) never carries a task past a deadline still ahead: it stops AT the deadline (ruling A3, docs/TASK-MODEL.md § Deadline). The button runs in the background, so a capped one sends a quiet banner, "Snoozed to deadline 6:00 PM" / "A quick snooze stops at the deadline", under the same "Bulk snooze results" switch and demo/notifications gates. Collapse id `deadline-cap` (a newer one replaces the older), no category, and deliberately no `taskId`: the capped snooze sends that task's `dismiss` push itself, which would clear a banner carrying its id.

## The deadlines-page nag (2026-10-22)

`src/core/notifications/deadline-nags.ts`, run every minute after the slot nag. With the task-queue switch on, a deadline task with no target sits on the task queue's **deadlines page** from its lead day (`docs/TASK-MODEL.md` § The deadlines page). While anything there waits, **one** push per user — never one per task — says so.

**Which rows count.** The page's own rows (`getTaskSegments(…, { deadlineRows: true })`, so membership, the switch, queue precedence and "seen" are the page's), then:

- `waiting` only. Seeing a row (its circle, or Considered all) silences it for the rest of the **OpenTask day** (resets at the rollover time, not midnight). In the **safety net** — from the day before the deadline's OpenTask day on, past the deadline included — seeing does not silence it: only a target or done takes it off the page (ruling 3).
- A **decked** row counts only in the safety net.
- A row whose own **Nag is off** (`auto_snooze_minutes = 0`) never counts, in the safety net too: off means off. It stays on the page.

**How often: the nag ladder.** Each counted row has an interval from the ladder's considering rung; the one whose next clock mark comes first sets the pace (`nagPace`; with the shipped rungs, the shortest — so adding a row only ever brings the nag sooner, and with the shipped tiers an Unset row, 60, outpaces a Medium one, 120):

| Priority | Overdue (as set, default) | Considering (×2): deadlines page, slot nag | Deadlines safety net |
| -------- | ------------------------- | ------------------------------------------ | -------------------- |
| Urgent   | 5                         | 10                                         | 10                   |
| High     | 15                        | 30                                         | 30                   |
| Medium   | 60                        | 120                                        | 60                   |
| Low      | 240                       | 480                                        | 60                   |
| Unset    | 30                        | 60                                         | 60                   |

Minutes. ONE considering ladder, no special cases (Trent, 2026-10-22): the user's own overdue tier ×2 at every priority, so it follows Settings → Notifications; the safety net brings any slower rung up to hourly (A2). The table is `NAG_LADDER` in `src/core/notifications/nag-ladder.ts`, keyed (kind, priority): `overdue`, `deadlines`, `slot_nag` (read per waiting reminder and quota prompt, the soonest mark wins — § The slot nag) and `quota_prompt`, a documented row only (prompts have no push of their own; they ride the slot nag at their quota's priority). Of the per-task `auto_snooze_minutes`, only Off (0) is read (the row leaves the count); any other value is the overdue nag's interval and does not change this nag's pace.

**No quiet hours** (ruling 2). Like the overdue nag, it sends whenever it is due — at 3 AM too. A page row starts waiting at the OpenTask day's start (the rollover time) or the moment a deadline is set inside its lead time, so the first nag of a day goes then.

**When exactly: `nag_sends`.** A row per (user, `deadlines-page`) holds `last_sent_at`. The first nag goes the moment something waits; each repeat when the clock mark nearest the last send plus the interval has come (§ Clock marks; `claimNagSend`, a compare-and-swap, claimed before sending): a row waiting from 03:00 at Unset nags 03:00, 04:00, 05:00; one set at 10:07 at High nags 10:07, 10:30, 11:00. That makes it restart-safe (the state is the row, not memory), a double tick sends once, after downtime the first tick sends once, and a priority rising mid-interval sends as soon as the new rung's mark has come. The slot nag uses it too (key `slot-nag`, below). The overdue checker would move by keying `task-<id>` with the per-task interval (its stateless boundary loses sends across downtime; a double tick no longer repeats it — the tick's minute claim).

**One alert per tick.** The nag is silent by its own rule, so it never leads a minute in which an overdue push would sound; it then goes out passive. In a minute of silent sends only, a safety-net nag ranks above the period pushes, a plain one last of all (§ One alert per tick).

**What it says.** Counts only, never titles (ruling 5): title "Deadlines", body "2 deadlines to plan · nearest Fri" (the nearest deadline's OpenTask day: a weekday within the week ahead, else "Oct 30"), or in the safety net "Deadline tomorrow: 1 unplanned" / "Deadlines today: 2 unplanned" / "Deadline passed: 1 unplanned", plus " · N more to plan" for the other counted rows.

**How it is sent.** A silent banner on both channels: APNs with no `sound`, `interruption-level: active` at every priority (never critical, never time-sensitive — ruling 4: only Urgent overdue is critical), no `badge`, no category, no `taskId`, thread `ot-tasks`, collapse id `deadlines-page`, `data.kind: "deadlines"`; Web Push with `silent`, tag `deadlines-page`, `urgency: normal`. Never in the badge.

**Tapping it** opens the dashboard with the Tasks card on the deadlines page: `/?tasks=deadlines` (`src/lib/tasks-panel-link.ts`; any segment kind works, `/?tasks=days`). Web Push carries it as `data.url`; the iOS and Mac apps map `kind: "deadlines"` to `NotificationActionRunner.Outcome.openDeadlines` and load `DeepLinkRouter.notificationDeadlinesPath`. The card reads the param once the reminders fetch has landed, pages to it and scrolls the card into view, then strips it; a kind the card isn't showing today is consumed and ignored. The web asks for the page with `?deadlines=1` from the web-UI PR (C); until then the link lands on the card's natural page. An installed native build from before this change has no case for the kind and ends at `.missingTaskId`: the app comes forward where it was, with no navigation.

**Off:** the task-queue switch off (no page), `notifications_enabled` off, the demo user.

## The slot nag (on the ladder since 2026-10-22)

`src/core/notifications/slot-nags.ts`. While any slot that has opened today still has reminders or quota prompts waiting, ONE push per user names the latest unfinished slot and counts the rest ("3 reminders waiting, and 2 earlier slots"), through the slot's own `SLOT_REMINDER` push (same collapse id, so it replaces that slot's banner; APNs only).

- **Pace: the ladder's `slot_nag` row, by priority** (Trent, 2026-10-22). Every waiting item the nag covers — each None/Low reminder at its own priority, each None/Low quota prompt at its quota's priority (Medium+ reminders and prompts have their own named pushes since 2026-10-26 and are not the nag's), in every unfinished opened slot, not only the one it names — has a considering rung (the user's tier ×2: Unset 60, Low 480 by default); the rung whose next **clock mark** comes first wins (`nagPace`; with the shipped rungs, the shortest interval). Not highest priority: with the shipped tiers an Unset item (60) outpaces a Low (480) one. All Unset is hourly; only Low waiting makes it every eight hours; finishing the last Unset item drops it back to the Low rung, counted from the last send. Still one nag per user — priority sets how often, never how many. Paced by `nag_sends` (key `slot-nag`); the slot-open push stamps it too, so the nag waits for the mark after a slot's own banner or the last nag (§ Clock marks). The cheap gate asks whether any rung's mark has come before the roster is read, so the waiting items are only computed for a user whose nag could be due.
- **The handover** (two periods at the Unset pace, both unfinished): 16:30 After School opens and pushes → 17:00 nag (16:30 + 60 = 17:30, a tie → 17:00) → 18:00 Dinnertime opens and pushes; the nag stands down that minute and the push stamps its clock, so there is no After School nag at 18:00 → 19:00 nag naming Dinnertime, "and 1 earlier slot". A period at 20:15 still pushes at 20:15; its nag comes at 21:00.
- **One alert per tick:** the nag and the slot-open push are `period` sends — when an overdue push (or a deadlines safety net) leads the same minute, they still go out, passive (§ One alert per tick).
- **Gone (Trent, 2026-10-22):** the 3-a-day cap, the derived gap, the evening reserve and the Wake–Sleep window. OpenTask has no time-of-day behaviour; the phone's sleep mode handles nights. (The old top-of-the-hour alignment went too; the 2026-10-26 clock marks are a different rule — they place every repeat, of every nag, and never hold one back.) An unfinished slot nags until its day ends — midnight with the task queue's switch off, the user's day start ("Day starts at") with it on.
- **The day: the Reminders screen's day** (2026-10-23, "one day boundary everywhere"). With the task queue's switch on it is the OpenTask day, which starts at the user's "Day starts at" (unset: 3:00 AM for everyone, so a default user's unfinished evening slots nag — silently — until 3 AM): from local midnight to the day start it is still the evening's day, every one of its slots has opened, and what is still waiting there keeps the nag going until the day starts (Trent: yesterday's unfinished evening slot keeps nagging until the day starts); then nothing of the new day has opened until its first slot. A period that starts before the day start (1:00 AM, the day starting at 3:00) opens at the end of its day; with a day start after 12:00 the day is named by the next date (11:00 PM: Monday is Sun 23:00 → Mon 23:00), so a 23:30 period opens at the start of its day and the evening's slots stop nagging at 23:00 (`periodOpensAt`). With the switch off the day is the calendar day, as before, so the nag is silent from midnight to the first slot. Which reminders are waiting is the Reminders surface's own roster at that moment (`reminderDay`). Finishing a slot — every reminder and prompt considered or done — silences it until the slot reopens the next day (silencing = acting).
- **Silent:** no sound (ruling 5: sound only on overdue), like the slot-open push — `buildSlotReminderNotification` never sets one.
- Still: never a slot that hasn't opened, never in the badge, never a reminder on its own. A slot opening with items this exact minute stands the nag down (its own banner is up); an empty one doesn't.
- `slot_nags` (the old per-day claim rows) is no longer written; the weekly purge drains it.

## Named reminder pushes (2026-10-26)

`src/core/notifications/reminder-nags.ts` (Trent, 2026-10-26; plan "named pushes and marks" Part A). A reminder at **Medium or above** gets a push of its own, by name, instead of being one of its period's count.

**When a reminder gets one** — all of:

- it is waiting in today's roster (the Reminders screen's own: `getRemindersBySlot`);
- its priority is Medium (2) or above (`isNamedReminderPriority`, `reminder-nag-rule.ts`);
- it is in a real period, not Anytime;
- its period has opened today (`periodOpensAt`, within the OpenTask day);
- **Priority is the one dial** (Trent, 2026-10-26: "Turn off every nag-specific option for reminders"). A reminder's own Nag value (`auto_snooze_minutes`) is ignored everywhere — it neither stops a named push nor paces one, and a None/Low reminder paces the period nag at its own priority whatever it stores. Stored values are not rewritten: a reminder made a task again keeps whatever it had. The editor offers a reminder no Nag option: the quick panel hides its Nag picker while the Reminder switch is on, and the new-reminder form and `ReminderDetail` have none. (From #368 until this ruling a Medium+ reminder with Nag off went back to its period instead; that rule is gone.)

**When it fires.** The first push at the period's open, exact. Repeats at the slot nag's rung for its priority (`nagIntervalMinutes('slot_nag', priority)`: Medium 120, High 30, Urgent 10 with the shipped tiers), on clock marks (`nextNagAt`, § Clock marks): a High reminder in a 09:15 period pushes 09:15, 09:30, 10:00, 10:30. It stops when considered (it leaves the roster) and at the end of the OpenTask day (the next day's periods have not opened; with the task queue on, an evening reminder sounds until the 3:00 AM day start — the phone's Sleep Focus silences `active`, ruling 8). No extra state.

**`nag_sends`.** One row per reminder, key `reminder-<taskId>`, no date. Due when `last === null || last < periodOpenedAt || now >= nextNagAt(last, I)` (the `since` floor of `claimNagSend`: each day starts afresh at the open, however long the rung), claimed by the compare-and-swap, under the tick's minute claim (`tick-reminder-nags`). The weekly purge (Sunday 4:50 AM UTC, `purgeGoneReminderNags`) drops the rows of reminders that are gone: deleted, in the trash, done, or no longer a reminder.

**The payloads.**

|          | APNs                                                                                                                                                                                                                     | Web Push                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Title    | the reminder's title                                                                                                                                                                                                     | the same                                                                                                   |
| Body     | `Morning · High reminder` (Medium / Urgent likewise), plus the tick lead's ` · N more waiting`                                                                                                                           | the same                                                                                                   |
| Level    | `interruption-level: active` always — never time-sensitive, never critical; `passive` when another push leads the tick                                                                                                   | `silent` when passive                                                                                      |
| Sound    | High and Urgent `sound: default`; Medium none                                                                                                                                                                            | High and Urgent `renotify`; Medium `silent`                                                                |
| Grouping | category `REMINDER_NAG`, thread `ot-reminders`, collapse id `reminder-<id>`                                                                                                                                              | tag `reminder-<id>`                                                                                        |
| Data     | `taskId`, `reminder_day` (the OpenTask date) — and **no `priority`**, on purpose: a shipped build's sweep clears banners `atOrBelowPriority`, reading a missing priority as 0, so any sweep clears a reminder banner too | `url` (`/reminders`), `taskId`, `reminder_day`; `actions: [{ action: 'considered', title: 'Considered' }]` |

No `badge`: a reminder is never in the badge. `taskId` is what the `dismiss` push matches, so considering it anywhere clears the banner. So does any edit that ends its named push — priority below Medium, converted to a task, moved to Anytime or to a period not yet open, its schedule moved off today: `updateTask` and `bulkEdit` ask `namedPushStands` before and after an edit that touches such a field (`namedPushEndCheck`, `reminder-nags.ts`) and dismiss through `dismissNotificationsForTasks` when it stood and no longer does.

**The cheap gate.** Every minute, before a user's roster is read, one query lists their Medium+ reminders with each one's `nag_sends` stamp, and the roster is read only if one of them could be due: its period (by the roster's own slot rule, from the row's time) has opened, a repeating one was not considered today, and its stamp is due by the claim's own rule (never sent, sent before the period opened, or the mark after its last send has come). That is a superset of the real test, so it never skips a due push (`tests/behavioral/rm-reminder-nags.test.ts` RR-11 compares it with the ungated answer minute by minute). A repeating reminder off its day still lets the roster be read; that only costs a read.

**The tick.** Kinds `reminder_urgent`, `reminder_high`, `reminder_medium` (§ One alert per tick). High and Urgent sound, so a High reminder leads a Medium overdue in the same minute; a Medium reminder is silent by its own rule and only leads a minute in which nothing sounds — silently.

**The Considered button.** `POST /api/notifications/actions { action: 'done', task_id, day }`. With `day` the route considers the reminder only when `day` is the user's current OpenTask day and the reminder is waiting in its roster (`reminderWaitingOn`); otherwise 200 `{ considered: false }` and nothing changes, so a stale push never advances an occurrence. Without `day` (every other button, and native builds before PR 3) `done` is as before. With no body token the route takes the ordinary auth chain, so the service worker calls it with the session cookie. **CSRF:** a request authenticated by the cookie or by the reverse-proxy header (it rides the proxy's own session cookie, review of #377; only a body token or Bearer is exempt) must also be same-origin — `Sec-Fetch-Site: same-origin`, or an `Origin` equal to the app's own (`AUTH_URL`'s, or the forwarded host's) — else 403, logged at warn (`isSameOriginRequest`, `src/core/auth/same-origin.ts`). The session cookie is SameSite=Lax (NextAuth's default, and the cookie `session-from-token` mints), so this is a second wall. The native apps send a token and no Origin, so they never meet it. `public/sw.js` handles `event.action === 'considered'` by POSTing with the push's `reminder_day` (no navigation), and the banner stays up until the server answers: a 2xx with `considered: true` or `false` closes it; a 401/403, a 5xx or a network error replaces it (same tag, silent) with "Couldn't mark it considered — open OpenTask", so a failure with the app closed is still seen (`tests/behavioral/rm-sw-considered.test.ts`). Native (PR 3, 2026-10-26): iPhone, Watch and Mac register `REMINDER_NAG` with one action, the DONE identifier titled "Considered"; `NotificationActionRunner` sends `done` with the payload's `reminder_day` as `day` (no day, no call), and `considered: false` is a success like `true` — the banner goes (it is removed before the call), no error banner, the Watch's usual click. A real failure keeps each device's failure handling. A bulk-snooze sweep never clears a `REMINDER_NAG` banner: a sweep clears only the banners of the tasks it moved (`moved_ids`, `ios/Shared/SweepDismissal.swift`), and it never moves a reminder. A body tap opens `/?task=<id>`, which the web forwards to /reminders (the Watch only opens its app). A build from before PR 3 shows the banner without buttons, a tap opens the task, and its sweeps clear the banner (a missing priority reads as P0).

## Named quota-prompt pushes (2026-10-26)

`src/core/notifications/prompt-nags.ts` (Push PR 4, Trent, 2026-10-26). The named reminder pushes for quota prompts: a waiting prompt whose **quota is Medium or above** gets a push of its own instead of being one of its period's count.

**When a prompt gets one** — all of:

- it is waiting in today's prompts (`getQuotaPromptsBySlot`, the Reminders screen's own: neither considered nor done, `promptWaiting`);
- its quota's priority is Medium (2) or above (`promptGetsNamedPush`, `reminder-nag-rule.ts`). **Priority is the only dial**: no Nag option, like reminders after #370;
- it is in a real period, not Anytime;
- its period has opened today (`openedPeriods`, the OpenTask day).

One per `prompt_key`, so a daily quota with prompts in several periods gets one per period. Both prompt off switches (`users.quota_prompts_enabled`, `OPENTASK_QUOTA_PROMPTS=off`) and a quota's own "Remind me" switch turn it off with the prompt.

**When it fires.** The first push at the period's open, exact; repeats at the slot nag's rung for the quota's priority (Medium 120, High 30, Urgent 10 with the shipped tiers), on clock marks (§ Clock marks). It **stops** when considered or did-it'd, when its count is met (a daily row `#k` once today's count reaches k; any other quota once anything is logged today — both make the prompt done, from any surface: the widget's +1 too), and at the end of the OpenTask day (the next day's keys are new and its periods have not opened).

**`nag_sends`.** Key `prompt-<prompt_key>`, under the tick's minute claim (`tick-prompt-nags`), with the same compare-and-swap as the other nags. Unlike `reminder-<id>`, the key carries its day (`q:<taskId>:<k>:<date>`), so each day's prompt is a fresh row: never sent is the first push, and no `since` floor is needed. The weekly purge (Sunday 4:50 AM UTC, beside the reminders', `purgeOldPromptNags`) drops `prompt-…` rows two days old or more, whose day is over.

**The cheap gate.** Before a user's prompts are computed, one query lists their Medium+ live quotas, and the placement rule alone (`promptPlacements`, the one `getQuotaPromptsBySlot` uses) says which period each prompt row is in. The prompts are computed only when a row is in an opened period, not considered today, and its `prompt-…` stamp is due. A superset of the real test (it never reads the count), so it never skips a due push (`tests/behavioral/qn-prompt-pushes.test.ts` QN-P11 compares it with the ungated answer minute by minute).

**The payloads.**

|          | APNs                                                                                                                                                   | Web Push                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title    | the quota's short title (`short_title ?? title`)                                                                                                       | the same                                                                                                                                                  |
| Body     | the count first, no priority word: `Morning · 1/3 this week` (`promptCountText`, the prompt row's own words), plus the tick lead's ` · N more waiting` | the same                                                                                                                                                  |
| Level    | `interruption-level: active` always; `passive` when another push leads the tick                                                                        | `silent` when passive                                                                                                                                     |
| Sound    | High and Urgent `sound: default`; Medium none                                                                                                          | High and Urgent `renotify`; Medium `silent`                                                                                                               |
| Grouping | category `QUOTA_NAG`, thread `ot-reminders`, collapse id `prompt-<prompt_key>`                                                                         | tag `prompt-<prompt_key>`                                                                                                                                 |
| Data     | `taskId` (the quota), `prompt_key` — and **no `priority`**, as on a named reminder push                                                                | `url` (`/reminders?prompt=<key>`), `taskId`, `prompt_key`; `actions: [{ action: 'considered', title: 'Considered' }, { action: 'did', title: 'Did it' }]` |

No `badge`: a quota is never in the badge.

**The buttons.** "Considered" is `POST /api/quota-prompts/consider { keys: [prompt_key] }`, "Did it" `POST /api/quota-prompts/did { keys: [prompt_key] }` (the web sends `source: 'web'`); both are idempotent per key. Another day's key is a 400. `public/sw.js` handles a banner with a `prompt_key` (both actions; a reminder banner keeps its own path) by POSTing in the background, no navigation, and keeps the banner up until the server answers: a 2xx closes it; a **400** is the key refused (the worker always sends a well-formed body: another day's push, or a quota no longer the user's live one) — Considered closes quietly, nothing to consider, and Did it replaces the banner (same tag, silent) with "That was yesterday's — open OpenTask to log it", since the count it meant to add is not logged (review of #377); a 401/403, a 5xx or a network error replaces it (same tag, silent) with "Couldn't mark it considered — open OpenTask" / "Couldn't log it — open OpenTask" (`tests/behavioral/qn-sw-prompt-actions.test.ts`). **CSRF:** both routes now refuse a request authenticated by the session cookie, or by the reverse-proxy header (an ambient credential too: the proxy's own session cookie), that isn't same-origin (403, logged at warn; `isCrossSiteCookieRequest`, `src/core/auth/same-origin.ts`, the actions route's own rule). Bearer requests are not checked, so the native apps and integrations are unaffected. `POST /api/quota-prompts/restore` is unchanged (no banner calls it).

**Stale banners.** A mutation that can end a prompt's named push asks `promptPushEndCheck` before and after, and dismisses the prompts whose push it ended — pushed today, standing before (waiting, Medium+, in an opened period), not after — through `dismissPromptNotifications` (`dismiss.ts`, no badge sync): consider and did it (`actOnPrompts`), the slot checklist's prompts (`bulkDone`), a count logged from anywhere (`incrementProgress`), an edit of the quota (`updateTask`, `bulkEdit`: priority below Medium, no longer a quota, its prompt moved to a period not yet open, its target or rule changed), and the user-level changes (`updatePreferences`: the prompt switch, the default prompt period, the day start; `deleteTimeSlot` and a retime in `updateTimeSlot`). Cheap: one stamp query, and the prompts are computed only when a prompt in scope was pushed today. Not covered: undo and redo — the banner stays until replaced or the day ends. A period deleted moves its prompts to the nearest period; if that one has opened the prompt still stands under the same key, so its banner stays (its body still names the old period until the next push).

**The dismiss payload is prompt-precise** (review of #377): `{ type: 'dismiss', taskIds: [<quota ids>], promptKeys: [<prompt keys>] }`, on Web Push and as the APNs silent push's data. A banner that carries a `prompt_key` (or the tag `prompt-<key>`) closes only when its key is in `promptKeys`, so considering Morning's prompt of a daily quota leaves Evening's banner up; every other banner closes by `taskIds` as before (`handleDismiss` in `public/sw.js`). A `dismiss` WITHOUT `promptKeys` (the ordinary task path: a quota deleted, done) closes every banner of those tasks, prompt banners included. Native builds before PR 4b read `taskIds` alone, so on them both period banners of a daily quota still go together; PR 4b matches by `prompt_key` the same way (`bannerIdentifiers(_:forTaskIds:promptKeys:)`, `ios/Shared/SweepDismissal.swift`, on the iPhone, Watch and Mac).

**The tick.** Kinds `prompt_urgent`, `prompt_high`, `prompt_medium` (§ One alert per tick), ranked with the reminder of the same priority. The source runs right after the named reminder pushes, so a reminder and a prompt of one priority lead in that order.

**Native (PR 4b, 2026-10-26).** iPhone, Watch and Mac register `QUOTA_NAG` (`registerNotificationCategories()`) with two actions, **Considered** (`CONSIDERED`) and **Did it** (`DID_IT`); no snooze, no delete, and not a content-extension category, so iOS shows its default expanded view. `NotificationActionRunner` gives the category its own case: Considered sends `POST /api/quota-prompts/consider { keys: [prompt_key] }` (no `source`), Did it `/did` with the device's `source` (`ProgressSource.forNotificationActions`: `watch` on the Watch, `mac` on the Mac, none — read as `api` — on the iPhone). No `prompt_key`, no call. The banner goes before the call, as for any task banner. A **400** (another day's key): Considered is quiet (`.promptConsidered`, as a success); Did it is `.promptDidStale` — nothing was logged, so the device says "That was yesterday's — open OpenTask to log it", the web's words: the Watch with its failure buzz and its own error banner, the iPhone and Mac with a soundless local notice (`postLocalNotice`; before this they only logged a failed action). Any other failure keeps each device's failure handling. After a Did it the app asks WidgetKit to reload every timeline (`reloadAllTimelines`, as `QuickActionHandler` and the watch's own did-it do — the app has no `WidgetStore` to write through); Considered leaves the widgets to the server's widget push. A body tap opens `/reminders?prompt=<key>` (`PromptDeepLink.webPath`, the Reminders widget's prompt link; the Watch only opens its app). A sweep never clears it: a sweep clears only the moved tasks' banners, and a quota has no target, so it is never moved. The iPhone and Mac skip their badge refresh after it (a quota is never in the badge). A build from before 4b has no `QUOTA_NAG` category: it shows the banner without buttons, a tap goes through the default path to `/?task=<quota id>`, which the web forwards to the quota on `/quotas?quota=<id>`, and a pre-2026-10-26 build's sweep clears it (a missing priority reads as P0).

## Who the cron senders notify

Every minute-cron sender — overdue, slot opens, the slot nag, the named reminder and quota-prompt pushes, the deadlines nag — asks `notifiableUsers()` / `notifiableUserSql()` (`src/core/notifications/notifiable-users.ts`, nag-map fix #10): `notifications_enabled = 1 AND is_demo = 0`. The event-driven pushes (sweep and cap feedback, "AI finished", widget push) already left the demo user out.

## iOS platform constraints

These apply regardless of which notification service is used.

### Interruption levels (iOS 15+)

| Level          | Behavior                                              | Breaks Focus?        | Breaks DND?  |
| -------------- | ----------------------------------------------------- | -------------------- | ------------ |
| Passive        | Silent delivery, notification center only             | No                   | No           |
| Active         | Standard sound and banner                             | No                   | No           |
| Time Sensitive | Immediate, breaks through Focus and Scheduled Summary | Yes (if user allows) | No           |
| Critical       | Bypasses mute, DND, all Focus modes                   | Yes (always)         | Yes (always) |

Time Sensitive requires the `com.apple.developer.usernotifications.time-sensitive` capability (no Apple review needed). Critical requires `com.apple.developer.usernotifications.critical-alerts` (Apple must approve for App Store apps; works without approval for personal/ad-hoc builds). OpenTask uses Critical for P4 (Urgent) overdue notifications with the user's `critical_alert_volume` preference (0.0-1.0, default 1.0) — and for nothing else (ruling 4, 2026-10-22): the deadlines nag and the named reminder and quota-prompt pushes are Active at every priority. Time Sensitive is no longer used (Trent, 2026-10-26): High overdue was `time-sensitive` until then and is `active` now, so only Urgent breaks through Focus and the phone's Sleep mode handles nights. Passive (no sound) is used since 2026-10-26 for every banner of a minute but the one that leads it (§ One alert per tick) — never for Urgent overdue.

### Notification grouping

Users can configure per-app in Settings > Notifications > [App] > Notification Grouping:

- **Automatic**: App controls grouping via `thread-id`
- **By App**: All notifications from the app in one stack
- **Off**: Every notification separate

### Cross-device notification dismissal

Native apps remove delivered notifications via `removeDeliveredNotifications(withIdentifiers:)`, triggered by a silent push. This is how OpenTask clears notifications when a task is deferred/completed from the web UI.

Requires the `remote-notification` background mode in the app's entitlements.

### Which banners a sweep clears

A bulk-snooze sweep (`POST /api/tasks/bulk/snooze-overdue`) clears the delivered banners of **exactly the tasks it moved, and nothing else** (2026-10-26). Both bulk snooze routes answer with `moved_ids`, the ids the call moved, queued ones included (a task sent to the Tasks queue was moved, so its banner is stale). The device that ran the sweep removes every delivered banner whose payload `taskId` is in that list (`dismissNotificationsAfterSweep` → `bannerIdentifiers`, `ios/Shared/SweepDismissal.swift`). That happens on every sweep path: the notification "All →" actions and the content extension's grid (through `NotificationActionRunner`), the iPhone's Home Screen quick actions, the Tasks widget's "All overdue" bar (iPhone and Mac), the watch's bulk sheet and Smart Stack card, and the Mac's menu items and menu-bar panel. A period push, the "AI finished" push, the deadlines nag, a named reminder or quota-prompt banner, the sweep result banner and the banner of an overdue task the sweep left where it was all stay.

The server already clears the same set on every device: `bulkSnooze` calls `dismissNotificationsForTasks(userId, snoozedIds)` — `snoozedIds` is what `moved_ids` carries — so the silent `dismiss` push reaches the other devices (§ Notification dismissal). The local half makes the device that ran the sweep clean the moment the response lands, whether or not the silent push wakes it. A server from before `moved_ids` sends none, so a new build clears nothing locally and relies on the silent push.

Before 2026-10-26 the apps cleared every delivered banner at or below a priority ceiling (P0–P2, plus High when the sweep took the High tier), reading a missing priority as P0. So every sweep also cleared the period push, the "AI finished" push, the deadlines nag and the named reminder banners, and the overdue banners the server held back for a passed deadline. Builds from before then still do that.

### Notification actions

Native apps can register up to 4 action buttons per notification category. OpenTask registers `TASK_REMINDER` (Done, +1hr, All +1hr, then the All → period actions), `TASK_SUMMARY` (All +1hr and the period actions), `SLOT_REMINDER` (Complete all) and `TASK_ADDED` (Done, Delete — the "AI finished" notification). `REMINDER_NAG` (the named reminder push, 2026-10-26: Considered — the DONE action, sending `day`; registered since PR 3). `QUOTA_NAG` (the named quota-prompt push, Push PR 4: Considered and Did it, by `prompt_key`; registered from native PR 4b). The content extension (Phase 4) can dynamically replace the first three with a snooze grid. Every button posts to `POST /api/notifications/actions` (`done`, `snooze`, `snooze30`, `snooze2h`, `delete`) or a bulk endpoint, through `NotificationActionRunner`. A single task's snooze button is honored even past a deadline that is still ahead (2026-10-10): one explicit tap leaves no room for the app's confirm. The bulk "All" buttons go through the sweep, which leaves such a task where it is.

## WidgetKit push (widget sync)

A third, narrower channel — not for user-facing notifications, for keeping the iOS/macOS home-screen and Lock Screen **widgets** in sync with data changed elsewhere (web app, other device). Uses Apple's WidgetKit push API (iOS 26 / macOS 26 —
[Updating widgets with WidgetKit push notifications](https://developer.apple.com/documentation/widgetkit/updating-widgets-with-widgetkit-push-notifications)),
which sits alongside APNs above but is a distinct token, topic, and push type.

### Why

Without this, a widget only refreshes on its own ~30 min timeline, when the app comes to foreground, or when the widget's own `AppIntent` runs (`docs` in `ios/AGENTS.md` § Widgets). A change made anywhere else could take up to half an hour to reach a widget. WidgetKit push closes that gap opportunistically — Apple still budgets and may delay delivery, so it is an addition to the timeline policy, not a replacement for it.

### How it works

1. Each widget kind's `WidgetConfiguration` attaches a `WidgetPushHandler` conformance via the `.pushHandler(_:)` modifier (`ios/OpenTaskWidgets/TasksWidget.swift`, `RemindersWidget.swift`, `TrackWidget.swift` — one shared handler type, `OpenTaskWidgetPushHandler` in `WidgetPushHandler.swift`, reused across all three per Apple's docs: "If you have multiple widget configurations, you can choose to use the same push handler type").
2. The system calls `pushTokenDidChange(_ pushInfo: WidgetPushInfo, widgets: [WidgetInfo])` — once for the first token, and again whenever it changes or the user adds/removes a widget. `pushInfo.token: Data` is the widget extension's own push token, hex-encoded (same `%02.2hhx` idiom as the main app's APNs token) before it goes over the wire.
3. The handler POSTs to `POST /api/push/apns/widget-token` through `APIClient.registerWidgetToken`, with the same Keychain-shared Bearer token as the rest of the app. The token's state (saved before the request, retried from every timeline reload until the server confirms it) is `WidgetPushRegistration` in `ios/Shared/WidgetPushRegistration.swift`, shared by the phone/Mac handler and the watch's `WatchWidgetPushHandler`; each passes its own key prefix (`widgetPush` / `watch.widgetPush`), app bundle id and platform. If `widgets` comes back **empty**, the handler only logs it and keeps the registration: the Mac's `chronod` sends an empty list every time it starts, with the widgets still placed, and unregistering then left the device without widget pushes for hours (2026-09-25). A token with no widget behind it costs one ignored push, and APNs retires a truly dead one (step 7). The watch handler (`WatchWidgetPushHandler`) follows the same rule since 2026-09-29. Neither handler sends the route's `DELETE` any more.
4. The server stores the token in `widget_push_tokens` (`user_id`, `push_token` unique, `bundle_id`, `platform`, `widget_kind`, `environment`, timestamps — `src/core/db/schema.sql`).
5. Whenever this user's data changes, the same `emitSyncEvent(userId)` that already drives the SSE stream for open browser tabs (`src/lib/sync-events.ts`) also schedules a widget push for each of the user's registered tokens (`src/core/notifications/widget-push.ts`), paced **per token** by the coalescing policy below — not one push per change.
6. When a token's push is due, `sendApnsWidgetReload(tokenId)` (`src/core/notifications/apns.ts`) re-reads that row and sends one push: `apns-push-type: widgets`, topic `<app bundle id>.push-type.widgets` (computed from the stored `bundle_id`, NOT the widget extension's own bundle id — Apple's docs use the containing app's id), body `{"aps": {"content-changed": true}}`. WidgetKit reloads that extension's timelines on receipt, equivalent to a `reloadAllTimelines()` call triggered from the server. Each send logs `Sending widget reload push to token <id> (<platform>) for user <id>` — one line per token, where before 2026-09-25 one line covered all of a user's tokens. So a bare `grep -c 'widget reload push'` is not comparable across that change (and the Mac, which is not throttled, adds lines of its own); count the iPhone's budget with `grep 'widget reload push' | grep -c '(ios)'`.
7. Stale tokens (`BadDeviceToken`/`Unregistered`, same reasons as `apns_devices`) are deleted automatically on send failure.

### Coalescing (push budget)

Apple budgets widget pushes per device with an undisclosed daily allowance and drops them silently once it is spent (separate from the ~40–70 timeline reloads a day a frequently viewed widget gets). The original 2s-per-user debounce only merged a bulk action's events; a person working down a list on the web (edits 3–15s apart) still sent one push per edit. On 2026-09-25 prod logged 46 pushes (to 2–3 tokens each) between 07:05 and 13:35 — 11 inside one minute — and Trent's iPhone reported its widget push budget at −17, so pushes that mattered stopped arriving.

The policy, per token (each token is one device's widget extension, with its own budget):

| Rule                                        | Behavior                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt first push                           | A change after a quiet spell goes out after a 2s settle, which still merges a bulk action's many sync events.                                                                                                                                                                                                                                                           |
| Minimum interval + guaranteed trailing push | After a push, that token gets no other push for `OPENTASK_WIDGET_PUSH_MIN_INTERVAL_SECONDS` (default **300**). Changes inside the window collapse into ONE push at the window's end, so the widget always ends on the final state. Worst-case cross-device lag is the window (vs the widget's own 30 min timeline).                                                     |
| Quiet hours                                 | A push due between the user's `sleep_time` and `wake_time` (their timezone) is held until `wake_time`; overnight changes ride that one push. Tradeoff: a late-night edit on another device reaches the phone's widget by push only in the morning (the widget's timeline or opening the app still refresh it). `OPENTASK_WIDGET_PUSH_QUIET_HOURS=false` turns this off. |
| Widget-visible changes only                 | An emit marked `emitSyncEvent(userId, { widgets: false })` pushes nothing: a notes-only edit (`isWidgetVisibleEdit` in `src/core/tasks/update.ts`), an `ai-*`-only label change, re-queuing or failing AI enrichment. Unmarked emits count as visible.                                                                                                                  |
| Failed sends don't use the window           | A send that fails for a reason that could pass later (network, 5xx: `sendApnsWidgetReload` resolves `false`) is rolled back from the pacing, so the next change goes out after the 2s settle instead of a full window later. No automatic retry: nothing is sent until something changes again. A stale token is removed and counts as done.                            |
| macOS exempt                                | chronod logs a Mac widget push as free (`ios/AGENTS.md` § Widgets "Budget"), so `macos` tokens keep settle-only pacing and no quiet hours. iOS and watchOS get the full policy.                                                                                                                                                                                         |

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
- Notify when AI finishes a new task (the quiet "AI finished" push; shown when AI is available). The "AI failed to process" push for a failed enrichment has no switch of its own: it follows only the master switch
- Bulk defer results (the quiet push after a sweep from outside the app left High or Urgent overdue)
- Nag intervals (tiered by priority). The considering nags — the deadlines page and the slot nag — run at twice these, every priority (§ The deadlines-page nag, § The slot nag)
- Test notification buttons (individual, high, bulk, critical)
