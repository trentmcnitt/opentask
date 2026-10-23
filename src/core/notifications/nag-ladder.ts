/**
 * THE NAG LADDER — how often each kind of nag repeats, by priority, in ONE
 * table (nag-map ruling 1, Trent 2026-10-22: "one ladder table, one module").
 *
 * Two paces, both read from the user's own overdue tiers (Settings →
 * Notifications, the `users.auto_snooze_*` columns):
 *
 *  - OVERDUE — a task past its target. The tier as set: Unset 30, Low 240,
 *    Medium 60, High 15, Urgent 5 by default. Overdue nags until it is acted
 *    on, by design (ruling 3): it is debt.
 *  - CONSIDERING — "this is waiting for you to look at it" (the deadlines
 *    page; the reminder slot nag and quota prompts are LISTED here but do not
 *    read the ladder yet, see below). HALF the pace of overdue: the same tier
 *    ×2. Low and Unset never nag — not being worth a nag is what Low means
 *    here, and Unset is not a claim that it matters.
 *
 * THE SAFETY NET (deadlines page, from the day before the deadline on; A2):
 * at least HOURLY, whatever the priority — a Low or Unset deadline row nags
 * every 60 minutes there, and a slower rung (Medium ×2 = 120 by default) is
 * brought up to 60. A faster rung (High 30, Urgent 10) keeps its own pace.
 *
 * WHAT IS LISTED BUT NOT WIRED (2026-10-22, PR B): `slot_nag` and
 * `quota_prompt` are declared with the considering pace so the table shows
 * where they would sit, but nothing reads their rows. The slot nag runs its
 * own schedule (top of the hour, at most 3 a day, inside Wake–Sleep —
 * slot-nags.ts); quota prompts have no push of their own (they ride the slot
 * push and the slot nag). Moving them onto the ladder is a product change —
 * see docs/NOTIFICATIONS.md § The nag ladder.
 *
 * The per-task override (`tasks.auto_snooze_minutes`, 0 = off) is the
 * overdue checker's business and is applied before this table there; a
 * page-level nag has no single task to read it from.
 */

import { HIGH_PRIORITY_THRESHOLD, URGENT_PRIORITY } from '@/lib/priority'

export type NagKind = 'overdue' | 'deadlines' | 'slot_nag' | 'quota_prompt'

/** Which of the user's five tier columns a rung reads. */
export type NagTier = 'unset' | 'low' | 'medium' | 'high' | 'urgent'

/** The user's overdue tiers, in minutes (`users.auto_snooze_*`). */
export interface NagTiers {
  unset: number
  low: number
  medium: number
  high: number
  urgent: number
}

/** A rung: the tier it reads and the multiplier, or `null` (never nags). */
export type NagRung = { tier: NagTier; times: number } | null

const tier = (t: NagTier, times: number): NagRung => ({ tier: t, times })

/** The considering pace: overdue ×2, Low and Unset silent (ruling 1). */
const CONSIDERING: Record<0 | 1 | 2 | 3 | 4, NagRung> = {
  0: null,
  1: null,
  2: tier('medium', 2),
  3: tier('high', 2),
  4: tier('urgent', 2),
}

/** THE TABLE, keyed (kind, priority 0–4). */
export const NAG_LADDER: Record<NagKind, Record<0 | 1 | 2 | 3 | 4, NagRung>> = {
  overdue: {
    0: tier('unset', 1),
    1: tier('low', 1),
    2: tier('medium', 1),
    3: tier('high', 1),
    4: tier('urgent', 1),
  },
  deadlines: CONSIDERING,
  // Listed, not wired (see the header).
  slot_nag: CONSIDERING,
  quota_prompt: CONSIDERING,
}

/** The deadlines page's safety net nags at least this often (A2). */
export const SAFETY_NET_FLOOR_MINUTES = 60

/** Priority (any number) to the table's 0–4 key. */
function rungKey(priority: number): 0 | 1 | 2 | 3 | 4 {
  if (priority >= URGENT_PRIORITY) return 4
  if (priority >= HIGH_PRIORITY_THRESHOLD) return 3
  if (priority === 2) return 2
  if (priority === 1) return 1
  return 0
}

/**
 * Minutes between two nags of `kind` at `priority`, or null when that rung
 * never nags. `safetyNet` (deadlines only) caps the interval at
 * SAFETY_NET_FLOOR_MINUTES, so even a silent rung nags hourly.
 */
export function nagIntervalMinutes(
  kind: NagKind,
  priority: number,
  tiers: NagTiers,
  { safetyNet = false }: { safetyNet?: boolean } = {},
): number | null {
  const rung = NAG_LADDER[kind][rungKey(priority)]
  const minutes = rung ? tiers[rung.tier] * rung.times : null
  if (!safetyNet) return minutes
  return minutes === null ? SAFETY_NET_FLOOR_MINUTES : Math.min(minutes, SAFETY_NET_FLOOR_MINUTES)
}

/** The tier columns as a query row names them (`users.auto_snooze_*`). */
export interface UserTierRow {
  auto_snooze_minutes: number
  auto_snooze_low_minutes: number
  auto_snooze_medium_minutes: number
  auto_snooze_high_minutes: number
  auto_snooze_urgent_minutes: number
}

export function tiersOf(row: UserTierRow): NagTiers {
  return {
    unset: row.auto_snooze_minutes,
    low: row.auto_snooze_low_minutes,
    medium: row.auto_snooze_medium_minutes,
    high: row.auto_snooze_high_minutes,
    urgent: row.auto_snooze_urgent_minutes,
  }
}
