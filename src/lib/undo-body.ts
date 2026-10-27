/**
 * The optional body of `POST /api/undo` and `POST /api/redo`
 *
 * - `session_start_id` (number): scope the returned counts to entries after
 *   it (the web's session watermark). Any other value is ignored, as always.
 * - `id` (2026-10-26, scoped native Undo): act only on this entry. Absent or
 *   null means the bare undo/redo; any other value that is not a positive
 *   integer is a 400, so a malformed id never falls back to undoing whatever
 *   is newest.
 *
 * No body, or a body that is not JSON, is the bare form with all-time counts.
 */

import type { NextRequest } from 'next/server'

export type UndoBody = { sessionStartId?: number; id?: number } | { error: string }

export async function parseUndoBody(request: NextRequest): Promise<UndoBody> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return {}
  }
  if (body === null || typeof body !== 'object') return {}
  const raw = body as Record<string, unknown>
  const sessionStartId = typeof raw.session_start_id === 'number' ? raw.session_start_id : undefined
  if (raw.id === undefined || raw.id === null) return { sessionStartId }
  if (typeof raw.id !== 'number' || !Number.isInteger(raw.id) || raw.id <= 0) {
    return { error: 'id must be a positive integer' }
  }
  return { sessionStartId, id: raw.id }
}
