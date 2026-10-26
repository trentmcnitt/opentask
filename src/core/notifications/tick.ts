/**
 * THE TICK COORDINATOR — ONE ALERT PER USER PER MINUTE (Trent, 2026-10-26;
 * plan "named pushes and marks" Part D).
 *
 * Each minute every sender (the overdue checker, the slot-open push, the slot
 * nag, the deadlines nag; named reminder pushes from PR 2) PRODUCES its
 * candidate sends instead of sending them. This module then, per user:
 *
 *  1. CLAIMS — each candidate's `claim` runs (the `nag_sends` compare-and-swap
 *     of the nags, the slot-open push's stamp), in source order. A lost claim
 *     drops the candidate: some other tick already sent it.
 *  2. PICKS THE LEAD — the candidate highest in `LEAD_ORDER` among those that
 *     would SOUND on their own (a tie: the sender's own order, so the overdue
 *     checker's "highest priority, most overdue first" stands). A send that
 *     is silent by its own rule (`silent`: the slot-open push and the slot
 *     nag, the deadlines nag and its safety net — ruling 5, sound only on
 *     overdue) never takes the lead from one that sounds (Trent, 2026-10-26,
 *     on #362: otherwise a safety net beside a Medium overdue left the minute
 *     with no sound at all). Only when nothing this minute would sound does
 *     the highest-ranked silent send lead — silently, as built. The lead
 *     keeps its level and its sound, and its
 *     body gets " · N more waiting", N being every OTHER thing this tick's
 *     banners speak for (an overdue banner is 1, a summary its overflow, a
 *     period push or nag its waiting items, the deadlines nag its rows).
 *     The suffix is a snapshot and can go stale — accepted (Trent).
 *  3. MARKS THE REST PASSIVE — the silent ones included: still one banner
 *     per item, each with its own actions, but APNs `interruption-level:
 *     passive` with no sound, and `silent` on Web Push. EXCEPT Urgent
 *     overdue: critical always, lead or not (`alwaysAlerts`).
 *  4. DELIVERS everything, then each source's after-step (the overdue
 *     checker's badge-only pushes).
 *
 * A user with one candidate gets exactly what the sender built — no suffix,
 * nothing passive.
 *
 * THE LEAD ORDER (Trent), among the sends that sound: Urgent overdue › High overdue › Urgent reminder ›
 * High reminder › deadlines safety net › Medium overdue › other overdue ›
 * Medium reminder › period › deadlines nag. The reminder kinds are PR 2's
 * named reminder pushes; nothing produces them yet. "Period" is the slot-open
 * push and the slot nag alike (the nag stands down the minute a slot opens,
 * so the two never meet for one user). An overdue summary ranks with its
 * bucket (High's with High overdue, the regular one with other overdue).
 *
 * WEB PUSH: only the overdue checker and the deadlines nag send there (slot
 * pushes are APNs only), and the deadlines nag is always silent there. So on
 * a tick led by a period or deadlines push the browser alerts for nothing —
 * one alert per user, not per channel.
 *
 * Split so `scripts/count-pushes.ts` can run the real decisions without
 * delivering: `planTick` (produce, claim, assign) and `runTick` (plan, then
 * deliver). The senders' `check*` entry points run their own source alone.
 */

import { log } from '@/lib/logger'
import { isApnsConfigured } from '@/core/notifications/apns'
import { isWebPushConfigured } from '@/core/notifications/web-push'

/** Every kind a push can be, for the lead order and the projection's counts. */
export type PushKind =
  | 'overdue_urgent'
  | 'overdue_high'
  | 'reminder_urgent'
  | 'reminder_high'
  | 'deadlines_safety_net'
  | 'overdue_medium'
  | 'overdue_other'
  | 'reminder_medium'
  | 'period'
  | 'deadlines'

/** Most important first. The `reminder_*` slots are PR 2's (named reminder pushes). */
export const LEAD_ORDER: readonly PushKind[] = [
  'overdue_urgent',
  'overdue_high',
  'reminder_urgent',
  'reminder_high',
  'deadlines_safety_net',
  'overdue_medium',
  'overdue_other',
  'reminder_medium',
  'period',
  'deadlines',
]

/** How one send goes out this tick. */
export interface Delivery {
  /** Banner without alerting: APNs `passive` and no sound; Web Push `silent`. */
  passive: boolean
  /** The lead's " · N more waiting", appended to its body; null otherwise. */
  suffix: string | null
}

/** A delivery that changes nothing — what a send alone in its tick gets. */
export const AS_BUILT: Delivery = { passive: false, suffix: null }

