# OpenTask Design Philosophy

This document explains how OpenTask works in practice — the behavioral patterns that emerge from its design, and why. Understanding this is essential for building features that feel right, especially AI features that interpret task data.

## Origin

OpenTask evolved from the [Due](https://www.dueapp.com/) app, a reminders app with aggressive snooze-based workflow. The key insight from Due: when you have a lot of tasks, managing the task manager becomes its own task. Setting precise due dates for everything is overhead that doesn't pay off for most items. What works is a system where you set an _intended_ time, get reminded, and quickly defer anything that isn't happening right now.

OpenTask carries this forward as a core design principle.

## Deadline, Target, Horizon

Until 2026-10-10 a task had one date, and priority decided what it meant: a reminder for P0-2, a deadline for P3 and P4. That broke down in daily use. On 10-10, 25 tasks sat "overdue", bulk-snoozed 12-14 times a day, and 123 of 136 one-off tasks were finished after their date. Trent: "I have 25 overdue things, and I'm really not overdue on 25 things. Technically, I'm not late on anything." The one date was carrying real deadlines, the times he wanted to start, AI placeholders and pure awareness, and the real deadlines that weekend lived only in task notes: "I genuinely don't know what should be done this weekend… It's the definition of this thing failing as a task manager."

The verdict was about the system, not the habits: "I don't want to think of snoozing as something I shouldn't be doing." So a task now answers three questions separately. `docs/TASK-MODEL.md` § Deadline, target, horizon has the rules.

- **Target** (`due_at`, API `target_at`): when nagging starts. Soft; snoozing it is normal and expected.
- **Deadline** (`deadline_at`): the real cutoff. A snooze never moves it, and a snooze can't cross it while it is still ahead without the user saying so.
- **Horizon** (days / weeks / months / eventually): how soon he'd like it done. "The speed at which I'd like to get it taken care of, with no target date."
- **Priority**: unchanged, what missing it costs. "Priority and due are separate. A low-priority meal voucher that expires on the 11th expires on the 11th."

A task with no target, or one whose target hasn't arrived, isn't nagged. It shows in its horizon's **task segment** on the reminders screen, at that horizon's clip, because "out of sight, out of mind" is the real failure for the squeaky-door kind of task. Once its target arrives it is **over target** (the old "overdue") and the nagging starts. Never both.

### The bulk snooze button

The bulk snooze button sits in the app's top bar — the only action button visible at all times — and snoozes every over-target P0-2 task by one hour (or a user-configured interval) with a single tap. P3 (High) tasks sit out that first pass but are not exempt: once nothing lower is left to sweep, the next tap takes them, so a day that is nothing but High tasks still clears in two taps. P4 (Urgent) is never bulk-snoozed and must be snoozed individually. A task whose snooze would cross a deadline that is still ahead stays put at any priority, and the result says so.

A single task might be snoozed many times in one day and still get completed that same day. This is normal, expected behavior — not a sign of procrastination. What the redesign changes is what a snooze can hide: it moves the target, never the deadline, and the target-age badge keeps counting from the first target, so a task snoozed for a week reads "7d" in red instead of looking fresh.

## What This Means for Feature Design

### Interpreting task data

- **The target (`due_at`)**: "when to start nagging," not a deadline, at any priority. Snoozes change it constantly.
- **`deadline_at`**: the real cutoff. Changes are deliberate. A passed deadline is significant at any priority.
- **`horizon`**: the user's stated pace. `null` means unset, treated as weeks but never reported as stated.
- **`original_due_at`**: the first-target date. A snooze keeps it, a deliberate re-target restarts it. The gap to `due_at` shows how far the target has drifted, not how many snoozes or why.
- **`snooze_count`**: lifetime count of snoozes (incremented on every snooze including bulk). High counts are normal and don't indicate avoidance.
- **`created_at`**: the most reliable signal of task age. It never changes.

### AI features

- **Don't treat "over target" as late.** It means the target has passed and the user is being reminded until they snooze, re-target or complete it. Lateness is about `deadline_at`.
- **Never infer a deadline from priority or a target**, and never guess one: an AI-guessed deadline caps snoozing. Enrichment sets a deadline only from an outside date stated in the wording, and a horizon only from explicit pace wording.
- **Use `created_at` as the primary age signal.** It's the one date snoozing can't muddy.
- **Don't infer snooze count or deferral count from dates.**
- **Don't use language that implies intentional deferral for P0-3.** "Deferred three times" implies conscious decisions; "has been on your list for 3 weeks" is factually grounded.

### UI features

- Over-target marks for P0-3 should be subtle; the target-age badge carries how stale a target is (gray, then amber at 3 days, red at 7)
- A passed deadline gets its own marker on the row, at any priority
- The bulk snooze button must remain fast and frictionless — it's used dozens of times per day
- Task segments must keep the reminders screen's bite-size, finishable feel: they never count in its badge or its notifications, and its headline counts them apart from the reminders ("75 reminders · 84 tasks considered", 2026-10-26)

## Snooze Mechanics (Technical)

For the full technical specification of snooze behavior, see the Snooze System section of `docs/SPEC.md`. Key points relevant to this document:

- First snooze saves `due_at` to `original_due_at`; subsequent snoozes preserve the existing `original_due_at`
- `snooze_count` is incremented on every snooze (including bulk) and never reset — it's a lifetime stat
- A bare PATCH to `due_at` is tracked as a snooze; a deliberate re-target (`retarget: true`) restarts `original_due_at` instead (`docs/TASK-MODEL.md` § Snooze)
- Completing a snoozed recurring task computes next occurrence from the RRULE, not the snoozed `due_at`
- `original_due_at` is cleared when a recurring task advances (the new due date becomes the new baseline)
