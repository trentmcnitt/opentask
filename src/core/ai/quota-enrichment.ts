/**
 * QUOTA ENRICHMENT — the pure half (2026-10-24; .tmp/plan-quota-enrichment-1022.md,
 * APPROVED 10-22: option A, units as recommended, inside the enrichment feature).
 *
 * A quota made from free text: `POST /api/tasks {"title": "eggs twice a week",
 * "is_tracked": true}`. The caller declares the kind; the server stores a
 * PROVISIONAL quota at once (`QUOTA_PROVISIONAL_RULE`, target 1, with
 * `ai-to-process`), and enrichment then reads the count, the period and the
 * reminder period out of the words — through the quota user prompt
 * (`buildQuotaEnrichmentUserPrompt`), the shared schema's `quota_*` fields, and
 * `postProcessQuotaEnrichment` here, which turns the answer into what is
 * stored. The write is `applyQuotaEnrichment` (enrichment.ts), through
 * `collectFieldChanges`, so every quota invariant applies.
 *
 * Everything here is pure, so production and the quality harness call the same
 * function and only the model call is duplicated.
 */

import { log } from '@/lib/logger'
import {
  QUOTA_INTERVAL_MAX,
  intervalPeriodName,
  quotaPeriodOf,
  quotaRule,
  type QuotaFreq,
} from '@/lib/track'
import { nearestSlot, parseHHMM, type TimeSlot } from '@/lib/time-slot-assign'
import type { QuotaPromptConfig, Task } from '@/types'
import { filterExplicitLabels } from './explicit-labels'
import type { EnrichmentResult } from './types'

/**
 * The period a quota made from words alone starts with, before enrichment has
 * read it: weekly, target 1 (plan §10.1 — a wrong daily would prompt every
 * day). Enrichment replaces it when the words name a period, and keeps it when
 * they name none ("piano scales").
 */
export const QUOTA_PROVISIONAL_RULE = 'FREQ=WEEKLY'

/** The answer with the quota fields nulled — for a task or a reminder, which never use them. */
export function withoutQuotaFields<T extends EnrichmentResult>(enrichment: T): T {
  return {
    ...enrichment,
    quota_target: null,
    quota_period: null,
    quota_interval: null,
    quota_prompt_time: null,
    quota_prompt_enabled: null,
  }
}

/**
 * What a quota's enrichment stores. A null leaves the stored value alone
 * (set-only, like targets and deadlines: the model's silence never clears).
 */
export interface QuotaEnrichmentPlan {
  title: string
  notes: string | null
  /** 0 = unstated, left alone. */
  priority: number
  /** At most one: a quota is filed under its first label (`groupByLabel`). */
  labels: string[]
  /** The period rule, canonical (`quotaRule`), or null to keep the current one. */
  rrule: string | null
  /** How many times per period, or null to keep the current target. */
  progress_target: number | null
  /** The reminder period the user named (`quota_prompt_config.slot_id`), or null. */
  prompt_slot_id: number | null
  /** Its label — for the quality harness and the logs. */
  prompt_slot_label: string | null
  /** `quota_prompt_config.enabled`: false for "don't remind me", or null. */
  prompt_enabled: boolean | null
}

const PERIOD_FREQ: Record<NonNullable<EnrichmentResult['quota_period']>, QuotaFreq> = {
  day: 'DAILY',
  week: 'WEEKLY',
  month: 'MONTHLY',
  year: 'YEARLY',
}

/**
 * The period from the model's `quota_*` fields, or — when it ignored the quota
 * prompt and answered like a task ("twice a week" → `FREQ=WEEKLY;BYDAY=TU,TH`)
 * — from its rule: the FREQ and INTERVAL, and as many times as the rule names
 * days (BYDAY on a weekly rule, BYMONTHDAY on a monthly one). An INTERVAL past
 * the period's cap (`QUOTA_INTERVAL_MAX`: "every 45 days") is DROPPED, not
 * clamped — the provisional period stays, and the user sets it.
 */
function quotaPeriodFromAnswer(parsed: EnrichmentResult): {
  rrule: string | null
  impliedTarget: number | null
} {
  let freq: QuotaFreq | null = parsed.quota_period ? PERIOD_FREQ[parsed.quota_period] : null
  let interval = parsed.quota_interval ?? 1
  let impliedTarget: number | null = null

  if (!freq && parsed.rrule) {
    const period = quotaPeriodOf(parsed.rrule)
    if (period) {
      freq = period.freq
      interval = period.interval
      const days = ruleDayCount(parsed.rrule, period.freq)
      if (days > 1) impliedTarget = days
      log.info('ai', `Quota enrichment: period read from a task-style rule "${parsed.rrule}"`)
    }
  }
  if (!freq) return { rrule: null, impliedTarget: null }
  if (interval > QUOTA_INTERVAL_MAX[freq]) {
    log.info(
      'ai',
      `Quota enrichment: interval ${interval} is past the ${freq} cap — period not applied`,
    )
    return { rrule: null, impliedTarget: null }
  }
  return { rrule: quotaRule(freq, interval), impliedTarget }
}

