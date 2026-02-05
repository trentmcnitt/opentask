# Toast Message System Design

## Goal

Give users confidence that actions, undos, and redos are affecting the right task with the right changes. Not verbose for its own sake — just enough information that the user never has to wonder "wait, did that change the wrong thing?"

## Design Decisions

### 1. Task name appears in every toast

**Decision: Always include the task title, even on the task detail page.**

Rationale:

- On the dashboard, the QuickActionPanel modal closes before the toast appears, removing the visual context of which task was edited.
- On the task detail page, it is mildly redundant but harmless, and provides a safety net (the user may have had multiple tabs open, or switched tasks quickly).
- Consistency between action toasts and undo toasts is the primary benefit. When the action toast says `Priority set to High — "Buy groceries"` and the undo toast says `Undid: Priority set to High — "Buy groceries"`, the user instantly recognizes the match.

The one exception is **bulk operations**, where listing individual task names is impractical. Bulk toasts use a count instead.

### 2. Toast layout: single line, natural wrapping

**Decision: Use a single string with natural text wrapping. No multi-line Sonner `title`/`description` split.**

The message is a plain text string. On mobile (375px), most messages fit in 1-2 lines. The Undo/Redo action button sits to the right. Sonner handles wrapping gracefully.

Rationale:

- Simpler implementation (no changes to the `showToast` interface)
- Two-line Sonner `title`+`description` would require the server to return structured data (action text and task title separately), adding complexity for marginal visual benefit
- If we want to upgrade to two-line layout later, the content decisions in this doc still apply — only the rendering changes

### 3. Em dash separator for edit operations

**Decision: Use `—` (em dash with spaces) to separate the action description from the task title in edit operations.**

This solves the "double on" problem where recurrence descriptions contain "on" and the task suffix also uses "on":

- Before: `Set recurrence to Weekly on Mon on "Task"` (awkward)
- After: `Recurrence set to Weekly on Mon — "Task"` (clean)

Two formatting patterns based on verb type:

**Edit operations** (action description is a self-contained phrase):

```
{description} — "{task_title}"
```

Examples:

- `Priority set to High — "Buy groceries"`
- `Snoozed to Mon 9:00 AM (+2d) — "Buy groceries"`
- `Recurrence set to Weekly on Mon — "Buy groceries"`

**Object operations** (task is the direct object of the verb):

```
{verb} "{task_title}"
```

Examples:

- `Completed "Buy groceries"`
- `Deleted "Buy groceries"`
- `Created "Buy groceries"`

**Rename** (task names ARE the content):

```
Renamed "{old_title}" → "{new_title}"
```

### 5. Bulk operation format

**Decision: Include action type, count, and key detail. No individual task names.**

The count plus action type gives enough context to differentiate bulk operations in the undo stack. Adding the key detail (snooze target, project name, field names) confirms the user is undoing the right batch.

### 6. "Undid:" / "Redid:" prefix

**Decision: Keep the current prefix style.**

"Undid:" reads naturally in English and clearly communicates past tense ("this thing was un-done"). "Redid:" is the natural counterpart. No icons, no visual treatment changes — the prefix text is sufficient to distinguish undo/redo toasts from action toasts.

### 7. Action toast = undo description (same string)

**Decision: The action toast message and the stored undo description should be the exact same string.**

When the user sees `Priority set to High — "Buy groceries"` as the action toast, and later undoes and sees `Undid: Priority set to High — "Buy groceries"`, the recognition is immediate. This is the core design principle that makes the whole system feel trustworthy.

Implementation note: to achieve this, the server should generate the description and return it in the mutation response. The client uses it directly for the action toast, and the server stores the same string in `undo_log.description`. This replaces the current split where `formatChangesToast` (client-side) and `formatEditDescription` (server-side) generate different strings.

---

## Title Truncation

### General rule (task identification in toasts)

Truncate titles longer than 20 characters. Show the first 17 characters followed by `...`.

