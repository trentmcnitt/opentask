/**
 * The question every Reminders surface asks the server (`GET /api/reminders`).
 *
 * The web shows the task queue's panels (task-queue PR 3), so it opts in to
 * them (`?queue=1`); without it the server leaves queued tasks out of
 * `task_segments` altogether, for native builds that predate the queue.
 * It draws a future deck's Upcoming row ("On deck Sat Oct 24", On deck D2)
 * too (`?deck=1`); without it a decked task is left out of Upcoming.
 * And it keeps each segment's "N of M" fixed for the day (`?handled=1`, the
 * day roster, 2026-10-22): rows decked, targeted or done today come back as
 * considered rows with `segment_left` (src/core/tasks/segment-roster.ts).
 * And it draws the DEADLINES page (`?deadlines=1`, 2026-10-22): a deadline
 * task with no target from its lead day, with `safety_net` and `seen` on each
 * row, quiet before its lead day (rule 3, 2026-10-25) — without it (and with
 * the task queue on) such a task would fall back into its horizon segment.
 * And it shows EVERY segment, every day, in fixed positions (`?fill=1`,
 * Trent 2026-10-24): an empty one comes back with no rows and reads as done
 * ("Nothing today ✓").
 *
 * The native apps ask the SAME question (native PR E, 2026-10-26:
 * `APIClient.remindersPath`). A leaf module, so the contract-fixture writer
 * (`tests/integration/contract-fixtures.test.ts`) can import it without the
 * hook's React and browser dependencies: it writes this string into
 * `tests/fixtures/contract/reminders-query.json`, and the Swift
 * `ContractDecodeTests` asserts the native path equals it — the drift guard.
 */
export const REMINDERS_URL = '/api/reminders?queue=1&deck=1&handled=1&deadlines=1&fill=1'
