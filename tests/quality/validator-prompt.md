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
- Were temporal phrases removed ("tomorrow", "next Tuesday") since they were extracted into `due_at`?
- Were priority phrases removed ("URGENT", "high priority") since they were extracted into `priority`?
- Was the user's voice preserved? ("grab" not changed to "buy", specific phrasing kept)
- Was an already-clean title left unchanged?

### 2. Date Extraction

- Was a relative date correctly interpreted? ("tomorrow" = correct date, "next Tuesday" = correct day)
- Was the timezone conversion to UTC correct? (e.g., 9am Chicago = 15:00 UTC in winter, 14:00 UTC in summer)
- Was `null` returned when no date was mentioned?
- Was the time reasonable for vague references? ("morning" = 8-10am local, "afternoon" = 1-3pm)

### 3. Priority Inference

- Was an explicit priority signal correctly captured? ("URGENT" = 4, "high priority" = 3)
- Was emotional urgency appropriately reflected? ("killing me", "really really need to" = 2-3)
- Was priority left at 0 when there was no signal? (conservative default)
- Was there no over-inference? ("check the mail" should not get priority 2)

### 4. Label Extraction (Explicit Only)

- Are labels empty when the user did NOT explicitly request a label? (This is the most common case — labels should almost always be `[]`)
- When the user explicitly said "label it as X", "tag it X", "add the X label", or "mark it as X", was that label correctly extracted?
- Were NO contextual labels inferred? ("dentist" must NOT produce "medical", "van" must NOT produce "car")
- Critical label exception: "critical" / "critical alert" still triggers the critical label (it's a system alert, not a classification)

### 5. Project Matching

- Was the correct project selected from the available list?
- Was `null` returned when no project was a clear match?

### 6. Recurrence Parsing

- Was the RRULE syntax correct? (FREQ=DAILY, FREQ=WEEKLY;BYDAY=MO)
- Was DTSTART NOT included? (the prompt explicitly forbids it)
- Was `null` returned when no recurrence was mentioned?
- Were vague recurrence signals correctly interpreted? ("every morning" = FREQ=DAILY)

### 7. Conservatism

- Were unextracted fields left as null/0/empty?
- Was nothing guessed when uncertain?
- "Better to leave empty than guess wrong" — was this principle followed?

### 8. Auto-Snooze Correctness

- Was `auto_snooze_minutes` parsed to the correct integer value? ("auto-snooze 30 minutes" = 30, "snooze every 2 hours" = 120)
- Was `null` returned when auto-snooze was not mentioned?
- Was `0` returned when the user explicitly disabled auto-snooze? ("no auto-snooze")
- Was auto-snooze not confused with regular snooze behavior? (regular snooze changes `due_at`; auto-snooze is a repeating reminder interval)

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

### 11. Critical Label Usage

- Was the "critical" label applied only for explicit "critical" or "critical alert" language?
- Was emotional urgency ("really important", "URGENT") NOT treated as a "critical" trigger? (those map to priority, not the critical label)
- Was non-alert usage of the word "critical" correctly ignored? ("critical thinking" is not a critical alert)

---

## Bubble Evaluation Criteria

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

- For priority 3-4 overdue tasks: does commentary treat the deadline as real and urgent?
- For priority 0-2 overdue tasks: does commentary focus on age/deferral, NOT hours overdue?
- Are notes referenced when they provide relevant context?
- Is recurrence_mode: from_completion correctly interpreted (overdue = the user hasn't completed the last occurrence)?

### 6. Factual Grounding

- Does the AI only state things derivable from the input data?
- For P0-2 tasks: is commentary based on task age (created_at) rather than due date gap?
- Does the AI avoid fabricated counts ("deferred twice", "snoozed X times")?
- Are notes referenced accurately when present (exact claim numbers, deadlines)?
- Is no narrative fabricated about what happened between two dates?

---

## Review Evaluation Criteria

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
- Is "act_soon" applied only for real consequences (P3-4 deadline, filing window), NOT routine P0-2 overdue?
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

### Bubble

| Scenario | Score | Pass | Key Finding |
| -------- | ----- | ---- | ----------- |
| ...      | ...   | ...  | ...         |

### Review

| Scenario | Score | Pass | Key Finding |
| -------- | ----- | ---- | ----------- |
| ...      | ...   | ...  | ...         |

## Prompt Improvement Opportunities

{List any patterns where prompts could be improved, based on scoring trends.}

## Overall Assessment

{2-3 sentences on the overall quality of the AI outputs.}
```
