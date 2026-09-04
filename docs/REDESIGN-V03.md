# OpenTask v0.3 — The Trust Redesign

_Version 0.3 — 2026-07-26. Build specification for the next minor version: notification overhaul, Track (quotas), the Reminders surface, view redesign, and widgets. Red-teamed via a 5-lens adversarial review with live-DB verification; all fixes applied, and both product forks (Track at-target behavior, reminders collapse granularity) resolved by the user 2026-07-26. Remaining build-time-with-user decisions are marked inline where they occur (§6 reminder retirement, §6.1 content strategy, §4.2 thread classes)._

**How to read this document:** it is deliberately rationale-heavy. It was distilled from a multi-day design conversation with the primary user (Trent), grounded in his live production data and several adversarially-reviewed design passes. When you hit an implementation issue mid-build — and you will — the _why_ sections are what let you make the right call instead of a plausible-looking wrong one. When a decision here seems arbitrary, check its rationale before overriding it; several "obvious improvements" were tried in design and killed for non-obvious reasons (§10). Where genuinely stuck, the deeper record lives hub-side (§12) — but this document is intended to stand alone.

---

## 1. The problem being solved

OpenTask's primary user has, measured 2026-07-25 in production:

- **484 active tasks, 217 recurring, ~214 coming due every 24h**
- **~100,000 recorded snoozes** — bulk sweeps repeated daily (~435 repetitions across the recurring set)
- **Priority distribution: None 382 (79%) · High 94 · Urgent 5 · Medium 4 · Low 1** — priority is used as a binary "matters" flag, not a ladder
- **"Today" filter matches 311 of 486** — two-thirds of the corpus, because the daily sweep re-dates everything
- 175 of the 217 recurring tasks have never been completed in OpenTask (largely a migration artifact from the previous app, Due — not pure neglect, but the counts cannot be trusted as adherence history)

_These numbers are a point-in-time snapshot (2026-07-25/26); the DB prep in §4.4 already changed the priority distribution. Do not re-derive counts or urgency from this table during the build — measure fresh if a decision depends on it._

His verdict, verbatim: _"The problem right now is I have no task manager. Essentially I can only use High and Urgent and that's it. It really barely works and I keep forgetting things."_

**The causal chain this redesign attacks:**

> notification repeat → nagging → defensive bulk-snoozing → every due date collapses to "today" → no view can discriminate → the app is a data dump behind 20 filter chips → the user stops trusting it

The nagging is the root. Everything downstream — the snooze choreography, the meaningless dates, the unusable dashboard — is the user defending himself from the notifier.

### 1.1 The founding constraint

**The harness adapts to the scale; the user does not adapt to the harness.** Any feature whose viability depends on the user pruning or curating his task count is wrong by construction. He explicitly maintains a large corpus on purpose. Solutions must hold the _interruption surface constant while content volume grows_ — containers, rollups, replacement — never trade volume for usability.

### 1.2 The instrument philosophy

OpenTask's only job is to **enforce what the user asked it to enforce**. It is an instrument: it keeps the score it was asked to keep and shuts up otherwise.

- **Quotas and targets are aims the user owns, not contracts the app polices.** No red failure states, no guilt UI, no streak-shaming.
- **The app must tolerate deliberate partial logging.** The user routinely stops recording mid-period ("on pace by Wednesday, stopped logging") out of expertise and flexibility, not failure. An instrument that treats non-recording as failure is broken.
- Tracking data is a bonus byproduct, never the product.

---

## 2. The four laws (violating these = the bug)

These were each learned the hard way; several killed multiple design iterations.

**L1 — Absence is never a signal.** Not-marked-done ≠ not-done. A clearing gesture (snooze or skip, any batch size, any custom time) carries no information about intent — the user sweeps small batches without reading them. Unset priority means _nobody stated one_, not "low." Never infer meaning from a blank field or an omitted action. The only trustworthy adherence signal is an explicit completion.

**L2 — A default is not an inference, but it must behave like one wasn't made.** Defaults are unavoidable (unset priority must notify _somehow_). Two rules: (a) never _report_ a default as if it were stated — "382 unclassified," never "382 low-priority"; (b) choose defaults by **failure asymmetry** — err toward the recoverable failure. A 30-min notification interval fails safe (annoying); silence fails dangerous (an urgent-but-unclassified item never reaches the user and he never learns it existed).

**L3 — Never overload one single-valued field with orthogonal dimensions.** This is what broke the current projects: `project_id` simultaneously encodes kind (Routine/Reminders/One-offs), state (Inbox/Backlog), and domain (Work) — so a work-routine has no home. Importance and obligation are likewise orthogonal (a coupon errand is a low-importance _obligation_; supplements are a high-importance _non-obligation_): do not encode kind on the priority ladder.