| Title                                  | Displayed                                 |
| -------------------------------------- | ----------------------------------------- |
| `Buy groceries`                        | `Buy groceries` (14 chars, no truncation) |
| `Send quarterly report to marketing`   | `Send quarterly re...`                    |
| `Gym`                                  | `Gym`                                     |
| `Review Q4 budget spreadsheet updates` | `Review Q4 budget ...`                    |

### Rename rule (showing old and new titles)

Truncate titles longer than 16 characters. Show the first 13 characters followed by `...`.

| Rename                                                               | Displayed                                         |
| -------------------------------------------------------------------- | ------------------------------------------------- |
| `Buy Groceries` → `Buy Food`                                         | `Renamed "Buy Groceries" → "Buy Food"`            |
| `Send quarterly report to team` → `Send quarterly report for review` | `Renamed "Send quarterl..." → "Send quarterl..."` |

### Implementation

```ts
function truncateTitle(title: string, maxLength: number = 20): string {
  if (title.length <= maxLength) return title
  return title.slice(0, maxLength - 3) + '...'
}
```

---

## Complete Format Specification

### Single-Field Changes

#### Priority

| Scenario              | Toast / Description               |
| --------------------- | --------------------------------- |
| None (0) → High (3)   | `Priority set to High — "Task"`   |
| Medium (2) → High (3) | `Priority Medium → High — "Task"` |
| High (3) → None (0)   | `Priority cleared — "Task"`       |

Rules:

- From None: `set to {label}`
- Between values: `{from} → {to}`
- To None: `cleared`

#### Due Date (non-snooze: task had no previous due_at)

| Scenario    | Toast / Description                 |
| ----------- | ----------------------------------- |
| null → date | `Due date set to Mon 9 AM — "Task"` |
| date → null | `Due date cleared — "Task"`         |

Date formatting uses the relative format from `formatSnoozeTarget`:

- Same day: `5:00 PM`
- Tomorrow: `tomorrow 9:00 AM`
- Within 7 days: `Mon 9:00 AM`
- Beyond 7 days: `Jan 15 9:00 AM`

#### Snooze (task had existing due_at, new due_at set)

| Scenario           | Toast / Description                     |
| ------------------ | --------------------------------------- |
| date → future date | `Snoozed to Mon 9:00 AM (+2d) — "Task"` |

The delta in parentheses uses `formatDurationDelta`: `+30m`, `+2h`, `+1d`, `+1w`, etc.

#### Recurrence

| Scenario          | Toast / Description                        |
| ----------------- | ------------------------------------------ |
| null → value      | `Recurrence set to Daily at 9 AM — "Task"` |
| value → new value | `Recurrence set to Weekly on Mon — "Task"` |
| value → null      | `Recurrence cleared — "Task"`              |

Recurrence detail uses `formatRRuleCompact` for the human-readable summary.

Rules:

- Set or changed: `set to {compact_rrule}` (same wording for initial set and change — no need to distinguish)
- Cleared: `cleared`

#### Project

| Scenario   | Toast / Description                |
| ---------- | ---------------------------------- |
| Any change | `Moved to {project_name} — "Task"` |

#### Title

| Scenario | Toast / Description                     |
| -------- | --------------------------------------- |
| Changed  | `Renamed "{old_title}" → "{new_title}"` |

No em dash or additional task name — the titles themselves are the identifying content. Uses the rename truncation rule (13 chars + `...` for titles over 16 chars).

#### Labels

| Scenario   | Toast / Description       |
| ---------- | ------------------------- |
| Any change | `Labels updated — "Task"` |

Label changes can be complex (add/remove multiple labels). Detailed label diffs are not shown in toasts — "Labels updated" is sufficient for recognition.

#### Notes

| Scenario | Toast / Description      |
| -------- | ------------------------ |
| Changed  | `Notes updated — "Task"` |

Note content is too long for a toast message.

---

### Two-Field Changes

Join both field descriptions with a comma. Task name at the end after em dash.

