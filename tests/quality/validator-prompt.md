# Layer 2 Validator Prompt — AI Quality Evaluation

You are evaluating AI outputs from OpenTask's prompt quality tests. For each scenario, you'll read the input (what was sent to the AI), the output (what the AI returned), and the requirements (what counts as good). Your job is to judge whether the output meets the quality bar.

---

## Evaluation Process

For each scenario:

1. Read `input.json` — understand what the AI was asked to do
2. Read `output.json` — see what the AI produced
3. Read `requirements.json` — understand the quality expectations
4. Evaluate against the criteria below for the relevant feature
5. Write your judgment to the scenario directory as `validation.md`

---

## Enrichment Evaluation Criteria

### 1. Title Quality

- Is the title clean, concise, and actionable?
- Were dictation artifacts removed (um, like, you know, or whatever)?
- Were temporal phrases removed ("tomorrow", "next Tuesday") since they were extracted into `due_at` / `on_deck_day`?
- Were priority phrases removed ("URGENT", "high priority") since they were extracted into `priority`?
- Was the user's voice preserved? ("grab" not changed to "buy", specific phrasing kept)
- Was an already-clean title left unchanged?
- (2026-10-16) Repeat wording left in the title once it is in `rrule` ("Water the ferns every other day", "Go to the gym twice a week") is a title miss; a repeat word that is part of a name ("Weekly standup") must stay.

### 2. Date Extraction

- Was a relative date correctly interpreted? ("tomorrow" = correct date, "next Tuesday" = correct day)
- Was the timezone conversion to UTC correct? (e.g., 9am Chicago = 15:00 UTC in winter, 14:00 UTC in summer)
- Was `null` returned when no date was mentioned?
- Was the time reasonable for vague references? ("morning" = 8-10am local, "afternoon" = 1-3pm)

### 2b. Target, deadline and horizon (task model, 2026-10-10)

`due_at` is the **target** (the day the user said to do it), `deadline_at` the **real cutoff**, `horizon` the **pace**. Layer 1 sees local datetimes (before UTC conversion).

- Is `deadline_at` set ONLY from stated cutoff wording ("by", "before", "due", "expires", "the deadline is", "closes at")? An inferred deadline — from urgency, topic (a bill, taxes) or a target date — is a **failure**: it caps the user's snoozing.
- A cutoff day with no time → end of that day (T23:59:00 or very close). A stated time is kept.
- A cutoff-only date leaves `due_at` null. A cutoff AND a "do it X" day sets both, unswapped.
- "do it Saturday", "remind me Thursday at 9", "tomorrow" are days to do it, not cutoffs: `deadline_at` null (a day with no time goes on deck — see 2c).
- Is `horizon` set ONLY from explicit pace wording ("this week" → weeks, "sometime this month" → months, "in the next few days" / "today or tomorrow" → days, "eventually" / "someday" → eventually)? A horizon from topic or size ("fix the squeaky door" → eventually) is a **failure**. A named day is not a pace.
- "by the end of the month" is a deadline, not a horizon.
- **Soon today** (2026-10-16) — the run's "now" is `run_now_local` in metadata.json (or the scenario's pinned `now` in input.json): "now" / "right now" / "immediately" → about 15 minutes out, rounded UP to the next quarter hour (2:07 → 2:30, 2:45 → 3:00, 11:52 PM → 12:15 AM tomorrow); never the current minute. "in an hour" / "in N hours" → now + N hours, rounded up to the quarter hour. A range ("in an hour or two", "in 2 or 3 hours") → a whole hour inside it is best; another quarter hour inside it is a minor miss; outside it (e.g. 15 minutes out) is a failure. A "now" that is not a time ("now that the lease is signed", "for now") → `due_at` null. **Same day** (2026-10-16): a one-off target dated today when the words say "tomorrow", or already past today with no clock time in the words, is a failure (the code moves it to tomorrow at the same time); "tonight at 7" said at 8 PM stays today, as said.
- Recurring tasks and reminders: `deadline_at` and `horizon` null.

### 2c. On deck (2026-10-20)

