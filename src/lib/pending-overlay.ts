/**
 * Optimistic changes that outlive their own write (2026-10-26, Trent on the
 * Mac app: tapping Considered on one row after another, a row he had handled
 * came back for a moment — and his next tap landed on it instead of the row
 * he aimed at).
 *
 * THE RULE: a tap's optimistic change is drawn over every payload until a
 * payload REQUESTED AFTER ITS WRITE ANSWERED has been applied. Only that one
 * is known to include the write. Before this, a surface dropped all its
 * changes on the first render after the last write answered, against
 * whatever payload it then held — in a burst, the one fetched before the
 * burst (each tap's follow-up refresh is superseded by the next tap's and
 * dropped by the latest-request guard), so every row of the burst came back
 * until the last refresh landed.
 *
 * Requests are counted by the surface's `LatestRequestGuard`: `latest()` when
 * the write answers is the `settledAt` mark; a payload whose request `seq` is
 * greater than it began afterwards. A failed write drops its entry at once
 * (the row goes back), as before.
 *
 * Each entry carries the `token` of the tap that made it, so a later tap on
 * the same row (put back after consider, say) replaces it and an earlier
 * tap's answer can neither settle nor drop the newer one.
 */

export interface PendingEntry<V> {
  value: V
  /** Which tap made it (`nextPendingToken`). */
  token: number
  /** The guard's `latest()` when its write answered; null while it is out. */
  settledAt: number | null
}

export type PendingMap<K, V> = ReadonlyMap<K, PendingEntry<V>>

let tokenCounter = 0
/** A fresh token for one tap's entries. */
export function nextPendingToken(): number {
  tokenCounter += 1
  return tokenCounter
}

/** `ids` set to `value` (or `value(id)`) by the tap `token`, its write out. */
export function addPending<K, V>(
  map: PendingMap<K, V>,
  ids: readonly K[],
  value: V | ((id: K) => V),
  token: number,
): Map<K, PendingEntry<V>> {
  const next = new Map(map)
  for (const id of ids) {
    const v = typeof value === 'function' ? (value as (id: K) => V)(id) : value
    next.set(id, { value: v, token, settledAt: null })
  }
  return next
}

/** The tap `token`'s write answered; `settledAt` is the guard's `latest()` now. */
export function settlePending<K, V>(
  map: PendingMap<K, V>,
  ids: readonly K[],
  token: number,
  settledAt: number,
): PendingMap<K, V> {
  let next: Map<K, PendingEntry<V>> | null = null
  for (const id of ids) {
    const entry = map.get(id)
    if (!entry || entry.token !== token) continue
    next ??= new Map(map)
    next.set(id, { ...entry, settledAt })
  }
  return next ?? map
}

/** The tap `token`'s write failed (or changed nothing): its rows go back. */
export function dropPending<K, V>(
  map: PendingMap<K, V>,
  ids: readonly K[],
  token: number,
): PendingMap<K, V> {
  let next: Map<K, PendingEntry<V>> | null = null
  for (const id of ids) {
    if (map.get(id)?.token !== token) continue
    next ??= new Map(map)
    next.delete(id)
  }
  return next ?? map
}

/** Whether a payload requested as `payloadSeq` already includes the entry's write. */
function retired<V>(entry: PendingEntry<V>, payloadSeq: number): boolean {
  return entry.settledAt !== null && payloadSeq > entry.settledAt
}

/** The changes still to draw over the payload requested as `payloadSeq`. */
export function activePending<K, V>(map: PendingMap<K, V>, payloadSeq: number): Map<K, V> {
  const active = new Map<K, V>()
  for (const [id, entry] of map) if (!retired(entry, payloadSeq)) active.set(id, entry.value)
  return active
}

/**
 * A row change for a list that holds whole rows (the dashboard's task list):
 * the row as the tap left it, or `null` for a row the tap took off the list.
 */
export type RowChange<T> = (row: T) => T | null

/** `rows` with each id's change applied over it (`activePending`'s result). */
export function applyRowChanges<T extends { id: number }>(
  rows: T[],
  changes: ReadonlyMap<number, RowChange<T>>,
): T[] {
  if (changes.size === 0) return rows
  const out: T[] = []
  for (const row of rows) {
    const change = changes.get(row.id)
    const next = change ? change(row) : row
    if (next) out.push(next)
  }
  return out
}

/**
 * One list's pending row changes, kept beside its fetch: `add` when a tap
 * changes a row, `settle` when its write answers, `drop` when it fails. The
 * fetch draws `applyRowChanges(payload, activePending(map, seq))`.
 */
export interface RowPending<T> {
  add(id: number, change: RowChange<T>): number
  settle(id: number, token: number): void
  drop(id: number, token: number): void
}