/** How many days a task-style rule names — BYDAY on WEEKLY, BYMONTHDAY on MONTHLY. */
function ruleDayCount(rrule: string, freq: QuotaFreq): number {
  const part = freq === 'WEEKLY' ? 'BYDAY' : freq === 'MONTHLY' ? 'BYMONTHDAY' : null
  if (!part) return 0
  const value = new RegExp(`(?:^|;)${part}=([^;]+)`, 'i').exec(rrule)?.[1]
  return value ? value.split(',').filter(Boolean).length : 0
}

/**
 * The reminder period the user named: a slot label (case-insensitive), else an
 * HH:MM snapped to the NEAREST slot (the reminder's rule — a stated time is a
 * near miss to correct, `sanitizeReminderEnrichment`). Nothing named → null,
 * never the default: the quota then prompts where the user's default says.
 */
function promptSlotFromAnswer<T extends Pick<TimeSlot, 'label' | 'start_time'>>(
  value: string | null,
  slots: T[],
): T | null {
  const said = value?.trim()
  if (!said) return null
  const byLabel = slots.find((s) => s.label.toLowerCase() === said.toLowerCase())
  if (byLabel) return byLabel
  const minutes = parseHHMM(said)
  return minutes === null ? null : nearestSlot(minutes, slots)
}

/**
 * The whole deterministic post-process of a quota's enrichment. Production
 * (`enrichTask`) and the quality harness both call it.
 *
 * What a quota never carries (a date, a deadline, a pace, a deck, a nag, a
 * recurrence mode, a project) is simply not in the plan; labels are
 * explicit-only and at most one; the period comes from `quota_*` (or a
 * task-style rule, as a fallback); the target from `quota_target` (or the
 * rule's day count); the reminder period from `quota_prompt_time`.
 */
export function postProcessQuotaEnrichment(
  parsed: EnrichmentResult,
  inputText: string,
  slots: Array<Pick<TimeSlot, 'id' | 'label' | 'start_time'>>,
): QuotaEnrichmentPlan {
  const { rrule, impliedTarget } = quotaPeriodFromAnswer(parsed)
  const target = parsed.quota_target ?? impliedTarget
  const slot = promptSlotFromAnswer(parsed.quota_prompt_time ?? null, slots)
  if (parsed.quota_prompt_time && !slot) {
    log.info('ai', `Quota enrichment: no period matches "${parsed.quota_prompt_time}"`)
  }
  return {
    title: parsed.title.trim(),
    notes: parsed.notes?.trim() || null,
    priority: parsed.priority,
    labels: filterExplicitLabels(parsed.labels, inputText).slice(0, 1),
    rrule,
    progress_target: target !== null && target >= 1 && target <= 1000 ? target : null,
    prompt_slot_id: slot?.id ?? null,
    prompt_slot_label: slot?.label ?? null,
    prompt_enabled: parsed.quota_prompt_enabled ?? null,
  }
}

/**
 * The plan's reminder settings merged over the stored config — `slot_id` only
 * when a period was named, `enabled` only when said, never `numbers` (a daily
 * quota's numbers spread from the base as a new one's do). Null when the plan
 * says nothing (nothing to write).
 */
export function quotaPromptConfigFor(
  stored: QuotaPromptConfig | null,
  plan: Pick<QuotaEnrichmentPlan, 'prompt_slot_id' | 'prompt_enabled'>,
): QuotaPromptConfig | null {
  const patch: QuotaPromptConfig = {}
  if (plan.prompt_slot_id !== null) patch.slot_id = plan.prompt_slot_id
  if (plan.prompt_enabled !== null) patch.enabled = plan.prompt_enabled
  if (Object.keys(patch).length === 0) return null
  return { ...(stored ?? {}), ...patch }
}

const PER_PERIOD: Record<QuotaFreq, string> = {
  DAILY: 'a day',
  WEEKLY: 'a week',
  MONTHLY: 'a month',
  YEARLY: 'a year',
}

/**
 * A quota's count and period as the toast and the push say it: "3× a week",
 * "Every day", "Every 2 weeks", "2× every 3 months". Null without a period.
 */
export function quotaCadenceWords(task: Pick<Task, 'rrule' | 'progress_target'>): string | null {
  const period = quotaPeriodOf(task.rrule)
  if (!period) return null
  const per = period.interval > 1 ? intervalPeriodName(period.freq, period.interval) : null
  if (task.progress_target <= 1) {
    const name = per ?? PER_PERIOD[period.freq].replace(/^a /, '')
    return `Every ${name.replace(/^every /, '')}`
  }
  return `${task.progress_target}× ${per ?? PER_PERIOD[period.freq]}`
}

/**
 * A quota's reminder setting as words: "No daily reminder" when turned off,
 * "Reminds at Midday" for a period it was given; null when it follows the
 * defaults (nothing worth saying).
 */
export function quotaPromptWords(
  task: Pick<Task, 'quota_prompt_config'>,
  slots: Array<Pick<TimeSlot, 'id' | 'label'>>,
): string | null {
  const config = task.quota_prompt_config
  if (config?.enabled === false) return 'No reminder'
  const slotId = config?.slot_id
  if (slotId === null || slotId === undefined) return null
  const slot = slots.find((s) => s.id === slotId)
  return slot ? `Reminds at ${slot.label}` : null
}
