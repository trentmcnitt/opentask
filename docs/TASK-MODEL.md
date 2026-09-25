# Task Model & Due Date Philosophy

Complete reference for the OpenTask task data model and due date semantics. The main `AGENTS.md` has a brief summary; this file has the full details.

## Due Date Philosophy

OpenTask is not a traditional task manager. Due dates for most tasks are **reminders, not deadlines**. Understanding that distinction is critical for interpreting task data correctly, especially in AI features. See `docs/DESIGN.md` for the full rationale.

**Priority determines whether a due date is a deadline or a reminder:**

- **Priority 0-1 (Unset/Low):** `due_at` means "remind me at this time." These tasks are eligible for bulk snooze. Being "overdue" just means `due_at` has passed — for low-priority tasks it's the normal state, not a problem.
- **Priority 2 (Medium):** `due_at` is a reminder. Eligible for bulk snooze. Being overdue has low significance.
- **Priority 3 (High):** `due_at` is a deadline. High tasks resist a sweep so a defensive bulk snooze can't silently re-date a real deadline — but they are not exempt from one: a bulk snooze takes them once no lower-priority task in the same batch is still eligible (see **Bulk snooze** below). Being overdue is significant. `HIGH_PRIORITY_THRESHOLD = 3` in `src/lib/priority.ts` is the boundary.
- **Priority 4 (Urgent):** `due_at` is a hard deadline. Urgent tasks resist sweeps _and_ break through everything (critical-level notifications). They must be snoozed individually, so every due date change is a deliberate decision. Being overdue is always significant. `URGENT_PRIORITY = 4` in `src/lib/priority.ts`.

| Priority        | Due date means | Bulk snooze                     | "Overdue" significance |
| --------------- | -------------- | ------------------------------- | ---------------------- |
| 0-1 (Unset/Low) | Reminder       | Eligible                        | Normal — not a problem |
| 2 (Medium)      | Reminder       | Eligible                        | Low                    |
| 3 (High)        | Deadline       | Only when nothing lower is left | Significant            |
| 4 (Urgent)      | Hard deadline  | Never                           | Critical               |

**Bulk snooze:** P0-P2 are always swept. **P3 (High) is swept only when no lower-priority task in the same batch is still eligible** — so the first press clears P0-P2 and a second press, finding only High left, takes it. Two presses, no mode, no second button. P4 (Urgent) is never swept: its due date is a hard deadline and every change to one has to be a deliberate, individual act.

The test is "is anything lower still eligible", **not** "is the batch pure": a P4 sitting in the batch does not hold the High tier back, because a P4 is never swept and would otherwise block it forever. `include_task_ids` still rescues an explicitly chosen task at any priority. The rule lives in `filterForBulkSnooze` (`src/core/tasks/bulk.ts`).

Why the change (Trent, 2026-09-15): with four overdue High tasks and nothing else late, the sweep button reported "no snoozable tasks" and the list stayed wrong. Excluding High outright protects a deadline from a sweep the user did not read; a sweep aimed at a batch that is already nothing but deadlines is the user looking straight at them and pressing anyway.

**Implications for code and AI:**

- `created_at` is the most reliable age signal — it never changes. Use it over `due_at` for understanding how long a task has existed.
- The gap between `original_due_at` and `due_at` shows how much total time the due date has shifted, but not how many snoozes occurred or why. Don't infer snooze counts or user intent from dates alone.
- `snooze_count` is a lifetime stat incremented on every snooze (including bulk). High counts are normal, not a sign of avoidance.
- For P0-2 tasks, avoid language like "deferred three times" (implies conscious decisions). Prefer factual framing: "has been on your list for 3 weeks." These tasks ride the bulk sweep, so a shifted due date reflects a sweep the user never read, not a decision.

## Priority Values

| Value | Meaning |
| ----- | ------- |
| 0     | Unset   |
| 1     | Low     |
| 2     | Medium  |
| 3     | High    |
| 4     | Urgent  |

## Recurrence Model

