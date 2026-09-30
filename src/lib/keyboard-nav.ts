/**
 * Where keyboard focus goes when the focused row is about to leave the list —
 * Cmd+D completing it (and possibly the rest of a selection), or
 * Backspace/Delete deleting it.
 *
 * Look forward first, then backward: forward is what makes rapid sequential
 * completion work (Cmd+D, Cmd+D, … walks down the list), and backward covers
 * the last row. Rows in `removedIds` are skipped both ways, since they are
 * leaving too. Returns null when the focused row isn't in the list or nothing
 * would be left.
 *
 * Callers compute this BEFORE the mutation: `orderedIds` still holds the
 * leaving rows at that point, which is what gives the scan its starting index.
 */
export function nextFocusAfterRemoval(
  orderedIds: readonly number[],
  focusedId: number,
  removedIds: ReadonlySet<number> = new Set([focusedId]),
): number | null {
  const currentIndex = orderedIds.indexOf(focusedId)
  if (currentIndex === -1) return null
  for (let i = currentIndex + 1; i < orderedIds.length; i++) {
    if (!removedIds.has(orderedIds[i])) return orderedIds[i]
  }
  for (let i = currentIndex - 1; i >= 0; i--) {
    if (!removedIds.has(orderedIds[i])) return orderedIds[i]
  }
  return null
}
