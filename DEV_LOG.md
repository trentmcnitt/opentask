# Development Log

Reverse chronological notes on the _why_ behind changes. For implementation details, see git history.

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