RFC 5545 RRULE strings (the iCalendar recurrence rule standard, e.g., `FREQ=WEEKLY;BYDAY=MO`) stored in `task.rrule`. Anchor fields preserve the intended local time across DST (Daylight Saving Time) transitions (e.g., a task due at 9 AM stays at 9 AM local time when clocks change):

- `anchor_time` — time of day
- `anchor_dow` — day of week
- `anchor_dom` — day of month

`computeNextOccurrence()` in `src/core/recurrence/` handles timezone-aware advancement.

**A recurring task carries debt.** Its `due_at` is the truth, past or future: in the future it is the next occurrence (or an explicit snooze target); in the past it has been overdue _since then_ and stays overdue — nagged at its priority cadence, across midnight, until done. It does not stop being overdue because a new day arrived, and a snooze that isn't honoured leaves it overdue from the snoozed time. Completing it advances `due_at` to the next scheduled occurrence after the completion (`from_due`: `rrule.after(max(prevDue, completedAt))`), so a Mon/Thu task finished on Tuesday next lands on Thursday. Only a recurring task with no `due_at` derives today's occurrence from the rrule at read time. Reminders (`is_reminder = 1`) are the exception and roll forward: a missed one is not re-shown until its next occurrence. See `effectiveDueAt()` in `src/core/recurrence/occurrence.ts` and REDESIGN-V03 §4.6 (amended 2026-09-07).

`recurrence_mode`: `from_due` (default) keeps the calendar anchor — the next occurrence is the next scheduled one after completion; `from_completion` counts the interval from when it was actually done (e.g. "every 3 months from the last filter change").

## Completion Behavior

- **Recurring tasks** advance in place: completing a daily task moves `due_at` forward and leaves `done=0`
- **One-off (non-recurring) tasks**: when completed, the app sets `done=1` and `archived_at` to the current time

## Snooze

Snooze sets `due_at` to a new value without modifying recurrence. For recurring tasks, the original schedule is preserved: a daily 9:00 AM task snoozed to noon and then completed will still regenerate as due at 9:00 AM tomorrow.

