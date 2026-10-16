/**
 * Where a quota's progress was logged from — `progress_events.source`
 * (2026-10-16).
 *
 * A client says which surface it is when it logs (`source` on
 * `POST /api/tasks/:id/progress` and on the quota-prompt did/restore routes);
 * anything that does not say is `api` — scripts, automations, and the native
 * builds shipped before this field existed, which keep working unchanged.
 * `undo` and `redo` are never sent: the server writes them itself, as the
 * compensating row an undo or redo of a count leaves (`undoEntry` /
 * `redoEntry`), so the events always sum to the count actually logged.
 */
export const CLIENT_PROGRESS_SOURCES = ['web', 'widget', 'watch', 'mac', 'api'] as const

export type ClientProgressSource = (typeof CLIENT_PROGRESS_SOURCES)[number]

/**
 * Every value a stored event can hold. `unknown` marks the events logged
 * before sources were recorded (the migration that added the column sets it,
 * src/core/db/index.ts); no client sends it.
 */
export type ProgressSource = ClientProgressSource | 'undo' | 'redo' | 'unknown'

/** What an event says when the caller did not. */
export const DEFAULT_PROGRESS_SOURCE: ClientProgressSource = 'api'
