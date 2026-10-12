# Task Model

Complete reference for the OpenTask task data model: deadline, target and horizon, task segments, priority, recurrence, snooze, quotas and undo. The main `AGENTS.md` has a brief summary; this file has the full details.

## Deadline, target, horizon

The 2026-10-10 task model. Until then one field, `due_at`, carried four different things: real deadlines, the times Trent wanted to start, AI placeholders, and pure awareness. Daily bulk snoozing bent it until "overdue" meant nothing ("I have 25 overdue things, and I'm really not overdue on 25 things" — Trent, 10-10). Now a task carries a separate answer for each question:

| Column        | API name                                | Meaning                                                                                                    | Moved by                                                       |
| ------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `due_at`      | `target_at` (`due_at` deprecated alias) | The **target**: when nagging starts. A soft commitment to a day and time                                   | Snooze (keeps the age), re-target (restarts it), remove target |
| `deadline_at` | `deadline_at`                           | The **deadline**: the real cutoff. It can move, but only deliberately                                      | Only an explicit write of the field. Never a snooze            |
| `horizon`     | `horizon`                               | How soon it should get done, its pace: `days`, `weeks`, `months`, `eventually`, or `null` (unset, = weeks) | Only an explicit write. Nothing grows or shrinks it on its own |
| `priority`    | `priority`                              | Unchanged: what missing it costs                                                                           | Unchanged                                                      |

Target, deadline and horizon are each nullable and independent of the others. The pure rules live in `src/lib/task-segments.ts`, shared by the server and the web UI. `tests/behavioral/tm-task-model.test.ts` has the rules as tests.

### API names

`target_at` is the primary name for the target, in requests and responses. `due_at` is its deprecated alias: older native builds, Shortcuts and the desks send it, so it is still accepted, and it is still returned with the same value (`formatTaskResponse`). Likewise `retarget: true` is the primary name for `reset_original_due_at: true`. The DB column is still `due_at`. `normalizeTargetAliases` (`src/core/validation/task.ts`) maps the names on create, update and the `changes` of a bulk edit. Sending both names with different values is a 400, never a guess.

Reads also expose `deadline_at`, `horizon`, `horizon_set_at`, `last_considered_at`, `segment_deferred_at`, `deadline_nag_off` and `original_due_at` (the first-target date).

### Target

The target is when a task starts nagging: the dashboard's over-target list, the overdue notifications, the app-icon badge. Before its target arrives, or with no target, a one-off task sits in a [task segment](#task-segments) instead. **Never both.**

**The target's age.** `original_due_at` is the first-target date, and the age clock:

