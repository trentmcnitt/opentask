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
 *   by others, and prompting Trent about Casey's quota would be wrong.
 * - Off switches: the user's `quota_prompts_enabled`, and the server-wide
 *   `OPENTASK_QUOTA_PROMPTS=off`. Either one makes every group's prompts empty.
 *
 * WHERE THEY GO: a NEW `groups[].prompts` field on GET /api/reminders.
 * `groups[].reminders` stays reminder-only, which is what keeps native builds
 * that predate prompts — they ignore unknown fields — safe. That is also why
 * this is a sibling of `getRemindersBySlot` rather than part of it.
 * The slot notifications and hourly nags count prompts too (phase 3, once the
 * native checklist could show them): `waitingBySlot` in
 * `src/core/notifications/slot-reminders.ts` reads this function, so both
 * off switches silence prompts there as well. The app-icon badge never
 * counts them.
 *
 * SLOT RESOLUTION: a prompt stores slot IDS (in its config, and the user's
 * default in `users.quota_prompt_slot_id`) and resolves them here, at read
 * time. One fallback rule, everywhere: the quota's own slot if it still
 * exists, else the user's default if IT still exists, else the first period of
 * the day. A deleted slot therefore never strands a prompt, and undoing the
 * delete (which restores the slot under its original id) puts it back.
 */

import { getDb } from '@/core/db'
import { listTimeSlots } from '@/core/time-slots'
import { getLabelColor } from '@/lib/label-colors'
import {
  assignDailyNumbers,
  dayStateFor,
  isDailyQuota,
  localDate,
  promptEnabled,
  promptKey,
  resolvePromptSlot,
  type QuotaPrompt,
} from '@/lib/quota-prompts'
import { effectiveProgress, isTracked, quotaLabelOf, quotaPeriodOf } from '@/lib/track'
import type { LabelColor, LabelConfig, Task } from '@/types'
import { getTasks } from './create'

// The prompt's shape lives in the client-safe half, so the web surfaces and
// the server agree on one definition.
export {
  assignDailyNumbers,
  isDailyQuota,
  promptEnabled,
  promptWaiting,
  resolvePromptSlot,
  type QuotaPrompt,
} from '@/lib/quota-prompts'

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
  const quotas = getTasks({ userId, done: false, kind: 'quota', limit: 1000 }).filter(
    (t) => isTracked(t) && t.user_id === userId && promptEnabled(t),
  )

  const slotIdAt = (slotIndex: number) => (slotIndex < 0 ? null : slots[slotIndex].id)
  const push = (slotIndex: number, prompt: Omit<QuotaPrompt, 'slot_id'>) => {
    const slotId = slotIdAt(slotIndex)
    bySlot.set(slotId, [...(bySlot.get(slotId) ?? []), { ...prompt, slot_id: slotId }])
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
      has_notes: !!task.notes?.trim(),
    }

    if (isDailyQuota(task)) {
      // One row per period, standing for every number assigned there; it is
      // keyed and judged by the highest of them.
      const numbersIn = new Map<number, number[]>()
      assignDailyNumbers(target, slots, task.quota_prompt_config, settings.defaultSlotId).forEach(
        (slotIndex, i) => numbersIn.set(slotIndex, [...(numbersIn.get(slotIndex) ?? []), i + 1]),
      )
      for (const [slotIndex, numbers] of numbersIn) {
        const k = numbers[numbers.length - 1]
        const key = promptKey(task.id, k, date)
        push(slotIndex, {
          ...base,
          prompt_key: key,
          number: k,
          numbers,
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
      numbers: null,
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