The output has `on_deck_day` (a local date, `YYYY-MM-DD`) beside `due_at`. **A day with no time** ("do it Saturday", "today", "tomorrow", "next Tuesday", "in 3 days", a bare "this weekend") puts the task **on deck** for that day: `on_deck_day` set and `due_at` **null** — that null is correct, not a missed target. Never both set.

- A clock time ("at noon", "1 PM", "tomorrow at 9am") or a **part of day** ("tomorrow morning", "tonight", "this afternoon", "this evening", "after work", "before bed") is a **target**: `due_at` a full datetime, `on_deck_day` null. A part-of-day word decked instead is a failure.
- A deadline plus a day to do it ("by Friday, do it Wednesday") keeps the day as a **target** (`due_at` Wednesday at the default task time, `deadline_at` Friday 23:59) — `on_deck_day` null.
- Repeating tasks are never on deck.
- **"remind me <day>" or "nag me <day>" with no time** ("nag me on Friday", "nag me next Monday" too; 2026-10-22) asks for a reminder: a TARGET that day at the default task time (9:00 AM), never on deck, and `auto_snooze_minutes` null (no interval was given). Every other bare day decks ("call the bank Thursday"), including one beside "don't nag me" (that is the nag turned off: `auto_snooze_minutes` 0).
- A named weekday beside "this weekend" wins ("plan Sunday brunch this weekend" → Sunday). A misspelled "tomorrow" ("tommorow") is still tomorrow.
- A4 also applies to deadlines: "by tomorrow" at 00:30 → `deadline_at` on the calendar today.
- A bare "this weekend" → on deck the coming Saturday (today on a Saturday or Sunday). "sometime this weekend" is a pace: `horizon` days, both dates null.
- Between local midnight and the user's rollover (the harness uses 7:00 AM; the run's now is in metadata), "tomorrow" means the coming day — the CALENDAR TODAY — for decks and targets alike. "tomorrow" at 00:30 on Oct 21 → `on_deck_day` 2026-10-21; "tomorrow at 3pm" at 00:30 on Oct 21 → `due_at` 2026-10-21T15:00; at 23:30 on Oct 20 both are Oct 21.
- The quality-notes of older scenarios may still say "due_at should be tomorrow" for a day with no time; read that as the DAY, now carried by `on_deck_day`.

### 2d. Relative targets (2026-10-24)

