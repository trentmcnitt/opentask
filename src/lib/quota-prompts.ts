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
  /**
   * Daily quotas: EVERY number this row stands for, ascending (`number` is the
   * last of them) — what moving the row to another period moves, so the
   * quota's other numbers stay where they are. `null` for every other quota.
   */
  numbers: number[] | null
  /** The period this row sits in (`time_slots.id`), `null` = un-slotted. */
  slot_id: number | null
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
  /**
   * The quota has notes (2026-09-25) — a prompt row wears the reminder rows'
   * `NotesMarker` for it. A flag, not the text: the rows only mark that a note
   * exists, and the quota's bubble and editor are where it is read.
   */
  has_notes: boolean
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
  const logged = Math.max(0, today.logged + applied)
  // Back to nothing logged today: a non-daily "did it" (key number 0) was
  // taken back too, so it must not keep the prompt done — nor block the next
  // "did it" as a duplicate. A daily prompt's done-ness is its count, so its
  // keys stay.
  const did = logged === 0 ? today.did.filter((k) => !/^q:\d+:0:/.test(k)) : today.did
  return { ...today, logged, did }
}
/**
 * The one fallback rule (header of src/core/tasks/quota-prompts.ts): the chosen slot if it exists, else
 * the user's default if it exists, else the first period of the day. Returns
 * an index into `slots` (sorted by start), or -1 when the user has no slots at
 * all — then every prompt sits in the un-slotted "Anytime" group.
 *
 * Deleting a slot no longer leans on this: `deleteTimeSlot` repoints stored
 * ids to the nearest remaining slot (2026-09-25). A missing id here means a
 * stale one from before that rule — the fallback keeps it from stranding.
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

/**
 * The config that moves one prompt ROW to `toSlotId` (2026-09-25, the period
 * chips in a prompt's bubble; the watch's hold list does the same in Swift).
 *
 * - A daily row moves only the numbers it stands for (`prompt.numbers`), as
 *   per-number overrides; the quota's other numbers keep their places.
 * - Every other quota moves as a whole: `slot_id`.
 *
 * Merged over the stored config, never replacing it: a PATCH replaces the
 * whole object, so dropping `enabled` or another number's override here would
 * silently undo a choice the user made in the editor.
 */
export function movedPromptConfig(
  config: QuotaPromptConfig | null | undefined,
  prompt: Pick<QuotaPrompt, 'numbers'>,
  toSlotId: number,
): QuotaPromptConfig {
  const base = config ?? {}
  if (prompt.numbers && prompt.numbers.length > 0) {
    const moved = Object.fromEntries(prompt.numbers.map((k) => [String(k), toSlotId]))
    return { ...base, numbers: { ...(base.numbers ?? {}), ...moved } }
  }
  return { ...base, slot_id: toSlotId }
}

/** The part of a reminder group a prompt move touches. */
export interface PromptGroup {
  slot: { id: number } | null
  prompts: QuotaPrompt[]
}

/**
 * Groups with each prompt in `moves` (prompt_key → slot id) shown in its new
 * period — the optimistic half of a move; the server's next payload replaces
 * it. Idempotent: a prompt already in its target (or no longer in the payload
 * under that key, as after a daily merge) is left alone, so re-applying a move
 * to a payload that already has it changes nothing.
 *
 * A daily row landing in a period that already holds a row of the same quota
 * MERGES into it, as the server would: one row per quota per period, keyed and
 * judged by its highest number.
 */
export function applyPromptMoves<G extends PromptGroup>(
  groups: G[],
  moves: Map<string, number>,
): G[] {
  let out = groups
  for (const [key, toSlotId] of moves) {
    const fromIndex = out.findIndex(
      (g) => (g.slot?.id ?? null) !== toSlotId && g.prompts.some((p) => p.prompt_key === key),
    )
    const toIndex = out.findIndex((g) => g.slot?.id === toSlotId)
    if (fromIndex < 0 || toIndex < 0) continue
    const moving = out[fromIndex].prompts.find((p) => p.prompt_key === key)!
    const target = out[toIndex].prompts
    const sibling = target.find((p) => p.task_id === moving.task_id)
    let prompts: QuotaPrompt[]
    if (sibling && sibling.numbers && moving.numbers) {
      const numbers = [...new Set([...sibling.numbers, ...moving.numbers])].sort((a, b) => a - b)
      const number = numbers[numbers.length - 1]
      const top = (sibling.number ?? 0) >= (moving.number ?? 0) ? sibling : moving
      const date = parsePromptKey(top.prompt_key)?.date ?? ''
      const merged: QuotaPrompt = {
        ...top,
        slot_id: toSlotId,
        numbers,
        number,
        prompt_key: promptKey(moving.task_id, number, date),
        done: top.current >= number,
      }
      prompts = target.map((p) => (p === sibling ? merged : p))
    } else {
      prompts = [...target.filter((p) => p !== sibling), { ...moving, slot_id: toSlotId }]
      prompts.sort(
        (a, b) =>
          a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) ||
          a.task_id - b.task_id,
      )
    }
    out = out.map((g, i) => {
      if (i === fromIndex) return { ...g, prompts: g.prompts.filter((p) => p !== moving) }
      if (i === toIndex) return { ...g, prompts }
      return g
    })
  }
  return out
}

