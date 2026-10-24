/**
 * The server's ONE way to read a user's Morning, Wake and Sleep times and
 * number-pad buttons (2026-10-21) — each a custom time or a link to a
 * reminder period, resolved by the pure rule in `src/lib/anchor-times.ts`.
 *
 * Every server reader of those times calls `getAnchorTimes` (or
 * `getTargetContext`, which calls it): never `SELECT morning_time` and use the
 * column, which would miss a link. The one reader that still touches the
 * raw `morning_time` column is `migrate-deadline-targets.ts`, a one-shot
 * migration that ran before links existed. (The day start never falls back
 * to Morning: unset, it is the fixed 3:00 AM, `DEFAULT_DAY_START`.)
 */

import { getDb } from '@/core/db'
import { listTimeSlots } from '@/core/time-slots'
import {
  ANCHOR_COLUMNS,
  DEFAULT_ANCHOR_ROW,
  hasAnyLink,
  resolveAnchorTimes,
  resolveDayStart,
  settingWrites,
  type AnchorRow,
  type AnchorTimes,
  type ResolvedDayStart,
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

/**
 * The user's "Day starts at", resolved (2026-10-23) — the ONE server read of
 * when the OpenTask day turns. `rolloverTimeForUser` is this time;
 * everything day-keyed reads it through there. The periods are read only
 * for a link (unset is the fixed 3:00 AM default).
 */
export function getDayStart(userId: number, slots?: readonly TimeSlot[]): ResolvedDayStart {
  const row = readAnchorRow(userId)
  const linked = row.day_start_time !== null && row.day_start_slot_id !== null
  return resolveDayStart(row, slots ?? (linked ? listTimeSlots(userId) : []))
}
