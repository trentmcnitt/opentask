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

### 4. Label Relevance

- Do the labels match the task content? ("dentist" → "medical", "van" → "car")
- Are labels conservative? (one accurate label > three speculative ones)
- Were no spurious labels added?

### 5. Project Matching

- Was the correct project selected from the available list?
- Was `null` returned when no project was a clear match?
- Was a shopping item matched to a Shopping project when available?

### 6. Recurrence Parsing

- Was the RRULE syntax correct? (FREQ=DAILY, FREQ=WEEKLY;BYDAY=MO)
- Was DTSTART NOT included? (the prompt explicitly forbids it)
- Was `null` returned when no recurrence was mentioned?
- Were vague recurrence signals correctly interpreted? ("every morning" = FREQ=DAILY)

### 7. Conservatism

- Were unextracted fields left as null/0/empty?
- Was nothing guessed when uncertain?
- "Better to leave empty than guess wrong" — was this principle followed?

---

## Bubble Evaluation Criteria

### 1. Task Selection

- Were overlooked tasks surfaced? (high snooze count, idle without attention, social obligations)
- Were obvious items correctly excluded? (daily recurring affirmations, urgent/high-priority, shopping, due today)
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

## Shopping Evaluation Criteria

### 1. Section Accuracy

- Is the correct store section assigned?
- For ambiguous items, is the most common classification used? (chicken broth = pantry, not meat)

### 2. Reasoning Quality

- Is the reasoning brief and logical?
- Does it explain why this section was chosen?

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

### Shopping

| Scenario | Score | Pass | Key Finding |
| -------- | ----- | ---- | ----------- |
| ...      | ...   | ...  | ...         |

## Prompt Improvement Opportunities

{List any patterns where prompts could be improved, based on scoring trends.}

## Overall Assessment

{2-3 sentences on the overall quality of the AI outputs.}
```
