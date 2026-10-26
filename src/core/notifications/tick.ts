/**
 * THE TICK COORDINATOR — ONE ALERT PER USER PER MINUTE (Trent, 2026-10-26;
 * plan "named pushes and marks" Part D).
 *
 * Each minute every sender (the overdue checker, the slot-open push, the slot
 * nag, the named reminder pushes, the named quota-prompt pushes, the
 * deadlines nag) PRODUCES its
 * candidate sends instead of sending them. This module then, per user:
 *
 *  1. CLAIMS — first the MINUTE, per sender and user (`claimTickMinute`, a
 *     persisted compare-and-swap in `nag_sends`, key `tick-<sender>`): a
 *     second run of the same minute — the startup check beside the cron, a
 *     deploy's new process overlapping the old one's last tick — sends
 *     nothing that sender already sent. Then each candidate's own `claim`
 *     (the `nag_sends` compare-and-swap of the nags, the slot-open push's
 *     stamp), in source order. A lost claim drops the candidate.
 *  2. PICKS THE LEAD — the candidate highest in `LEAD_ORDER` among those that
 *     would SOUND on their own (a tie: the sender's own order, so the overdue
 *     checker's "highest priority, most overdue first" stands). A send that
 *     is silent by its own rule (`silent`: the slot-open push and the slot
 *     nag, a Medium named reminder or prompt push, the deadlines nag and its safety net
 *     — ruling 5, sound only on overdue) never takes the lead from one that sounds (Trent, 2026-10-26,
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
 *  4. DELIVERS the lead FIRST, then the rest. If the lead reached no device
 *     on any channel (a bad token, the network: `deliveryFailed`), the next
 *     send that would sound is PROMOTED — delivered as the alert, with its
 *     own " · N more waiting" — and so on until one gets through; nothing is
 *     sent twice, and an Urgent overdue (critical anyway) ends the search.
 *     Then the rest, as planned, and each source's after-step (the overdue
 *     checker's badge-only pushes).
 *
 * A user with one candidate gets exactly what the sender built — no suffix,
 * nothing passive.
 *
 * THE LEAD ORDER (Trent), among the sends that sound: Urgent overdue › High overdue › Urgent reminder ›
 * High reminder › deadlines safety net › Medium overdue › other overdue ›
 * Medium reminder › period › deadlines nag. The reminder kinds are the named
 * reminder pushes (reminder-nags.ts): High and Urgent sound, Medium is silent.
 * A named quota-prompt push (prompt-nags.ts, Push PR 4) RANKS WITH the
 * reminder of its quota's priority (`SAME_RANK`): a High prompt ties a High
 * reminder, and the tie goes to the sender's order (reminders are planned
 * first). Its own kinds (`prompt_*`) keep the projection's counts apart.
 * "Period" is the slot-open
 * push and the slot nag alike (the nag stands down the minute a slot opens,
 * so the two never meet for one user). An overdue summary ranks with its
 * bucket (High's with High overdue, the regular one with other overdue).
 *
 * WEB PUSH: only the overdue checker, the named reminder and prompt pushes
 * and the deadlines nag send there (slot pushes are APNs only), and the
 * deadlines nag and a Medium reminder or prompt push are always silent there. So on a tick led by a
 * period or deadlines push the browser alerts for nothing — one alert per
 * user, not per channel.
 *
 * Split so `scripts/count-pushes.ts` can run the real decisions without
 * delivering: `planTick` (produce, claim, assign) and `runTick` (plan, then
 * deliver). The senders' `check*` entry points run their own source alone.
 */

import { log } from '@/lib/logger'
import { isApnsConfigured } from '@/core/notifications/apns'
import { isWebPushConfigured } from '@/core/notifications/web-push'
import { claimTickMinute } from '@/core/notifications/nag-sends'
import { deliveryFailed, type DeliveryResult } from '@/core/notifications/delivery-result'

/** Every kind a push can be, for the lead order and the projection's counts. */
export type PushKind =
  | 'overdue_urgent'
  | 'overdue_high'
  | 'reminder_urgent'
  | 'prompt_urgent'
  | 'reminder_high'
  | 'prompt_high'
  | 'deadlines_safety_net'
  | 'overdue_medium'
  | 'overdue_other'
  | 'reminder_medium'
  | 'prompt_medium'
  | 'period'
  | 'deadlines'

/**
 * Most important first. The `reminder_*` kinds are the named reminder pushes
 * (reminder-nags.ts), the `prompt_*` kinds the named quota-prompt pushes
 * (prompt-nags.ts) — each listed after its reminder twin, whose rank it
 * shares (`SAME_RANK`).
 */
export const LEAD_ORDER: readonly PushKind[] = [
  'overdue_urgent',
  'overdue_high',
  'reminder_urgent',
  'prompt_urgent',
  'reminder_high',
  'prompt_high',
  'deadlines_safety_net',
  'overdue_medium',
  'overdue_other',
  'reminder_medium',
  'prompt_medium',
  'period',
  'deadlines',
]

/**
 * Kinds that rank as another (Push PR 4, Trent: "prompts rank with reminders
 * of the same priority"). A tie keeps the earlier send, so a reminder and a
 * prompt of one priority lead in the sources' order.
 */
