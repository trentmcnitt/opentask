/**
 * Quota reminders — the pure, client-safe half (2026-09-24).
 *
 * An unmet quota also shows up as a reminder-like PROMPT in a reminder period
 * each day, so it gets the same attention a reminder does. The server computes
 * prompts (`src/core/tasks/quota-prompts.ts`); this file holds what both sides
 * need to agree on: a prompt's identity, and how a day's record reads.
 */
import { DateTime } from 'luxon'
import { quotaPeriodOf } from '@/lib/track'
import type { LabelColor, QuotaDayState, QuotaPromptConfig, Task } from '@/types'
import type { TimeSlot } from '@/lib/time-slot-assign'

/** A quota's period, as `quotaFreqOf` names it (kept literal here to stay import-free). */
export type PromptPeriod = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'

/** One prompt, as GET /api/reminders sends it in `groups[].prompts`. */
export interface QuotaPrompt {
  /** `q:<taskId>:<k>:<date>` — the row's identity; act on it, key rows by it. */
  prompt_key: string
  task_id: number
  /**
   * Daily quotas: the highest prompt number assigned to this period (`k`);
   * the row is done once today's count reaches it. `null` for every other
   * quota, which prompts once a day.
   */
  number: number | null
  title: string
  /** Today's count — 0 once the period has ended, even before the cron runs. */
  current: number
  target: number
  /** The quota's period, for a client's own wording ("· week"). */
  period: PromptPeriod | null
  /**
   * The quota's label colour, resolved server-side so every client draws the
   * same stripe. A `LabelColor` name, never a CSS class. `null` = neutral:
   * no label, no colour configured, or GREEN — green means "met" on quota
   * chips, so a stripe never spends it (`trackStripeClass`).
   */
  stripe_color: LabelColor | null
  /** Considered today (the circle, or "did it", which implies it). */
  considered: boolean
  /** Done for today: daily — count reached `number`; others — progress logged today. */
  done: boolean
}

/** Is a prompt still waiting for today? */
export function promptWaiting(prompt: Pick<QuotaPrompt, 'considered' | 'done'>): boolean {
  return !prompt.considered && !prompt.done
}

/**
 * A reminder group's numbers WITH its prompts. Every count a surface shows —
 * the slot counter, its bar, the day bar, the badge, "waiting so far" —
 * reads these two, so a prompt counts exactly the way a reminder does: waiting
 * until handled, then considered. `considered` on the group itself stays
 * reminder-only (it is what the server and the native apps mean by it).
 */
export interface CountableGroup {
  reminders: unknown[]
  considered?: number
  prompts?: Pick<QuotaPrompt, 'considered' | 'done'>[]
}

export function groupWaiting(group: CountableGroup): number {
  return group.reminders.length + (group.prompts ?? []).filter(promptWaiting).length
}

export function groupConsidered(group: CountableGroup): number {
  return (group.considered ?? 0) + (group.prompts ?? []).filter((p) => !promptWaiting(p)).length
}

/**
 * The owner's local calendar date, YYYY-MM-DD. A quota's day record and every
 * prompt key are scoped to it, so "today" means the same thing to the prompt
 * list, the actions and the undo that restores them.
 */
export function localDate(timezone: string, now: Date = new Date()): string {
  return DateTime.fromJSDate(now).setZone(timezone).toFormat('yyyy-LL-dd')
}

/**
 * A prompt's identity: `q:<taskId>:<k>:<date>`.
 *
 * `k` is the prompt's number for a daily quota — the HIGHEST number assigned
 * to its period, since a period shows at most one row per quota — and 0 for
 * every other quota, which prompts once a day. Numbered prompts share a task
 * id, so clients key rows by this and act on `task_id`. The date makes a key
 * from yesterday's payload refer to yesterday, which the server refuses.
 */
export function promptKey(taskId: number, number: number, date: string): string {
  return `q:${taskId}:${number}:${date}`
}

