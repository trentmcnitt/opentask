# Task Model & Due Date Philosophy

Complete reference for the OpenTask task data model and due date semantics. The main `AGENTS.md` has a brief summary; this file has the full details.

## Due Date Philosophy

OpenTask is not a traditional task manager. Due dates for most tasks are **reminders, not deadlines**. Understanding that distinction is critical for interpreting task data correctly, especially in AI features. See `docs/DESIGN.md` for the full rationale.

**Priority determines whether a due date is a deadline or a reminder:**

- **Priority 0-1 (Unset/Low):** `due_at` means "remind me at this time." These tasks are eligible for bulk snooze. Being "overdue" just means `due_at` has passed — for low-priority tasks it's the normal state, not a problem.
- **Priority 2 (Medium):** `due_at` is a reminder. Eligible for bulk snooze. Being overdue has low significance.
- **Priority 3 (High):** `due_at` is a deadline, but these tasks are still eligible for bulk snooze. Being overdue is significant.
- **Priority 4 (Urgent):** `due_at` is a hard deadline. Urgent tasks are never bulk-snoozed — they must be snoozed individually, so every due date change is a deliberate decision. Being overdue is always significant. `URGENT_PRIORITY = 4` in `src/lib/priority.ts`.

| Priority        | Due date means | Bulk snooze | "Overdue" significance |
| --------------- | -------------- | ----------- | ---------------------- |
| 0-1 (Unset/Low) | Reminder       | Eligible    | Normal — not a problem |
| 2 (Medium)      | Reminder       | Eligible    | Low                    |
| 3 (High)        | Deadline       | Eligible    | Significant            |
| 4 (Urgent)      | Hard deadline  | Never       | Critical               |

**Bulk snooze:** One pass — all overdue P0-P3 tasks are snoozed, P4 (Urgent) is always excluded. No tiers, no multi-click flow.

**Implications for code and AI:**

- `created_at` is the most reliable age signal — it never changes. Use it over `due_at` for understanding how long a task has existed.
- The gap between `original_due_at` and `due_at` shows how much total time the due date has shifted, but not how many snoozes occurred or why. Don't infer snooze counts or user intent from dates alone.
- `snooze_count` is a lifetime stat incremented on every snooze (including bulk). High counts are normal, not a sign of avoidance.
- For P0-3 tasks, avoid language like "deferred three times" (implies conscious decisions). Prefer factual framing: "has been on your list for 3 weeks."

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

## Completion Behavior

- **Recurring tasks** advance in place: completing a daily task moves `due_at` forward and leaves `done=0`
- **One-off (non-recurring) tasks**: when completed, the app sets `done=1` and `archived_at` to the current time

## Snooze

Snooze sets `due_at` to a new value without modifying recurrence. For recurring tasks, the original schedule is preserved: a daily 9:00 AM task snoozed to noon and then completed will still regenerate as due at 9:00 AM tomorrow.

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
  action: UndoAction, // 'done' | 'undone' | 'snooze' | 'edit' | 'delete' | 'create' | 'restore' | 'bulk_done' | 'bulk_snooze' | 'bulk_edit' | 'bulk_delete'
  description: string | null,
  fieldsChanged: string[],
  snapshots: UndoSnapshot[],
): number
```

- `createTaskSnapshot(beforeTask, afterTask, fieldsChanged, completionId?)` — build an `UndoSnapshot`. See [Critical Requirements](../AGENTS.md#every-mutation-must-be-atomic-and-logged-for-undo) for usage details and the `completionId` pattern.
- `executeUndo(userId)` — restores the task to `before_state` from the most recent undoable action
- `executeRedo(userId)` — re-applies `after_state` from the most recent undone action

Undo history is per-user and works as a stack (last action undone first).

## Task Access

`canUserAccessTask(userId, task)` from `@/core/tasks` — returns `true` if the user owns the task or it's in a shared project. Use this in route handlers that need to verify access.
