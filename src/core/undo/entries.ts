/**
 * Reading undo_log entries for undo and redo
 *
 * Single and batch undo/redo all load entries the same way: the same columns,
 * the same JSON parsing, and the same stack order. This module owns that, so
 * `executeUndo`, `executeRedo` and the batch functions only decide which
 * entries to take.
 *
 * Stack order: undo walks down from the newest not-undone entry (id DESC);
 * redo walks up from the oldest undone entry (id ASC). Undo marks entries from
 * the top down, so the oldest undone entry is the last one undone and the
 * next one to redo.
 */

import { getDb } from '@/core/db'
import { emitSyncEvent } from '@/lib/sync-events'
import { syncBadgeCount } from '@/core/notifications/dismiss'
import type { UndoSnapshot, SlotUndoState } from '@/types'
import { parseSlotState } from './slot-row'
import { dispatchUndoRedoWebhooks } from './dispatch-webhooks'

/** Parsed undo_log entry, ready for undoEntry() or redoEntry() */
export interface ParsedUndoEntry {
  id: number
  action: string
  description: string | null
  fieldsChanged: string[]
  snapshots: UndoSnapshot[]
  /** Set only on time_slot_edit / time_slot_delete entries. */
  slotState?: SlotUndoState | null
  /** When the entry was written — the rollover fence's reference (`rollover-fence.ts`). */
  createdAt?: string | null
}

/** An undo_log row as selected by selectUndoEntries() */
export interface RawUndoRow {
  id: number
  action: string
  description: string | null
  fields_changed: string
  snapshot: string
  slot_state: string | null
  created_at?: string | null
}

export function parseUndoRow(raw: RawUndoRow): ParsedUndoEntry {
  return {
    id: raw.id,
    action: raw.action,
    description: raw.description,
    fieldsChanged: JSON.parse(raw.fields_changed),
    snapshots: JSON.parse(raw.snapshot) as UndoSnapshot[],
    slotState: parseSlotState(raw.slot_state),
    createdAt: raw.created_at ?? null,
  }
}

export interface SelectUndoEntriesOptions {
  /** false: entries that can be undone (newest first); true: entries that can be redone (oldest first) */
  undone: boolean
  /** Only entries with id > afterId (a session boundary) */
  afterId?: number
  /** Only entries with id >= fromId */
  fromId?: number
  /** Only entries with id <= throughId */
  throughId?: number
  limit?: number
}

/**
 * Load and parse a user's undo_log entries in stack order: id DESC for
 * `undone: false` (undo), id ASC for `undone: true` (redo).
 */
export function selectUndoEntries(
  userId: number,
  options: SelectUndoEntriesOptions,
): ParsedUndoEntry[] {
  let sql = `
    SELECT id, action, description, fields_changed, snapshot, slot_state, created_at
    FROM undo_log
    WHERE user_id = ? AND undone = ?
  `
  const params: number[] = [userId, options.undone ? 1 : 0]

  if (options.afterId !== undefined) {
    sql += ' AND id > ?'
    params.push(options.afterId)
  }
  if (options.fromId !== undefined) {
    sql += ' AND id >= ?'
    params.push(options.fromId)
  }
  if (options.throughId !== undefined) {
    sql += ' AND id <= ?'
    params.push(options.throughId)
  }

  sql += options.undone ? ' ORDER BY id ASC' : ' ORDER BY id DESC'

  if (options.limit !== undefined) {
    sql += ' LIMIT ?'
    params.push(options.limit)
  }

  const rows = getDb()
    .prepare(sql)
    .all(...params) as RawUndoRow[]
  return rows.map(parseUndoRow)
}

/**
 * Where one of a user's undo_log entries stands, for a by-id undo or redo
 * that found it is not the entry it may act on (`undoLatest`, `redoNext`):
 * `live` (not undone), `undone`, or `gone` — purged, never existed, or
 * another user's (told apart from none, so an id never says whose it is).
 */
export function entryState(userId: number, id: number): 'live' | 'undone' | 'gone' {
  const row = getDb()
    .prepare('SELECT undone FROM undo_log WHERE id = ? AND user_id = ?')
    .get(id, userId) as { undone: number } | undefined
  if (!row) return 'gone'
  return row.undone === 1 ? 'undone' : 'live'
}

/**
 * After an undo/redo transaction commits: refresh open tabs and widgets,
 * resync the app-icon badge (an undo can put a task back in the past or take
 * it out), then send a task.updated webhook for every task each entry touched.
 *
 * Undo and redo don't dismiss notifications: they can't tell which delivered
 * banners the restored state makes stale, so only the badge follows.
 */
export function afterUndoRedo(
  userId: number,
  entries: ParsedUndoEntry[],
  kind: 'undo' | 'redo',
): void {
  emitSyncEvent(userId)
  syncBadgeCount(userId)
  for (const entry of entries) {
    dispatchUndoRedoWebhooks(userId, entry.snapshots, entry.fieldsChanged, kind)
  }
}
