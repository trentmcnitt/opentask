/**
 * The one client-side caller of `POST /api/undo` and `POST /api/redo`.
 *
 * Every web surface that undoes or redoes a single action goes through here
 * (`useUndoRedo` for the pages, `useNativeSnoozeToast` for the iOS quick-action
 * toast), so the request body is built in exactly one place.
 *
 * `sessionStartId` scopes the request to the page's session: the server only
 * undoes/redoes actions logged after that `undo_log` id and reports counts for
 * that range. Pass `null` for an unscoped request (the latest action of any
 * age, counts over the whole log) — no body is sent at all then.
 */

export type UndoRedoKind = 'undo' | 'redo'

/** The `data` of a successful undo/redo response. */
export interface UndoRedoResult {
  description: string
  undoable_count?: number
  redoable_count?: number
}

/**
 * Returns the response's `data`, or `null` when the server refused (nothing to
 * undo/redo). A network failure throws, so callers can tell "nothing to do"
 * from "it failed".
 */
export async function postUndoRedo(
  kind: UndoRedoKind,
  sessionStartId: number | null,
): Promise<UndoRedoResult | null> {
  const init: RequestInit = { method: 'POST' }
  if (sessionStartId !== null) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify({ session_start_id: sessionStartId })
  }
  const res = await fetch(`/api/${kind}`, init)
  if (!res.ok) return null
  const json = await res.json()
  return json.data
}
