/**
 * Quota reminders (2026-09-24) — "prompts".
 *
 * Trent never opens the Quotas surface, so quotas go undone; reminders are
 * what he sees and gets nagged about. So every UNMET quota also appears as a
 * reminder-like PROMPT in a reminder period (time slot) each day, with its
 * progress on it: "Cook daily vegetables · 3/5".
 *
 * Ticking a reminder means "considered" — seen and handled — not "did it". A
 * prompt therefore has TWO actions (Trent's final decision, 2026-09-24):
 *   - CONSIDER (the round circle, as on a reminder): handled for today, no
 *     progress logged. Consider-all only ever considers.
 *   - DID IT (the square checkbox by the count): progress, and considered too.
 * Both live in `./quota-prompt-actions.ts`; this file only COMPUTES prompts.
 *
 * NOT REAL TASKS. Prompts are computed at read time from each quota's state
 * plus its `quota_day_state` (the owner's day: progress logged, prompts
 * considered, prompts done). Nothing is stored per prompt, so there is nothing
 * to sync, duplicate or clean up. Each prompt is identified by its
 * `prompt_key` (`q:<taskId>:<k>:<date>`, see `@/lib/quota-prompts`).
 *
 * THE RULES
 * - Daily quota, target N: numbers 1..N spread over the day's periods,
 *   starting at the quota's period and clamping at the last one (never
 *   wrapping back to early morning); each number's period can be overridden.
 *   At most ONE row per quota per period: the row stands for the highest
 *   number assigned there (`k`), is done once today's count reaches k, and its
 *   label shows progress ("Daily Walks · 1/2"), never "#1".
 * - Every other quota (weekly, monthly, yearly, daily with INTERVAL > 1):
 *   one prompt a day in its period. Done for today once ANY progress is
 *   logged today from anywhere; gone until the period resets once met.
 * - Yearly and period-less quotas default OFF; everything else ON, for every
 *   user. `quota_prompt_config.enabled` overrides.
 * - Only the user's OWN quotas. `getQuotas` includes shared-project rows owned
 *   by others, and prompting Trent about Kelly's quota would be wrong.
 * - Off switches: the user's `quota_prompts_enabled`, and the server-wide
 *   `OPENTASK_QUOTA_PROMPTS=off`. Either one makes every group's prompts empty.
 *
 * WHERE THEY GO: a NEW `groups[].prompts` field on GET /api/reminders.
 * `groups[].reminders` and the slot notifications stay reminder-only (phase 1),
 * which is what keeps current native builds — which ignore unknown fields —
 * safe. That is also why this is a sibling of `getRemindersBySlot` rather than
 * part of it: `countRemindersBySlot` feeds the notification cron.
 *
 * SLOT RESOLUTION: a prompt stores slot IDS (in its config, and the user's
 * default in `users.quota_prompt_slot_id`) and resolves them here, at read
 * time. One fallback rule, everywhere: the quota's own slot if it still
 * exists, else the user's default if IT still exists, else the first period of
 * the day. A deleted slot therefore never strands a prompt, and undoing the
 * delete (which restores the slot under its original id) puts it back.
 */

import { getDb } from '@/core/db'
import { listTimeSlots, type TimeSlot } from '@/core/time-slots'
import { getLabelColor } from '@/lib/label-colors'
import { dayStateFor, localDate, promptKey } from '@/lib/quota-prompts'
import {
  effectiveProgress,
  isTracked,
  quotaLabelOf,
  quotaPeriodOf,
  type QuotaFreq,
} from '@/lib/track'
import type { LabelColor, LabelConfig, QuotaPromptConfig, Task } from '@/types'
import { getTasks } from './create'

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
  period: QuotaFreq | null
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

/** The server-wide kill switch, read per call so it can be flipped without a code change. */
export function quotaPromptsEnabledGlobally(): boolean {
  return (process.env.OPENTASK_QUOTA_PROMPTS ?? '').trim().toLowerCase() !== 'off'
}

interface UserPromptSettings {
  enabled: boolean
  defaultSlotId: number | null
  labelConfig: LabelConfig[]
}

