/**
 * The dashboard's completion fill (REDESIGN-V03-adjacent, Trent 2026-09-23):
 * a background fill behind the Today date chip and each project chip,
 * proportional to today's completion for that scope — done today / (done
 * today + still due today) — turning to a "finished" state when everything
 * due today in that scope is done. Shared by `DueDateFilterBar` (the Today
 * chip) and `ProjectFilterBar` (each project chip) so the two chip types
 * agree on what "finished" means.
 */
export interface CompletionFill {
  /** 0..1 of the target, capped — mirrors `TrackState.fraction` (`@/lib/track`). */
  fraction: number
  /** Everything due today in this scope is done — nothing due today does NOT count as finished. */
  finished: boolean
}

/**
 * `done` and `remaining` are each optional so callers that don't have
 * completion data yet (or a chip with nothing to do with the concept, like an
 * excluded chip) can pass `undefined` and get no fill rather than a fill
 * frozen at 0%. Returns `null` when there is nothing due today in this scope
 * at all — a project with nothing due must not light up "finished".
 */
export function computeCompletionFill(
  done: number | undefined,
  remaining: number | undefined,
): CompletionFill | null {
  if (done == null || remaining == null) return null
  const total = done + remaining
  if (total <= 0) return null
  return {
    fraction: Math.min(1, Math.max(0, done) / total),
    finished: remaining === 0 && done > 0,
  }
}
