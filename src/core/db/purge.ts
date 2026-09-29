/**
 * Shared retention purge: deletes rows older than N days from one table.
 *
 * Used by the undo log, AI activity, completions and webhook delivery purges,
 * which were four copies of the same cutoff-and-DELETE block. The retention
 * comes from `envVar` when it holds a valid integer, else `defaultDays`. An
 * unparseable value falls back to the default (it used to produce an Invalid
 * Date cutoff and throw a RangeError, so the purge never ran).
 *
 * `table` and `column` are interpolated into the SQL, so they must be
 * constants from the callers, never user input.
 */

import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { parseEnvInt } from '@/lib/env'

export interface PurgeOptions {
  table: string
  column: string
  /** Env var holding the retention in days; omit when the caller passes the days directly. */
  envVar?: string
  defaultDays: number
  /** Plural noun for the log line, e.g. "undo log entries". */
  label: string
}

export function purgeOlderThan({
  table,
  column,
  envVar,
  defaultDays,
  label,
}: PurgeOptions): number {
  const retentionDays = envVar ? parseEnvInt(process.env[envVar], defaultDays) : defaultDays

  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays)
  const cutoffIso = cutoffDate.toISOString()

  const result = getDb()
    .prepare(`DELETE FROM ${table} WHERE datetime(${column}) < datetime(?)`)
    .run(cutoffIso)

  if (result.changes > 0) {
    log.info('cron', `Deleted ${result.changes} ${label} older than ${retentionDays} days`)
  }

  return result.changes
}
