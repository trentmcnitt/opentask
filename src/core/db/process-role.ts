/**
 * WHICH PROCESS IS THIS (2026-10-24): the Next.js server, or anything else —
 * a tsx script (`reset-demo-user.ts`, `create-token.ts`, the seeds), a test
 * runner, a build worker.
 *
 * WHY IT MATTERS: `runMigrations()` (src/core/db/index.ts) has data steps that
 * depend on the server-wide task-queue switch (`taskQueueEnabled()`,
 * `OPENTASK_TASK_QUEUE`). The switch is set in the SERVER's environment only;
 * a script opening the same database runs without it and, before this fix,
 * re-ran the switch-OFF steps on every run — storing an automatic target
 * (`target_auto = 1`) on every deadline one-off the deadlines page held,
 * which the server's next start turned back into a lead (prod, 10-24: the
 * 4-hourly demo reset logged `deadlineNoTargetToAuto: 1`). Only the server
 * knows the switch, so only the server runs those steps.
 *
 * THE MARK: `register()` in src/instrumentation.ts calls `markServerProcess()`
 * as its first statement in the Node.js runtime, before any `await`. That is
 * before any database is opened: Next's `prepare()` awaits the instrumentation
 * hook (`ensureInstrumentationRegistered` → `await register()`) before
 * `handleRequest` serves a single request, in `next start`, the standalone
 * `server.js` and `next dev` alike, and the instrumentation module's own
 * top-level imports open nothing. Every other process never calls it.
 *
 * ON `globalThis`, NOT A MODULE VARIABLE: Next compiles instrumentation and the
 * route handlers into separate bundles, so this module may be instantiated
 * more than once in the server process, and `next dev` reloads modules on
 * edit without running `register()` again. `globalThis` is one per process
 * and survives both. Not an environment variable either: that would be
 * inherited by child processes the server spawns.
 *
 * A process that plays the server on a private COPY of a database may mark
 * itself explicitly (`scripts/simulate-days.ts`); tests mark and unmark it
 * around the cases that exercise the server's start.
 */

const SERVER_MARK = Symbol.for('opentask.serverProcess')

type Marked = { [SERVER_MARK]?: boolean }

/** Mark this process as the OpenTask server (instrumentation's `register()`). */
export function markServerProcess(): void {
  ;(globalThis as Marked)[SERVER_MARK] = true
}

/** Tests only: take the mark off again. */
export function unmarkServerProcess(): void {
  delete (globalThis as Marked)[SERVER_MARK]
}

/** Whether this process is the OpenTask server (see the module doc). */
export function isServerProcess(): boolean {
  return (globalThis as Marked)[SERVER_MARK] === true
}