| Fields                | Toast / Description                                                  |
| --------------------- | -------------------------------------------------------------------- |
| Priority + due date   | `Priority set to High, due date set to Mon 9 AM — "Task"`            |
| Snooze + priority     | `Snoozed to Mon 9:00 AM (+2d), priority set to High — "Task"`        |
| Priority + recurrence | `Priority Medium → High, recurrence set to Daily at 9 AM — "Task"`   |
| Priority + notes      | `Priority set to High, notes updated — "Task"`                       |
| Due date + recurrence | `Due date set to Mon 9 AM, recurrence set to Daily at 9 AM — "Task"` |
| Project + priority    | `Moved to Work, priority set to High — "Task"`                       |

**Ordering rule for two fields**: When snooze is present, it comes first. Otherwise, use the order: priority, due date, recurrence, project, title, labels, notes. This matches the visual layout of QuickActionPanel (priority and due date are the most prominent controls).

---

### Three or More Fields

Use comma-separated field names without values. Task name at the end after em dash.

| Fields                           | Toast / Description                                           |
| -------------------------------- | ------------------------------------------------------------- |
| Priority + due date + recurrence | `Updated priority, due date, and recurrence — "Task"`         |
| Priority + labels + notes        | `Updated priority, labels, and notes — "Task"`                |
| 4+ fields                        | `Updated priority, due date, recurrence, and labels — "Task"` |

The Oxford comma is used for 3+ items.

---

### Object Operations (Done, Delete, Create, Restore)

These use the task name as a direct object (no em dash).

| Operation            | Toast / Description        |
| -------------------- | -------------------------- |
| Complete (one-off)   | `Completed "Task"`         |
| Complete (recurring) | `Advanced "Task"`          |
| Delete (soft)        | `Deleted "Task"`           |
| Restore from trash   | `Restored "Task"`          |
| Create               | `Created "Task"`           |
| Clear snooze         | `Cleared snooze on "Task"` |

---

### Bulk Operations

No individual task names. Count + action type + key detail.

| Operation              | Toast / Description                          |
| ---------------------- | -------------------------------------------- |
| Bulk done              | `Completed {n} tasks`                        |
| Bulk snooze (absolute) | `Snoozed {n} tasks to Mon 9:00 AM`           |
| Bulk snooze (relative) | `Snoozed {n} tasks (+1h)`                    |
| Bulk delete            | `Deleted {n} tasks`                          |
| Bulk move              | `Moved {n} tasks to {project}`               |
| Bulk edit (1 field)    | `Updated priority on {n} tasks`              |
| Bulk edit (2 fields)   | `Updated priority and due date on {n} tasks` |
| Bulk edit (3+ fields)  | `Updated {m} fields on {n} tasks`            |

---

### Undo / Redo Toasts

The undo and redo toasts prepend "Undid: " or "Redid: " to the stored description.

| User action               | Toast message                                           |
| ------------------------- | ------------------------------------------------------- |
| Undo a priority change    | `Undid: Priority set to High — "Buy groceries"`         |
| Redo that priority change | `Redid: Priority set to High — "Buy groceries"`         |
| Undo a snooze             | `Undid: Snoozed to Mon 9:00 AM (+2d) — "Buy groceries"` |
| Undo a completion         | `Undid: Completed "Buy groceries"`                      |
| Undo a bulk done          | `Undid: Completed 5 tasks`                              |
| Undo a bulk move          | `Undid: Moved 5 tasks to Work`                          |
| Nothing to undo           | `Nothing to undo`                                       |
| Nothing to redo           | `Nothing to redo`                                       |

---

## Implementation Architecture

### Current state (two formatting paths)

```
Action toast:  client changes → formatChangesToast() → "Priority updated"
Undo description: server-side   → formatEditDescription() → 'Priority Medium → High on "Buy groceries"'
```

These are generated independently, producing different strings.

### Target state (single formatting path)

