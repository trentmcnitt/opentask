/**
 * THE NAG LADDER — how often each kind of nag repeats, by priority, in ONE
 * table (nag-map ruling 1; Trent 2026-10-22: "one considering ladder, no
 * special cases").
 *
 * Two paces, both read from the user's own overdue tiers (Settings →
 * Notifications, the `users.auto_snooze_*` columns):
 *
 *  - OVERDUE — a task past its target. The tier as set: Unset 30, Low 240,
 *    Medium 60, High 15, Urgent 5 by default. Overdue nags until it is acted
 *    on, by design (ruling 3): it is debt.
 *  - CONSIDERING — "this is waiting for you to look at it": the deadlines
 *    page, the reminder slot nag, and quota prompts (which ride the slot nag).
 *    HALF the pace of overdue: the same tier ×2 at EVERY priority, Low and
 *    Unset included — Urgent 10, High 30, Medium 120, Low 480, Unset 60 by
 *    default.
 *
 * THE SAFETY NET (deadlines page, from the day before the deadline on; A2):
 * at least HOURLY — a slower rung (Medium 120, Low 480) is brought up to 60;
 * a faster one (Urgent 10, High 30, Unset 60) keeps its own pace.
 *
 * WHO READS WHICH ROW:
 *  - `overdue` — the overdue checker (overdue-checker.ts), after the per-task
 *    override (`tasks.auto_snooze_minutes`).
 *  - `deadlines` — the deadlines-page nag (deadline-nags.ts), per row, the
 *    rung whose next clock mark comes first wins (`nagPace`).
 *  - `slot_nag` — the unfinished-slot nag (slot-nags.ts), per waiting item:
 *    each None/Low reminder at its own priority, each quota prompt at its
 *    quota's; the soonest mark wins (Trent, 2026-10-22 — a reminder's priority
 *    is prominence AND how often its slot nags, REDESIGN-V03 §6). One nag per
 *    user, never one per item. ALSO the named Medium+ reminder pushes
 *    (reminder-nags.ts, 2026-10-26): each repeats at this row's rung for its
 *    own priority, and is no longer in the slot nag.
 *  - `quota_prompt` — DOCUMENTED ONLY. A quota prompt has no push of its own:
 *    it rides the slot push and the slot nag, so the `slot_nag` row paces it
 *    (at the quota's priority). The row says where a prompt's own nag would
 *    sit if it ever had one — the same rungs.
 *
 * A page-level nag has no single task to read a per-task override from; the
 * deadlines nag only honours a task's Nag OFF (0), by leaving the row out.
 */

import { getDb } from '@/core/db'
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

/** A rung: the tier it reads and the multiplier. */
export interface NagRung {
  tier: NagTier
  times: number
}

type Ladder = Record<0 | 1 | 2 | 3 | 4, NagRung>

/** Priority 0–4 → tier column, at `times` the tier. */
function ladder(times: number): Ladder {
  return {
    0: { tier: 'unset', times },
    1: { tier: 'low', times },
    2: { tier: 'medium', times },
    3: { tier: 'high', times },
    4: { tier: 'urgent', times },
  }
}

/** The considering pace: overdue ×2, every priority (Trent, 2026-10-22). */
const CONSIDERING = ladder(2)

/** THE TABLE, keyed (kind, priority 0–4). */
export const NAG_LADDER: Record<NagKind, Ladder> = {
  overdue: ladder(1),
  deadlines: CONSIDERING,
  slot_nag: CONSIDERING,
  // Documented only: prompts ride the slot nag (see the header).
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
 * Minutes between two nags of `kind` at `priority`. `safetyNet` (deadlines
 * only) caps the interval at SAFETY_NET_FLOOR_MINUTES.
 */
export function nagIntervalMinutes(
  kind: NagKind,
  priority: number,
  tiers: NagTiers,
  { safetyNet = false }: { safetyNet?: boolean } = {},
): number {
  const rung = NAG_LADDER[kind][rungKey(priority)]
  const minutes = tiers[rung.tier] * rung.times
  return safetyNet ? Math.min(minutes, SAFETY_NET_FLOOR_MINUTES) : minutes
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

/** A user's tiers, read from `users`. */
export function userNagTiers(userId: number): NagTiers {
  const row = getDb()
    .prepare(
      `SELECT auto_snooze_minutes, auto_snooze_low_minutes, auto_snooze_medium_minutes,
              auto_snooze_high_minutes, auto_snooze_urgent_minutes
       FROM users WHERE id = ?`,
    )
    .get(userId) as UserTierRow
  return tiersOf(row)
}