export interface TickSend {
  userId: number
  kind: PushKind
  /** How many waiting things this banner speaks for (the lead's "N more"). */
  items: number
  /** Never passive: Urgent overdue is critical, lead or not. */
  alwaysAlerts?: boolean
  /**
   * Makes no sound by its own rule (period pushes and nags, the deadlines nag
   * and its safety net). Never leads a minute in which something sounds.
   */
  silent?: boolean
  /** Run before the lead is picked; false drops the send (a lost `nag_sends` claim). */
  claim?: () => boolean
  deliver: (delivery: Delivery) => Promise<void>
}

export interface PlannedSend extends TickSend {
  delivery: Delivery
}

/** Which channels are on. Defaults to the server's configuration. */
export interface Channels {
  apns: boolean
  webPush: boolean
}

export interface SourcePlan {
  sends: TickSend[]
  /** Runs after every send of the tick went out (the overdue checker's badge-only pushes). */
  after?: () => Promise<void>
}

/** One sender, as the coordinator calls it. `plan` is read-only; claims are the coordinator's. */
export interface TickSource {
  name: string
  plan: (now: Date, channels: Channels) => SourcePlan
}

export function configuredChannels(): Channels {
  return { apns: isApnsConfigured(), webPush: isWebPushConfigured() }
}

const rank = (kind: PushKind) => LEAD_ORDER.indexOf(kind)

/** " · 4 more waiting". */
export function moreWaitingSuffix(n: number): string {
  return ` · ${n} more waiting`
}

/**
 * The minute's lead: the highest-ranked send that would sound on its own (a
 * tie to the earlier send); with nothing sounding, the highest-ranked of all.
 */
function pickLead(list: TickSend[]): TickSend {
  const sounding = list.filter((s) => !s.silent)
  const pool = sounding.length > 0 ? sounding : list
  return pool.reduce((best, s) => (rank(s.kind) < rank(best.kind) ? s : best))
}

/**
 * Pure: per user, the lead (`pickLead`) keeps its level and gets the "N
 * more" suffix; the rest go passive unless they always alert. Order of the
 * input is kept in the output.
 */
export function assignDeliveries(sends: TickSend[]): PlannedSend[] {
  const byUser = new Map<number, TickSend[]>()
  for (const send of sends) {
    const list = byUser.get(send.userId) ?? []
    list.push(send)
    byUser.set(send.userId, list)
  }
  const deliveries = new Map<TickSend, Delivery>()
  for (const list of byUser.values()) {
    if (list.length === 1) {
      deliveries.set(list[0], AS_BUILT)
      continue
    }
    const lead = pickLead(list)
    const others = list.reduce((n, s) => (s === lead ? n : n + s.items), 0)
    for (const send of list) {
      if (send === lead) deliveries.set(send, { passive: false, suffix: moreWaitingSuffix(others) })
      else deliveries.set(send, { passive: !send.alwaysAlerts, suffix: null })
    }
  }
  return sends.map((send) => ({ ...send, delivery: deliveries.get(send)! }))
}

export interface TickPlan {
  sends: PlannedSend[]
  after: (() => Promise<void>)[]
}

/**
 * Produce every source's candidates, claim them (in source order) and assign
 * each its delivery. Writes only what the claims write. A source that throws
 * is logged and left out: one broken sender never silences the others.
 */
export function planTick(
  sources: TickSource[],
  now: Date,
  channels: Channels = configuredChannels(),
): TickPlan {
  const claimed: TickSend[] = []
  const after: (() => Promise<void>)[] = []
  for (const source of sources) {
    try {
      const plan = source.plan(now, channels)
      for (const send of plan.sends) {
        if (!send.claim || send.claim()) claimed.push(send)
      }
      if (plan.after) after.push(plan.after)
    } catch (err) {
      log.error('notifications', `${source.name} error:`, err)
    }
  }
  return { sends: assignDeliveries(claimed), after }
}

/** Plan the tick, deliver every send, then the after-steps. Failures are logged per send. */
export async function runTick(
  sources: TickSource[],
  now: Date = new Date(),
  channels: Channels = configuredChannels(),
): Promise<void> {
  const plan = planTick(sources, now, channels)
  const results = await Promise.allSettled(plan.sends.map((s) => s.deliver(s.delivery)))
  for (const r of results) {
    if (r.status === 'rejected') log.error('notifications', 'Notification send error:', r.reason)
  }
  for (const step of plan.after) {
    try {
      await step()
    } catch (err) {
      log.error('notifications', 'Notification after-step error:', err)
    }
  }
}