**L4 — The user performs no rituals.** No closure taps, no acknowledge buttons, no daily review ceremonies. His words: _"The design has to assume I'm not going to close it out."_ Any flow requiring a habitual confirming tap is dead on arrival.

Corollary of L1+L4: **completion data will be sparse and partially maintained forever.** Design for that; never build anything that breaks when logging stops mid-week.

---

## 3. The population model (what's actually in the corpus)

The 217 recurring tasks are four distinct populations wearing one shape. The redesign gives each its own home; the migration (§9) sorts them.

1. **Protocol (~half)** — real regimen items with times: supplements, skincare sequences, exercise, kid-care routines. Discrete actions, individually completable, time-of-day matters. _Home: standard tasks in time buckets (§7)._
2. **Prompted thoughts (~40)** — principles and considerations delivered by repetition: _"Depressed = Past, Anxious = Future, Present = Peace."_ Not actions. Completing one means "I considered it" — that IS its completion (the user did exactly this in his pre-OpenTask app and valued it). _Home: the Reminders surface (§6)._
3. **Parked one-off obligations (~40–50)** — real errands (_Register the car_, _E-sign insurance_) given a fake daily rrule because recurrence was the only resurfacing mechanism. The user does this constantly and hates it. _Home: real tasks with real due dates; resurfacing is the notifier's job, not a fake schedule's._
4. **Quotas (~a dozen, currently encoded in titles)** — _"Eggs (2x/week)"_, _"Beef For Kids 4x/week"_. N-per-period targets, no time of day. _Home: Track (§5)._

---

## 4. Priority & notifications — the core overhaul

### 4.1 Priority semantics (unchanged ladder, new cadences)

Priority means **importance**, expressed to the user as interruption cadence. The ladder stays 0–4; no new rungs, no repurposing (L1: P0 stays "unset" — it never gains distinct behavior).

| P   | Label        | Cadence (repeat interval while overdue)      | APNs interruption-level |
| --- | ------------ | -------------------------------------------- | ----------------------- |
| 0   | None (unset) | default 30 min (unchanged — L2 failure-safe) | active                  |
| 1   | Low          | **rare — a few times/day** (e.g. 240 min)    | active                  |
| 2   | Medium       | **~hourly** (e.g. 60 min)                    | active                  |
| 3   | High         | 15 min (unchanged)                           | time-sensitive          |
| 4   | Urgent       | 5 min (unchanged)                            | critical                |

Key change is not the intervals — it's **§4.2: repeats replace instead of stack.** The user's correction that shaped this: Medium must NOT be notify-once — one missed glance (phone face-down, in a meeting) loses it permanently, which fails dangerous for something rated moderately important. Nothing goes fully silent by default; the bottom rungs get _slower cadence plus replacement_, so persistence never becomes pile-up.

Implementation (concrete — the schema today has exactly three interval columns, `schema.sql:20-22`):

- `users.auto_snooze_minutes` becomes **P0-only** (keeps default 30). Add `users.auto_snooze_low_minutes` (P1, default 240) and `users.auto_snooze_medium_minutes` (P2, default 60). `auto_snooze_high_minutes` / `auto_snooze_urgent_minutes` unchanged.
- `getEffectiveInterval` (`overdue-checker.ts:68-73`) currently branches only on `>=4` / `>=3` with everything else falling through to one shared value — it must branch explicitly on `=== 1` and `=== 2`.
- The settings UI (`settings/page.tsx` renders three `AutoSnoozeRow`s mapped 1:1 to the three columns) becomes **five rows**, one per tier.
- Per-task `auto_snooze_minutes` override stays and wins, as now.

**Warning from production:** the per-task `auto_snooze_minutes` override has been exercised exactly once ever (task 2127, "Test critical alert," 2026-03-12) — the `=0` disables-notifications path is verified in source but effectively untested in production. Test on ~5 tasks before relying on it broadly.

### 4.2 Replace, don't stack

The problem with repeats was never repetition — it's accumulation. Current code sets `collapseId: task-${taskId}`, so each task's own repeats already replace **their own prior notification**; the pile comes from many tasks each holding a slot, and (see §4.5) stale never-completed items monopolizing the per-bucket "individual" slots.

Changes:

