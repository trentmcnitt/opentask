/**
 * UNDO ON THE REMINDERS SURFACE IS OPTIMISTIC (Trent, 2026-10-29: "if I
 * consider something in the reminders and I undo it, it can take anywhere
 * from fairly quick to many seconds before it reappears"). The row used to
 * come back only with the refresh after `POST /api/undo` — a refresh that is
 * held while any row is still collapsing and superseded by every newer one
 * (the undo's own sync event, another device's). Now an undone consider puts
 * its rows back the way they left, at once, and the server reconciles behind
 * it (`useReminders`):
 *
 * - The toast's Undo restores before any request: it knows exactly what it
 *   took away.
 * - The header's undo (and the keyboard's) restores as soon as `POST
 *   /api/undo` names the entry it undid (`undone_id`): a completion records
 *   its own `undo_id`, so the surface knows which rows that entry took.
 *
 * Until a payload requested AFTER the undo has landed, a restored row is
 * PINNED waiting: an older payload, already on its way, still lists it as
 * considered and must not take it away again (`PinnedUndone`).
 */
import type { ReminderGroup } from '@/hooks/useReminders'
import type { QuotaPrompt } from '@/lib/quota-prompts'

/**
 * Put rows back where they were before a consider: reminders out of the
 * considered list into their slot, in the order `snapshot` had them; prompts
 * back to waiting. A row still collapsing is still in `reminders` and stays
 * where it is.
 */
export function restoreInPlace(
  groups: ReminderGroup[],
  snapshot: ReminderGroup[],
  ids: ReadonlySet<number>,
  keys: ReadonlySet<string>,
): ReminderGroup[] {
  const order = new Map<number, number>()
  for (const g of snapshot) g.reminders.forEach((r, i) => order.set(r.id, i))
  return groups.map((g) => {
    const returning = g.consideredItems.filter((r) => ids.has(r.id))
    const prompts = g.prompts.some((p) => keys.has(p.prompt_key))
      ? g.prompts.map(
          (p): QuotaPrompt =>
            keys.has(p.prompt_key) ? { ...p, considered: false, done: false } : p,
        )
      : g.prompts
    if (returning.length === 0 && prompts === g.prompts) return g
    const rank = (id: number) => order.get(id) ?? Number.MAX_SAFE_INTEGER
    const reminders =
      returning.length === 0
        ? g.reminders
        : [...g.reminders, ...returning].sort((a, b) => rank(a.id) - rank(b.id))
    const consideredItems = g.consideredItems.filter((r) => !ids.has(r.id))
    return {
      ...g,
      reminders,
      count: reminders.length,
      consideredItems,
      considered: consideredItems.length,
      prompts,
    }
  })
}

/** Not yet confirmed: pinned until the undo's answer says which entry it was. */
export const UNCONFIRMED = Number.POSITIVE_INFINITY

/**
 * Rows an undo put back, each pinned waiting until a payload requested after
 * the undo (its request seq at least the entry's) has been applied. Keys are
 * reminder ids (numbers) and prompt keys (strings).
 */
export class PinnedUndone {
  private readonly from = new Map<number | string, number>()

  /** Pin rows now, before the server has answered. */
  pin(keys: Iterable<number | string>): void {
    for (const key of keys) this.from.set(key, UNCONFIRMED)
  }

  /** The undo is on the server: any payload from request `seq` on includes it. */
  confirm(keys: Iterable<number | string>, seq: number): void {
    for (const key of keys) if (this.from.has(key)) this.from.set(key, seq)
  }

  /** Whether every one of `keys` is still waiting for its undo's answer. */
  unconfirmed(keys: Iterable<number | string>): (number | string)[] {
    return [...keys].filter((key) => this.from.get(key) === UNCONFIRMED)
  }

  /** Stop pinning (the undo failed, or the row is being considered again). */
  release(keys: Iterable<number | string>): void {
    for (const key of keys) this.from.delete(key)
  }

  /** A payload from request `seq` is being applied: it includes every undo confirmed by then. */
  settle(seq: number): void {
    for (const [key, from] of this.from) if (seq >= from) this.from.delete(key)
  }

  /** The pinned reminder ids and prompt keys, for `reconcileInFlight`. */
  ids(): Set<number> {
    return new Set([...this.from.keys()].filter((k): k is number => typeof k === 'number'))
  }
  keys(): Set<string> {
    return new Set([...this.from.keys()].filter((k): k is string => typeof k === 'string'))
  }
}
