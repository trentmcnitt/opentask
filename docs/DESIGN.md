# OpenTask Design Philosophy

This document explains how OpenTask works in practice — the behavioral patterns that emerge from its design, and why. Understanding this is essential for building features that feel right, especially AI features that interpret task data.

## Origin

OpenTask evolved from the [Due](https://www.dueapp.com/) app, a reminders app with aggressive snooze-based workflow. The key insight from Due: when you have a lot of tasks, managing the task manager becomes its own task. Setting precise due dates for everything is overhead that doesn't pay off for most items. What works is a system where you set an _intended_ time, get reminded, and quickly defer anything that isn't happening right now.

OpenTask carries this forward as a core design principle.

## The Two-Tier Due Date System

Due dates in OpenTask serve two different purposes depending on task priority. This is the single most important behavioral distinction in the app.

### Priority 0-2 (Unset, Low, Medium): Due dates as reminders

For most tasks, `due_at` means "when to next remind me about this." It's aspirational — the time the user intends to do it — but it's not a commitment. These tasks are bulk-snoozed routinely, often many times per day.

**The bulk snooze button** is the primary driver of this behavior. It sits in the app's top bar — the only action button visible at all times — and snoozes every overdue P0-2 task by one hour (or a user-configured interval) with a single tap. The server always skips P3-4 tasks during bulk snooze; they must be snoozed individually.

A typical daily pattern:

1. User wakes up with 15 overdue tasks from yesterday
2. Taps the bulk snooze button — all P0-2 tasks move forward one hour
3. Works on a few tasks, completes them
4. An hour later, the remaining tasks become overdue again
5. Taps bulk snooze again
6. Repeats throughout the day

A single task might be snoozed multiple times in one day and still get completed that same day. This is normal, expected behavior — not a sign of procrastination.

**What this means for `due_at`:** For P0-2 tasks, `due_at` changes constantly and carries no signal about user intent. A task being "overdue" simply means its `due_at` has passed — the user is being notified and will either snooze it again or complete it. The gap between `original_due_at` and `due_at` tells you the task has drifted from its original intended date, but nothing about how or why — it could be one deliberate postponement or hundreds of bulk snoozes from the daily snooze-all routine.

### Priority 3-4 (High, Urgent): Due dates as deadlines

High and Urgent tasks are exempt from bulk snooze. Every change to their `due_at` requires an individual, conscious action — the user opens the task, chooses a new time, and confirms. This makes due date changes for P3-4 tasks meaningful. If a P3 task's `original_due_at` differs from its `due_at`, someone deliberately moved it.

These tasks represent real commitments with real consequences: tax deadlines, filing windows, appointments. Being overdue on a P3-4 task is significant.

### The dividing line

The `HIGH_PRIORITY_THRESHOLD` constant (value: 3) is the boundary. Everything below it participates in bulk snooze; everything at or above it is protected from it. This single constant defines the behavioral split between "reminder" and "deadline."

## What This Means for Feature Design

### Interpreting task data

- **`due_at` for P0-2**: Treat as "next notification time," not "deadline." Changes are noise.
- **`due_at` for P3-4**: Treat as a real deadline. Changes are meaningful.
- **`original_due_at`**: The `due_at` before the first snooze. Preserved across re-snoozes. Useful for understanding how far a task has drifted from its original intent, but the gap doesn't tell you how many times it was snoozed or whether the snoozes were deliberate.
- **`snooze_count`**: Lifetime count of snoozes (incremented on every snooze including bulk). Because of bulk snooze frequency, high counts are normal and don't indicate avoidance.
- **`created_at`**: The most reliable signal of task age. Unlike `due_at`, it never changes.

### AI features

AI features that analyze tasks must understand this behavioral model. Key principles:

- **Don't treat P0-2 "overdue" as meaningful.** It just means `due_at` has passed and the user is being reminded periodically until they snooze or complete it.
- **Do treat P3-4 "overdue" as meaningful.** The deadline has passed.
- **Use `created_at` as the primary age signal.** It's the one date that can't be muddied by snoozing.
- **Don't infer snooze count or deferral count from dates.** The gap between `original_due_at` and `due_at` shows total drift but not the path taken.
- **Don't use language that implies intentional deferral for P0-2.** "Deferred three times" implies conscious decisions; "has been on your list for 3 weeks" is factually grounded.

### UI features

- Overdue badges for P0-2 should be subtle — being overdue is the normal state
- Overdue badges for P3-4 should be prominent — a missed deadline needs attention
- The bulk snooze button must remain fast and frictionless — it's used dozens of times per day

## Snooze Mechanics (Technical)

For the full technical specification of snooze behavior, see the Snooze System section of `docs/SPEC.md`. Key points relevant to this document:

- First snooze saves `due_at` to `original_due_at`; subsequent snoozes preserve the existing `original_due_at`
- `snooze_count` is incremented on every snooze (including bulk) and never reset — it's a lifetime stat
- Any PATCH to `due_at` (even a manual edit) is tracked as a snooze
- Completing a snoozed recurring task computes next occurrence from the RRULE, not the snoozed `due_at`
- `original_due_at` is cleared when a recurring task advances (the new due date becomes the new baseline)
