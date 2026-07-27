/**
 * System label vocabulary (REDESIGN-V03 §7.2)
 *
 * Deliberately dependency-free. Both `@/core/db` (which seeds these during the
 * registry backfill) and `@/core/labels` (which validates against them) need
 * these constants, and `@/core/labels` imports `getDb` — so defining them in
 * either would make the two modules import each other in a cycle that resolves
 * at module-init time, exactly when it is most fragile.
 *
 * TWO SEPARATE MACHINES share the `ai-` namespace. Do not merge them:
 * - PROCESSING STATE is owned by enrichment.ts and drives the queue.
 * - PROVENANCE records where a task came from and who is watching it.
 */

/** Namespace reserved for labels that carry behavior rather than meaning. */
export const RESERVED_LABEL_PREFIX = 'ai-'

/** Enrichment processing state machine — owned by enrichment.ts, leave alone. */
export const PROCESSING_LABELS = ['ai-to-process', 'ai-failed', 'ai-locked'] as const

/** Provenance labels (§7.2). */
export const PROVENANCE_LABELS = {
  /** Created by the assistant. */
  added: 'ai-added',
  /** Created on assistant initiative, not yet blessed by the user. */
  proposed: 'ai-proposed',
  /** The assistant/desk watches this task. */
  monitored: 'ai-monitored',
} as const

/**
 * Everything the system owns. Always valid, never user-created.
 *
 * Enumerating these means validation never depends on whether the backfill
 * happened to run first, while a *typo* in the reserved namespace
 * (`ai-monitred`) still fails loudly — which is the point of gating it.
 */
export const SYSTEM_LABELS: ReadonlySet<string> = new Set<string>([
  ...PROCESSING_LABELS,
  ...Object.values(PROVENANCE_LABELS),
])

export function isReservedLabel(name: string): boolean {
  return name.startsWith(RESERVED_LABEL_PREFIX)
}
