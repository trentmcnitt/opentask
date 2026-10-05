# Development Log

Reverse chronological notes on the _why_ behind changes. For implementation details, see git history.

---

## 10-05-26

### A notification when AI can't process a task

**Trent's request:** a failed enrichment was silent. On the second failed attempt the task swaps `ai-to-process` for the red `ai-failed` label and keeps the raw text as its title, and the user only found out by opening the app. Now that moment sends one quiet banner (no sound): "AI couldn't process a task" (or "a reminder", "a quota"), with the text he typed as the body, cut at 200 characters. Tapping it selects the task on the dashboard, and it has the "AI finished" push's Done and Delete buttons (`TASK_ADDED`).

**Which switch.** Trent's call: not the "Notify when AI finishes a new task" switch. That one is about the success push, and a failure nobody hears about is the problem being fixed. It follows only the master notification switch, never goes to the demo user, and has no setting of its own. Nor is it limited to the 10-minute Just added window, as "AI finished" is: a retry of an old task that fails again is worth knowing about too.

**Exactly once per failure.** `handleFailure` is the only code that writes `ai-failed`, and both enrichment paths announce the attempt that wrote it. The once-per-task guard is released when the task is claimed for enrichment again, not after a time window, so a retried task that fails again gets a fresh alert, and a task that was already `ai-failed` before this shipped never gets one. Its collapse id is `ai-failed-<id>`, not `enriched-<id>`, so the two pushes never replace each other.

**Not fixed: a task can still wait in `ai-to-process` forever with no alert.** The warm enrichment slot can stop answering without ever failing. The per-query timeout rejects the caller, but the slot stays `busy`. A failed warmup during a recycle leaves queued callers waiting too. Callers queued behind either never time out, so the per-minute queue cycle stays "running" and every pending task waits until the server restarts. A fix is proposed (recycle the slot on a query timeout, and reject queued callers when a recycle's warmup fails) but not built, because that engine is shared with Quick Take. Also expected: during an outage every pending task reaches `ai-failed` within two attempts, so each one sends its own alert.

---

## 10-04-26

### A notification says what a bulk snooze left overdue

**Trent's request:** most of his bulk snoozes run from outside the app (the notification's "All +1hr" / "All → <period>" buttons, run in the background on the phone, watch and Mac, and Shortcuts), and none of them said what stayed overdue. The sweep leaves High behind until nothing lower is left, and never moves Urgent, so "I pressed snooze and it's still red" had no explanation. Now, when a Bearer-token sweep leaves High or Urgent overdue, one quiet banner (no sound) says so, with counts only and never titles: "Snoozed 8 tasks until 3:00 PM" / "2 High and 1 Urgent still overdue. Snooze again to move the High ones". Nothing left behind means no notification. It is `TASK_SUMMARY`, so long-press opens the bulk snooze grid, and its collapse id makes a newer result replace the older one.

**Who doesn't get it.** The web UI (session auth) already shows a toast. The rule is that a surface showing the result itself sends `notify: false`: the Home Screen quick actions (they open the app and the page shows the same toast), the watch's bulk snooze sheet and Smart Stack card, and the Mac menu-bar panel. Any Shortcut can do the same. The notification buttons, the iPhone widget's "All overdue" bar and the Mac's Snooze menu items keep the push. The setting is Settings → Notifications → "Bulk snooze results", on by default.

**The one non-obvious part.** The payload carries `priority` (4 if Urgent was left, else 3), although it isn't a task. The apps clear the moved tiers' banners after every sweep and treat a banner with no priority as 0. Since this push races the response to the very sweep it reports, it could otherwise be cleared on arrival. With the priority it stays until a later sweep moves the High tier (when it goes stale) or the app is opened. `docs/NOTIFICATIONS.md` § Bulk snooze feedback has the full lifecycle.

---

## 09-30-26

### All is the by-project view again; a per-project cap setting

