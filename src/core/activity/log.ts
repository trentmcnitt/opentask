/**
 * Activity log — permanent mutation history for AI pattern analysis
 *
 * Records every task mutation with before/after diffs. Unlike the undo log
 * (purged after 30 days), activity log entries are permanent and designed
 * for long-term behavioral analysis by AI features.
 *
 * Called inside existing transactions — uses getDb() which returns the
 * transaction handle when inside withTransaction().
 */

import { getDb } from '@/core/db'
import { currentAttribution } from '@/core/request-context'
import type { Task } from '@/types'

export type ActivityAction =
  | 'create'
  | 'edit'
  | 'snooze'
  | 'complete'
  | 'uncomplete'
  | 'delete'
  | 'restore'
  | 'reprocess'
  // §7.5: declining an occurrence. Deliberately distinct from 'complete' —
  // the whole purpose of skip is that it is NOT a completion.
  | 'skip'
  // §5: a quota's period closed at its boundary (the rollover job, not the
  // user). Metadata carries what was logged against the target.
  | 'period_rollover'

export interface ActivityEntry {
  userId: number
  taskId: number
  action: ActivityAction
  /**
   * 'rollover': the task queue's rollover job (task-queue PR 2), a system
   * action — `metadata.rollover` says what it did (stripped, rolled,
   * waiting, released, try_tomorrow_cleared).
   */
  source?: 'single' | 'bulk' | 'rollover'
  batchId?: string
  fields?: string[]
  before?: Partial<Task>
  after?: Partial<Task>
  metadata?: Record<string, unknown>
}

// `client` and `token_name`: which client made the write, from the request
// context (`system` outside a request — see src/core/request-context.ts).
const INSERT_SQL = `
  INSERT INTO activity_log (user_id, task_id, action, source, batch_id, fields, before, after,
                            metadata, client, token_name)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`

function insertValues(entry: ActivityEntry, client: string, tokenName: string | null): unknown[] {
  return [
    entry.userId,
    entry.taskId,
    entry.action,
    entry.source ?? 'single',
    entry.batchId ?? null,
    entry.fields ? JSON.stringify(entry.fields) : null,
    entry.before ? JSON.stringify(entry.before) : null,
    entry.after ? JSON.stringify(entry.after) : null,
    entry.metadata ? JSON.stringify(entry.metadata) : null,
    client,
    tokenName,
  ]
}

export function logActivity(entry: ActivityEntry): void {
  logActivityBatch([entry])
}

export function logActivityBatch(entries: ActivityEntry[]): void {
  if (entries.length === 0) return
  const { client, tokenName } = currentAttribution()
  const stmt = getDb().prepare(INSERT_SQL)
  for (const entry of entries) stmt.run(...insertValues(entry, client, tokenName))
}