1. **Per-class threads:** replace the single constant `threadId: 'opentask-overdue'` with per-class thread IDs (e.g. `ot-reminders`, `ot-tasks`, `ot-urgent`) so iOS groups them as separate visible stacks. (Which classes get threads is a build-time decision with the user — start with reminders/tasks/urgent.)
2. **Class-level collapse for reminders:** all Reminders-surface notifications share ONE collapse ID (`ot-reminders-current`) → no matter how many are pending, exactly one reminder notification exists, updated in place. The existing summary path (`collapseId: 'overdue-summary'`) already proves the pattern in this codebase. **Hard requirement that follows from replace-semantics:** APNs _replaces_ the prior notification wholesale — the old payload is gone, not merged — so every slot notification MUST embed its full current item list, never a delta. APNs payloads cap at ~4KB; at this corpus's scale that means item IDs + truncated titles, with the content extension fetching full detail on expand. **Collapse granularity — DECIDED (Trent, 2026-07-26): one collapse ID per time slot** (`ot-reminders-<slot_id>`), not one shared for the class. Each slot holds its own live banner, replaced in place by its own updates; an unaddressed morning banner survives the evening slot firing. All slot banners share the `ot-reminders` thread, so they stack as one group in Notification Center. (The rejected alternative — a single class-wide collapse ID — silently vanished missed slots.)
3. **Bucket notifications (§6/§7):** a time bucket fires one notification for the bucket ("Early morning — 8 waiting" or a short teaser list), not N notifications. Batch caps in `overdue-checker.ts` become largely vestigial for bucketed classes.

### 4.3 Snooze guard prompts (warn, never reinterpret)

Two confirm-prompts, same principle: **the app never silently reinterprets an explicit instruction.**