**Snooze vs explicit reschedule** (Trent, 2026-09-24). `original_due_at` is the occurrence origin; a task is **snoozed** when `due_at` has moved off it (`is_snoozed` = `original_due_at` set and `!== due_at`, the same test as the row's snoozed indicator). A freshly dated task is not snoozed — `createTask` sets the origin to the first date.

| Change to an existing date                                                                                                                             | What it is          | `original_due_at`       | `snooze_count` |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | ----------------------- | -------------- |
| Snooze endpoint, bulk snooze, snooze-overdue, notification snooze, quick-panel +1h/preset/Now buttons, bare `PATCH { due_at }` (iOS content extension) | Snooze              | Kept (set on first one) | +1             |
| `PATCH { due_at, reset_original_due_at: true }` — the quick panel's date picker                                                                        | Explicit reschedule | = the new `due_at`      | Reset to 0     |
| `PATCH { rrule, due_at }`                                                                                                                              | Re-schedule         | Cleared                 | Unchanged      |

A bare `PATCH { due_at }` stays a snooze because the iOS content extension snoozes with exactly that payload, so the reschedule has to opt in. Undo restores the prior `original_due_at` and `snooze_count` either way. `PATCH { rrule, due_at }` honors the date and derives the rule's anchors from it, like `createTask` (it used to be dropped).

**Reminders** (`is_reminder`) are never snoozed: the snooze endpoint refuses them, bulk snooze skips them, and a bare `PATCH { due_at }` that would move a dated reminder is refused too. An explicit reschedule (`reset_original_due_at: true`) is allowed, as is giving an undated reminder its first date. `skip-occurrence` refuses reminders — a missed one rolls forward on its own, and completing one marks it considered.

## Quotas and completion

A quota (`isTracked`: `is_tracked` or `progress_target > 1`, one definition in `src/lib/track.ts`) is counted within its period; its period boundary resets `progress_current`. Marking one **done** closes the period early and zeroes the count, so `markDone` refuses a quota unless the caller passes `close_period: true`, and `bulkDone` skips quotas (reporting `quota_skipped`) unless the same flag is set — refusing only when the batch is nothing but quotas. No app surface completes a quota; they log progress (`POST /api/tasks/{id}/progress`).

A quota's completions are the period rollover's (`period-rollover.ts`): a met period closes into a completions row. `markUndone` (`POST /api/tasks/{id}/undone`) refuses a quota — putting one back deleted that record while the period stayed closed. Correct the count with a −1.

**Which period a count belongs to** (2026-09-24). The rollover cron runs every few minutes, so for a few minutes after a boundary a quota still carries the old period's count. Readers deciding what today looks like use `effectiveProgress()` (`src/lib/track.ts`), which reads an expired period as 0; writes (`incrementProgress`, prompt actions) run that quota's rollover inline first (`rolloverQuotaNow`), so a +1 at 00:02 counts for the new day. `progress_events` records the delta actually applied (a −1 at zero records nothing).

**Undo across a period boundary is a no-op.** Progress snapshots carry the period they were counted in (a `_period_start` witness; `createQuotaSnapshot`). Undo and redo skip a snapshot whose quota has since moved to a new period — they do not refuse, because a throw inside `undoEntry` would roll back the `undone` flag and wedge the undo stack. The entry is still marked undone.

## Quota reminders (prompts)

Every unmet quota also appears as a **prompt** in a reminder period (time slot) each day, so quotas get the attention reminders get (2026-09-24; `src/core/tasks/quota-prompts.ts`). Prompts are computed at read time — nothing is stored per prompt — and arrive in `GET /api/reminders` `groups[].prompts`, a separate array from `reminders` (which, with its counts, is unchanged). Identity: `prompt_key` = `q:<taskId>:<k>:<date>`.

- **Daily** quota (FREQ=DAILY, no INTERVAL), target N: numbers 1..N spread one per period from the quota's period, clamping at the last period; each number's period can be set in the editor. One row per quota per period, standing for the highest number there (`k`); done once today's count reaches `k`. The label shows progress ("Daily Walks · 1/2").
- **Every other** quota (weekly, monthly, yearly when enabled, daily with INTERVAL > 1): one prompt a day. Done for today once any progress is logged today from anywhere; gone until the period resets once met.
- Defaults: on for daily/weekly/monthly, off for yearly and period-less; `quota_prompt_config.enabled` overrides. Only the user's own quotas (never another user's shared-project quota).
- Off switches: the user's `quota_prompts_enabled` preference, and `OPENTASK_QUOTA_PROMPTS=off` on the server. Either empties every `prompts` array and takes prompts out of the notifications.
- **Notifications**: a waiting prompt (not considered, not done) counts exactly like a reminder in its slot's push and in the hourly nags. A slot with only prompts still notifies, and a slot stays unfinished until its prompts are handled. The body counts both, e.g. "3 reminders · 2 quotas waiting". Prompts are never in the app-icon badge. See `docs/NOTIFICATIONS.md` § Time-slot notifications.
- **Where**: slot ids are stored (the quota's `quota_prompt_config.slot_id` / `numbers`, the user's `quota_prompt_slot_id`) and resolved at read time with one fallback rule: the quota's slot if it exists, else the user's default if it exists, else the first period of the day (`resolvePromptSlot`). A write naming a slot id the stored config does not already name must name one of the quota **owner's** periods (`assertPromptSlotsOwned`, 400 otherwise); stale ids already stored are left alone, so a quota whose period was deleted stays editable.
- **Moving a prompt** (2026-09-25): the prompt's hold bubble on the web and a press-and-hold on the watch offer the user's periods; one tap is a `PATCH /api/tasks/{id}` of the merged `quota_prompt_config` — the quota editor's own write, so one undo entry. A non-daily quota gets `slot_id`. A daily row moves only the numbers it stands for (`groups[].prompts[].numbers`, e.g. `numbers: {"1": <slot>}`); the quota's other numbers stay put. Each prompt also carries the `slot_id` it sits in.
- **Several quotas at once** (2026-09-25): the Quotas page's multi-edit Details has "Remind me daily" (on / off / mixed "—") and a "Reminds me in" period row, and sends only what changed through `POST /api/tasks/bulk/edit` — one undo entry. There, and only there, `quota_prompt_config` is **merged** over each quota's stored config (`mergePromptConfig` in `src/core/tasks/bulk.ts`): `enabled`/`slot_id` replace that field, `numbers` replaces the map and `{}` clears it. Choosing a period sends `{slot_id, numbers: {}}`, so a daily quota's numbers spread from that base exactly as a fresh one's do.

