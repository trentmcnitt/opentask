/**
 * The server's ONE way to read a user's Morning, Wake and Sleep times and
 * number-pad buttons (2026-10-21) — each a custom time or a link to a
 * reminder period, resolved by the pure rule in `src/lib/anchor-times.ts`.
 *
 * Every server reader of those times calls `getAnchorTimes` (or
 * `getTargetContext`, which calls it): never `SELECT morning_time` and use the
 * column, which would miss a link. The readers that still touch the raw
 * `morning_time` column: the no-periods rollover fallbacks (`read.ts`'s SQL,
 * `stampRolloverDates`) — with no periods there can be no link, so there the
 * column IS the resolved time — and `migrate-deadline-targets.ts`, a one-shot
 * migration that ran before links existed.
 */

import { getDb } from '@/core/db'
import { listTimeSlots } from '@/core/time-slots'
import {
  ANCHOR_COLUMNS,
  DEFAULT_ANCHOR_ROW,
  hasAnyLink,
  resolveAnchorTimes,
  settingWrites,
  type AnchorRow,
  type AnchorTimes,
  type SettingChange,
} from '@/lib/anchor-times'
import type { TimeSlot } from '@/lib/time-slot-assign'
import type Database from 'better-sqlite3'

const ANCHOR_SELECT = `SELECT ${ANCHOR_COLUMNS.join(', ')} FROM users WHERE id = ?`

/** The user's seven stored settings (the schema defaults if the user is missing). */
export function readAnchorRow(userId: number, db: Database.Database = getDb()): AnchorRow {
  return (db.prepare(ANCHOR_SELECT).get(userId) as AnchorRow | undefined) ?? DEFAULT_ANCHOR_ROW
}

/**
 * Move each setting in `changes` to its `side`, compare-and-set
 * (`settingWrites`), inside the caller's transaction: a period delete
 * converting its links ('after'), and undo ('before') / redo ('after') of
 * that delete.
 */
export function applySettingChanges(
  tx: Database.Database,
  userId: number,
  changes: readonly SettingChange[],
  side: 'before' | 'after',
): void {
  if (changes.length === 0) return
  const writes = settingWrites(readAnchorRow(userId, tx), changes, side)
  const cols = Object.keys(writes) as (keyof AnchorRow)[]
  if (cols.length === 0) return
  tx.prepare(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(
    ...cols.map((c) => writes[c]),
    userId,
  )
}

/**
 * The user's seven times, resolved. `slots` saves a query for a caller that
 * already holds the user's periods; otherwise they are read only when
 * something actually links to one (most users link nothing).
 */
export function getAnchorTimes(userId: number, slots?: readonly TimeSlot[]): AnchorTimes {
  return resolveUserAnchorTimes(userId, readAnchorRow(userId), slots)
}

/** `getAnchorTimes` for a caller that already read the row (the preferences response). */
export function resolveUserAnchorTimes(
  userId: number,
  row: AnchorRow,
  slots?: readonly TimeSlot[],
): AnchorTimes {
  return resolveAnchorTimes(row, slots ?? (hasAnyLink(row) ? listTimeSlots(userId) : []))
}