const SAME_RANK: Partial<Record<PushKind, PushKind>> = {
  prompt_urgent: 'reminder_urgent',
  prompt_high: 'reminder_high',
  prompt_medium: 'reminder_medium',
}

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
   * Makes no sound by its own rule (period pushes and nags, a Medium named
   * reminder or prompt push, the deadlines nag and its safety net). Never
   * leads a minute in which something sounds.
   */
  silent?: boolean
  /** Run before the lead is picked; false drops the send (a lost `nag_sends` claim). */
  claim?: () => boolean
  /** Send it; the result says whether it reached anything (delivery-result.ts). */
  deliver: (delivery: Delivery) => Promise<DeliveryResult | void>
}

export interface PlannedSend extends TickSend {
  delivery: Delivery
  /** This user's lead this minute (also a send alone in its tick). */
  lead: boolean
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
  /** The sender's `nag_sends` key for its minute claim (`claimTickMinute`), e.g. `tick-overdue`. */
  minuteKey: string
  plan: (now: Date, channels: Channels) => SourcePlan
}

export function configuredChannels(): Channels {
  return { apns: isApnsConfigured(), webPush: isWebPushConfigured() }
}

const rank = (kind: PushKind) => LEAD_ORDER.indexOf(SAME_RANK[kind] ?? kind)

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
  const leads = new Set<TickSend>()
  for (const list of byUser.values()) {
    if (list.length === 1) {
      deliveries.set(list[0], AS_BUILT)
      leads.add(list[0])
      continue
    }
    const lead = pickLead(list)
    leads.add(lead)
    const others = list.reduce((n, s) => (s === lead ? n : n + s.items), 0)
    for (const send of list) {
      if (send === lead) deliveries.set(send, { passive: false, suffix: moreWaitingSuffix(others) })
      else deliveries.set(send, { passive: !send.alwaysAlerts, suffix: null })
    }
  }
  return sends.map((send) => ({ ...send, delivery: deliveries.get(send)!, lead: leads.has(send) }))
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
      const minuteOf = new Map<number, boolean>()
      const minuteClaimed = (userId: number) => {
        if (!minuteOf.has(userId)) {
          minuteOf.set(userId, claimTickMinute(userId, source.minuteKey, now))
        }
        return minuteOf.get(userId)!
      }
      for (const send of plan.sends) {
        if (!minuteClaimed(send.userId)) continue
        if (!send.claim || send.claim()) claimed.push(send)
      }
      if (plan.after) after.push(plan.after)
    } catch (err) {
      log.error('notifications', `${source.name} error:`, err)
    }
  }
  return { sends: assignDeliveries(claimed), after }
}

/** Deliver one send; a throw is logged and counts as reaching nothing. */
async function deliverOne(send: TickSend, delivery: Delivery): Promise<DeliveryResult | void> {
  try {
    return await send.deliver(delivery)
  } catch (err) {
    log.error('notifications', 'Notification send error:', err)
    return { attempted: 1, delivered: 0 }
  }
}

/**
 * One user's minute: the lead first; if it reached nothing, promote the next
 * send that would sound (`pickLead` over what is left) until one gets
 * through — unless an Urgent overdue is left, which alerts anyway. Then the
 * rest, as planned. Nothing is delivered twice.
 */
async function deliverUserSends(list: PlannedSend[]): Promise<void> {
  const pending: PlannedSend[] = list.filter((s) => !s.lead)
  let current: { send: TickSend; delivery: Delivery } | null = null
  const lead = list.find((s) => s.lead)
  if (lead) current = { send: lead, delivery: lead.delivery }
  while (current) {
    if (!deliveryFailed(await deliverOne(current.send, current.delivery))) break
    if (pending.length === 0 || pending.some((s) => s.alwaysAlerts)) break
    const next = pickLead(pending) as PlannedSend
    pending.splice(pending.indexOf(next), 1)
    const others = pending.reduce((n, s) => n + s.items, 0)
    log.warn('notifications', `Tick lead reached no device for user ${next.userId}: promoting`)
    current = {
      send: next,
      delivery: { passive: false, suffix: others > 0 ? moreWaitingSuffix(others) : null },
    }
  }
  await Promise.all(pending.map((s) => deliverOne(s, s.delivery)))
}

/**
 * Plan the tick, deliver each user's sends (the lead first, `deliverUserSends`),
 * then the after-steps. Failures are logged per send.
 */
export async function runTick(
  sources: TickSource[],
  now: Date = new Date(),
  channels: Channels = configuredChannels(),
): Promise<void> {
  const plan = planTick(sources, now, channels)
  const byUser = new Map<number, PlannedSend[]>()
  for (const send of plan.sends) {
    const list = byUser.get(send.userId) ?? []
    list.push(send)
    byUser.set(send.userId, list)
  }
  await Promise.all([...byUser.values()].map(deliverUserSends))
  for (const step of plan.after) {
    try {
      await step()
    } catch (err) {
      log.error('notifications', 'Notification after-step error:', err)
    }
  }
}