**This corrects the 09-29-26 entry below.** Retiring the Projects view was a misreading: "All" had meant the by-project view, not a due-date one, and the claim that Projects went unused was wrong. So **All now groups every open task by project** (Inbox, Personal, Work…, in the order Settings lists projects, each heading a tag in its project's color), and the due-date grouping (Overdue / Today / Tomorrow / This Week / Later / No Due Date) is gone — the date filter chips still narrow any view by due date. The switch keeps its order and names: All · Today · Newest.

The stored value follows the view: the All chip stores `default_grouping = 'project'` again, and `'time'` becomes the retired value — accepted on PATCH so an older client doesn't 400, but stored, returned and rendered as `'project'` (`coerceGrouping`, `src/lib/grouping.ts`). A startup data step (`restoreProjectGrouping`) rewrites any stored `'time'`, the inverse of the 09-29 step, and new users start on `'project'`.

What went with the due-date grouping: the "now (h:mm)" divider between Overdue and Today (there is no Overdue section to divide from). What stayed, unchanged: the overdue jump button and red pill still set the Overdue filter and scroll the first group under the top bar — under project grouping that is overdue tasks grouped by project, landing at the top of the list; a notification tap on a task Today hides still switches this visit to All.

**New setting — Settings → Projects → "Tasks shown per project"** (`project_preview_count`, 1–50, default 6): how many tasks each project group shows before "Show all". It replaces the fixed 10 of 09-23. Today's time slots keep their fixed 5.

### The phone `+` focuses the add field at the top, not a sheet

**Trent's decision:** the phone tab bar's `+` no longer opens its own quick-add sheet (added the day before, #173). It scrolls the dashboard to the top and focuses the "Add a task..." field there, the same field desktop uses, with its mic and AI chip, so there is one place to add a task and the keyboard comes up on it. `QuickAddSheet` and its "Add manually" link are gone; the field's own `+` icon still opens the full form.

**Why it is a window event with a synchronous focus.** iOS (Safari and the app's WKWebView) raises the keyboard for a programmatic `focus()` only when it runs synchronously inside the user's tap. The tab bar lives in `AppLayout` and the field deep in the dashboard, so the tap dispatches `focus-quick-add` and the field's `QuickAdd` listener calls `focus({ preventScroll: true })` then `window.scrollTo(0, 0)`; `dispatchEvent` runs listeners synchronously, so nothing leaves the gesture. Going through React state (as the sheet did, via `autoFocus`) or waiting for a smooth scroll would. The header is sticky and in the flow, so at scroll 0 the field sits just below it.

**From another page** the `+` still navigates to `/?action=quick-add`, as before; the dashboard focuses the field once its data has loaded. That focus comes after a navigation, outside the tap, so on iOS the field is focused but the keyboard may wait for a tap on it. Reminders and Quotas keep their own in-place add. Desktop's Add button is unchanged.

---

## 09-29-26

### The view switch is All · Today · Newest

**Trent's decision:** the dashboard's switch goes from Today · Projects · All to **All · Today · Newest** (in that order — he asked for All first, and for "Newest" over "New"). He never used Projects, and wanted one tap to see everything he has added, newest first. New is every open task in one flat list, newest added first, each row naming its project; its order is fixed (the `age` sort, whatever the saved sort says), so the sort dropdown is replaced there by a "Newest added" caption, and the "Unified" button is hidden because New is already flat. Its icon is a sort arrow, not Sparkles, which means AI across the app. It persists like the others, as `default_grouping = 'new'`. The project filter chips stay, so one project is still one tap away in any view. A stored `'project'` lands on All, the nearest view: the startup migration rewrites the column, every reader coerces it (`coerceGrouping`, `src/lib/grouping.ts`), and a PATCH of `'project'` is accepted and saved as `'time'` instead of refused, so an older client doesn't get a 400. The native apps never read `default_grouping`. New users start on All (`'time'`) as well, where they used to start on Projects.

---

## 09-28-26

### Just added: a card of its own, not a copy of the row

**The requirement (Trent):** right after adding a task — from quick add, the Mac menu bar, or an iOS Shortcut on another device — you must be able to see that it landed, where, and what the AI made of it, **without scrolling** and **without the real row leaving its proper place**: "We have to have a place that shows the recent tasks without having to scroll down", and "the real row at the top means it's not in the actual place it's supposed to be". Until now this lived only in a code comment.

Three attempts: a separate "Recent" view (#115) meant switching views to check; a dashed read-only copy of the row at the top of the Inbox (#121) looked cheap next to the real row, its "New · 1m" tag sat above the title's line, and the real row was still at the bottom of the Inbox. Now a **Just added card** under the add field lists the last 10 minutes' tasks — project, what the AI filled in (or "AI is filling in details…"), how long ago — and a tap scrolls to the real row in its real group and flashes it. The real row only wears a small "New" tag, centred on its first line. Chosen from three mockups (`~/hub-store/capabilities/opentask/mockups-2026-09-28-just-added/`, option A).

Same day, same test task: "Test task for job search" stayed in the Inbox despite a Job Search project, because the enrichment prompt only moved a task on explicit phrasing ("add it to…"). Trent chose "file it when the text names the project" — a separate prompt change with its own quality run.

---

## 09-15-26

### Bulk snooze: the High tier joins in once nothing lower is left

**This supersedes the 02-24-26 entry "Simplified bulk snooze" below, which is now history.** That entry describes a "P0-P3 eligible, P4 excluded" binary; P3 was pulled back out during the v0.3 work, and the rule shipped today is neither of those. Current rule, in one line: **P0-P2 always, P3 only when no lower-priority task in the same batch is still eligible, P4 never.** `docs/TASK-MODEL.md` is the reference; `filterForBulkSnooze` in `src/core/tasks/bulk.ts` is the implementation.

Trent had four overdue P3 tasks and one sweep button, and the button reported "No snoozable tasks (4 urgent must be snoozed individually)" — wrong word (they were High, not Urgent, and the internal `urgentSkipped`, whose name is frozen by the public `skipped_urgent` field, had leaked into user copy) and, underneath it, a rule that left the only late thing on his list unmovable. Excluding High outright protects a deadline from a sweep the user did not read; a sweep aimed at a batch that is already nothing but deadlines is the user looking straight at them and pressing anyway. So: first press clears P0-P2, second press takes the High. Two presses, no mode, no second button.

The "is anything lower still eligible" test deliberately ignores P4 — a P4 is never swept, so counting it would defer the High tier forever. `skipped_high` is additive on the API; `skipped_urgent` keeps its name and its High+Urgent meaning for the iOS client.

---

## 02-24-26

### QuickActionPanel overflow in SelectionActionSheet dialog

Intermittent bug where the snooze grid (and entire panel content) overflowed the right edge of the desktop dialog when opening a single task via selection mode. The root cause: `DialogContent` uses CSS `grid` layout, and grid items default to `min-width: auto` — they refuse to shrink below their content's minimum intrinsic width. `QuickActionPopover` already wrapped its panel in `<div className="min-w-0">` to override this, but `SelectionActionSheet` was missing it. The bug was intermittent because the content's intrinsic minimum width is task-dependent — most tasks fit, but certain combinations of metadata, annotations, and action buttons pushed over the ~390px threshold, causing `overflow-x-hidden` to clip the right side.

### UX Improvements (5 items)

After a couple days of real-world usage, five pain points were addressed in one batch:

1. **Overdue badge** — iOS app icon now shows a badge number with the total overdue task count. Web tab title shows `(N) OpenTask`. Badge count includes all overdue tasks (including P4 Urgent). Clears on app foreground (existing behavior).

2. **Simplified bulk snooze** — Replaced the three-tier system (P0/P1 first, P2 second, P3/P4 never) with a simple binary: P0-P3 eligible, P4 (Urgent) excluded. The tiered system was too frustrating in practice — users just wanted to clear overdue tasks quickly. `MEDIUM_PRIORITY_THRESHOLD` removed, `URGENT_PRIORITY = 4` added. AI prompts, docs, and all test suites updated to match.

3. **Dynamic Type in WKWebView** — WKWebView doesn't relay iOS Dynamic Type settings to web content. Solved by mapping `UIContentSizeCategory` to a CSS root font-size percentage (82% to 150%) and injecting it via `WKUserScript`. Since Tailwind uses `rem` everywhere, scaling the root font-size scales the entire layout proportionally. Observes `UIContentSizeCategory.didChangeNotification` for live updates.

4. **Absolute times on notification buttons** — The three action buttons below the snooze grid (long-press) now show "4:00 PM" instead of "+1hr", and "All → 4:00 PM" instead of "All +1hr". Uses `DateHelpers.snapToNextHour()` and `formatShortTime()`. Updates dynamically when the user taps grid buttons.

5. **Bulk snooze notification bugs** — Three bugs found and fixed: (a) AppDelegate didn't dismiss notifications after bulk snooze from lock screen, (b) Content extension silently dismissed notifications even when the API call failed (changed to `.doNotDismiss` on error), (c) Watch app had the same dismissal gap as AppDelegate.

### Critical Alerts Entitlement

Applied to Apple for the Critical Alerts entitlement (allows bypassing DND/ringer switch for P4 notifications). Pending Apple approval. In the meantime, P4 notifications use `time-sensitive` interruption level (same as P3). The entitlement entries, `.criticalAlert` authorization option, and critical sound payload are removed from the codebase until approved — will re-add when the entitlement comes through.

---

## 02-21-26

### Load Time Performance Optimizations

**Problem:** Every page in OpenTask was `'use client'` with no server-side data fetching. The load waterfall was: empty HTML shell → download JS bundle → hydrate → `useSession()` → client-side API calls (`/api/tasks`, `/api/projects`) → render content. Users saw a spinner for the entire duration. Additionally, every component was in the initial bundle — no code splitting — and both `AppLayout` and the dashboard independently fetched `/api/projects`, doubling that request.

**Approach:** Seven phases, ordered from zero-risk config changes to architectural refactor.

1. **Font `display: 'swap'`** — shows fallback system font immediately instead of invisible text during font load
2. **Root `loading.tsx` + `error.tsx`** — Next.js Suspense fallback for route transitions (spinner instead of blank screen) and a catch-all error boundary
3. **Dynamic imports** (`next/dynamic`) — QuickActionPopover, KeyboardShortcutsDialog, BatchUndoDialog, ProjectPickerSheet, and CreateTaskPanel lazy-loaded behind interaction gates. Prefetch for QuickActionPopover and CreateTaskPanel fires 2 seconds after mount so the first interaction isn't delayed.
4. **Service worker static asset caching** — cache-first for `/_next/static/` URLs (content-hashed, immutable). Existing `activate` handler already purges old caches on deploy.
5. **Shared `ProjectsProvider` context** — single `/api/projects` fetch shared between AppLayout and dashboard, eliminating the duplicate request
6. **Server component dashboard** — `page.tsx` converted to an async server component that calls `auth()` + `getTasks()` + `getProjects()` server-side, passing data as props to the new `DashboardClient.tsx`. Eliminates the client-side fetch waterfall entirely.
7. **Extracted `useQuickActionShortcut` hook** — moved from QuickActionPopover to its own file so the component can be code-split (hooks can't be dynamically imported)

**Results (measured against dev server with Playwright):**

| Metric                     | Before  | After          | Change |
| -------------------------- | ------- | -------------- | ------ |
| DOM Content Loaded         | 1,303ms | 1,101ms        | -15%   |
| First Contentful Paint     | 1,317ms | 1,112ms        | -16%   |
| API requests on load       | 15      | 11             | -27%   |
| JS transfer (first visit)  | 347KB   | 521KB          | +50%   |
| JS transfer (repeat visit) | 347KB   | ~0 (SW cached) | -100%  |

**The JS size trade-off:** First-visit JS transfer increased 50% due to a known Turbopack limitation — `next/dynamic` boundaries cause Turbopack to duplicate shared dependencies (lucide-react, Radix UI) across per-route chunks instead of extracting a common chunk. Webpack handles this correctly (1,727KB total vs Turbopack's 2,557KB), but webpack's standalone build doesn't bundle `bcrypt` native modules for Linux, causing 500 errors on deploy. No fix is available from Vercel. The trade-off is acceptable: repeat visits (the common case for a PWA) serve everything from the service worker cache, and FCP improved 16% even with the larger first-visit payload.

**Dead ends:**

- `optimizePackageImports` in `next.config.ts` — tested and confirmed it has zero effect on Turbopack builds (identical output hashes with and without). Turbopack auto-optimizes barrel imports natively. Removed.
- Webpack build — produces much better chunk deduplication but the standalone output doesn't trace `bcrypt` native modules correctly. Server returned 500 on all auth endpoints. Reverted.

**Hydration safety:** The server component fetches tasks, but the client still shows a loading spinner during hydration (while `useSession()` resolves, ~50-100ms). This prevents hydration mismatch — SSR output and client first-render both show the spinner, then data appears once session resolves. The improvement over before: session resolves → render immediately (data already in state) vs. session resolves → fetch API → wait → render.

### Notification System Overhaul — Unified Checker + Consolidation

**Problem:** The notification cron bundled three unrelated jobs (overdue check, critical alerts, AI enrichment) under a single `isHeartbeatRunning` guard. When AI enrichment hung (SEGV), the guard stayed locked and notifications were silently skipped for 10-12 minutes until the server crashed and restarted. Additionally, two separate checkers (`checkOverdueTasks` for P0-P3 and `checkCriticalTasks` for P4) duplicated boundary logic with inconsistent intervals — P4 used the user's configured 5-min interval for web push but a hardcoded 60-min interval for APNs. No notification consolidation meant a burst of 50 overdue tasks generated 50 individual notifications.

**Solution:**

1. **Separated notification cron from enrichment** — Two independent crons in `instrumentation.ts`, each with their own guard. Notification cron has a 30-second safety timeout that force-resets the guard if a check hangs, preventing permanent lockout. A stuck enrichment process can never block notification delivery.

2. **Merged two checkers into one** — Deleted `critical-alerts.ts`. The unified `checkOverdueTasks()` handles all priorities (P0-P4) in a single query + boundary check. P4 now uses the user's configured `auto_snooze_urgent_minutes` for both web push and APNs (hardcoded 60-min interval deleted).

3. **Added consolidation caps** — Three buckets prevent notification flooding:
   - Regular (P0-P2): 4 individual + summary if more
   - High (P3): 5 individual + summary if more
   - Urgent (P4): unlimited, no summary

   Within each bucket, highest priority tasks get individual slots first (P2 before P1 before P0), then most overdue. Both web push and APNs follow the same rules — no more channel-specific logic.

4. **Marked vestigial columns** — `last_notified_at` and `last_critical_alert_at` on the tasks table (replaced by mod-based boundary detection) are now marked as vestigial in schema.sql.

**Files touched:**

- `src/instrumentation.ts` — Separated notification and enrichment crons
- `src/core/notifications/overdue-checker.ts` — Unified checker with consolidation
- `src/core/notifications/critical-alerts.ts` — Deleted (merged into overdue-checker)
- `src/core/notifications/apns.ts` — Added `sendApnsSummaryNotification()`
- `src/core/notifications/index.ts` — Removed `checkCriticalTasks` export
- `src/core/db/schema.sql` — Marked vestigial columns
- `tests/behavioral/notification-timing.test.ts` — Rewritten for unified checker + consolidation

### iOS Silent Push Fix — UIBackgroundModes Was Missing

**Problem:** Marking a task done on Watch dismissed the web notification on Mac but NOT the iPhone notification. Server logs showed the dismiss silent push was sent successfully — Apple accepted it, no errors. The problem was iOS-side: the app never received the silent push.

**Root cause:** `UIBackgroundModes` was completely absent from the built app's Info.plist — since the app was first built. The `project.yml` used `INFOPLIST_KEY_UIBackgroundModes: remote-notification` with `GENERATE_INFOPLIST_FILE: true`, but Xcode silently ignores that build setting. No error, no warning — the key just doesn't appear in the generated plist. Without `UIBackgroundModes: [remote-notification]`, iOS discards all `content-available: 1` silent pushes at the device level.

**Fix:** Switched from Xcode's auto-generated Info.plist to xcodegen's `info` block, which generates a real Info.plist file on disk with the correct keys. Applied to both the iOS app and Watch app targets.

**Diagnostic value:** The comprehensive notification logging added earlier in the session (send/dismiss/action logging across all channels) was essential for isolating this to the iOS side. Server logs clearly showed the dismiss was sent and accepted — without that, we'd have been guessing.

### Cross-Device Dismiss-All on App Open

**Problem:** OpenTask is notification-heavy by design. When you open the app and see your task list, all the notification noise on other devices becomes stale. But notifications only cleared on the device you opened — other devices kept buzzing.

**Solution:** New `POST /api/notifications/dismiss-all` endpoint sends a `dismiss-all` signal to all web push subscriptions and APNs devices. Three trigger points:

- **Web app:** `visibilitychange` listener fires when the tab becomes visible (debounced 30s)
- **iOS app:** `applicationDidBecomeActive` calls the API after clearing local notifications
- **All devices receive:** Service worker, AppDelegate, and WatchAppDelegate all handle the `dismiss-all` silent push type by calling `removeAllDeliveredNotifications()`

### Test Notification Rewrite

**Problem:** Test notifications sent a generic push with `taskId: 0`, which meant (a) actioning them from Watch failed with a 400 error (`!0 === true` in JS validation), and (b) cross-device dismiss didn't work because there was no real task to dismiss.

**Solution:** Test notifications now create a real temporary task (with "test" label) and send to ALL channels (web push + APNs) after a 3-second delay. The delay gives the user time to switch away from the tab so the service worker doesn't suppress the web notification. Because it's a real task, tapping Done/Snooze triggers the full action + cross-device dismiss flow — a true end-to-end test.

---

## 02-20-26

### watchOS Companion App for Notification Actions

**Problem:** Apple Watch shows APNs notification action buttons (Done, +1hr, All +1hr) when notifications mirror from iPhone, but tapping them has no effect. The Watch forwards actions back to the iPhone app's `AppDelegate`, but this forwarding is unreliable — the iPhone may be locked, suspended, or terminated. Errors are silently swallowed, so there's zero feedback that the action didn't work.

**Solution:** Minimal watchOS 10+ companion app (`OpenTaskWatch`) that handles notification actions directly on the Watch. Registers the same `TASK_REMINDER` category, makes API calls over the Watch's own network connection, and provides haptic feedback on success/failure. Credentials transferred from iPhone via WatchConnectivity, then stored in the Watch's local keychain.

**Key decisions:**

- watchOS 10.0 minimum (matches iOS 17.0 min, covers Apple Watch Series 4+)
- WatchConnectivity for credential sharing — App Group keychain only works between apps on the same device; Watch is a separate device with its own keychain
- Watch registers its own APNs device token — mirrored notifications always forward actions back to the iPhone, so the Watch's `UNUserNotificationCenterDelegate` is never called for mirrored notifications. Direct APNs means the Watch receives its own notifications and handles actions locally.
- Server-side per-device APNs topic routing — `bundle_id` column in `apns_devices` table sets the `topic` per notification (`io.mcnitt.opentask` for iPhone, `io.mcnitt.opentask.watchapp` for Watch)
- Cross-device notification dismissal — Watch handles silent push (`type: "dismiss"`) same as iPhone, so actioning a task on one device clears notifications on all devices
- Haptic + local error notification on failure solves the silent failure problem that made the old forwarding approach useless
- Bare-bones scope: notification actions only, no task browsing UI

**Lessons learned:**

- Apple Watch dev setup is painful. Developer Mode toggle only appears after Xcode "prepares" the device. Watch connects through the iPhone, not directly. Unpairing in Xcode made reconnection difficult. When Xcode gets stuck in a connect/reconnect loop, `sudo pkill -9 remoted` on the Mac forces a clean reconnection.
- XcodeBuildMCP doesn't support watchOS builds (`build_device` hardcodes iOS platform). Use `xcodebuild` and `xcrun devicectl` directly for watchOS.
- Initial assumption that mirrored notifications would invoke the Watch app's delegate was wrong — they always forward to the iPhone. Required adding Watch-side APNs registration and server-side per-device topic routing.

**Status:** Built and compiles. Server-side APNs topic routing done. Physical device testing of notification actions still pending.

---

## 02-15-26

### Priority-Based Notification Icons

**Problem:** All notifications used the same `icon-192.png` regardless of priority. High and Urgent notifications looked identical to routine ones, making it impossible to gauge severity at a glance from the notification shade.

**Solution:** Generated icon variants using ImageMagick — the base sun logo with exclamation point badges overlaid. Selected V5 (synthwave neon glow, top-right) as the active set, with V4 (red circle badge) kept as backups.

- `icon-192-high.png` — single `!` badge for P3 (High) tasks
- `icon-192-urgent.png` — double `!!` badge for P4 (Urgent) and critical tasks
- P0-P2 tasks continue using the default `icon-192.png`

Wired into `sendIndividualNotification` (overdue checker), `sendCriticalNtfy` (critical alerts), and the test notification endpoint. Added a "High" test button in Settings so all icon variants can be verified from the phone.

**Files touched:**

- `public/icon-192-high.png`, `public/icon-192-urgent.png` — new V5 neon glow icons
- `public/icon-192-high-v4.png`, `public/icon-192-urgent-v4.png` — V4 red badge backups
- `src/core/notifications/overdue-checker.ts` — priority-based icon selection in `sendIndividualNotification`
- `src/core/notifications/critical-alerts.ts` — use urgent icon for critical alerts
- `src/app/api/notifications/test/route.ts` — added `high` type, updated critical icon
- `src/app/settings/page.tsx` — added High test button

---

## 02-11-26

### Bubble AI Input Pipeline Improvements

**Problem:** The Bubble AI received a limited view of each task (9 fields), causing commentary that over-focused on "overdue" status. In OpenTask, due dates serve two different purposes:

- **Priority 3-4 (High/Urgent):** Real deadlines that can't be auto-snoozed. Overdue is significant.
- **Priority 0-2 (Unset/Low/Medium):** Notification triggers for auto-snooze cycles. "Overdue" often just means the notification is active — not interesting.

The AI saw `recurring: yes/no` but not the actual rrule pattern (daily vs monthly matters), didn't see `notes` (AI-generated context from dictation), didn't see `recurrence_mode` (from_completion changes overdue semantics), and used an overengineered scoring system with a hard cap of 50 tasks.

**Solution:**

1. **Extended TaskSummary** with `rrule`, `notes`, and `recurrence_mode` fields
2. **Simplified task selection** from a scoring algorithm (score + sort + limit 50) to a simple 7-day filter (include everything due within 7 days, overdue, or no due date)
3. **Updated task line format** to show `rrule: FREQ=WEEKLY;BYDAY=MO` instead of `recurring: yes/no`, plus conditional `recurrence_mode` and `notes`
4. **Rewrote overdue guidance** in the Bubble system prompt with priority-based deadline semantics
5. **Changed one-off task age anchor** from `created_at` to `original_due_at ?? created_at` (captures deferral time)
6. **Added 3 new quality scenarios** testing overdue/deadline distinction: high-priority real deadline, low-priority deferral pattern, and mixed priorities with from_completion

**Rationale:** The previous approach treated all overdue tasks the same way, but OpenTask's auto-snooze model means most "overdue" tasks are just in their notification cycle. By giving the AI the full picture (rrule pattern, notes, recurrence mode) and explicit guidance on deadline semantics, the Bubble can produce more nuanced and useful commentary.

---

### Bubble Prompt Rewrite — Behavioral Model & Grounding

**Problem:** The Bubble AI fabricated claims like "deferred twice" because it saw `original_due_at` and `due_at` for P0-2 tasks and invented narratives about what happened between those dates. For P0-2, this gap is pure bulk-snooze noise — users tap the snooze-all button 10+ times per day. The behavioral model was buried in the middle of the prompt, and there were no explicit grounding constraints telling the AI what it could and couldn't conclude from its data. The validator prompt also referenced "snooze count" which the AI never sees.

**Solution:**

1. **Removed `original_due_at` from P0-2 task lines** — the AI now only sees this for P3-4 tasks where due date changes were deliberate. For P0-2, it uses `created_at` as the age signal (reliable, never changes).
2. **Restructured the prompt** — moved the behavioral model ("How OpenTask works") to the very top, before any surfacing instructions. LLMs weight early content more heavily.
3. **Added explicit grounding rules** — "You CAN state: ..." / "You CANNOT state: ..." lists that prevent the AI from fabricating counts, implying intentional deferral for P0-2, or narrating paths between dates.
4. **Fixed the example** — removed `(originally due: ...)` from P0-2 example tasks, changed commentary to age-based ("on your list for 3 weeks"), removed "keeps getting deferred" from summary.
5. **Fixed the validator prompt** — removed all "snooze count" references, added "Factual Grounding" criterion.
6. **Updated scenario quality_notes** — expectations now require age-based commentary (from `created_at`) instead of deferral-based commentary for P0-2 tasks.

**Key insight:** The prompt should only reference data the AI actually receives. Mentioning data the AI doesn't see (even to say "don't use it") primes it to try to infer that data from other signals. The cleanest fix is to remove the problematic data from the input entirely for P0-2 tasks, and structure the prompt so the behavioral model comes first.

---

## 02-04-26

### Activity/Undo/Toast Consistency Overhaul

**Problem:** Dashboard popover was firing immediate API calls when changing priority/recurrence, creating multiple undo entries and toasts for what felt like one user action. Activity items in history were truncated with no way to see full details.

**Solution:**

1. **Batched saves on dashboard** - QuickActionPanel now uses `onSaveAll` mode (same pattern as task detail page). All changes are staged locally and sent in a single PATCH call when Save is clicked. This means:
   - One API call instead of multiple
   - One undo entry instead of multiple
   - One descriptive toast (e.g., "Updated priority and recurrence")

2. **Enhanced `bulkEdit()` for snooze** - Discovered that `bulkEdit()` didn't handle `due_at` changes at all. Added snooze detection logic matching `updateTask()` so bulk edits now properly track `snooze_count`, `original_due_at`, and daily stats.

3. **Overdue tasks keep overdue status** - Previously, changing rrule on an overdue task would auto-compute a new due_at, making it magically not-overdue. Now: if task is overdue, changing recurrence only updates the schedule, not the due date. You still have to deal with the overdue task.

4. **Preview new due_at when changing recurrence** - When user changes recurrence in QuickActionPanel for a non-overdue task, the UI now shows a preview of what the new due_at will be (computed client-side using rrule library). Helps users understand the impact before saving.

5. **Expandable activity items** - History page now shows chevron on activity items. Click to expand and see full before/after details for each changed field. Collapsed view still truncates for clean list appearance.

**Files touched:**

- `src/app/page.tsx` - Added `handleSaveAllChanges`, wired batched save to popover
- `src/components/QuickActionPopover.tsx` - Added `onSaveAll` prop
- `src/components/QuickActionPanel.tsx` - Added `previewDueAt` computation and display
- `src/core/tasks/bulk.ts` - Added `due_at` handling with snooze detection, overdue check for rrule
- `src/core/tasks/update.ts` - Added overdue check in `applyAnchorUpdates()`
- `src/app/history/page.tsx` - Added expandable activity items with details panel
- `src/lib/format-toast.ts` - New file for `formatChangesToast()` helper

**Key insight:** The staged changes architecture already existed in QuickActionPanel - it was just a matter of wiring up the dashboard to use `onSaveAll` mode instead of individual callbacks. TaskDetail already worked this way.
