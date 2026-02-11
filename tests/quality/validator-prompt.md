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

### 10. Meta Notes Quality

- Were reference numbers preserved exactly? (phone numbers, case numbers, Rx numbers, confirmation codes)
- Were addresses and specific details captured? (street addresses, suite numbers, extensions)
- Was context that doesn't belong in the title separated into meta_notes? (instructions, amounts, reference info)
- Was `null` returned when there was nothing extra to capture? ("buy milk" has no meta_notes)
- Was information NOT duplicated? (if "Walgreens" is in the title, it shouldn't be repeated in meta_notes)

### 11. Critical Label Usage

- Was the "critical" label applied only for explicit "critical" or "critical alert" language?
- Was emotional urgency ("really important", "URGENT") NOT treated as a "critical" trigger? (those map to priority, not the critical label)
- Was non-alert usage of the word "critical" correctly ignored? ("critical thinking" is not a critical alert)

---

## Bubble Evaluation Criteria

### 1. Task Selection

- Were overlooked tasks surfaced? (high snooze count, idle without attention, social obligations)
- Were obvious items correctly excluded? (daily recurring affirmations, urgent/high-priority, due today)
- Were time-sensitive items without hard deadlines recognized?
- Were social obligations identified? (calls, thank-you cards, RSVPs)

### 2. Reason Quality

- Are reasons specific and actionable? ("You've snoozed this 7 times" not "This deserves attention")
- Is the tone direct? (like a thoughtful friend, not a nagging app)
- Do reasons reference concrete data from the task? (snooze count, dates, labels)

### 3. Summary Quality

- Is the summary 1-2 sentences?
- Does it capture the key themes across surfaced tasks?
- Is it concise and informative?

### 4. No Hallucination

- Do all `task_id` values exist in the input task list?
- Are no tasks invented or referenced that weren't provided?

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

## Prompt Improvement Opportunities

{List any patterns where prompts could be improved, based on scoring trends.}

## Overall Assessment

{2-3 sentences on the overall quality of the AI outputs.}
```
