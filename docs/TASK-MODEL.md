# Task Model

Complete reference for the OpenTask task data model: deadline, target and horizon, task segments, priority, recurrence, snooze, quotas and undo. The main `AGENTS.md` has a brief summary; this file has the full details.

## Deadline, target, horizon

The 2026-10-10 task model. Until then one field, `due_at`, carried four different things: real deadlines, the times Trent wanted to start, AI placeholders, and pure awareness. Daily bulk snoozing bent it until "overdue" meant nothing ("I have 25 overdue things, and I'm really not overdue on 25 things" — Trent, 10-10). Now a task carries a separate answer for each question:

| Column        | API name                                | Meaning                                                                                                    | Moved by                                                       |
| ------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `due_at`      | `target_at` (`due_at` deprecated alias) | The **target**: when nagging starts. A soft commitment to a day and time. Never after the deadline         | Any move ("Snooze" in the UI), remove target / Back to auto    |
| `deadline_at` | `deadline_at`                           | The **deadline**: the real cutoff. It can move, but only deliberately                                      | Only an explicit write of the field. Never a snooze            |
| `horizon`     | `horizon`                               | How soon it should get done, its pace: `days`, `weeks`, `months`, `eventually`, or `null` (unset, = weeks) | Only an explicit write. Nothing grows or shrinks it on its own |
| `priority`    | `priority`                              | Unchanged: what missing it costs                                                                           | Unchanged                                                      |