```
User saves → server generates description → returns in response → client uses for action toast
                                          → stored in undo_log.description
User undoes → server returns stored description → client prepends "Undid: "
```

Changes required:

1. **Server**: `formatEditDescription` already generates rich descriptions. Enhance it to match the new format spec (em dash separator, all field detail patterns).
2. **Server**: Return `description` field in PATCH/POST mutation responses.
3. **Client**: Replace `formatChangesToast(changes)` with the `description` from the server response.
4. **Client**: No changes to `showToast` interface (still a plain string + optional action button).

### Formatting functions to modify

| Function                         | File                          | Change                                                              |
| -------------------------------- | ----------------------------- | ------------------------------------------------------------------- |
| `formatEditDescription`          | `src/lib/field-labels.ts`     | Update to new format (em dash, all field patterns, truncated title) |
| `formatBulkEditDescription`      | `src/lib/field-labels.ts`     | Minor wording updates                                               |
| `formatChangesToast`             | `src/lib/format-toast.ts`     | Deprecate; client reads description from server response instead    |
| `buildPriorityFragment`          | `src/lib/field-labels.ts`     | Update for set/cleared patterns                                     |
| Bulk operation `logAction` calls | `src/core/tasks/bulk.ts`      | Enrich descriptions (snooze target, project name)                   |
| `markTaskDone` logAction         | `src/core/tasks/mark-done.ts` | Use `Completed` / `Advanced` wording                                |

### New helper: `truncateTitle`

```ts
// src/lib/format-toast.ts or src/lib/field-labels.ts
function truncateTitle(title: string, maxLength: number = 20): string {
  if (title.length <= maxLength) return title
  return title.slice(0, maxLength - 3) + '...'
}
```

---

## Edge Cases

1. **Snooze vs due date set**: Distinguish using the `isSnoozeScenario` flag from `collectFieldChanges`. If the task had an existing `due_at` and the new value is different, it is a snooze. If `due_at` was null, it is a due date set.

2. **Recurrence change also changes due_at and anchor fields**: The `FIELD_LABELS` map already excludes `anchor_*` and `snooze_count`. The toast should only mention `recurrence`, not the derived fields. The `fieldsChanged` array includes all fields for undo correctness, but `formatEditDescription` filters to user-facing fields only.

3. **Priority 0 ("None") is a clear, not a set**: When priority changes to 0, use "cleared" instead of "set to None". When priority changes FROM 0, use "set to {label}" instead of "None → {label}".

4. **Task title at the limit**: A 20-character title is NOT truncated (the rule is "longer than 20"). A 21-character title becomes 17 chars + "..." = 20 chars.

5. **Empty redo stack after new action**: When the user performs a new action after undoing, the redo stack is cleared. This is existing behavior (`logAction` deletes undone entries). The "Nothing to redo" message will appear if they try to redo.

6. **Toast auto-dismiss timing**: Consider increasing the Sonner duration from the default (4s) to 5s for undo/redo toasts, since users need time to read the description AND decide whether to click the Redo/Undo button. This is an implementation detail, not a format decision.

7. **Rename where old and new titles are very similar**: If the user changes "Buy groceries" to "Buy Groceries" (just capitalization), the toast `Renamed "Buy groceries" → "Buy Groceries"` correctly shows the subtle difference. No special handling needed.

8. **Bulk operations with mixed results**: If a bulk edit changes priority on 5 tasks but 2 already had the target priority, the description says "Updated priority on 3 tasks" (using `snapshots.length`, which only counts tasks that actually changed).

---

## Future Enhancements (not in scope)

- **Two-line toast layout**: Use Sonner's `title`+`description` props to show the action on line 1 (bold) and the task name on line 2 (muted). Requires structured data from the server.
- **Label detail in toasts**: Show "Added 'urgent' label" or "Removed 'low-priority' label" instead of generic "Labels updated."
- **Undo history panel**: A slide-out panel showing the last N actions with undo buttons on each. For power users who want to undo something other than the most recent action.
