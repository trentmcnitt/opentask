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

export interface ActivityEntry {
  userId: number
  taskId: number
  action: ActivityAction
  source?: 'single' | 'bulk'
  batchId?: string
  fields?: string[]
  before?: Partial<Task>
  after?: Partial<Task>
  metadata?: Record<string, unknown>
}

const INSERT_SQL = `
  INSERT INTO activity_log (user_id, task_id, action, source, batch_id, fields, before, after, metadata)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`

export function logActivity(entry: ActivityEntry): void {
  const db = getDb()
  db.prepare(INSERT_SQL).run(
    entry.userId,
    entry.taskId,
    entry.action,
    entry.source ?? 'single',
    entry.batchId ?? null,
    entry.fields ? JSON.stringify(entry.fields) : null,
    entry.before ? JSON.stringify(entry.before) : null,
    entry.after ? JSON.stringify(entry.after) : null,
    entry.metadata ? JSON.stringify(entry.metadata) : null,
  )
}

export function logActivityBatch(entries: ActivityEntry[]): void {
  if (entries.length === 0) return
  const db = getDb()
  const stmt = db.prepare(INSERT_SQL)
  for (const entry of entries) {
    stmt.run(
      entry.userId,
      entry.taskId,
      entry.action,
      entry.source ?? 'single',
      entry.batchId ?? null,
      entry.fields ? JSON.stringify(entry.fields) : null,
      entry.before ? JSON.stringify(entry.before) : null,
      entry.after ? JSON.stringify(entry.after) : null,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
    )
  }
}