Two actions, because ticking a reminder means "considered", not "did it":

| Action                                        | Endpoint                                                                       | Effect                                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Consider (the circle; every "Considered all") | `POST /api/quota-prompts/consider`, or a bare key in `bulk/complete` `prompts` | Handled for today; no progress                                                                    |
| Did it (the square checkbox)                  | `POST /api/quota-prompts/did`, or `{ key, did: true }` in `bulk/complete`      | Daily #k: count raised to ≥ k. Others: +1 unless this key was already done today. Also considered |

Both are one transaction and one undo entry (`quota_prompt`, or the `bulk_done` entry of a mixed batch). The owner's day lives in `quota_day_state` (`{date, logged, did, considered}`), written in the same transaction as the count and by every `incrementProgress`, and restored by undo — so undoing a +1 or a did-it brings the prompt back. Keys for another local day are refused. Prompts are never put back with `/undone` (a quota refuses it); undo is the way back.

## Overdue

"Overdue" everywhere — the badge, the notifier, the snooze-overdue sweep and `GET /api/tasks?overdue=true` — is `getCurrentlyDueTaskIds` (`src/core/tasks/currently-due.ts`): reminders and quotas are never overdue, and a recurring task's due-ness is derived from its schedule (`effectiveDueAt`).

## Updating Recurrence Rules

Updating `rrule` also re-derives `anchor_*` fields and may recompute `due_at`. When logging this for undo, include all derived fields in `fieldsChanged` so undo restores the complete prior state:

```ts
const fieldsChanged = ['rrule', 'anchor_time', 'anchor_dow', 'anchor_dom', 'due_at']
```

## Undo System

Functions from `@/core/undo`:

```ts
logAction(
  userId: number,
  action: UndoAction, // 'done' | 'undone' | 'snooze' | 'edit' | 'delete' | 'create' | 'restore' | 'bulk_*' | 'progress' | 'skip' | 'time_slot_*' | 'quota_prompt'
  description: string | null,
  fieldsChanged: string[],
  snapshots: UndoSnapshot[],
  slotState?: SlotUndoState, // only for 'time_slot_edit' | 'time_slot_delete'
): number
```

**Time slot entries (2026-09-24).** Moving a time slot's start or removing a slot moves that slot's reminders (a reminder belongs to a slot only through its time of day). Those two changes log `time_slot_edit` / `time_slot_delete`, whose task snapshots are the moved reminders and whose `slotState` (`undo_log.slot_state`) is the slot row before/after. Undo and redo write the slot row back in the same transaction, so one Undo restores the slot together with its reminders — a deleted slot comes back under its original id. See `src/core/time-slots/edit.ts`.

- `createTaskSnapshot(beforeTask, afterTask, fieldsChanged, completionId?)` — build an `UndoSnapshot`. See [Critical Requirements](../AGENTS.md#every-mutation-must-be-atomic-and-logged-for-undo) for usage details and the `completionId` pattern.
- `executeUndo(userId)` — restores the task to `before_state` from the most recent undoable action
- `executeRedo(userId)` — re-applies `after_state` from the most recent undone action

Undo history is per-user and works as a stack (last action undone first).

## Task Access

`canUserAccessTask(userId, task)` from `@/core/tasks` — returns `true` if the user owns the task or it's in a shared project. Use this in route handlers that need to verify access.
