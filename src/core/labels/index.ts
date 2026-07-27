/**
 * Label registry (REDESIGN-V03 §7.2)
 *
 * Labels were bare free-text: any string a caller sent became a label, so a
 * typo silently forked the taxonomy and nothing ever noticed. That was tolerable
 * while labels were decoration. It stops being tolerable once labels carry
 * behavior — `ai-proposed` / `ai-added` / `ai-monitored` are provenance that the
 * assistant and the desk act on, and an AI caller that typos one produces a task
 * nobody is watching while appearing to have flagged it.
 *
 * So **creating a label is a discrete act.** Writing a task with an unknown
 * label is rejected unless the caller explicitly says `create_label`. A typo
 * fails loudly instead of minting a tag.
 *
 * TWO SEPARATE AI VOCABULARIES — do not merge them:
 * - `ai-to-process` / `ai-failed` / `ai-locked` are a LIVE processing state
 *   machine owned by enrichment.ts. Leave them alone.
 * - `ai-proposed` / `ai-added` / `ai-monitored` are PROVENANCE, defined here.
 */

import { getDb } from '@/core/db'
import { ValidationError } from '@/core/errors'
import {
  SYSTEM_LABELS,
  PROVENANCE_LABELS,
  RESERVED_LABEL_PREFIX,
  isReservedLabel,
} from '@/lib/label-vocabulary'

export { SYSTEM_LABELS, PROVENANCE_LABELS, RESERVED_LABEL_PREFIX, isReservedLabel }

export type LabelFacet = 'domain' | 'operational'

export interface Label {
  id: number
  user_id: number
  name: string
  facet: LabelFacet
  icon: string | null
  color: string | null
  created_at: string
}

/**
 * Filter a machine-produced label set down to what may be auto-registered.
 *
 * Used by the enrichment path (§7.2). Labels the user explicitly asked for are
 * allowed through and will be registered; anything in the reserved namespace
 * that isn't already registered is dropped rather than created.
 */
export function filterAutoCreatableLabels(userId: number, names: string[]): string[] {
  const registered = new Set(listLabels(userId).map((l) => l.name))
  return names.filter(
    (name) => !isReservedLabel(name) || registered.has(name) || SYSTEM_LABELS.has(name),
  )
}

export function listLabels(userId: number): Label[] {
  return getDb()
    .prepare('SELECT * FROM labels WHERE user_id = ? ORDER BY facet, name')
    .all(userId) as Label[]
}

export function getLabelByName(userId: number, name: string): Label | null {
  const row = getDb()
    .prepare('SELECT * FROM labels WHERE user_id = ? AND name = ?')
    .get(userId, name) as Label | undefined
  return row ?? null
}

/**
 * Register a label. Idempotent — re-registering an existing name returns the
 * existing row rather than erroring, so callers can be naive about ordering.
 */
export function createLabel(
  userId: number,
  name: string,
  options: { facet?: LabelFacet; icon?: string | null; color?: string | null } = {},
): Label {
  const trimmed = name.trim()
  if (!trimmed) throw new ValidationError('Label name cannot be empty')

  const existing = getLabelByName(userId, trimmed)
  if (existing) return existing

  const db = getDb()
  db.prepare('INSERT INTO labels (user_id, name, facet, icon, color) VALUES (?, ?, ?, ?, ?)').run(
    userId,
    trimmed,
    options.facet ?? 'domain',
    options.icon ?? null,
    options.color ?? null,
  )

  return getLabelByName(userId, trimmed)!
}

/**
 * Register the system vocabulary for a user.
 *
 * Called at user creation. The startup backfill seeds existing users, but it
 * runs once at schema-init — anyone created afterwards would otherwise never
 * get these rows, and the chip bar would silently omit the operational facet
 * for them. Validation doesn't depend on this (SYSTEM_LABELS is authoritative),
 * so this is about the registry being a complete picture, not about gating.
 *
 * Idempotent — safe to call on an existing user.
 */
export function seedSystemLabels(userId: number): void {
  const db = getDb()
  const insert = db.prepare(
    "INSERT OR IGNORE INTO labels (user_id, name, facet) VALUES (?, ?, 'operational')",
  )
  for (const name of SYSTEM_LABELS) insert.run(userId, name)
}

export function deleteLabel(userId: number, name: string): boolean {
  const res = getDb().prepare('DELETE FROM labels WHERE user_id = ? AND name = ?').run(userId, name)
  return res.changes > 0
}

/**
 * Enforce the registry against a task's incoming labels.
 *
 * **Only labels being NEWLY added are checked.** A label already stored on the
 * task round-trips freely, even if it is somehow absent from the registry. This
 * matters: without it, one unregistered legacy value would make every unrelated
 * edit to that task fail, which is a far worse failure than a stray tag.
 *
 * @param userId          owner
 * @param incoming        the full label array the caller wants the task to end up with
 * @param existing        labels currently stored on the task (omit for creates)
 * @param createUnknown   when true, unknown labels are registered instead of rejected
 */
export function validateLabelsExist(
  userId: number,
  incoming: string[],
  existing: string[] = [],
  createUnknown = false,
): void {
  if (incoming.length === 0) return

  const alreadyOnTask = new Set(existing)
  const added = incoming.filter((name) => !alreadyOnTask.has(name))
  if (added.length === 0) return

  const registered = new Set(listLabels(userId).map((l) => l.name))
  const unknown = added.filter((name) => !registered.has(name) && !SYSTEM_LABELS.has(name))
  if (unknown.length === 0) return

  if (createUnknown) {
    for (const name of unknown) createLabel(userId, name)
    return
  }

  throw new ValidationError(
    `Unknown label${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. ` +
      'Create it first, or pass create_label to create it as part of this write.',
  )
}

/**
 * Swap `ai-proposed` for `ai-added` on one task (§7.2's `confirm` verb).
 *
 * Deliberately task-scoped and narrow: it removes `ai-proposed`, adds
 * `ai-added`, and touches nothing else. Confirming a task the assistant
 * proposed is a statement about provenance, not an invitation to re-edit it.
 */
export function confirmProvenance(labels: string[]): string[] {
  const next = labels.filter((l) => l !== PROVENANCE_LABELS.proposed)
  if (!next.includes(PROVENANCE_LABELS.added)) next.push(PROVENANCE_LABELS.added)
  return next
}