- Snoozing a task past its next recurrence → "This pushes past its next occurrence (Tue 7:00). Snooze anyway / snooze to next occurrence / cancel." (Chosen over auto-clamping — the user explicitly rejected silent clamping.)
- Snoozing a task with no due date → confirm that adding a due date is intended (it's often an accident).

**Scope (load-bearing):** these prompts apply to the **single-task interactive snooze UI only.** The bulk paths (`bulk/snooze`, `snooze-overdue`) must NEVER modal-block — a per-item prompt inside a bulk sweep would rebuild the exact friction this redesign exists to remove (and would violate L1 by treating sweep participation as deliberate). Bulk behavior: apply the snooze and report counts in the response (mirroring §4.4's silently-skip-and-report pattern), no prompts.

### 4.4 Bulk snooze: P3/P4 exempt (already coded, deploy pending)

`filterForBulkSnooze` now excludes P3 _and_ P4 (was P4 only); `HIGH_PRIORITY_THRESHOLD` is the filter constant. Committed intent: High = "resists sweeps, doesn't interrupt calls"; Urgent = "resists sweeps AND breaks through everything." Tests updated (SP/BS suites), full suite green. **The production DB was prepared 07-26**: 24 recurring P3/P4 tasks were re-prioritized to P2 (`undo_log` id 3652); two active recurring tasks kept at P3 deliberately (#8870 E-sign insurance, #11160 garbage — genuinely deadline-shaped). A third recurring P3 row exists (#1518) but is inactive (done/archived — excluded by the notifier's `done = 0 AND deleted_at IS NULL AND archived_at IS NULL` filter); benign. `include_task_ids` bypass semantics unchanged.

**Cleanup rider:** `src/core/tasks/bulk.ts` (~line 265) still carries a stale comment — `// P0-P3 eligible, P4 (Urgent) excluded` — contradicting the corrected filter. Fix it, and grep for any remaining "P4 excluded"/"P0-P3" phrasing before Stage 0 ships (same class of fix as the `anchor-derivation.ts` docstring in §4.6).

### 4.5 Fix the stale-first burial

`overdue-checker.ts` orders `priority DESC, due_at ASC` and caps "individual" notifications per bucket — so the _stalest_ items monopolize the few visible slots every cycle, burying genuinely-new overdue items. After the population sort this shrinks, but the ordering deserves revisiting (e.g. recency of becoming-overdue, or explicit per-class policies).

### 4.6 Do not trust `due_at` freshness on recurring items

A trap discovered in design review: today, recurring items' `due_at` stays fresh **only because the user's daily sweep re-dates them** (~100k snoozes are, functionally, a hand-cranked roll-forward). Every change in this document that reduces nagging reduces sweeping — and then `due_at` on never-completed recurring items freezes at its last value. **Any logic that means "is this item current today" for a recurring item must derive today's occurrence from the rrule (+ `anchor_time`) at read time, never from `due_at` freshness.** Obligations (one-offs) keep `due_at` as the source of truth; schedules are the source of truth for recurring items' _today-ness_, with an explicit snooze winning for the rest of that day only.

Related source-truth correction: **`anchor_time` IS used in recurrence computation** — `compute-next.ts` prefers it over BYHOUR when setting the occurrence time, and 29 of the 217 live rrules have no BYHOUR at all, so for those it is the _only_ carrier of time-of-day. The docstring in `anchor-derivation.ts` claiming it is "NOT used for recurrence computation" is **false** — fix the docstring as part of this work.

**The mechanism, concretely (this is load-bearing infrastructure — Build Order Stage 1):**

- _Algorithm:_ today's occurrence for a recurring item = evaluate its rrule with `anchor_time` supplying the time-of-day (reuse `compute-next.ts`'s existing anchor-over-BYHOUR preference — do not write a second evaluator). "Current today" = today's occurrence exists and is ≥ now, OR an explicit snooze target set today is still ahead (the snooze wins for the rest of that day only; tomorrow the schedule reasserts).
- _Call sites that must move off raw `due_at`_ (all three confirmed `due_at`-only today): `overdue-checker.ts` (the base overdue query), `dismiss.ts:getOverdueCount` (badge), `bulk/snooze-overdue/route.ts` (both queries). True one-offs (no rrule) keep raw `due_at` as sole truth.
- _A cached/materialized `next_occurrence_at` column is PERMITTED_ as an implementation detail (recomputed on write + on recurrence advance) — what §10 rejects is a scheduled job that _mutates user-visible due dates_, not a derived cache. If cached, it must be recomputed synchronously on every rrule/anchor/snooze write, never by cron alone.

### 4.7 OPEN CONSIDERATION — "wants to happen at" vs "expires at" (noted by the user, 2026-08-06)

Not a decision; a distinction the user flagged (verbatim from a task he filed to himself: _"Want vs expires? (Ie report due date, coupon, etc. — missing un-make-up-able)"_). Most timed tasks **want** to happen at a time: a morning walk wants the morning, but nothing is lost when it slips — it doesn't expire just because the notification fired. A minority **expire**: a report deadline, a coupon — miss it and the opportunity is un-make-up-able, no amount of later action recovers it. The current model approximates this through priority (P0–2 due dates are reminders; P3/P4 are deadlines — see TASK-MODEL) but priority is _importance_, and expiry is orthogonal to importance (L3: a low-importance coupon still hard-expires). If this is ever built, the likely shape is an explicit expiry attribute — affecting what happens _after_ the time passes (does it stay current, roll forward, or lapse) — rather than a new priority rung. To consider; nothing in v0.3 depends on it.

---

## 5. Track (quotas)

**Concept:** every task is already a quota with target 1. Generalize completion.

- `progress_target INTEGER NOT NULL DEFAULT 1`, `progress_current INTEGER NOT NULL DEFAULT 0` on tasks.
- **+1 increment endpoint** (and UI affordance on the row). Sub-target increments must NOT dispatch `task.completed` (webhook fires only on actual completion).
- **At-target behavior — DECIDED (Trent, 2026-07-26): period-anchored.** Reaching target marks the row "met" (visual state change, no completion event); it stays open until the rrule's natural period boundary, whose advance fires the completion path and resets `progress_current` to 0. Overflow logs past target display (3/2). An explicit complete-tap before the boundary is still allowed and completes early. (The rejected alternative — auto-complete at target — made overflow unobservable; rationale preserved in the hub design record.)
- **Track items are exempt from the §4.1 cadence loop** (parallel to §6's reminder carve-out): excluded from `overdue-checker.ts`'s base query (`progress_target > 1` filter). Their only notification is §5's own pace nudge. Without this exemption a tracked task with a due date gets the standard nag _plus_ the pace nudge.
- **Mutual exclusivity:** `progress_target > 1` and the Reminders flag (§6) are rejected together at validation — an item is tracked or a reminder, never both.
- **Undo/redo:** `VALID_TASK_COLUMNS` (`src/core/undo/apply-fields.ts`) is a static allowlist that throws on unknown fields — extend it with `progress_target`/`progress_current` (and skip's fields, §7.5) BEFORE these ship, or the first undo of a tracked completion 500s.
- Increment timestamps recorded (a small `progress_events` table) — but treat as "when logged," not "when done": the user logs loosely, within ~24h. Fine for pace math; never build timing analysis on it.
- **Pace is deterministic view logic**, not AI: behind/on-pace derives from period elapsed vs. progress remaining. Display only (a subtle bar/fraction).
- **Notification policy: silent while on pace.** At most ONE mild nudge near period close when short — phrased as a question, not an alarm, because per L1 a 0/1 late in the week may mean _unlogged_, not _undone_.
- Filter chip for tracked items (`progress_target > 1`); the tasks widget (§8) can render tracked items as progress rows.
- Opt-in is just setting a target > 1 ("Track" in the task editor).

Existing title-encoded quotas ("Eggs (2x/week)") migrate in §9.

---

## 6. The Reminders surface

**What it is:** a separate screen/tab for the prompted-thoughts population — principles, considerations, "thoughts to have at the right moment." Not a project, not a priority rung, not merely a tag: **a distinct surface with distinct behavior.** (It may be implemented as a persistent filter state that _looks_ like a tab — the user is fine with a chip-that-looks-like-a-tab.)

**Behavior, all of which differs from tasks:**

- Items live in **time-of-day buckets** named by life-moment ("Early morning," "Before work," "Evening" — user-configurable labels). The buckets are derived from each item's scheduled time; production data already clusters at 07:00/09:00/12:00/16:00/20:30, so buckets emerge rather than being invented.
- **Items cannot be snoozed out of their bucket.** They stay visible in the bucket until completed — completion means "considered/done" exactly as the user's old app worked. The bucket view shows only incomplete items (completed ones drop out rather than burying the rest).
- **Never counted in overdue**, never in the badge, never fire individual notifications. The **bucket** notifies (once, at bucket time, one notification with class-level collapse per §4.2).
- **Priority = prominence, not interruption.** Within a bucket, higher priority sorts first and renders heavier. Even the highest-priority reminder never nags — its importance is expressed by position, because the canonical high-priority reminder ("morning supplements" — _"you don't have to, but consistency matters"_) is important without being an interrupt.
- Reminders keep due-times ("consider X" belongs near bedtime, not lunch) and rrules. What they lack is _debt_: missing one costs nothing; the next occurrence simply arrives. A recurring reminder's today-ness derives from its schedule (§4.6), so a missed one resets naturally at the next occurrence — no roll-forward job, no accumulated "overdue by N days" state, ever.

**Rationale (why not just tasks-with-a-tag):** these items differ _behaviorally_ — no debt, no badge, bucket-locked, container-notified. Behavior enforced by the surface beats behavior promised by AI/user discipline. But avoid a new first-class DB entity if a flag + surface can carry it: the user is deliberately wary of new primitives. **Representation: a boolean column** (e.g. `is_reminder`) read by the Reminders surface and the notifier — NOT a label. Two reasons: §7.1's resolution of L3 is that kind is never stored as a name, and a behavior-bearing value inside the JSON `labels` array would need `json_each()` at every query site where an indexed boolean is wanted (`overdue-checker.ts`, dashboard queries). Mutually exclusive with Track (§5).

### 6.0 Time-slot buckets — schema and assignment (shared infrastructure: §6 AND §7.3 both build on this; it is a Stage 1 item)

Nothing resembling this exists in the repo — the only current "bucket" concept (`useFilterState.ts` / `DueDateFilterBar.tsx`) is an unrelated due-date classifier (overdue/today/this-week). Define:

- A `time_slots` table (or config): `id`, `label` ("Early morning", "Before work", …), `start_time` (HH:MM local), `sort_order`. Per-user. Seed from the production clusters (07:00 / 09:00 / 12:00 / 16:00 / 20:30) at migration; user-editable labels and boundaries.
- **Assignment algorithm:** an item belongs to the slot with the latest `start_time` ≤ its time-of-day, where time-of-day = `anchor_time` if set, else `due_at`'s local time. Items with neither → no slot (they render in the un-slotted group, §7.3).
- The dashboard (§7.3) and the Reminders surface (§6) group by the SAME table — one definition of "morning."

**Terminology guard (naming collisions with existing code):** "bucket" already means the due-date classifier above — in code, name this concept **time slot** (`time_slots`, `slot_id`), never `bucket`. Likewise "skip": `review/execute` already uses `skip` as a no-op review acknowledgment; §7.5's verb is a different operation — name the API action distinctly (e.g. `skip-occurrence`) to avoid collision.

**Open question the builder must NOT decide unilaterally:** what _retires_ a reminder. Nothing self-prunes (the user was explicit: no mechanism deletes un-done things), and reminders are cheap to keep — so the pile can regrow invisibly. Options (periodic review prompt, staleness surfacing in the Reminders screen, nothing-for-now) are a user decision.

### 6.1 Notification-content strategy for buckets (decide during build, with the user)

Candidates, in current preference order:

1. **Batch checklist in the notification** (his favorite): long-press the bucket notification → content extension shows a checklist → check items → ONE commit action button. **What the existing code proves, precisely:** the stage-in-SwiftUI → commit-on-action-button → dismiss-on-success/`.doNotDismiss`-on-failure _discipline_ (the snooze grid stages one scalar, `selectedDueAt`, through a fixed 16-button grid). **What is NEW and must be built:** a variable-length per-row-checkable list (array-valued staged state), a bounded `ScrollView`/`List` (the extension resizes-to-fit via `preferredContentSize`, it does not scroll natively), a **batch-complete endpoint** (none exists in `src/app/api` — the commit button must send one request with N task IDs, not N requests), and a new `UNNotificationExtensionCategory` (Info.plist currently lists only `TASK_REMINDER`/`TASK_SUMMARY`). Do NOT rely on SwiftUI Buttons inside the extension committing directly — unverified; action buttons are the reliable commit surface.
2. Count only ("Early morning — 8 waiting").
3. One full item rotating (delivers the thought itself; nothing to tap — but the user noted an unread notification still isn't an _acknowledged_ one, and teasers entice taps; this shapes but doesn't decide the choice).

Known iOS bug to investigate while in this code: the user reports long-press on _grouped_ notifications sometimes fails to show the content extension (the snooze grid). Reproduce and fix or document.

---

## 7. Organization & views

### 7.1 Projects and labels — the target model

| Layer        | Cardinality          | Carries                    | Members at migration                                                                                                                     |
| ------------ | -------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Projects** | exactly one per task | macro domain               | **Inbox** (landing/unclassified) · **Work** · **Personal** (· _General_ only if it proves distinct from Personal — expected to collapse) |
| **Labels**   | many per task        | micro domain + operational | `nutrition`, `kids`, `house`, … + `ai-added`, `ai-proposed`, `ai-monitored`                                                              |
| **Neither**  | —                    | kind                       | Reminders = the surface (§6) · quotas = Track fields (§5) · routine-vs-task = behavior (rrule + cadence)                                 |

Retiring as projects: Routine (→ time buckets), Reminders (→ §6 surface), One-offs (→ plain tasks), Backlog (→ no due date, optional `someday` label), temp/temp2/OpenTask (→ delete or label). **Kind is never stored as a name anywhere** — it is expressed as behavior and surface. That is the resolution of L3.

Grouping vs filtering rule: **group by single-valued fields** (time bucket, project — no duplication possible), **filter by labels** (composable). Chip semantics: **AND across facets, OR within a facet** (the existing tri-state chips with an "excluded" state already imply AND — exclusion is incoherent under OR).

### 7.2 The label registry

Labels today are bare free-text (no registry, no list endpoint, typos silently fork the taxonomy). Build a registry:

- `labels` table: `name` (canonical, unique), `facet` (domain / operational / …), `icon`, `color`.
- **Creation is a discrete act**: task create/update with an unknown label is REJECTED unless an explicit `create_label` flag accompanies it. A typo fails loudly instead of minting a tag.
- List endpoint + CLI verb.
- API conveniences so automated callers never type label strings: `--ai-proposed` / `--ai-added` flags on create, and a `confirm <id>` verb that swaps `ai-proposed` → `ai-added`. (Rationale: the AI assistant managing tasks must never be able to typo a behavior-relevant label in free text.)
- **Close the enrichment bypass:** `src/core/ai/enrichment.ts` writes `labels` via raw `UPDATE tasks SET labels = ?`, skipping validation entirely. Once labels can carry behavior, this path must validate against the registry too.
- **Distinguish two AI label vocabularies (they are different machines):** the LIVE labels `ai-to-process` / `ai-failed` / `ai-locked` (enrichment.ts) are a _processing state machine_ — leave them alone. The NEW `ai-proposed` / `ai-added` / `ai-monitored` are _provenance_: `ai-added` = created by the assistant, `ai-proposed` = created on assistant initiative not yet blessed, `ai-monitored` = the assistant/desk watches this task. `confirm <id>` is **task-scoped**: removes `ai-proposed`, adds `ai-added`, touches nothing else.
- **Migration order:** backfill the registry from the ~6 existing production label values BEFORE enforcement turns on, and validation rejects only labels being _newly added_ — never an already-stored label round-tripping through an edit save (otherwise existing tasks fail on unrelated edits).

### 7.3 The dashboard

Today's dashboard is a data dump behind ~20 filter chips. Target: **opening the app answers "what now" without scanning.**

- Default view = **today, grouped by time slot** (§6.0), in time order; within slots sort by priority. **No-time-of-day items (most Track items, §3):** an explicit un-slotted group on the same view (suggested: "Anytime today," rendered after the timed slots, tracked items as progress rows) — they must not become invisible from the front door.
- **Expand/collapse per group with first-N shown** (~5) and a "show all" affordance — scales to any group size without truncating content (§1.1).
- Controls scoped to the view they act on (bulk actions operate on the visible/expanded scope, not the whole corpus).
- The Reminders surface is separate (§6); the dashboard is tasks.
- An "all caught up" state for the day is explicitly desired (the inbox-zero feeling for _today_, while later-today items still pend).
- Keep the unified/all view reachable — the corpus stays fully accessible; it's just not the front door.

### 7.4 AI features

`whats-next` / `insights` run **once daily on schedule + on-demand refresh only** — never eagerly on page load (single-user install; eager regeneration wastes tokens). This is a stated user requirement.

### 7.5 The `skip` verb

New task action: **skip** (API name `skip-occurrence` — see §6.0 terminology guard; `review/execute` already uses "skip" for something else) — "not doing this occurrence, advance without recording a completion." For recurring items: advance to next occurrence, `completion_count` untouched (add `skip_count`). For one-offs it's equivalent to archiving without completion. Purpose: **protect `completion_count` honesty** — today the user must either lie (mark done) or defer (snooze) to clear an item. Expect bulk-skip; per L1 it carries no intent signal and nothing may be built on skip patterns.

Plumbing: add `skip` / `bulk_skip` to the `UndoAction` union (`src/types/index.ts` — no such member exists), extend `VALID_TASK_COLUMNS` with `skip_count`, and dispatch a `task.skipped` webhook event (NOT `task.completed`).

---

## 8. Widgets

Three independent Home-Screen/Today-View widgets — separate widget _kinds_ (each gets its own refresh budget). **Sizes:** primary layouts are `systemLarge` (the 4×4-icon footprint; WidgetKit mapping — `systemSmall` ≈ 2×2 icons, `systemMedium` ≈ 4×2, `systemLarge` ≈ 4×4) with `systemMedium` reduced variants, **plus a `systemSmall` (2×2) variant of every kind** (AMENDED per user 2026-07-27 — the original "2×2, like a big one" reading conflated the two; he wants both). The Track widget's 2×2 is the flagship small: a quota compresses to a ring + fraction perfectly, which lists don't.

1. **Reminders widget** — current time slot's incomplete items, check-off via AppIntent buttons; chevron (AppIntent) to move between slots; defaults to the current slot. Small variant: current slot name + count + top item.
2. **Tasks widget** — today's tasks; chevron cycles whatever projects exist (do not hardcode a count — §7.1 leaves General's fate open). **Tracked items are EXCLUDED** (AMENDED 2026-07-27 — they have their own widget now; a quota row in the task list buries the thing being glanced at). Small variant: overdue count + next task.
3. **Track widget** (AMENDED 2026-07-27 — the user rates this the second-most-important widget; the original spec wrongly folded it into Tasks) — every `progress_target > 1` item as a progress row: title, n/target, thin bar, `+1` AppIntent button; §5 pace states render but never alarm. Small (2×2) variant is first-class: one quota as a progress ring + fraction, chevron-cycled; behind-pace item preferred by default.

**Interaction affordances (AMENDED 2026-07-27, from first real use):**

- **Chevrons must telegraph their edges**: render disabled/dimmed when there is nothing further in that direction, and where the layout affords it show the adjacent page's name next to the glyph (e.g. `‹ Midday … Evening ›`) so paging is a choice, not a gamble.
- **Check-off must be optimistic**: the item leaves the widget the moment it is tapped (local cache tombstone), with the server call reconciling behind it — the round trip is seconds long and a visible multi-second delay reads as a dead button. On failure the item reappears (honest), it never silently stays gone.

Watch app (`ios/OpenTaskWatch/`): **out of scope for v0.3** beyond continuing to compile — no watch widgets/complications this round.

Platform facts the implementation must respect (verified against Apple docs 2026-07):

- **Interactive widgets work via AppIntent buttons/toggles; on a locked device they are inert** until authentication. Lock-Screen accessory widgets = glanceable status only. The "swipe left from Lock Screen" flow = Today View, which is fine _after_ unlock (Face ID glance).
- **Refresh budget ~40–70 timeline reloads/day per widget** (a commonly-cited estimate, not an Apple-published exact figure — do not hard-code logic assuming a specific count) — but reloads triggered by the widget's own AppIntent interactions and by the foregrounded app are **budget-free**. Check-offs refresh instantly at no cost; only unprompted refreshes are budgeted.
- **No swipe gestures in widgets** — taps only; hence chevrons. Smart Stack (user stacks the two widgets) supplies the swipe between them — worth suggesting to the user, not required.
- **Live Activities are NOT the all-day surface**: hard 8h update ceiling (12h Lock-Screen linger), local updates do not extend it, chaining requires an alert-bearing push (a daily bookkeeping alert — self-defeating), budgets are opaque and exhaust silently. If used at all, session-scoped only (a focus block), started via `LiveActivityIntent`. iOS 27 changes nothing material here (verified: no new ActivityKit symbols).
- Push channels available if needed later: `liveactivity` (16.1+), `controls` (18+), `widgets` (26+). **Deployment target:** the app currently targets iOS 17.0 (`project.pbxproj`). Do NOT bump the whole app to 26 for widget push — interactive widgets need only 17, and the widget _extension_ can carry its own higher target if `widgets`-type push is wanted. Re-confirm both household devices' actual OS versions immediately before any bump (asserted 26.x at spec time; exactly the kind of claim that goes stale).

---

## 9. Migration (deliberately LAST)

The corpus sort happens **after** the destinations exist (user's explicit ruling: don't touch the 217 until the model is built). Process:

1. AI classifies every recurring task into the four populations (§3) — protocol → time-slotted task · prompted thought → Reminders surface · parked one-off → real task with a real due date, rrule removed · quota-title → Track with parsed target. **For each parked one-off the classification pass must PRODUCE the new `due_at` value** (its real deadline, or a chosen resurface date) — and the migration must PATCH `due_at` explicitly alongside `rrule: null`: clearing rrule alone does NOT refresh `due_at` (`collect-field-changes.ts` leaves it at its last stale sweep value — precisely the untrustworthy state §4.6 warns about, made permanent). After its due date passes, a parked one-off behaves as an ordinary overdue task under §4.1 cadence — resurfacing IS the notifier, no special mechanism.
2. **The user reviews the list once** and adjusts; then a dry-run-first bulk script executes. (House pattern: fetch → plan → print → `--execute`.) **Mandatory: take a `sqlite3 .backup` snapshot immediately before `--execute`** (the README documents the procedure), and STATE which mutation layer the script uses — the house precedent (`scripts/migrate-due.ts`) is raw SQL bypassing undo/webhooks/activity-log, in which case the backup file is the only recovery path and the one human gate is the review list.
3. Projects migrate: current project → new project (Work stays Work; everything else lands Inbox/Personal pending the sort) with labels derived where obvious. **Non-recurring Backlog (~122 tasks, 25% of corpus) gets its own explicit sub-step:** apply §7.1's rule — due date removed (or kept if genuinely real), optional `someday` label, project → Personal/Inbox. "Labels derived where obvious" is not sufficient instruction for this population.
4. Bracket prefixes (`[M]`, `[E]`, …) stay in titles until the bucket chip renders from `anchor_time`; then one bulk pass strips them. (They encode time-of-day AND frequency inconsistently — `[W]` vs `[Weekly]` vs `[Weekend]` — the derived chip dissolves this.)
5. Completion counts are NOT trusted as adherence history (Due-migration artifact); Track starts everyone at 0.

---

## 10. Rejected designs (do not resurrect)

Each of these was proposed and killed in design; the reason is the load-bearing part.

| Rejected                                                   | Why                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Nightly roll-forward cron advancing missed recurring items | "Extra machinery"; §4.6 read-time derivation achieves it with no job                                   |
| Silently clamping a snooze to the next occurrence          | The app never silently reinterprets an explicit instruction → warning prompt instead (§4.3)            |
| Batch-size / custom-time as a deliberation signal          | L1 — the user bulk-snoozes small batches unread, to custom times, routinely                            |
| P0 as a "Silent" tier                                      | L1 (unset ≠ lowest) + L2 (silence fails dangerous)                                                     |
| "Reminders have no completion / acknowledge button"        | False — completing-as-considered is real and valued; acknowledge-buttons violate L4                    |
| Offers→P0-P2 / obligations→P3-P4 mapping                   | L3 (kind on the importance axis) + L1 (P0 is unset)                                                    |
| A separate sister app for reminders                        | Kicks the can — the main app still needs the gradient                                                  |
| Reminders as a priority rung ("PR")                        | Destroys the importance gradient _within_ reminders (§6 priority-as-prominence instead)                |
| Notify-once for Medium                                     | Fails dangerous — one missed glance loses it permanently (→ slower cadence + replacement)              |
| An always-on "today" Live Activity                         | 8h wall + alert-bearing chained restarts (§8)                                                          |
| A digest artifact/rendered surface                         | User: extra clutter; a Telegram notification is wanted, a surface is not (hub-side, out of scope here) |
| Streaks                                                    | Requires completion fidelity the user will never provide (L4) and history is polluted                  |

---

## 11. Build order

1. **Stage 0 (deploy unblock):** ⚠ there is no pending _commit_ — the P3/P4 sweep-exemption diff sits **uncommitted in a dirty working tree** on a branch with an unrelated name (`fix/ai-structured-output-schema`), mixed with unrelated dirty/untracked files. The builder must: verify the diff against §4.4's description, re-run the full suite fresh, choose a branch strategy, and commit ONLY the relevant files. Then deploy (this also ships the older undeployed PATCH rrule+due_at fix). DB prep done 07-26. Add §4.3 prompts (single-task scope only). §7.4 AI scheduling. §4.4 cleanup rider (stale comments).
2. **Stage 1 (model):** label registry (backfill first, §7.2) → project restructure → **time-slot infrastructure (§6.0)** → **read-time occurrence derivation (§4.6 mechanism + its three call sites)** → Track (period-anchored, per the §5 decision) → skip. Extend `VALID_TASK_COLUMNS` + `UndoAction` + webhooks for every new column/verb in this stage.
3. **Stage 2 (notifications):** per-class threads + per-slot collapse (§4.2, decided) → cadence ladder (§4.1 columns + settings UI) → slot notifications → batch-checklist extension (§6.1 — new endpoint + category).
4. **Stage 3 (views):** dashboard rework → Reminders surface.
5. **Stage 4 (surfaces):** the two widgets.
6. **Migration last** (§9).

Each stage ships alone and is independently reversible. The primary user budget is ~7 hrs/week — prefer the smallest version of each stage that is honestly usable.

---

## 12. Hub pointers (context beyond this document)

For sessions with hub access (`~/hub-store/capabilities/opentask/`): `design.md` (the working design record this spec was distilled from), `capability.jnl.md` (dated deliberation — full rationale for every kill in §10), `learned.md` + `trent.learned.md` (operating laws and user-specific judgment, including the proactive task-creation protocol). The user's own words quoted here are sourced there. This document supersedes none of them; it is the repo-facing distillation.