Target, deadline and horizon are each nullable, but tied by two rules since 2026-10-12 (spec §8): **a one-off with a deadline always has a target** (the deadline's stored automatic target, if the user picked none), and **the target is never after the deadline**. The pure rules live in ONE module, `src/lib/task-segments.ts` (each constant named once), shared by the server and the web UI — the native apps get them through the API (`attempts_label`, `attempts_offer`, `age_label`, the segments). `tests/behavioral/tm-task-model.test.ts`, `tm-auto-target.test.ts`, `tm-occurrence.test.ts`, `bg-badges.test.ts`, the seeded random invariants in `tm-invariants.test.ts` and the golden suite have the rules as tests (see [Testing the model](#testing-the-model-the-golden-suite-and-the-day-simulator)).

### API names

`target_at` is the primary name for the target, in requests and responses. `due_at` is its deprecated alias: older native builds, Shortcuts and the desks send it, so it is still accepted, and it is still returned with the same value (`formatTaskResponse`). The DB column is still `due_at`. `normalizeTargetAliases` (`src/core/validation/task.ts`) maps the names on create, update and the `changes` of a bulk edit. Sending both names with different values is a 400, never a guess.

Old clients' flags are accepted and change nothing (rulings Q1/Q4, 2026-10-12): `retarget` (alias `reset_original_due_at`) is a plain move on a task (on a reminder it is still the explicit reschedule a period move sends, see [Snooze](#snooze)); `allow_past_deadline(_ids)` and `cap_at_deadline(_ids)` change nothing, since every move stops at the deadline; `deadline_nag_off` is ignored (an old "Remove target" sends it with `target_at: null`, which on a deadline task is now Back to auto).

Reads also expose `deadline_at`, `horizon`, `horizon_set_at`, `last_considered_at`, `segment_deferred_at`, `segment_targeted_at`, `target_set_at` (when the target was last set, see [Upcoming](#upcoming)), `target_auto` (the target is the deadline's automatic one), `occurrence_at` (a repeating task's scheduled occurrence, see [Recurrence Model](#recurrence-model)), `original_due_at` (the first-target date), and the two badges' fields — `attempts`, `attempts_counted_through`, `attempts_label`, `attempts_offer`, `age_label`, `growth_kept_at` (see [The two badges](#the-two-badges-attempts-and-age)). `deadline_nag_off` is no longer stored, but is still returned for shipped native builds: computed per response, `true` only for a one-off whose deadline has passed and whose target is after it, `false` otherwise — so those builds' own implied-target rule reads the task's own target (see [Native builds](#native-builds)). `is_snoozed` and `snooze_count` left the API on 2026-10-12: there is no snooze state.

### Target

The target is when a task starts nagging: the dashboard's over-target list, the overdue notifications, the app-icon badge. **A target the user picked makes a task quiet until its date** (2026-10-12, reversing 10-10's "horizon before the target"): a one-off with a picked target is in no horizon segment, and before the date it shows only on its [Upcoming](#upcoming) heads-up days. A one-off with no target, or with a deadline's **automatic** target (`target_auto`, see [Deadline](#deadline)), sits in its horizon's [task segment](#task-segments). **Never two places at once.** The dashboard's main task list is unchanged for now: it still lists future-targeted tasks until the dashboard redesign. A task that wants occasional early glances should have no picked target: a deadline plus a horizon.

| State                                                                              | Where it shows                                                                                             |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| No target, or the deadline's automatic target not here yet                         | Its horizon segment, on the check-in rhythm. A deadline pulls the horizon in as it nears. No Upcoming rows |
| A picked target (a one-off's, or a repeating task's next occurrence), not here yet | No horizon segment. Upcoming, on its heads-up days only                                                    |
| Target arrived (picked or automatic)                                               | Over target: dashboard, notifications, badge                                                               |

`hasPickedTarget` (`src/lib/task-segments.ts`) is the one test: a target that is not `target_auto`.

**The first target.** `original_due_at` is the first-target date. It no longer drives a badge (the attempts badge replaced the target-age "2d" tab, spec §7), but it is still written for shipped native builds, which read it as their age clock:

| Change                                                               | `original_due_at`              |
| -------------------------------------------------------------------- | ------------------------------ |
| Any move (every snooze; `retarget` from old clients changes nothing) | Kept: the age keeps counting   |
| A task with no target gets one (any path, including "Target today")  | = the new target: age restarts |
| A deadline's automatic target is stored                              | = that target                  |
| A repeating task's done / skip                                       | = the next occurrence          |
| Remove target (`target_at: null`, no deadline)                       | Cleared                        |

A no-target → target change always restarts the clock, even if a stale origin is somehow still stored, so a fresh target never shows an age inherited from an old one (`collectDueAtChanges`, `src/core/tasks/helpers/collect-field-changes.ts`).

**The attempts tab.** A row with a target and at least one attempt carries a corner tab with the count ("3×"): local days on which it was over target (see [The two badges](#the-two-badges-attempts-and-age)). It replaced the target-age "2d" tab on 2026-10-12.

**Remove target** sends a one-off with no deadline back to its horizon's segment (the row's snooze menu, the editor's … menu, Upcoming's target chip). **A deadline task never loses its target** (§8.3): in the same places it offers **Back to auto** instead — only when its target is one the user picked (ruling Q9); an automatic target offers neither. Back to auto is `target_at: null` on a deadline task: the server stores the automatic target again, computed from that moment (nothing records when the deadline was first set). One rule decides what each surface offers: `targetReset` (`src/lib/task-segments.ts`). A repeating task's target goes only with its recurrence ("Remove target & recurrence").

There is no automatic target lapse. Over-target items are cleared by done, remove target / Back to auto (which the row offers at 3×), Process (targets missed on 3 or more days, `ATTEMPTS_OFFER_REMOVE`; it lists deadline tasks apart and unchecked, and never an automatic target) and review.

### Deadline

`deadline_at` is an ordinary field. No snooze path ever sends it, which is what keeps a snooze from moving it. Enrichment sets it only from an outside date stated in the wording: an AI-guessed deadline is worse than an AI-guessed date, because it caps snoozing.

**A deadline always has a visible target** (spec §8, 2026-10-12 — Trent: "the Friday-morning deadline-day nag is adding a required target, but through some other invisible mechanic, which I do not like"). It replaced the read-time implied target, `deadline_nag_off` and the deadline-day re-arm (ruling A4).

1. **Stored, not computed.** A one-off (not a reminder, not a quota) with a deadline and no target the user picked carries a real stored target, flagged `target_auto`: the user's `morning_time` on the deadline's local day minus the **lead** — the same 3/4 lead as Upcoming's early heads-up (`leadDaysForWait`; Trent: "let's make it consistent everywhere"): 3 days when the wait (local days from now to the deadline's day) is under 16 (`HEADS_UP_LONG_WAIT`), 4 days at 16 or more. If that moment has already passed, the target is now (ruling Q10): over target at once. Never after the deadline, so a deadline already past gives the deadline itself. `autoTargetAt` in `src/lib/task-segments.ts`; `DEADLINE_LEAD_DAYS` is gone. Example: deadline Fri Oct 23 23:59, set Mon Oct 12 → wait 11 → Tue Oct 20, 9:00 AM. The editor labels it "auto · … (3 days before deadline)".
2. **Target ≤ deadline while the deadline is ahead.** Every move — `PATCH { target_at }`, the snooze endpoint, bulk snooze, snooze-overdue, bulk edit, Today and its picker, native quick snoozes and notification buttons — stops AT the deadline (`capAtDeadline`). There is no "past the deadline anyway": to go later, change or remove the deadline. A capped move says so: the description reads "Snoozed to deadline 6:00 PM", the response carries `capped_at_deadline` (single) / `capped_deadline` (bulk, a count), and a native quick snooze that sent `cap_at_deadline` (the content extension's custom time) or a notification button gets the quiet "Snoozed to deadline" push (`deadline-cap-feedback.ts`, ruling A3). **Once the deadline has passed** the cap is off (Trent's ruling, 2026-10-12): a single snooze or re-target can pick any target, later or earlier, and the row keeps its red "past deadline …" marker. In a **bulk** snooze a passed deadline puts the task in the High tier (see [Priority and bulk snooze](#priority-and-bulk-snooze)). The web toast for a sweep adds "· N stopped at their deadline". The pickers offer **Deadline day** (ruling Q8): the user's morning on the deadline's local day, or the deadline itself if earlier (`deadlineDayTarget`; the row's snooze menu, the editor's target picker, a segment row's Today picker) — never once the deadline has passed, nor once that morning has gone (`deadlineDayPick`).
3. **No Remove target on a deadline task**: Back to auto (see [Target](#target)).
4. **Deadline changes.** An automatic target moves with the deadline (re-derived from that moment). A target the user picked stays, pulled back to the deadline if the new deadline is earlier. Removing the deadline removes an automatic target and leaves a picked one.
5. **Only a picked target is quiet.** An automatic target keeps the task on its horizon rhythm, with the deadline pull-in, until the target's day, then it nags. It has no Upcoming rows.

One function applies all of this to every writer — `resolveTarget` (`src/lib/task-segments.ts`), called by `collectFieldChanges` (update, bulk edit, bulk snooze, snooze-overdue, the snooze endpoint, Today), `createTask` and AI enrichment; completion and skip cap the advanced target too. Past the deadline, nagging continues (Trent: "sometimes it's for a client and you're in a rush, so we can't just stop nagging"), and the over-target row carries a past-deadline marker (`isPastDeadline`).

**The migration** (`src/core/db/migrate-deadline-targets.ts`, a `runMigrations` data step, idempotent, logged when it does something): repeating tasks get `occurrence_at` (see [Recurrence Model](#recurrence-model)); one-offs with `deadline_nag_off` and no target get an automatic target (the flag cleared); one-offs with `deadline_nag_off` and a target of their own keep it exactly, as a picked target (`target_auto = 0`, `due_at` and `target_set_at` untouched; only the flag cleared); one-offs with a deadline and no target get one; targets after a deadline **still ahead** are pulled back to it (a passed deadline caps nothing, so its target is left). `npx tsx scripts/count-target-migration.ts <copy.db>` prints each step's count and task ids (ids only), read-only. The `deadline_nag_off` and `snooze_count` columns are left in place (unused) so undo entries written before still apply.

**A recurring deadline moves with the occurrence** (the weekly Upwork lock). On done, skip and put-back, `advanceDeadline` keeps the deadline the same number of calendar days after the new occurrence, at the same LOCAL time of day, so a DST change doesn't shift it by an hour. It measures from the scheduled occurrence (`occurrence_at`), so a moved target never shifts it. Recurring tasks never get an automatic target: their occurrence is their target. Left alone, a stale deadline would cap every later snooze.

### In the editor

The task editor (`QuickActionPanel`) shows the three fields as separate lines, and says what the model computes rather than only what is stored (2026-10-12, `src/lib/editor-target-labels.ts`):

| Task                                       | What the editor says                                                                                                                                                                                                                                |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deadline, automatic target (one-off)       | Target line: "auto · Tue, Oct 20, 9:00 AM (3 days before deadline)" — the stored automatic target, in the over-target colour once it has arrived ("(deadline day)" when set late). The … menu offers no target reset (ruling Q9). Never "No target" |
| Deadline, picked target                    | The target as set; the … menu (and the picker's Clear) offers **Back to auto**; the picker offers **Deadline day**                                                                                                                                  |
| Back to auto, or a new deadline, staged    | The auto line in blue, showing what Save produces (`stagedAutoTarget`): the automatic target for the deadline, from now                                                                                                                             |
| Recurring, target moved off its occurrence | Under the target: "Occurrence Sun, Oct 18, 12:00 PM · target moved" (`movedOccurrenceLabel`) — a moved target is not a changed schedule. It replaced the "Snoozed · Originally due" line                                                            |
| Recurring                                  | The recurrence line is labelled as the target ("Target Sundays at 12:00 PM"), and the picker's time is "Target"; "Schedule from" offers "Target" / "Completion" (the code mode stays `from_due`)                                                    |
| Recurring, with a deadline                 | Deadline line: "Sun Oct 18, 11:00 PM · moves with each week" ("each day/month/year", or "each occurrence" for an every-N rule) — said only when `advanceDeadline` would move it                                                                     |
| Recurring, no deadline                     | The deadline picker opens on the occurrence's target (day and time), not tomorrow, so "deadline 11 PM the same day" is only a time change. Opening it sets nothing                                                                                  |
| Recurring                                  | No Horizon row: a recurring task never enters a task segment, so its horizon does nothing                                                                                                                                                           |
| One-off with a picked target               | The Horizon row is greyed and says why: "Target set: quiet until Nov 1" (2026-10-12). Removing the target, or Back to auto (staged or saved), brings the horizon back. An automatic target leaves it working                                        |

The recurrence line itself opens the recurrence editor (it sits in a soft box that darkens while the editor is open); the Repeat button beside the other actions does the same and is labelled by what a tap does ("Edit recurrence" / "Close recurrence editor"). Neither removes a recurrence — that is the editor's "None", or "Remove target & recurrence" in the … menu.

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

"Over target" is what "overdue" was: a task whose target (picked or automatic) has arrived. Same machinery, new word — see [Over target (overdue)](#over-target-overdue) for the code. The code, the API and the query parameters keep "overdue". The UI word lives in one constant, `OVER_TARGET` in `src/lib/task-model-words.ts`, beside `HORIZON_WORD` and the horizon labels. Both words are **PROVISIONAL** (Trent: "not a fan of the name"; "horizon" "doesn't resonate"). The native apps keep their own copy.

## Task segments

Rules in `src/lib/task-segments.ts`; reads and actions in `src/core/tasks/task-segments.ts`; the row in `src/components/TaskSegmentRow.tsx`, the Reminders-screen section in `src/components/reminders/TaskSegmentGroup.tsx`, the panel page in `src/components/DashboardRemindersPanel.tsx`.

A task segment lists tasks for awareness, on the reminders screen: one-off tasks with no target in their horizon's segment, and targeted tasks on their heads-up days in [Upcoming](#upcoming). It answers "out of sight, out of mind": a squeaky door isn't worth today, but without being reminded at some clip, the day it would fit naturally is missed too.

**Which tasks (horizon segments).** The user's own open, one-off tasks with **no target the user picked** (since 2026-10-12): not deleted, not archived, not recurring, not a reminder, not a quota. Only the owner's: a task in someone else's shared project is theirs to consider. A deadline task with its automatic target is here until that target arrives (it has no Upcoming rows; the pull-in already shows it — a 23:59 deadline 11 days out: Days on D−6 to D−4, then nagging from D−3). A target later **today** takes a task out (`targetIsToday` compares local days).

**One segment per effective horizon, each on its own day** (`latestSegmentDay`), on the user's **check-in day** (`users.check_in_day`, Settings → "Check-in day", 2026-10-12): Luxon weekday numbering, 1 = Monday … 7 = Sunday, default 6 = Saturday. It is its own setting, independent of `week_start` (the quota changeover), and plays no part in Upcoming.

| Horizon      | Comes round                                                           |
| ------------ | --------------------------------------------------------------------- |
| `days`       | Every day                                                             |
| `weeks`      | Every check-in day                                                    |
| `months`     | The first check-in day of the month (it stacks with weeks that day)   |
| `eventually` | The first check-in day of each quarter: January, April, July, October |

The headers' hints follow it: "TASKS · WEEKS · Tuesdays", "1st Tuesday" (`horizonHints`, `src/lib/task-model-words.ts`).

A segment shows only on a day it has items.

**Carry-over.** A task appears once its segment has come round since the task was last **seen**, and keeps appearing, day after day, until it is considered ("anything not considered shows again the next day until it is"). Seen is the later of `last_considered_at` and `created_at`. Writing a task down is seeing it, so a weeks task added on Tuesday waits for the next check-in day.

**States** (`segment_state` on each row): `waiting`; `considered` (considered today); `deferred` (Defer All today: off today's list, back tomorrow). The web lists only `waiting` rows; the header counts "X of Y" like a slot (X = considered + deferred today, Y = the segment's rows today — a task marked done leaves it entirely), and "Show N considered" unfolds the rest, each with a put-back (`POST /api/task-segments/restore`, which clears both stamps; 2026-10-11).

**Order.** Priority, then id (Upcoming: the target, then id). Horizon decides **whether** a task shows, never where, so acting on one never reorders the rest under the finger (the 09-05 rule).

**Over 50 items** (`nudge`, strictly more than `SEGMENT_NUDGE_THRESHOLD`) the segment suggests Process or AI help instead of a tap-through.

**Never counted, never notified.** Segments are not in `groups[]`. Their rows never count in the reminders headline, the nav badge, "Considered all so far", the slot notifications or the hourly unfinished-slot nag, and a segment never sends a notification. Anything time-critical has a target, and a task whose target has arrived is on the dashboard, not here.

**Where it shows.** After the periods, and shaped like one (Trent, 2026-10-11: "days, weeks, etc. should be individual segments and behave similarly to the segments for reminders"; earlier the same day each was a card of its own under the periods, and 10-10 had them first). On the Reminders screen each segment is a section like a period's: the collapsible header ("TASKS · DAYS · Daily", "X of Y"), the hairline, the rows, and "Show N considered" with put-back; "Defer all" sits where a period has "Considered all". On the dashboard the segments have their own **Tasks card**, directly under the Reminders card (Trent, 2026-10-11: "i liked the reminders on top of tasks like it was before"; for part of that day they were pages of the period pager). The Reminders card pages through the periods alone, as before. The Tasks card is a pager of the same shape across today's segments: its own strip of teal bars (proportional, gray track, green when all handled, the page on screen ringed in its teal), the same chevrons, header ("TASKS · DAYS · Daily"), row cap and "Show more", the "X of Y" that opens what was considered with put-back, and "Defer all" behind the header tap. It opens on the first segment with anything waiting and, when one is finished (last row or Defer all), moves to the next that waits (`usePanelPager` with no slot pages: `naturalPageIndex`, `pageAfterFinishing` in `src/lib/time-slot-assign.ts`); it never lands on a finished segment while another waits. With every segment finished it collapses to one line, "Tasks · 75 of 75 ✓", whose count still opens what was considered. A horizon change that moves a row to another segment says so: "Moved to Tasks · Months". Rows use the slot rows' exact geometry on each surface (panel: 19px controls, 13.5px title; page: 24px, 16px), so circles and checkboxes line up down the column. The native surfaces follow: the Reminders widget's page ring is slots then segments with the clock's slot as the natural page, and the watch shows segments after the period's rows.

**Colours** (2026-10-11, Trent's pick): one teal per horizon, darkest for the soonest — the `--segment-*` tokens in `src/app/globals.css`. Fills, light: Days `#0f9d8f`, Weeks `#2bb5a6`, Months `#4fb8ab`, Eventually `#8ccfc6`; dark: Days `#2bb5a6`, Weeks `#4fc8bb`, Months `#8fdcd2`, Eventually `#c3ece6`. Titles (`--segment-title-*`): light, `#0b7a6f` for every horizon (the lighter fills are too faint for small text); dark, each title is its fill. **Upcoming** (2026-10-12, PROPOSED, awaiting Trent): a bluer teal so its bar reads apart from Days beside it — light `#1a8fb0` (title `#136f8a`), dark `#4cb8d9` (title = fill). A segment's bar fills in its teal over the slots' gray track and turns green when finished, like a slot. The Reminders screen's day bar (above the periods) shows the segments after the periods the same way, a tap scrolling to the section; they stay out of its "N waiting so far" and "X of Y considered".

**The row.** Circle on the left = considered (never a completion; a tap anywhere else on the row does the same, as on a reminder). Checkbox on the right = done. "Today" (target today) sits just left of the checkbox. A quiet horizon chip changes the horizon in one tap; it shows its word only when the task's own horizon differs from the segment's (a deadline pulled it in), and a faint dot marks unset. A second line appears only when there is something to say: a future target as a date chip ("Nov 1"), or the deadline. Without either the row is one line, a reminder row's height.

**API.** `GET /api/reminders` returns a top-level `task_segments` array. It is deliberately not inside `groups`: a native build that predates it ignores the key, so its "Complete all" can never reach a real task. Upcoming is one more entry, `horizon: "upcoming"`, after `days` (an older native build draws it in the Weeks teal, labelled "Upcoming" — accepted).

```json
"task_segments": [
  {
    "horizon": "weeks",
    "tasks": [{ "id": 12, "title": "…", "target_at": null, "segment_state": "waiting", "recurring": false }],
    "waiting": 3,
    "considered": 1,
    "deferred": 0,
    "nudge": false
  }
]
```

Each task is a full `formatTaskResponse` row plus `segment_state` and `recurring` (2026-10-12: a repeating task's occurrence, Upcoming only — the web offers it Today and the picker since §6, but no target reset; older native builds hide Today on it, which is still safe). Three actions, each with the body `{ "ids": [taskId, ...] }`. The ids must be the caller's own open tasks; anything else is a 400, not a skip. Each action is one transaction and one undo entry (`task_segment`, or the bulk edit's for Target today), logged even when nothing changed, so a toast's Undo never reaches an older action.

| Endpoint                               | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Response                                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `POST /api/task-segments/consider`     | The circle: stamps `last_considered_at`. "I saw it." Never a completion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `{ considered }`                         |
| `POST /api/task-segments/defer`        | Defer All: stamps `segment_deferred_at`. Off today's segment, back tomorrow. Not a consider, which keeps "considered" honest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `{ deferred }`                           |
| `POST /api/task-segments/target-today` | A move of the target (a picked target) to the time the Snooze-all button goes to (`bulk_snooze_default`: the next period, or the default snooze option) if that is still today, else the top of the next hour (`targetTodayTime`). Optional `at`: that moment instead (today or a later day; the web's long-press picker). Also stamps considered and `segment_targeted_at`, in the same bulk edit, so one Undo puts back all three. Every id counts as an explicit pick, so the High/Urgent sweep filter never drops one. Stopped at the deadline like every move (§8.2). **Repeating tasks are targeted too** (since §6, 2026-10-12; batch 1 skipped them): only the target moves, the occurrence stays, so done that day brings the next one round on schedule (codes-blog: Today on Saturday, done Saturday → the following Sunday) and the deadline doesn't drift. `skipped_recurring` stays in the response, always `[]`, for clients that read it | `{ until, affected, skipped_recurring }` |

**`segment_targeted_at`** (2026-10-12) records when a task was last targeted **from a task segment**: the row's Today button, or the time picker its long-press (or right-click) opens — both `POST /api/task-segments/target-today`, which Process's "Do it" also calls. The dashboard's Just now card lists a task for 15 minutes after it (`src/lib/just-added.ts`), so a run of Today taps can be checked and the odd one re-targeted. It is deliberately **not** a general "target changed" stamp: a snooze, an edit, a create and a recurrence advance never set it (a later "target last changed by any path" stamp would be a separate column). Undo of the targeting restores its previous value.

## Upcoming

The heads-up segment (2026-10-12; spec rev 3 §2). The rules live with every other date rule in `src/lib/task-segments.ts` (`headsUpDays`, `upcomingState`, `upcomingGap`), each constant named once; `tests/behavioral/up-upcoming.test.ts` has the reference dates, the DST day and a day-by-day golden timeline.

**Which tasks.** One-offs with a target the user **picked** whose target hasn't arrived, and repeating tasks' next occurrences — `rrule` set, `is_reminder = 0`, not a quota (`isTracked`). Reminders and quotas never appear, and neither does a deadline's **automatic** target (§8.5): its task stays in its horizon segment. A target is never after its deadline (§8.2).

**The rule.** _Wait_ = the target's local day − the local day of `target_set_at`. Then:

1. **The day before the target**, if the wait is at least 2 days (`HEADS_UP_DAY_BEFORE_MIN_WAIT`). Made today for tomorrow: none.
2. **If the wait is more than 7 days** (`HEADS_UP_EARLY_AFTER_WAIT`), one earlier heads-up: 3 days before when the wait is under 16 (`HEADS_UP_LONG_WAIT`), 4 days before at 16 or more.

Local days throughout, Luxon calendar days in the user's zone — UTC days and 24-hour math get DST and late-night waits wrong. At most two heads-ups per occurrence; the check-in day plays no part.

| Task (made Mon Oct 12 unless noted) | Wait | Upcoming               |
| ----------------------------------- | ---- | ---------------------- |
| Made Sat Oct 10, target Tue Oct 13  | 3    | Mon Oct 12             |
| Made today, target tomorrow         | 1    | none                   |
| Target Tue Oct 20                   | 8    | Sat Oct 17, Mon Oct 19 |
| Every 2 weeks, Mon Oct 26           | 14   | Fri Oct 23, Sun Oct 25 |
| Sun Nov 1                           | 20   | Wed Oct 28, Sat Oct 31 |
| Monthly, Tue Dec 1 (done Nov 1)     | 30   | Fri Nov 27, Mon Nov 30 |
| Weekly Sun, done on its day         | 7    | Sat                    |
| Weekly Sun, done Fri                | 9    | Thu, Sat               |
| Daily                               | 1    | none                   |

**Carry-over.** An untapped heads-up shows again the next day as the **same single row**, until it is considered or the target's day comes: it shows while the latest heads-up day on or before today is later than the local day of `last_considered_at`. Considered today it is listed as `considered` (so "X of Y" and put-back work); Defer all is `segment_deferred_at` as everywhere. On the target's day it leaves Upcoming and is over target. Never counted over target, never notified. A move restamps `target_set_at`, so an over-target task moved a week on gets a day-before row.

**`target_set_at`** is when the target was last set, by any path: create (every task gets it), any move (PATCH, bulk edit, bulk snooze, snooze-overdue, the snooze endpoint, native quick snoozes), Today and its picker, a completion advance, skip, put-back, AI enrichment, and any change to `deadline_at` (it can move the target: an automatic one follows it, a picked one is pulled back). Every writer goes through `src/core/tasks/target-set.ts`; a guard test fails when a file writes `due_at`/`deadline_at` in SQL without importing it. It is in every undo snapshot, so undo and redo restore it. Seeded once on migration with `created_at` (a repeating task: the later of that and `last_completed_at`); a null reads the same way. On the first day a heads-up day already past shows as carry-over — expected. Distinct from `segment_targeted_at`.

**The row.** Circle (considered), the done square, and the gap text: "Target Tue Nov 3 · deadline Sat Nov 7 (+4d)" ("Target Tue Nov 3" with no deadline; "(same day)"). Every row has Today and its hold/right-click picker (with **Deadline day** when the task has one) — repeating rows too since §6 (`upcomingRowActions`). A one-off's target chip opens a one-item menu (`targetReset`): **Remove target** with no deadline (back to its horizon segment), **Back to auto** with one (the deadline's automatic target; the row leaves Upcoming). Undo on the toast. A repeating row's chip says "repeats" and offers nothing. No horizon chip: a targeted task's horizon decides nothing. Header "TASKS · UPCOMING · Heads-up"; a strip bar on the dashboard Tasks card and the Reminders day bar, the over-50 nudge and Defer all, like every segment.

**The editor** greys the Horizon row on a one-off with its own target: "Target set: quiet until Nov 1".

**Process** never asks to grow the horizon of a task with a target of its own (`growthAsk`), and the dashboard's left panel (desktop) has a Process button.

## The two badges: attempts and age

Spec §7 (2026-10-12; rulings Q5–Q7, Q10 — Trent: separate signals). The rules are in the one rules module, `src/lib/task-segments.ts` (§ the two badges); `tests/behavioral/bg-badges.test.ts` has them as tests, and the golden suite (below) has them day by day.

### Attempts

**An attempt is a local day (the owner's zone) on which the task was over target.** The day counts **the moment** the task goes over target — the badge reads "1×" at once (ruling Q5), including a deadline's automatic target that is already past when it is set (Q10). One per local day: moving it again the same day adds nothing. Days before the target never count, so moving a target that has not arrived adds nothing.

- **Who counts:** any ordinary open task that can go over target — its own target, a repeating occurrence, a deadline's automatic target. Never a reminder or a quota (`canAttempt`).
- **Resets** only on done (one-off) and on each new occurrence of a repeating task (done or skip): attempts 0, checkpoint cleared. The completion row keeps the count (`completions.attempts`), so History shows a late occurrence ("· 3×").
- **Removing the target freezes the count** (nothing counts without a target); it resumes if the task is retargeted and goes over target again.
- **The badge shows only while the task has a target** (`attempts_label`, "3×"); the count is kept under it. On the dashboard row a corner tab, one calm plum in three depths (1–2 light, `ATTEMPTS_MEDIUM` 3–6 medium, `ATTEMPTS_STRONG` 7+ strong; red is kept for a passed deadline); on a segment or Upcoming row a chip at the end of the second line.
- **At 3× (`ATTEMPTS_OFFER_REMOVE`) the row offers to drop the target** — offered, never automatic: a small "Remove target?" on a one-off with no deadline, "Back to auto?" on a deadline task whose target the user picked. Nothing on an automatic target (Q9), on a repeating task (its target goes only with its recurrence), or once the deadline has passed ("auto" would be the passed deadline). `attemptsOffer`; the API sends it as `attempts_offer`. Process lists the same tasks in its old-targets step (over target now, 3×+).

**Storage and the read.** `tasks.attempts` is the count as of a checkpoint, `tasks.attempts_counted_through` (a local date, yyyy-MM-dd). Between two writes the target is constant, and a task over target stays over target, so the days since the checkpoint are exactly the local days from the latest of (the day after the checkpoint, the target's day, the day the target was set — `target_set_at` —, the creation day) through today if the target has arrived, else through yesterday (`effectiveAttempts`). Every read adds them: the server in `rowToTask` (the owner's zone, from a subquery in `taskColumns`), the web row at render — so "1×" appears the moment the target passes, without a refetch.

**Advancing it** — three places, one rule:

1. **On read**, as above (no write).
2. **The checkpoint on every target move.** A write that moves `due_at` or `deadline_at` first persists the count as of now, read from the row _before_ the move (`stampTargetSet`, `src/core/tasks/target-set.ts` — the module every target writer already goes through). Without it, a task that went over target at 9:00 and was moved at 9:00:30 would lose the day.
3. **The minute cron** (`persistAttempts`, `src/core/tasks/attempts.ts`, started in `src/instrumentation.ts`) writes the stored columns current for every task whose target has arrived, for anything that reads them raw. No undo entry, no `updated_at` bump, no sync event.

**Undo.** The checkpoint and the cron record the past, so they are not undo entries: undo of a move restores the old target and leaves the count, which is still true. Done and skip change the count, so their snapshots carry `attempts` and `attempts_counted_through`: undo restores the count, redo resets it again. Put-back (`markUndone`) restores the count from the completion row it deletes, checkpointed at the later of the completion day (or the day before, if the target had not arrived by then) and yesterday — so the days it sat done don't count, and today counts at most once.

**Migration.** New columns, `attempts = 0` and no checkpoint. The read then counts the over-target days of each task's _current_ target, from its day (never before the task existed or the target was set) — the part of the history that is recoverable. The days earlier targets were missed are not known.

### Age

Only a task with **neither a target nor a deadline** (truly undated), counted from `created_at`, shown only past one threshold per horizon — unset reads as weeks (`AGE_THRESHOLDS`, `AGE_LABELS`, `ageLabel`):

| Horizon         | Shown past | Label   |
| --------------- | ---------- | ------- |
| `days`          | 7 days     | `>1 wk` |
| `weeks` / unset | 1 month    | `>1 mo` |
| `months`        | 1 quarter  | `>3 mo` |
| `eventually`    | 6 months   | `>6 mo` |

Calendar arithmetic (a month is a calendar month), strictly past. The API sends it as `age_label`; the dashboard row shows it where every row used to show "Xd old", and segment rows end their second line with it.

**The same thresholds are Process's growth asks** (ruling Q7; they replaced 14/60/180 days): a days task is asked "weeks?" past 7 days on its horizon, weeks or unset "months?" past a month, months "eventually?" past a quarter — counted from the latest of `horizon_set_at` (else `created_at`) and `growth_kept_at`. Choosing **keep** (`affirm_horizon`) stamps `growth_kept_at`, so Process asks again only one threshold period after it; the horizon's own clock is untouched and the badge still shows creation age. Growth asks about a deadline-only task too (when its deadline is far enough not to steer the horizon); the badge is for undated tasks only.

## Testing the model: the golden suite and the day simulator

Spec "Testing and evaluation" (2026-10-12): the date rules grew one at a time, so they are pinned down as a whole.

- **The day simulator** (`src/core/sim/day-simulator.ts`) steps a task list forward day by day (or hour by hour, `hourly`) through the **real core** — it moves the clock, reads the Reminders screen with `getTaskSegments` (segments and Upcoming), over target with `getCurrentlyDueTaskIds`, the badges through `getTaskById` — and a policy acts through the real writers: `never`, `tap` (consider every waiting row the day it shows), `complete-repeating` (done on its day), `complete`. Each day records each task's place (`quiet`, a horizon, `upcoming`, `over`, `done`), its attempts, age and offer, and the day's counts. A day is read at 21:00 by default (`at`), after that day's scripted steps and before the policy acts.
- **The golden suite** (`tests/golden/*.ts`, one runner: `tests/behavioral/golden.test.ts`): 26 dated timelines — the spec's reference dates, the v7 table's rows (restated with the approved 3/4 lead where v7's wait/6 rule differs), and every case raised on 10-12 (codes-blog on the day and early, a weekly Friday, every 2 weeks, every 10 days over 5 cycles, every 22 days, the monthly 1st across Nov/Dec/Jan, snowmobile, taxes, gutters, made Saturday for Tuesday, made today for tomorrow, a deadline tomorrow at 3 PM made at 1:35 PM, the squeaky door, the Nov 1 pile, the past-deadline case, undated ages, a weekly across the March DST change). Each states, for every local day of its window, a line such as `upcoming`, `over 3× →remove`, `quiet 1×`, `weeks >1 mo`; unlisted days are `quiet`. The runner compares every day. America/Chicago.
- **Invariants** (`tests/behavioral/tm-invariants.test.ts`): seeded random tasks and writes (TM-INV-01–03), and a random list through the simulator (TM-INV-04/05): one segment at most, never Upcoming and over target, a picked target never in a horizon segment and an automatic one never in Upcoming, never told then silent before the target, target ≤ deadline while it is ahead, attempts +1 a local day at most and only while over target, none before a target arrives.
- **The CLI**, for watching daily load on a real list:

  ```bash
  npx tsx scripts/simulate-days.ts <database> --user <id> [--days 61] [--policy tap] [--from 2026-10-12] [--at 21:00] [--hourly] [--titles] [--json]
  ```

  It opens `<database>` **read-only**, copies it with SQLite's backup into a temp file, empties every delivery channel on the copy (push subscriptions, APNs devices, widget push tokens, webhooks), runs there, and deletes the copy. It prints one line a day — the rows in each segment (Upcoming included), over target, at the 3× offer — and the Upcoming and over-target task ids. Ids only unless `--titles` (local use only). Run it on a `.backup` copy of production, never the live file, and keep that copy out of the repo (ruling Q11). There is no dev page: the CLI covers it.

## Priority and bulk snooze

Priority is **what missing the task costs**. It no longer says whether a date is a deadline: the deadline is its own field (see [Deadline](#deadline)), and a low-priority meal voucher that expires on the 11th still expires on the 11th. Priority sets the nag cadence (`docs/NOTIFICATIONS.md` § Repeat intervals), the notification's interruption level, and how a bulk snooze treats an over-target task:

| Priority        | Bulk snooze                     | Over-target significance |
| --------------- | ------------------------------- | ------------------------ |
| 0-1 (Unset/Low) | Eligible                        | Normal — not a problem   |
| 2 (Medium)      | Eligible                        | Low                      |
| 3 (High)        | Only when nothing lower is left | Significant              |
| 4 (Urgent)      | Never                           | Critical                 |

`HIGH_PRIORITY_THRESHOLD = 3` and `URGENT_PRIORITY = 4` in `src/lib/priority.ts` are the boundaries. Urgent tasks also break through everything (critical-level notifications) and must be snoozed individually, so every change to one is a deliberate decision. On top of the priority rules, a sweep's move stops at a deadline still ahead (see [Deadline](#deadline)), and a **passed deadline counts as High**.

**Bulk snooze:** P0-P2 are always swept. **P3 (High) is swept only when no lower-priority task in the same batch is still eligible** — so the first press clears P0-P2 and a second press, finding only High left, takes it. Two presses, no mode, no second button. P4 (Urgent) is never swept: every change to an Urgent task's target has to be a deliberate, individual act.

**A passed deadline joins the High tier** (Trent's ruling, 2026-10-12; `bulkSnoozeTier` in `src/core/tasks/bulk.ts`): a P0-P2 task whose deadline has passed waits while anything lower is still eligible, and goes with the High tier after; alone, it moves. A P3 with a passed deadline is still just P3; a P4 is never swept, deadline or not. This holds for every sweep — snooze-all and snooze-overdue, `bulk/snooze`, a bulk date edit, the notification buttons — and `include_task_ids` rescues it like any High task. The response counts the ones held back only by the deadline in `skipped_deadline` (not in `skipped_urgent`), and the toast names them beside High: "Snoozed 3 tasks (2 high, 1 past deadline skipped)", "No snoozable tasks (1 past deadline, 1 urgent skipped)"; the sweep's feedback push says "1 past deadline still over target. Snooze again to move it".

The test is "is anything lower still eligible", **not** "is the batch pure": a P4 sitting in the batch does not hold the High tier back, because a P4 is never swept and would otherwise block it forever. `include_task_ids` still rescues an explicitly chosen task at any priority. The rule lives in `filterForBulkSnooze` (`src/core/tasks/bulk.ts`).

Why the change (Trent, 2026-09-15): with four overdue High tasks and nothing else late, the sweep button reported "no snoozable tasks" and the list stayed wrong. Excluding High outright protects a High task from a sweep the user did not read; a sweep aimed at a batch that is already nothing but High tasks is the user looking straight at them and pressing anyway. (Written when P3/P4 dates stood in for deadlines. A real deadline is now protected by the deadline cap at any priority.)

**Implications for code and AI:**

- A task's real cutoff is `deadline_at`, never its target. Don't read a target as a deadline at any priority, and don't infer a deadline from priority.
- `created_at` is the most reliable age signal — it never changes. Use it over `due_at` for understanding how long a task has existed.
- `original_due_at` is the first-target date: the gap to `due_at` is how far moves have carried the target since it was set, but not how many moves occurred or why. Don't infer snooze counts or user intent from dates alone. (There is no snooze count since 2026-10-12.)
- A target marked `target_auto` (printed "(from deadline)" in the AI's task lines) was not picked by the user: it is the deadline's automatic lead-in.
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

**The occurrence apart from the target** (spec §6, rulings Q2/Q3, 2026-10-12). A repeating task keeps its **scheduled occurrence** in `occurrence_at`; `due_at` is its **target**. A move (any snooze, Today, the picker) changes only the target. Done and skip advance from the occurrence and set both (the target capped at the advanced deadline): `rrule.after(max(occurrence_at, completedAt))`, so done early (Saturday, for a Sunday occurrence moved to Saturday) brings the following Sunday — never the next day — and a target moved past the next occurrence (a weekly moved +10 days) is allowed: done advances to the next occurrence after now, with no catch-up and no second row. `advanceDeadline` measures from the occurrence, so the deadline never drifts. A schedule change (a new rule) sets the occurrence to what the rule schedules. A reminder's date is its occurrence (a reminder is never moved, only rescheduled). Put-back (`markUndone`) restores both, from the completion row's `occurrence_at_was`. `original_due_at` is still written — the first target of the current occurrence — for shipped native builds, which read it as the age clock. Migration seed: `original_due_at`, else `due_at` (every advance has written `original_due_at = the next occurrence`, and a snooze kept it).

**A recurring task carries debt.** Its `due_at` is the truth, past or future: in the future it is the next occurrence (or a moved target); in the past it has been overdue _since then_ and stays overdue — nagged at its priority cadence, across midnight, until done. It does not stop being overdue because a new day arrived. Completing it advances to the next scheduled occurrence after the completion (`from_due`, above), so a Mon/Thu task finished on Tuesday next lands on Thursday. Only a recurring task with no `due_at` derives today's occurrence from the rrule at read time. Reminders (`is_reminder = 1`) are the exception and roll forward: a missed one is not re-shown until its next occurrence. See `effectiveDueAt()` in `src/core/recurrence/occurrence.ts` and REDESIGN-V03 §4.6 (amended 2026-09-07).

`recurrence_mode`: `from_due` (default) keeps the calendar anchor — the next occurrence is the next scheduled one after completion; `from_completion` counts the interval from when it was actually done (e.g. "every 3 months from the last filter change").

## Completion Behavior

- **Recurring tasks** advance in place: completing a daily task moves `due_at` forward and leaves `done=0`
- **One-off (non-recurring) tasks**: when completed, the app sets `done=1` and `archived_at` to the current time

## Snooze

**One "move target" gesture, no snooze state** (spec §6, ruling Q1, 2026-10-12 — Trent: "snooze is just retargeting"; "Just keep snooze" for the word). Every date change of a dated task — the snooze endpoint, bulk snooze, snooze-overdue, notification snooze, the quick panel's buttons and picker, `PATCH { target_at }`, Today — is the same move of the target (`due_at`): the first-target date (`original_due_at`) is kept, the move never touches `deadline_at` or a repeating task's occurrence, and it stops at the deadline (see [Deadline](#deadline)). There is no snoozed flag, no snooze count, no "snoozed from" line, no snooze/re-target split: `retarget` / `reset_original_due_at` from old clients change nothing on a task. "Snooze" stays the word in the UI (the row's button, snooze-all, notifications, widgets, settings), and a user-sent move still counts the daily snooze stat and reads "Snoozed to …" in its toast.

| Change                            | What it is  | `original_due_at`       |
| --------------------------------- | ----------- | ----------------------- |
| Any move of a dated task's target | A move      | Kept (set on first one) |
| A task with no date gets one      | First date  | = the new date          |
| `PATCH { rrule, due_at }`         | Re-schedule | Cleared                 |
| `target_at: null` (no deadline)   | Remove      | Cleared                 |

A task already due at the target is left alone. Bulk snooze follows the same rule as `PATCH` and bulk edit — it goes through the same `collectFieldChanges`. Undo restores the prior `original_due_at`, `occurrence_at`, `target_auto` and `target_set_at`. `default_snooze_option` (the single-tap snooze) also accepts `next_period` (2026-10-10). `PATCH { rrule, due_at }` honors the date and derives the rule's anchors from it, like `createTask`.

**Default reminder slot** (2026-09-28). A reminder created without a schedule — `POST /api/tasks {"title", "is_reminder": true}` with `rrule` omitted and no `due_at`, as an Apple Shortcut or the Reminders quick add sends — is given `FREQ=DAILY;BYHOUR=h;BYMINUTE=m` at the start of the user's default reminder slot (`defaultReminderRule`, `src/core/time-slots/index.ts`), so it never starts in "Anytime". It is still title-only for the enrichment trigger (judged on the caller's input), and enrichment with no time cue keeps it in that slot. The setting is `users.quota_prompt_slot_id` (API alias `default_reminder_slot_id`) — the same default quota prompts use, resolved the same way (`resolvePromptSlot`: the stored slot, else the first period). An explicit `rrule: null` stays unscheduled (a one-time reminder); a supplied rule is used as sent; a user with no slots gets no default.

**Reminders** (`is_reminder`) are never snoozed: the snooze endpoint refuses them, bulk snooze skips them, and a bare `PATCH { due_at }` that would move a dated reminder is refused too. An explicit reschedule (`reset_original_due_at: true` — the one place that flag still means something; a period move sends it) is allowed and moves the reminder's occurrence with its date, as is giving an undated reminder its first date. `skip-occurrence` refuses reminders — a missed one rolls forward on its own, and completing one marks it considered.

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

"Over target" in the UI, "overdue" in the code and the API. Everywhere — the badge, the notifier, the snooze-overdue sweep and `GET /api/tasks?overdue=true` — it is `getCurrentlyDueTaskIds` (`src/core/tasks/currently-due.ts`): reminders and quotas are never over target, and a recurring task's due-ness is derived from its schedule (`effectiveDueAt`). Since 2026-10-12 a deadline's target is stored (`target_auto`, see [Deadline](#deadline)), so these queries — and the client counts (`countTasks`, `src/lib/task-counts.ts`) — read `due_at` alone again: a deadline task joins at its automatic target like any other. (From 2026-10-10 to 10-12 they computed an implied target at read time; that is gone.)

## Native builds

Shipped iOS / watchOS / Mac builds (including ones not yet reinstalled) decode every task field with defaults, and still run their own copy of the old implied-target rule (`TargetAge.swift`). The server keeps them correct without a rebuild: every deadline task now carries a stored target at or before its deadline, and `deadline_nag_off` is `false`, so their rule finds nothing to imply and reads `due_at` as the target — the server's own answer. The one exception is a one-off whose deadline has passed and whose target is after it (allowed since 2026-10-12): the response sends `deadline_nag_off: true` for it (computed, never stored), because their rule leaves a nag-off task with a passed deadline to its own target — without it they would imply a target 4 days before the deadline and show it over target. `original_due_at` keeps its meaning (the first target of the current occurrence, their age clock). `is_snoozed` and `snooze_count`, which no build decodes, left the response. `target_auto`, `occurrence_at` and the badge fields (`attempts`, `attempts_label`, `attempts_offer`, `age_label`, …) are new and ignored by them — they still draw their own "2d" age tab from `original_due_at` until rebuilt. A capped quick snooze still answers `capped_at_deadline` / `capped_deadline`, and `skipped_deadline` stays (now: held back like High because the deadline has passed — their sweep summaries ignore it); `skipped_recurring` stays, always `[]`.

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