export interface ParsedPromptKey {
  taskId: number
  number: number
  date: string
}

export function parsePromptKey(key: string): ParsedPromptKey | null {
  const match = /^q:(\d+):(\d+):(\d{4}-\d{2}-\d{2})$/.exec(key)
  if (!match) return null
  const taskId = Number.parseInt(match[1], 10)
  const number = Number.parseInt(match[2], 10)
  if (!Number.isSafeInteger(taskId) || taskId <= 0 || !Number.isSafeInteger(number)) return null
  return { taskId, number, date: match[3] }
}

/**
 * A quota's record for `date`. A record from another day is an empty one —
 * nothing clears it at midnight, it simply stops applying.
 */
export function dayStateFor(state: QuotaDayState | null | undefined, date: string): QuotaDayState {
  if (state && state.date === date) {
    return {
      date,
      logged: Math.max(0, state.logged ?? 0),
      did: Array.isArray(state.did) ? state.did : [],
      considered: Array.isArray(state.considered) ? state.considered : [],
    }
  }
  return { date, logged: 0, did: [], considered: [] }
}

/**
 * Today's record after `applied` progress was logged from anywhere — the
 * widget, the watch, the web chips, a prompt's "did it". Net, and never below
 * zero: a +1 corrected by a −1 is "nothing logged today", so the prompt it hid
 * comes back.
 */
export function withLogged(
  state: QuotaDayState | null | undefined,
  date: string,
  applied: number,
): QuotaDayState {
  const today = dayStateFor(state, date)
  return { ...today, logged: Math.max(0, today.logged + applied) }
}
/**
 * The one fallback rule (header of src/core/tasks/quota-prompts.ts): the chosen slot if it exists, else
 * the user's default if it exists, else the first period of the day. Returns
 * an index into `slots` (sorted by start), or -1 when the user has no slots at
 * all — then every prompt sits in the un-slotted "Anytime" group.
 */
export function resolvePromptSlot(
  slots: Pick<TimeSlot, 'id'>[],
  chosen: number | null | undefined,
  userDefault: number | null | undefined,
): number {
  if (slots.length === 0) return -1
  for (const id of [chosen, userDefault]) {
    if (id === null || id === undefined) continue
    const index = slots.findIndex((s) => s.id === id)
    if (index >= 0) return index
  }
  return 0
}

/** Does this quota prompt at all? Its own switch, else its period's default. */
export function promptEnabled(task: Pick<Task, 'rrule' | 'quota_prompt_config'>): boolean {
  const explicit = task.quota_prompt_config?.enabled
  if (explicit !== undefined) return explicit
  const period = quotaPeriodOf(task.rrule)
  return period !== null && period.freq !== 'YEARLY'
}

/** Daily in the counting sense: resets every day. `INTERVAL=2` is not. */
export function isDailyQuota(task: Pick<Task, 'rrule'>): boolean {
  const period = quotaPeriodOf(task.rrule)
  return period?.freq === 'DAILY' && period.interval === 1
}

/**
 * Which slot (index into `slots`) each of a daily quota's numbers 1..N sits
 * in. Unassigned numbers spread one per period from the quota's own slot and
 * CLAMP at the last period — "#4 in Early morning" after "#3 in Evening"
 * would be nonsense.
 */
export function assignDailyNumbers(
  target: number,
  slots: Pick<TimeSlot, 'id'>[],
  config: QuotaPromptConfig | null,
  userDefault: number | null,
): number[] {
  const base = resolvePromptSlot(slots, config?.slot_id, userDefault)
  const out: number[] = []
  for (let k = 1; k <= target; k++) {
    const override = config?.numbers?.[String(k)]
    const overrideIndex =
      override === null || override === undefined ? -1 : slots.findIndex((s) => s.id === override)
    out.push(
      overrideIndex >= 0 ? overrideIndex : base < 0 ? -1 : Math.min(base + k - 1, slots.length - 1),
    )
  }
  return out
}