| Change                                                              | `original_due_at`              |
| ------------------------------------------------------------------- | ------------------------------ |
| Any snooze (see [Snooze](#snooze))                                  | Kept: the age keeps counting   |
| Re-target (`retarget: true`, the target line's own picker)          | = the new target: age restarts |
| A task with no target gets one (any path, including "Target today") | = the new target: age restarts |
| Remove target (`target_at: null`)                                   | Cleared                        |

A no-target → target change always restarts the clock, even if a stale origin is somehow still stored, so a fresh target never shows an age inherited from an old one (`collectDueAtChanges`, `src/core/tasks/helpers/collect-field-changes.ts`).

**Target-age badge.** An over-target row carries a corner tab with just the age ("2d"): whole local days since the first target (`targetAgeDays`). Blank on the target day itself. Three depths of one calm plum (`--over-target`; never red or amber — Trent, 2026-10-11): 1–2 days light, 3–6 medium, 7+ strong. Red is kept for a passed deadline only (`TARGET_AGE_MEDIUM_DAYS = 3`, `TARGET_AGE_STRONG_DAYS = 7`, placeholders Trent may tune). A deadline-only task's age counts from its implied target. Never from before the task was created (2026-10-11): the age is how long it has been on the list, so a task created with a deadline 3 days out (implied target yesterday) shows no badge on its first day.

**Remove target** sends the task back to its horizon's segment. On a task with a deadline it also sets `deadline_nag_off`, or removing would do nothing: the deadline's implied target would keep the task over target.

There is no automatic target lapse. Over-target items are cleared by done, remove target, Process ("remove targets aged 7d+", `STALE_TARGET_DAYS = 7`, which leaves deadline tasks out) and review.

### Deadline

`deadline_at` is an ordinary field. No snooze path ever sends it, which is what keeps a snooze from moving it. Enrichment sets it only from an outside date stated in the wording: an AI-guessed deadline is worse than an AI-guessed date, because it caps snoozing.

**The deadline caps a snooze, but only while it is still ahead.** `crossesDeadline(deadline, until)` is true when the deadline is in the future and the snooze lands past it. It is never a silent clamp:

| Path                                                                                                                                                           | Snooze past a deadline that is still ahead                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single snooze (snooze endpoint, `PATCH { target_at }`, the quick grid)                                                                                         | Refused: 409 `PAST_DEADLINE` (`PastDeadlineError`). Resend with `allow_past_deadline: true` once the user confirms. On the web the confirm is the refusal toast's "Snooze anyway" button, with Undo after (`src/lib/past-deadline.ts`), not a modal                                                                                                                                                               |
| Bulk snooze, snooze-overdue, bulk edit with a date                                                                                                             | The task is left where it is and counted in `skipped_deadline`, the way an Urgent task is. Ids in `allow_past_deadline_ids` go through. The web toast adds "· N kept before their deadline"                                                                                                                                                                                                                       |
| Native quick snoozes: notification buttons, the content extension's custom time, widget / watch / Mac menu-bar rows (`cap_at_deadline`, `cap_at_deadline_ids`) | Stopped AT the deadline (ruling A3, 2026-10-11): the target moves to the deadline, `deadline_nag_off` is NOT set, and it says so — the description reads "Snoozed to deadline 6:00 PM", `capped_at_deadline` / `capped_deadline` in the response, a quiet "Snoozed to deadline" push for a notification button (`deadline-cap-feedback.ts`) and the Mac menu bar's note. Only the web's "Snooze anyway" goes past |
| Re-target (`retarget: true`), or a task with no target getting its first                                                                                       | Not capped: that sets a target, it doesn't snooze one                                                                                                                                                                                                                                                                                                                                                             |

**Past the deadline, nagging continues** (Trent: "sometimes it's for a client and you're in a rush, so we can't just stop nagging"). The cap is off, snooze works as it always did, and the over-target row carries a past-deadline marker (`isPastDeadline`). A better post-deadline behavior is an open question; none is built. **The cap is PROVISIONAL.**

**A deadline with no target still nags.** A one-off task with a deadline and either no target or a target **past** the deadline has an **implied target**: the user's `morning_time` on the day `DEADLINE_LEAD_DAYS` (4, every priority; tentative, `src/lib/task-segments.ts`) before the deadline (rulings A2 and B2, 2026-10-10 — a target set past its own deadline never hides the deadline; an end-of-day deadline doesn't first nag at 23:59). The task nags from the earlier of its own target and the implied one. A target at or before the deadline is honoured as set. It is computed, never stored, so nothing drifts: `effectiveTargetAt(task, ctx)` everywhere, with the user's clock (`getTargetContext` on the server, `setClientTargetContext` in the browser); the over-target queries shortlist deadline rows in SQL and put the effective target in `due_at` in JS (`withEffectiveTarget`). A SNOOZE that lands past the deadline — confirmed with `allow_past_deadline`, or any snooze once the deadline has passed — sets `deadline_nag_off`, so the snooze holds; a deliberate re-target past the deadline does not. **The deadline day re-arms it (ruling A4, 2026-10-11):** with `deadline_nag_off` set, the implied target is the user's morning on the deadline's own local day (or the deadline itself, if earlier), so on its last day a deadline task is quieted only by done, delete or the per-task nag override (`auto_snooze_minutes: 0`) — remove target and "Snooze anyway" silence the 4-day nag, not the last day. A target of the user's own at or before the deadline is still honoured, and once the deadline has passed, a task that has a target of its own (a deliberate snooze past it) follows that target; with no target it stays on until done. A snooze the re-armed nag overrides is saved and its response description is `DEADLINE_TODAY_HOLDS` ("Deadline today: this stays on until it's done"), which the toast shows. A deadline-only task already nagging from its implied target is SNOOZED when moved (capped, counted, its age kept). `deadline_nag_off` (what remove target sets) turns it off for that task. Any change to `deadline_at` turns it back on, unless the same request says otherwise: a new deadline is new information. Recurring tasks never get an implied target.

**A recurring deadline moves with the occurrence** (the weekly Upwork lock). On done, skip and put-back, `advanceDeadline` keeps the deadline the same number of calendar days after the new occurrence, at the same LOCAL time of day, so a DST change doesn't shift it by an hour. It measures from the occurrence origin (`original_due_at`), so a snoozed occurrence never shifts it. Left alone, a stale deadline would cap every later snooze.

### Horizon

How soon the task should get done. It decides which [task segment](#task-segments) the task appears in, and nothing else. `null` is unset: treated as `weeks`, but never reported as set (`task.horizon` stays null, and the UI says "Unset"). Enrichment sets it only from explicit pace wording ("sometime this month"). Changing it restarts `horizon_set_at`, the clock Process reads to ask whether a horizon should grow; re-sending the same value is not a change.

**Effective horizon** (`effectiveHorizon`) is the sooner of the set horizon (unset = weeks) and the one the deadline implies:

| Deadline         | Implies  |
| ---------------- | -------- |
| ≤ 7 days away    | `days`   |
| ≤ 21 days away   | `weeks`  |
| ≤ 90 days away   | `months` |
| Further, or none | nothing  |

A deadline only ever pulls a horizon **in**. Nothing grows one on its own: growth is Process asking and the user saying yes. The 90-day step is this build's call, so a deadline months away still surfaces monthly on an "eventually" task.

The dashboard's `horizon` sort (`src/lib/task-grouping.ts`) orders over target first, then effective horizon, deadline, priority, newest. It is the default sort for new users since 2026-10-11 (`users.default_sort` defaults to `horizon`); a saved sort is never changed.

### Over target

"Over target" is what "overdue" was: a task whose target, set or implied, has arrived. Same machinery, new word — see [Over target (overdue)](#over-target-overdue) for the code. The code, the API and the query parameters keep "overdue". The UI word lives in one constant, `OVER_TARGET` in `src/lib/task-model-words.ts`, beside `HORIZON_WORD` and the horizon labels. Both words are **PROVISIONAL** (Trent: "not a fan of the name"; "horizon" "doesn't resonate"). The native apps keep their own copy.

## Task segments

Rules in `src/lib/task-segments.ts`; reads and actions in `src/core/tasks/task-segments.ts`; the row in `src/components/TaskSegmentRow.tsx`, the Reminders-screen section in `src/components/reminders/TaskSegmentGroup.tsx`, the panel page in `src/components/DashboardRemindersPanel.tsx`.

A task segment lists tasks whose target hasn't arrived, for awareness, on the reminders screen. It answers "out of sight, out of mind": a squeaky door isn't worth today, but without being reminded at some clip, the day it would fit naturally is missed too.

**Which tasks.** The user's own open, one-off tasks: not deleted, not archived, not recurring (its schedule already brings it round), not a reminder, not a quota. Only the owner's: a task in someone else's shared project is theirs to consider. And only while its effective target is not today or earlier. A target later **today** already takes a task out (`targetIsToday` compares local days), so "Target today" moves it to the dashboard at once instead of showing it in both places until the hour comes.

**One segment per effective horizon, each on its own day** (`latestSegmentDay`):

| Horizon      | Comes round                                                       |
| ------------ | ----------------------------------------------------------------- |
| `days`       | Every day                                                         |
| `weeks`      | Every Saturday                                                    |
| `months`     | The first Saturday of the month (it stacks with weeks that day)   |
| `eventually` | The first Saturday of each quarter: January, April, July, October |

A segment shows only on a day it has items.

**Carry-over.** A task appears once its segment has come round since the task was last **seen**, and keeps appearing, day after day, until it is considered ("anything not considered shows again the next day until it is"). Seen is the later of `last_considered_at` and `created_at`. Writing a task down is seeing it, so a weeks task added on Tuesday waits for Saturday.

**States** (`segment_state` on each row): `waiting`; `considered` (considered today); `deferred` (Defer All today: off today's list, back tomorrow). The web lists only `waiting` rows; the header counts "X of Y" like a slot (X = considered + deferred today, Y = the segment's rows today — a task marked done leaves it entirely), and "Show N considered" unfolds the rest, each with a put-back (`POST /api/task-segments/restore`, which clears both stamps; 2026-10-11).

**Order.** Priority, then id. Horizon decides **whether** a task shows, never where, so acting on one never reorders the rest under the finger (the 09-05 rule).

**Over 50 items** (`nudge`, strictly more than `SEGMENT_NUDGE_THRESHOLD`) the segment suggests Process or AI help instead of a tap-through.

**Never counted, never notified.** Segments are not in `groups[]`. Their rows never count in the reminders headline, the nav badge, "Considered all so far", the slot notifications or the hourly unfinished-slot nag, and a segment never sends a notification. Anything time-critical has a target, and a task whose target has arrived is on the dashboard, not here.

**Where it shows.** After the periods, and shaped like one (Trent, 2026-10-11: "days, weeks, etc. should be individual segments and behave similarly to the segments for reminders"; earlier the same day each was a card of its own under the periods, and 10-10 had them first). On the Reminders screen each segment is a section like a period's: the collapsible header ("TASKS · DAYS · Shown every day", "X of Y"), the hairline, the rows, and "Show N considered" with put-back; "Defer all" sits where a period has "Considered all". On the dashboard the segments have their own **Tasks card**, directly under the Reminders card (Trent, 2026-10-11: "i liked the reminders on top of tasks like it was before"; for part of that day they were pages of the period pager). The Reminders card pages through the periods alone, as before. The Tasks card is a pager of the same shape across today's segments: its own strip of teal bars (proportional, gray track, green when all handled, the page on screen ringed in its teal), the same chevrons, header ("TASKS · DAYS · Shown every day"), row cap and "Show more", the "X of Y" that opens what was considered with put-back, and "Defer all" behind the header tap. It opens on the first segment with anything waiting and, when one is finished (last row or Defer all), moves to the next that waits (`usePanelPager` with no slot pages: `naturalPageIndex`, `pageAfterFinishing` in `src/lib/time-slot-assign.ts`); it never lands on a finished segment while another waits. With every segment finished it collapses to one line, "Tasks · 75 of 75 ✓", whose count still opens what was considered. A horizon change that moves a row to another segment says so: "Moved to Tasks · Months". Rows use the slot rows' exact geometry on each surface (panel: 19px controls, 13.5px title; page: 24px, 16px), so circles and checkboxes line up down the column. The native surfaces follow: the Reminders widget's page ring is slots then segments with the clock's slot as the natural page, and the watch shows segments after the period's rows.

**Colours** (2026-10-11, Trent's pick): one teal per horizon, darkest for the soonest — the `--segment-*` tokens in `src/app/globals.css`. Fills, light: Days `#0f9d8f`, Weeks `#2bb5a6`, Months `#4fb8ab`, Eventually `#8ccfc6`; dark: Days `#2bb5a6`, Weeks `#4fc8bb`, Months `#8fdcd2`, Eventually `#c3ece6`. Titles (`--segment-title-*`): light, `#0b7a6f` for every horizon (the lighter fills are too faint for small text); dark, each title is its fill. A segment's bar fills in its teal over the slots' gray track and turns green when finished, like a slot. The Reminders screen's day bar (above the periods) shows the segments after the periods the same way, a tap scrolling to the section; they stay out of its "N waiting so far" and "X of Y considered".

**The row.** Circle on the left = considered (never a completion; a tap anywhere else on the row does the same, as on a reminder). Checkbox on the right = done. "Today" (target today) sits just left of the checkbox. A quiet horizon chip changes the horizon in one tap; it shows its word only when the task's own horizon differs from the segment's (a deadline pulled it in), and a faint dot marks unset. A second line appears only when there is something to say: a future target as a date chip ("Nov 1"), or the deadline. Without either the row is one line, a reminder row's height.

**API.** `GET /api/reminders` returns a top-level `task_segments` array. It is deliberately not inside `groups`: a native build that predates it ignores the key, so its "Complete all" can never reach a real task.

```json
"task_segments": [
  {
    "horizon": "weeks",
    "tasks": [{ "id": 12, "title": "…", "target_at": null, "segment_state": "waiting" }],
    "waiting": 3,
    "considered": 1,
    "deferred": 0,
    "nudge": false
  }
]
```

Each task is a full `formatTaskResponse` row plus `segment_state`. Three actions, each with the body `{ "ids": [taskId, ...] }`. The ids must be the caller's own open tasks; anything else is a 400, not a skip. Each action is one transaction and one undo entry (`task_segment`, or the bulk edit's for Target today), logged even when nothing changed, so a toast's Undo never reaches an older action.

| Endpoint                               | Effect                                                                                                                                                                                                                                                                                                                                                                                                             | Response              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| `POST /api/task-segments/consider`     | The circle: stamps `last_considered_at`. "I saw it." Never a completion                                                                                                                                                                                                                                                                                                                                            | `{ considered }`      |
| `POST /api/task-segments/defer`        | Defer All: stamps `segment_deferred_at`. Off today's segment, back tomorrow. Not a consider, which keeps "considered" honest                                                                                                                                                                                                                                                                                       | `{ deferred }`        |
| `POST /api/task-segments/target-today` | A deliberate target (`retarget`: the age starts there) at the time the Snooze-all button goes to (`bulk_snooze_default`: the next period, or the default snooze option) if that is still today, else the top of the next hour (`targetTodayTime`). Also stamps considered, in the same bulk edit, so one Undo puts back both. Every id counts as an explicit pick, so the High/Urgent sweep filter never drops one | `{ until, affected }` |

## Priority and bulk snooze

Priority is **what missing the task costs**. It no longer says whether a date is a deadline: the deadline is its own field (see [Deadline](#deadline)), and a low-priority meal voucher that expires on the 11th still expires on the 11th. Priority sets the nag cadence (`docs/NOTIFICATIONS.md` § Repeat intervals), the notification's interruption level, and how a bulk snooze treats an over-target task:

| Priority        | Bulk snooze                     | Over-target significance |
| --------------- | ------------------------------- | ------------------------ |
| 0-1 (Unset/Low) | Eligible                        | Normal — not a problem   |
| 2 (Medium)      | Eligible                        | Low                      |
| 3 (High)        | Only when nothing lower is left | Significant              |
| 4 (Urgent)      | Never                           | Critical                 |

`HIGH_PRIORITY_THRESHOLD = 3` and `URGENT_PRIORITY = 4` in `src/lib/priority.ts` are the boundaries. Urgent tasks also break through everything (critical-level notifications) and must be snoozed individually, so every change to one is a deliberate decision. On top of the priority rules, a task whose snooze would cross a deadline that is still ahead stays put (see [Deadline](#deadline)).

**Bulk snooze:** P0-P2 are always swept. **P3 (High) is swept only when no lower-priority task in the same batch is still eligible** — so the first press clears P0-P2 and a second press, finding only High left, takes it. Two presses, no mode, no second button. P4 (Urgent) is never swept: every change to an Urgent task's target has to be a deliberate, individual act.

The test is "is anything lower still eligible", **not** "is the batch pure": a P4 sitting in the batch does not hold the High tier back, because a P4 is never swept and would otherwise block it forever. `include_task_ids` still rescues an explicitly chosen task at any priority. The rule lives in `filterForBulkSnooze` (`src/core/tasks/bulk.ts`).

Why the change (Trent, 2026-09-15): with four overdue High tasks and nothing else late, the sweep button reported "no snoozable tasks" and the list stayed wrong. Excluding High outright protects a High task from a sweep the user did not read; a sweep aimed at a batch that is already nothing but High tasks is the user looking straight at them and pressing anyway. (Written when P3/P4 dates stood in for deadlines. A real deadline is now protected by the deadline cap at any priority.)

**Implications for code and AI:**

- A task's real cutoff is `deadline_at`, never its target. Don't read a target as a deadline at any priority, and don't infer a deadline from priority.
- `created_at` is the most reliable age signal — it never changes. Use it over `due_at` for understanding how long a task has existed.
- `original_due_at` is the first-target date: the gap to `due_at` is how far snoozing has moved the target since it was set, but not how many snoozes occurred or why. Don't infer snooze counts or user intent from dates alone.
- `snooze_count` is a lifetime stat incremented on every snooze (including bulk). High counts are normal, not a sign of avoidance.
- For P0-2 tasks, avoid language like "deferred three times" (implies conscious decisions). Prefer factual framing: "has been on your list for 3 weeks." These tasks ride the bulk sweep, so a shifted target reflects a sweep the user never read, not a decision.
- An unset `horizon` is unset, not "weeks": never report it as stated.

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

Snooze moves the target (`due_at`) without modifying recurrence, and never touches `deadline_at`. For recurring tasks, the original schedule is preserved: a daily 9:00 AM task snoozed to noon and then completed will still regenerate as due at 9:00 AM tomorrow.

**Snooze vs explicit reschedule** (Trent, 2026-09-24). `original_due_at` is the occurrence origin; a task is **snoozed** when `due_at` has moved off it (`is_snoozed` = `original_due_at` set and `!== due_at`, the same test as the row's snoozed indicator). A freshly dated task is not snoozed — `createTask` sets the origin to the first date.

| Change to an existing date                                                                                                                                                | What it is  | `original_due_at`       | `snooze_count` |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------- | -------------- |
| Snooze endpoint, bulk snooze, snooze-overdue, notification snooze, quick-panel +1h/preset/Now buttons, bare `PATCH { target_at }` or `{ due_at }` (iOS content extension) | Snooze      | Kept (set on first one) | +1             |
| `PATCH { target_at, retarget: true }` (alias `reset_original_due_at`) — the target line's own picker; also "Target today"                                                 | Re-target   | = the new `due_at`      | Reset to 0     |
| `PATCH { rrule, due_at }`                                                                                                                                                 | Re-schedule | Cleared                 | Unchanged      |

A task with **no** date is not snoozed by any of these: it gets its first date (origin = that date, `snooze_count` unchanged, no snooze stat), and a task already due at the target is left alone. Bulk snooze follows the same rule as `PATCH` and bulk edit — it goes through the same `collectFieldChanges` (2026-09-29; it used to count both as snoozes). A bare `PATCH { due_at }` stays a snooze because the iOS content extension snoozes with exactly that payload, so the reschedule has to opt in. Undo restores the prior `original_due_at` and `snooze_count` either way. A snooze past a deadline that is still ahead is refused or skipped (see [Deadline](#deadline)). `default_snooze_option` (the single-tap snooze) also accepts `next_period` (2026-10-10). `PATCH { rrule, due_at }` honors the date and derives the rule's anchors from it, like `createTask` (it used to be dropped).

**Default reminder slot** (2026-09-28). A reminder created without a schedule — `POST /api/tasks {"title", "is_reminder": true}` with `rrule` omitted and no `due_at`, as an Apple Shortcut or the Reminders quick add sends — is given `FREQ=DAILY;BYHOUR=h;BYMINUTE=m` at the start of the user's default reminder slot (`defaultReminderRule`, `src/core/time-slots/index.ts`), so it never starts in "Anytime". It is still title-only for the enrichment trigger (judged on the caller's input), and enrichment with no time cue keeps it in that slot. The setting is `users.quota_prompt_slot_id` (API alias `default_reminder_slot_id`) — the same default quota prompts use, resolved the same way (`resolvePromptSlot`: the stored slot, else the first period). An explicit `rrule: null` stays unscheduled (a one-time reminder); a supplied rule is used as sent; a user with no slots gets no default.

**Reminders** (`is_reminder`) are never snoozed: the snooze endpoint refuses them, bulk snooze skips them, and a bare `PATCH { due_at }` that would move a dated reminder is refused too. An explicit reschedule (`reset_original_due_at: true`) is allowed, as is giving an undated reminder its first date. `skip-occurrence` refuses reminders — a missed one rolls forward on its own, and completing one marks it considered.

## Quotas and completion

A quota (`isTracked`: `is_tracked` or `progress_target > 1`, one definition in `src/lib/track.ts`) is counted within its period; its period boundary resets `progress_current`. Marking one **done** closes the period early and zeroes the count, so `markDone` refuses a quota unless the caller passes `close_period: true`, and `bulkDone` skips quotas (reporting `quota_skipped`) unless the same flag is set — refusing only when the batch is nothing but quotas. No app surface completes a quota; they log progress (`POST /api/tasks/{id}/progress`).

**A quota always has a period** (Trent, 2026-09-25): its rule names a day, week, month or year (`quotaPeriodOf`). With no period there is no boundary, so the count would never reset and a met prompt would never return. Create, PATCH and bulk edit refuse a result that is a quota without one (`QUOTA_PERIOD_MESSAGE`, 400) — `rrule: null` on a quota, or making a task a quota without a rule; a bulk edit that would do it to any row is refused whole. A legacy period-less row (none in production) is still read harmlessly and stays editable while a write leaves its rule alone.

A quota's completions are the period rollover's (`period-rollover.ts`): a met period closes into a completions row. `markUndone` (`POST /api/tasks/{id}/undone`) refuses a quota — putting one back deleted that record while the period stayed closed. Correct the count with a −1.

**Which period a count belongs to** (2026-09-24). The rollover cron runs every few minutes, so for a few minutes after a boundary a quota still carries the old period's count. Readers deciding what today looks like use `effectiveProgress()` (`src/lib/track.ts`), which reads an expired period as 0; writes (`incrementProgress`, prompt actions) run that quota's rollover inline first (`rolloverQuotaNow`), so a +1 at 00:02 counts for the new day. `progress_events` records the delta actually applied (a −1 at zero records nothing).

**Undo across a period boundary is a no-op.** Progress snapshots carry the period they were counted in (a `_period_start` witness; `createQuotaSnapshot`). Undo and redo skip a snapshot whose quota has since moved to a new period — they do not refuse, because a throw inside `undoEntry` would roll back the `undone` flag and wedge the undo stack. The entry is still marked undone.

## Quota reminders (prompts)

Every unmet quota also appears as a **prompt** in a reminder period (time slot) each day, so quotas get the attention reminders get (2026-09-24; `src/core/tasks/quota-prompts.ts`). Prompts are computed at read time — nothing is stored per prompt — and arrive in `GET /api/reminders` `groups[].prompts`, a separate array from `reminders` (which, with its counts, is unchanged). Identity: `prompt_key` = `q:<taskId>:<k>:<date>`.

- **Daily** quota (FREQ=DAILY, no INTERVAL), target N: numbers 1..N spread one per period from the quota's period, clamping at the last period; each number's period can be set in the editor. One row per quota per period, standing for the highest number there (`k`); done once today's count reaches `k`. The label shows progress ("Piano Scales · 1/2").
- **Every other** quota (weekly, monthly, yearly when enabled, daily with INTERVAL > 1): one prompt a day. Done for today once any progress is logged today from anywhere; gone until the period resets once met.
- Defaults: on for daily/weekly/monthly, off for yearly (and for a legacy period-less row, which can no longer be created — see below); `quota_prompt_config.enabled` overrides. Only the user's own quotas (never another user's shared-project quota).
- Off switches: the user's `quota_prompts_enabled` preference, and `OPENTASK_QUOTA_PROMPTS=off` on the server. Either empties every `prompts` array and takes prompts out of the notifications.
- **Notifications**: a waiting prompt (not considered, not done) counts exactly like a reminder in its slot's push and in the hourly nags. A slot with only prompts still notifies, and a slot stays unfinished until its prompts are handled. The body counts both, e.g. "3 reminders · 2 quotas waiting". Prompts are never in the app-icon badge. See `docs/NOTIFICATIONS.md` § Time-slot notifications.
- **Where**: slot ids are stored (the quota's `quota_prompt_config.slot_id` / `numbers`, the user's `quota_prompt_slot_id` — the default reminder slot, which also places new reminders) and resolved at read time: the quota's slot, else the user's default, else the first period of the day (`resolvePromptSlot`). Retiming a slot keeps its id, so its prompts follow it. **Deleting a slot moves its prompts the way it moves its reminders** (2026-09-25): every stored id naming it is repointed to the remaining slot nearest the removed slot's start, in the delete's own transaction and undo entry (`deleteTimeSlot`, `src/core/time-slots/edit.ts`), so one Undo restores the slot, its reminders and its prompt placements. Only stored ids move — a daily quota's never-placed numbers re-spread over the remaining periods. The read-time fallback past a missing id remains only for ids left stale by deletes made before that rule. A write naming a slot id the stored config does not already name must name one of the quota **owner's** periods (`assertPromptSlotsOwned`, 400 otherwise); stale ids already stored are left alone, so such a quota stays editable.
- **Moving a prompt** (2026-09-25): the prompt's hold bubble on the web and a press-and-hold on the watch offer the user's periods; one tap is a `PATCH /api/tasks/{id}` of the merged `quota_prompt_config` — the quota editor's own write, so one undo entry. A non-daily quota gets `slot_id`. A daily row moves only the numbers it stands for (`groups[].prompts[].numbers`, e.g. `numbers: {"1": <slot>}`); the quota's other numbers stay put. Each prompt also carries the `slot_id` it sits in.
- **Several quotas at once** (2026-09-25): the Quotas page's multi-edit Details has "Remind me daily" (on / off / mixed "—") and a "Reminds me in" period row, and sends only what changed through `POST /api/tasks/bulk/edit` — one undo entry. There, and only there, `quota_prompt_config` is **merged** over each quota's stored config (`mergePromptConfig` in `src/core/tasks/bulk.ts`): `enabled`/`slot_id` replace that field, `numbers` replaces the map and `{}` clears it. Choosing a period sends `{slot_id, numbers: {}}`, so a daily quota's numbers spread from that base exactly as a fresh one's do.

Two actions, because ticking a reminder means "considered", not "did it" — and a way back from either:

| Action                                                          | Endpoint                                                                       | Effect                                                                                                                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consider (the circle; every "Considered all")                   | `POST /api/quota-prompts/consider`, or a bare key in `bulk/complete` `prompts` | Handled for today; no progress                                                                                                                                            |
| Did it (the square checkbox)                                    | `POST /api/quota-prompts/did`, or `{ key, did: true }` in `bulk/complete`      | Daily #k: count raised to ≥ k. Others: +1 unless this key was already done today — progress logged elsewhere today does not block it (Trent, 2026-09-25). Also considered |
| Put back (the filled dashed circle in a considered / DONE list) | `POST /api/quota-prompts/restore`                                              | Waiting for today again: the key leaves `considered` and `did`, and a did-it's progress comes off — exactly what it added                                                 |

Each is one transaction and one undo entry (`quota_prompt`, or the `bulk_done` entry of a mixed batch). The owner's day lives in `quota_day_state` (`{date, logged, did, considered, did_applied}`), written in the same transaction as the count and by every `incrementProgress`, and restored by undo — so undoing a +1 or a did-it brings the prompt back. Keys for another local day are refused (400).

**Putting a prompt back** (2026-09-25). A handled prompt is listed with the reminders in the web's "Show N considered" lists and the Reminders widget's DONE section; its filled dashed circle puts it back — never `/undone`, which a quota refuses.

- **What comes off.** `did_applied[key]` records what each did-it added to the count, accumulated, so a repeat did-it (which adds 0) keeps the first one's record. Daily #k adds only what was missing up to k, so a did-it that found the count already at k added 0, and its put-back takes 0: the row is un-handled but, with the count still at k, stays done. A did-it recorded before `did_applied` existed reads as 1 for a once-a-day prompt (its first did-it always added exactly 1) and 0 for a daily numbered one (not recoverable; the count is left alone rather than guessed).
- **Cascade.** A did-it the lower count no longer supports waits again with it (below).
- **No-op.** A key already waiting changes nothing, but the request still logs an undo entry, as a −1 at zero does, so a toast's Undo never reaches an older action.

**A −1 that takes back a did-it** (2026-09-25; settles PR #92's open question). When the count drops so a did-it no longer holds, that prompt waits again: its key leaves `did`, `considered` and `did_applied` (`withLogged`, `brokenDids` in `src/lib/quota-prompts.ts`). A daily #k did-it holds while today's count is at least k. Any other quota's holds while anything is still logged today. A prompt that was only considered stays considered through a −1.

## Over target (overdue)

"Over target" in the UI, "overdue" in the code and the API. Everywhere — the badge, the notifier, the snooze-overdue sweep and `GET /api/tasks?overdue=true` — it is `getCurrentlyDueTaskIds` (`src/core/tasks/currently-due.ts`): reminders and quotas are never over target, and a recurring task's due-ness is derived from its schedule (`effectiveDueAt`). Since 2026-10-10 these queries read the **effective** target (`withEffectiveTarget` — see § Deadline, target, horizon), so a deadline-only task joins at its implied target. The client counts (`countTasks`, `src/lib/task-counts.ts`) read the same rule through `effectiveTargetAt`. Moving a deadline-only task that is already nagging is a snooze of its implied target: capped by the deadline, counted, its age kept. A relative +N sweep still skips it, having no date of its own to add to.

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
  action: UndoAction, // 'done' | 'undone' | 'snooze' | 'edit' | 'delete' | 'create' | 'restore' | 'bulk_*' | 'progress' | 'skip' | 'time_slot_*' | 'quota_prompt' | 'task_segment'
  description: string | null,
  fieldsChanged: string[],
  snapshots: UndoSnapshot[],
  slotState?: SlotUndoState, // only for 'time_slot_edit' | 'time_slot_delete'
): number
```

**Time slot entries (2026-09-24).** Moving a time slot's start or removing a slot moves that slot's reminders (a reminder belongs to a slot only through its time of day). Those two changes log `time_slot_edit` / `time_slot_delete`, whose task snapshots are the moved reminders (and, for a delete, the quotas whose `quota_prompt_config` was repointed to the nearest slot, 2026-09-25) and whose `slotState` (`undo_log.slot_state`) is the slot row before/after, plus `prompt_default` when a delete repointed the user's default prompt period. Undo and redo write the slot row (and that default) back in the same transaction, so one Undo restores the slot together with its reminders and prompt placements — a deleted slot comes back under its original id. See `src/core/time-slots/edit.ts`.

- `createTaskSnapshot(beforeTask, afterTask, fieldsChanged, completionId?)` — build an `UndoSnapshot`. See [Critical Requirements](../AGENTS.md#every-mutation-must-be-atomic-and-logged-for-undo) for usage details and the `completionId` pattern.
- `executeUndo(userId)` — restores the task to `before_state` from the most recent undoable action
- `executeRedo(userId)` — re-applies `after_state` from the most recent undone action

Undo history is per-user and works as a stack (last action undone first).

## Task Access

`canUserAccessTask(userId, task)` from `@/core/tasks` — returns `true` if the user owns the task or it's in a shared project. Use this in route handlers that need to verify access.