function readUserSettings(userId: number): UserPromptSettings {
  const row = getDb()
    .prepare(
      'SELECT quota_prompts_enabled, quota_prompt_slot_id, label_config FROM users WHERE id = ?',
    )
    .get(userId) as
    | { quota_prompts_enabled: number; quota_prompt_slot_id: number | null; label_config: string }
    | undefined
  let labelConfig: LabelConfig[] = []
  try {
    labelConfig = row?.label_config ? (JSON.parse(row.label_config) as LabelConfig[]) : []
  } catch {
    labelConfig = []
  }
  return {
    enabled: (row?.quota_prompts_enabled ?? 1) !== 0,
    defaultSlotId: row?.quota_prompt_slot_id ?? null,
    labelConfig,
  }
}

/**
 * The one fallback rule (see the header): the chosen slot if it exists, else
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

function stripeColor(task: Task, labelConfig: LabelConfig[]): LabelColor | null {
  const label = quotaLabelOf(task)
  const color = label ? getLabelColor(label, labelConfig) : null
  return color === 'green' ? null : color
}

/**
 * Today's prompts for a user, by slot id (`null` = the un-slotted group).
 * Every prompt assigned today is returned, handled ones included with their
 * `considered`/`done` flags — the slot bar sizes a period by its day total,
 * which must not shrink as things are handled.
 */
export function getQuotaPromptsBySlot(
  userId: number,
  timezone: string,
  now: Date = new Date(),
): Map<number | null, QuotaPrompt[]> {
  const bySlot = new Map<number | null, QuotaPrompt[]>()
  if (!quotaPromptsEnabledGlobally()) return bySlot
  const settings = readUserSettings(userId)
  if (!settings.enabled) return bySlot

  const slots = listTimeSlots(userId)
  const date = localDate(timezone, now)
  const quotas = getTasks({ userId, done: false, limit: 1000 }).filter(
    (t) => isTracked(t) && t.user_id === userId && promptEnabled(t),
  )

  const push = (slotIndex: number, prompt: QuotaPrompt) => {
    const slotId = slotIndex < 0 ? null : slots[slotIndex].id
    bySlot.set(slotId, [...(bySlot.get(slotId) ?? []), prompt])
  }

  for (const task of quotas) {
    const current = effectiveProgress(task, timezone, now)
    const target = Math.max(1, task.progress_target ?? 1)
    const day = dayStateFor(task.quota_day_state, date)
    const base = {
      task_id: task.id,
      title: task.title,
      current,
      target,
      period: quotaPeriodOf(task.rrule)?.freq ?? null,
      stripe_color: stripeColor(task, settings.labelConfig),
    }

    if (isDailyQuota(task)) {
      // One row per period, standing for the highest number assigned there.
      const highest = new Map<number, number>()
      assignDailyNumbers(target, slots, task.quota_prompt_config, settings.defaultSlotId).forEach(
        (slotIndex, i) => highest.set(slotIndex, Math.max(highest.get(slotIndex) ?? 0, i + 1)),
      )
      for (const [slotIndex, k] of highest) {
        const key = promptKey(task.id, k, date)
        push(slotIndex, {
          ...base,
          prompt_key: key,
          number: k,
          considered: day.considered.includes(key),
          done: current >= k,
        })
      }
      continue
    }

    const key = promptKey(task.id, 0, date)
    const did = day.did.includes(key)
    const considered = day.considered.includes(key)
    const loggedToday = day.logged > 0
    // Met before today and untouched today: gone until the period resets.
    // Met TODAY (by a did-it or a +1) stays, handled, so today's count of
    // handled prompts does not drop a row the user just finished.
    if (current >= target && !loggedToday && !did && !considered) continue
    push(resolvePromptSlot(slots, task.quota_prompt_config?.slot_id, settings.defaultSlotId), {
      ...base,
      prompt_key: key,
      number: null,
      considered,
      done: did || loggedToday,
    })
  }

  // Frozen alphabetical order, the Quotas surface's own (`trackedItems`), so
  // acting on one never reorders the rest under the finger.
  for (const [slotId, prompts] of bySlot) {
    bySlot.set(
      slotId,
      prompts.sort(
        (a, b) =>
          a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) ||
          a.task_id - b.task_id,
      ),
    )
  }
  return bySlot
}

/** Is a prompt still waiting for today? */
export function promptWaiting(prompt: Pick<QuotaPrompt, 'considered' | 'done'>): boolean {
  return !prompt.considered && !prompt.done
}