A target counted back from a stated deadline ("remind me the evening before", "the morning of", "2 days before") is `target_days_before` + `target_time` (+ `target_slot_id` when it follows one of the user's periods); `due_at` and `on_deck_day` are then **null** — that null is correct, the app derives the target from the deadline. The output's `target_time` / `target_slot_id` are what the CODE mapped (`target_period` is the model's word), and `target_slot_label` names the linked period.

- Set ONLY from wording counted back from a deadline the input states. A named day ("by Monday, do it Sunday morning") is a fixed `due_at` with the three null; no deadline (an occasion like a birthday, an undated trip) or a repeat → all null. Offsets on any other scenario are a **failure**.
- `target_days_before`: "the day before" / "the evening before" / "the night before" → 1, "N days before" → N, "the morning of" → 0.
- The model's `target_period` is the user's own word, or a listed period's exact name when the word is that name — never a different period the time falls in ("evening" with periods AM / PM / Night is "evening", not "Night"). The model's `target_time` is set only for a clock time said for the reminder (the deadline's own time is not it).
- Mapped time: a clock time said → that time; "morning" or no part of day → the Default task time (the scenario's `morningTime`, 9:00 by default), even with a period named Morning; a period's exact name → linked, at its start; another part of day → 13:00 afternoon, 18:00 evening, 20:00 night.
- The reminder wording must not be lost when the three are null (a repeat, no date): it stays in the title or notes, in the user's words — no added advice.

### 3. Priority Inference

- Was an explicit priority signal correctly captured? ("URGENT" = 4, "high priority" = 3)
- Was emotional urgency appropriately reflected? ("killing me", "really really need to" = 2-3)
- Was priority left at 0 when there was no signal? (conservative default)
- Was there no over-inference? ("check the mail" should not get priority 2)

### 4. Label Extraction (Explicit Only)

- Are labels empty when the user did NOT explicitly request a label? (This is the most common case — labels should almost always be `[]`)
- When the user explicitly said "label it as X", "tag it X", "add the X label", or "mark it as X", was that label correctly extracted?
- Were NO contextual labels inferred? ("dentist" must NOT produce "medical", "van" must NOT produce "car")

### 5. Project Matching

- Was the correct project selected from the available list?
- A project is set only by an explicit instruction ("add it to Work") or a **name match**: the task text contains the project's full name as a phrase, used as that name ("test task for job search" → Job Search). Is the project `null` otherwise?
- No inference from topic: "apply to Acme" must not go to Job Search, "fix that deployment bug" must not go to Work.
- Name-match false positives are failures: part of a longer word ("homework", "workout"), a verb ("work out"), a schedule cue or direction ("after work", "on the way home"), or Inbox.
- Two matching names → the longer, more specific one; unrelated matches with no explicit instruction → `null`.
- **Project descriptions** (2026-10-16, the text after " — " in the project list): a description only settles which project the user's words mean when they could mean several (an instruction "add it to the rental project" with Oak Rental and Pine Rental → the one whose description fits). A pick made only because a description fits the topic is a **failure** (also when the run log shows the guard nulled it), and so is a description pulling a task away from a project its words name.

### 6. Recurrence Parsing

- Was the RRULE syntax correct? (FREQ=DAILY, FREQ=WEEKLY;BYDAY=MO)
- Was DTSTART NOT included? (the prompt explicitly forbids it)
- Was `null` returned when no recurrence was mentioned?
- Were vague recurrence signals correctly interpreted? ("every morning" = FREQ=DAILY)
- (2026-10-16) A repeat made on its day after its time must start at its next occurrence, not today's past one.
- (2026-10-17) "today" / "tonight" (with no other day named) is TODAY's local date, also late in the evening when UTC has moved to tomorrow; a target on the next day is a failure.

### 7. Conservatism

- Were unextracted fields left as null/0/empty?
- Was nothing guessed when uncertain?
- "Better to leave empty than guess wrong" — was this principle followed?

### 8. Nag Interval Correctness (`auto_snooze_minutes`)

The app calls this field the **nag** (2026-10-21; "auto-snooze" before) and calls moving a target **defer** ("snooze" before). Users may say either word; both must land the same way.

- Was `auto_snooze_minutes` parsed to the correct integer value? ("nag me every 30 minutes" = 30, "auto-snooze 30 minutes" = 30, "snooze every 2 hours" = 120, "defer reminders every hour" = 60)
- Was `null` returned when no nag interval was mentioned? A bare verb is not an interval: "nag Dave about the invoice" (nagging someone is the task) and "defer it to Friday" (a day) leave it null.
- Was `0` returned when the user explicitly turned it off? ("nag off", "don't nag me", "no auto-snooze")
- Was the nag not confused with deferring? (deferring moves `due_at`; the nag is a repeating reminder interval, never an `rrule`)

### 9. Recurrence Mode

- Was `"from_completion"` set only when the user explicitly signals it? ("from when I finish", "after I do it", "start counting from when I actually do it")
- Was `null` returned as the default when no mode was mentioned? (standard recurrence = `null`, not `"from_due"`)
- Was recurrence mode not confused with regular recurrence? ("every Monday" = rrule only, no recurrence_mode; "every 2 weeks from completion" = rrule + `"from_completion"`)

### 10. Notes Quality

- Were reference numbers preserved exactly? (phone numbers, case numbers, Rx numbers, confirmation codes)
- Were addresses and specific details captured? (street addresses, suite numbers, extensions)
- Was context that doesn't belong in the title separated into notes? (instructions, amounts, reference info)
- Was `null` returned when there was nothing extra to capture? ("buy milk" has no notes)
- Was information NOT duplicated? (if "Walgreens" is in the title, it shouldn't be repeated in notes)

### 11. "Critical" Keyword as Priority Signal

- Was "critical" / "critical alert" correctly mapped to priority 4 (not a label)?
- Was emotional urgency ("really important") NOT treated as P4? (those map to priority 2-3)
- Was non-urgency usage of "critical" correctly ignored? ("critical thinking" should NOT trigger P4)

---

## What's Next Evaluation Criteria

### 1. Task Selection

- Were overlooked tasks surfaced? (old lingering tasks, idle without attention, social obligations)
- Were obvious items correctly excluded? (daily recurring affirmations, urgent/high-priority, due today)
- Were time-sensitive items without hard deadlines recognized?
- Were social obligations identified? (calls, thank-you cards, RSVPs)

### 2. Reason Quality

- Are reasons specific and actionable? ("Been on your list for 3 weeks" not "This deserves attention")
- Is the tone direct? (like a thoughtful friend, not a nagging app)
- Do reasons reference concrete data from the task? (task age from created_at, dates, labels, notes)

### 3. Summary Quality

- Is the summary 1-2 sentences?
- Does it capture the key themes across surfaced tasks?
- Is it concise and informative?

### 4. No Hallucination

- Do all `task_id` values exist in the input task list?
- Are no tasks invented or referenced that weren't provided?

### 5. Overdue/Deadline Distinction

Task lines show `target:` (soft, deferrable — "overdue" means past it), `deadline:` (the real cutoff, only when set) and `horizon:` (pace, only when set).

- A `deadline:` within the week (or passed) is time-sensitive at ANY priority — does commentary treat it as real?
- A far `deadline:` is not urgent, even at P3-4, even when the target is near.
- Is no deadline invented for a task with no `deadline:` field and none in its notes?
- For priority 3-4 tasks with a deadline in their notes (no field): is it treated as real?
- For priority 0-2 overdue tasks: does commentary focus on age/deferral, NOT hours overdue?
- Are notes referenced when they provide relevant context?
- Is recurrence_mode: from_completion correctly interpreted (overdue = the user hasn't completed the last occurrence)?

### 6. Factual Grounding

- Does the AI only state things derivable from the input data?
- For P0-2 tasks: is commentary based on task age (created_at) rather than due date gap?
- Does the AI avoid fabricated counts ("deferred twice", "snoozed X times")?
- Words (2026-10-21): the app says "overdue" for a task past its target, "defer" for moving a target and names priorities in words. "Overdue" is correct; "snooze" and "P3"/"P4" in user-facing text are word misses.
- Are notes referenced accurately when present (exact claim numbers, deadlines)?
- Is no narrative fabricated about what happened between two dates?

---

## Insights Evaluation Criteria

### 1. Score Reasonableness

- Does the score reflect "attention needed" (the OPPOSITE of urgency)?
- Old forgotten P0 tasks (months old, no due date) should score HIGH (70+)
- P4/Urgent tasks should ALWAYS score LOW (0-20), regardless of overdue status
- Recurring tasks 1-2 days overdue should score LOW (0-20) — normal cadence
- P0-2 tasks overdue by 1-2 days should score LOW (0-25) — routine reminder behavior
- Well-organized tasks with clear due dates should score LOW (0-29)
- P3 due today with consequences still days away should score MEDIUM (30-50)

### 2. Signal Accuracy

- Are signals from the correct vocabulary? (stale, act_soon, quick_win, vague, misprioritized, review)
- Is "stale" applied to tasks sitting 3+ weeks with no progress?
- Is "act_soon" applied only for real consequences — a `deadline:` within 7 days or passed (any priority), or a P3-4 deadline/filing window stated in notes — and NOT for routine overdue targets or a `deadline:` weeks away?
- Is "quick_win" applied to small, concrete tasks doable in under 10 minutes?
- Is "vague" applied only when the title is genuinely unclear AND notes don't clarify?
- Is "misprioritized" applied when priority clearly doesn't match content?
- Do 60-70% of tasks have NO signals?

### 3. Commentary Quality

- Is commentary specific, concise, and grounded in task data?
- Does it reference concrete details (task age, due date, notes content)?
- Is the tone direct and useful, not corporate-speak?
- For low-scoring tasks, is commentary brief and positive?

### 4. No Hallucination

- Do all task_ids exist in the input?
- Are dates, ages, and facts accurate?
- Is no narrative fabricated about task history?

### 5. Completeness

- Does every input task appear in the output?

### 6. Signal Restraint

- Do most tasks (60-70%) have NO signals?
- Does no task have more than 2 signals?

### 7. Large-List Specific (50+ task scenarios)

For scenarios with 50+ tasks, evaluate these additional criteria:

- **Score distribution**: Are scores meaningfully spread? Scores should not cluster around a single value. There should be clear differentiation between well-organized tasks (0-29), borderline tasks (30-60), and attention-needed tasks (70+).
- **Anchor task accuracy**: For scenarios with anchor tasks (IDs 9001+), do the anchor tasks receive appropriate scores and signals as described in the requirements? These are hand-crafted to have obvious expected outcomes.
- **Cross-task calibration**: Do similar tasks receive similar scores? A P0 task created 3 months ago should score comparably to another P0 task created 3 months ago, regardless of their position in the list.
- **Signal restraint at scale**: With 50+ tasks, signal restraint becomes more important. The AI should not over-signal just because there are many tasks. At least 50% of tasks should have zero signals.
- **Commentary consistency**: Is commentary quality maintained across the full list? Early and late tasks in the output should both get specific, grounded commentary — not generic filler.
- **Chunked consistency** (for `review-large-chunked` only): If the scenario used the production chunking code path, check that anchor tasks were scored consistently despite being split across chunks. Score variance of ±15 points from the single-call scenario is acceptable for anchor tasks.

---

## Quick Take Evaluation Criteria

### 1. Contextual Awareness

- Does the response show awareness of the user's existing task list?
- Does it reference specific details (project names, due dates, task counts, patterns)?
- Is it clear the AI "saw" the full picture, not just the new task?

### 2. Cross-Referencing

- When relevant, does the response cross-reference related tasks? (same project, same day, same label)
- Are counts accurate? ("3 other Acme tasks" when there are actually 3)
- Is the cross-reference natural and useful, not forced?

### 3. Brevity

- Is the response a single sentence, roughly 20 words or fewer?
- Is it concise and punchy, not padded with filler words?
- Does it feel like a quick aside, not a paragraph?

### 4. Non-Generic

- Would this response be impossible to write without seeing the task list? (the key test)
- Does it avoid generic phrases like "task added!", "got it!", "noted!"?
- Does it avoid generic productivity advice like "don't forget to prioritize"?

### 5. No Prioritization Advice

- Does it avoid suggesting the user reprioritize, reorder, or schedule tasks?
- Does it stick to observation, not recommendation?

### 6. Tone

- Is the tone like a sharp assistant who just glanced at your list?
- Direct, not corporate or overly enthusiastic?
- Not sarcastic or negative about the user's workload?

### 7. Factual Accuracy

- Are any facts stated (task counts, project names, dates) actually correct given the input data?
- Does it avoid hallucinating tasks, projects, or dates that don't exist?

---

## Quota Enrichment Evaluation Criteria (`enrichment_quota`, 2026-10-24)

The output is the stored PLAN, not the raw answer: `title`, `notes`, `priority`, `labels`, `rrule` (the bare period rule `FREQ=X[;INTERVAL=N]`, or null = the provisional weekly period stays), `progress_target`, `prompt_slot_label` (null = the user's default reminder period), `prompt_enabled`. `model_answer` is the raw answer, for context only.

1. **Count** — the target comes only from occurrence words ("twice" = 2, "3x" = 3, "a couple" = 2); "every day" = 1 per day; nothing said = 1.
2. **Period and interval** — "every other day" = `FREQ=DAILY;INTERVAL=2`, "once a fortnight" = `FREQ=WEEKLY;INTERVAL=2`, "quarterly" = `FREQ=MONTHLY;INTERVAL=3`. No period in the words → null (correct). A stated period past the cap (more than 30 days, 12 weeks, 12 months) → null (dropped by code; the model should still have written what was said).
3. **Units (Trent, 10-22)** — a quota counts TIMES. A measured amount of one doing stays in the title with a count of 1 per period ("100 pushups a day" → "100 pushups", 1). Separate occasions are the count ("8 glasses of water a day" → 8). A target equal to the amount ("100", "20" for minutes) is a failure.
4. **No task priming** — the model should not answer with a task rule (`model_answer.rrule` with BYDAY) or a due date. A fallback the code caught is a minor deduction, not a failure, when the stored plan is right.
5. **Title** — the thing itself in the user's words, count/period/reminder words removed, no invented verb on a bare noun, everything else kept ("for the kids").
6. **Reminder period** — only when the user said when; the time word maps to the user's window ("evening" = their Evening). Unsaid → null; a period picked from the topic is a failure. "Don't remind me" → `prompt_enabled` false.
7. **Labels** — explicit only, at most one; none inferred from the topic.
8. **Nothing lost** — named days and other details the title cannot carry go to notes.

---

## Process Evaluation Criteria (2026-10-10)

### Project recommendations (`process_projects`)

- One entry per task, `project_id` from the given list or null — never an invented id, never the Inbox.
- A project only when the task clearly fits (description first, then name, then user context). Two equal fits or none → null. A confident wrong pick is worse than null.
- Descriptions outweigh names; user context resolves people ("Dana" → Family when context says Dana is the wife).
- Reasons: one short sentence naming what matched. No lecturing.

### Duplicates (`process_duplicates`)

- Groups only tasks that are the same piece of work in different words.
- Related-but-different work (buy paint / paint the fence; call mom / visit mom; email Sam / email Jordan; rent / electric bill) must NOT be grouped.
- Conservative: an empty `groups` is a correct answer for a list without duplicates. Any false group is a failure.
- Reasons short and specific.

---

## Scoring Scale

| Score | Description                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------ |
| 9-10  | **Excellent** — Would genuinely help the user. All criteria met, output feels natural and correct.           |
| 7-8   | **Good** — Minor imperfections, fully usable. Maybe a label is slightly off or a date is 1 hour off.         |
| 5-6   | **Mediocre** — Technically valid but not helpful. Missing obvious extractions or including unnecessary ones. |
| 3-4   | **Poor** — Noticeable issues. Wrong priority, missed obvious date, hallucinated data.                        |
| 1-2   | **Bad** — Wrong extractions, missed obvious signals, confusing output.                                       |
| 0     | **Complete failure** — JSON invalid, required fields missing, total misunderstanding.                        |

**Pass threshold: score >= 6**

---

## Output Format

For each scenario's `validation.md`, use this structure:

```markdown
# Validation: {scenario-id}

## Score: {0-10}

## Pass: {yes/no}

## Accept: {yes/no} (would a user be satisfied?)

## Criteria Results

| Criterion    | Pass   | Notes        |
| ------------ | ------ | ------------ |
| {criterion1} | yes/no | {brief note} |
| {criterion2} | yes/no | {brief note} |
| ...          | ...    | ...          |

## Reasoning

{2-4 sentences explaining the overall judgment. Reference specific field values.}
```

For the `layer2-summary.md`, use:

```markdown
# Layer 2 Quality Summary

**Run:** {timestamp}
**Model:** {model}
**Scenarios:** {passed}/{total} passed

## Results by Feature

### Enrichment

| Scenario | Score | Pass | Key Finding |
| -------- | ----- | ---- | ----------- |
| ...      | ...   | ...  | ...         |

### What's Next

| Scenario | Score | Pass | Key Finding |
| -------- | ----- | ---- | ----------- |
| ...      | ...   | ...  | ...         |

### Quick Take

| Scenario | Score | Pass | Key Finding |
| -------- | ----- | ---- | ----------- |
| ...      | ...   | ...  | ...         |

### Insights

| Scenario | Score | Pass | Key Finding |
| -------- | ----- | ---- | ----------- |
| ...      | ...   | ...  | ...         |

## Prompt Improvement Opportunities

{List any patterns where prompts could be improved, based on scoring trends.}

## Overall Assessment

{2-3 sentences on the overall quality of the AI outputs.}
```