/**
 * A daily quota up to this target gets one chip row PER NUMBER in a Track
 * chip's bubble; above it, one row per period its numbers currently sit in.
 *
 * Why a cap at all: per-number rows are what the quota editor shows, and for
 * "floss twice a day" they are the clearest answer. For "8 glasses of water"
 * they are eight near-identical rows of chips — a wall to read in a bubble
 * meant to be glanced at. Grouped, it is never more rows than the user has
 * periods (and fewer once numbers share one), and each group is exactly a
 * Reminders prompt row (the server's own grouping), so a tap moves what that
 * row's own chips would. 4 is where the two kinds of row stop being about the
 * same size: five default periods group a target of 5+ into at most 5 rows.
 *
 * Fitting is not this cap's job: with five periods a compact row wraps to two
 * lines, and even four of them can outgrow a phone's room above or below a
 * chip — the bubble scrolls within the space it has (`TrackChipPopover`).
 */
export const MAX_PER_NUMBER_ROWS = 4

/** One chip row: the numbers it moves (a daily quota) and where they are now. */
export interface QuotaPeriodRow {
  /** Daily: the numbers this row stands for, ascending. `null` = the whole quota. */
  numbers: number[] | null
  /** The period they sit in now (`time_slots.id`). */
  slotId: number
}

/**
 * The period chip rows for a quota's own bubble (a Track chip, 2026-09-25),
 * by the server's placement rule — the same `resolvePromptSlot` /
 * `assignDailyNumbers` the editor's pickers show. Empty when the quota has no
 * daily reminder (its switch is off, or it is yearly/period-less by default)
 * or the user has no periods to move it between.
 *
 * - Not daily: one row, the quota's period (moves `slot_id`).
 * - Daily, target ≤ `MAX_PER_NUMBER_ROWS`: one row per number.
 * - Daily, above it: one row per period, holding the numbers now there.
 */
export function quotaPeriodRows(
  task: Pick<Task, 'rrule' | 'progress_target' | 'quota_prompt_config'>,
  slots: Pick<TimeSlot, 'id'>[],
  userDefault: number | null,
): QuotaPeriodRow[] {
  if (slots.length === 0 || !promptEnabled(task)) return []
  const config = task.quota_prompt_config ?? null
  if (!isDailyQuota(task)) {
    return [
      { numbers: null, slotId: slots[resolvePromptSlot(slots, config?.slot_id, userDefault)].id },
    ]
  }
  const target = Math.max(1, task.progress_target ?? 1)
  const placed = assignDailyNumbers(target, slots, config, userDefault)
  if (target <= MAX_PER_NUMBER_ROWS) {
    return placed.map((index, i) => ({ numbers: [i + 1], slotId: slots[index].id }))
  }
  const rows: QuotaPeriodRow[] = []
  placed.forEach((index, i) => {
    const row = rows.find((r) => r.slotId === slots[index].id)
    if (row) row.numbers!.push(i + 1)
    else rows.push({ numbers: [i + 1], slotId: slots[index].id })
  })
  return rows.sort(
    (a, b) => slots.findIndex((s) => s.id === a.slotId) - slots.findIndex((s) => s.id === b.slotId),
  )
}

/**
 * A row's numbers, short: "2nd of 2", "1st–3rd of 8", "1st, 4th–5th of 6".
 * Runs of consecutive numbers collapse, so a grouped row of a large target
 * stays one short line.
 */
export function numbersLabel(numbers: number[], target: number): string {
  const runs: [number, number][] = []
  for (const n of numbers) {
    const last = runs[runs.length - 1]
    if (last && n === last[1] + 1) last[1] = n
    else runs.push([n, n])
  }
  const text = runs
    .map(([a, b]) => (a === b ? ordinal(a) : `${ordinal(a)}–${ordinal(b)}`))
    .join(', ')
  return `${text} of ${target}`
}

/** 1st, 2nd, 3rd, 11th — a daily quota's numbers, wherever they are named. */
export function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}
