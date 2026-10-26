/**
 * Quota enrichment — the post-process (2026-10-24)
 *
 * `postProcessQuotaEnrichment` turns the model's answer into what a quota
 * stores: the period through `quotaRule` (from the `quota_*` fields, or a
 * task-style rule as a fallback), the target, at most one explicit label, and
 * the reminder period the user named. Pure — no AI and no database.
 */

import { describe, test, expect } from 'vitest'
import {
  postProcessQuotaEnrichment,
  quotaCadenceWords,
  quotaPromptConfigFor,
  quotaPromptWords,
  withoutQuotaFields,
} from '@/core/ai/quota-enrichment'
import { postProcessTaskEnrichment, sanitizeReminderEnrichment } from '@/core/ai/enrichment'
import { DEFAULT_TIME_SLOTS, type TimeSlot } from '@/lib/time-slot-assign'
import type { EnrichmentResult } from '@/core/ai/types'
import { CALENDAR_DAY_START } from '@/lib/opentask-day'

const SLOTS: TimeSlot[] = DEFAULT_TIME_SLOTS.map((slot, index) => ({
  id: index + 1,
  user_id: 1,
  label: slot.label,
  start_time: slot.start_time,
  sort_order: index,
  created_at: '2026-01-01T00:00:00.000Z',
}))
const MIDDAY = SLOTS.find((s) => s.label === 'Midday')!
const EVENING = SLOTS.find((s) => s.label === 'Evening')!

function answer(overrides: Partial<EnrichmentResult> = {}): EnrichmentResult {
  return {
    reasoning: 'test',
    title: 'Eggs',
    due_at: null,
    deadline_at: null,
    horizon: null,
    priority: 0,
    labels: [],
    project_name: null,
    rrule: null,
    auto_snooze_minutes: null,
    recurrence_mode: null,
    notes: null,
    quota_target: null,
    quota_period: null,
    quota_interval: null,
    quota_prompt_time: null,
    quota_prompt_enabled: null,
    ...overrides,
  }
}

describe('postProcessQuotaEnrichment — period and target', () => {
  test('quota fields → the canonical period rule and the target', () => {
    const plan = postProcessQuotaEnrichment(
      answer({ quota_target: 2, quota_period: 'week' }),
      'eggs twice a week',
      SLOTS,
    )
    expect(plan.rrule).toBe('FREQ=WEEKLY')
    expect(plan.progress_target).toBe(2)
  })

  test('an interval rides in the rule; interval 1 is left out', () => {
    expect(
      postProcessQuotaEnrichment(
        answer({ quota_period: 'day', quota_interval: 2 }),
        'stretch every other day',
        SLOTS,
      ).rrule,
    ).toBe('FREQ=DAILY;INTERVAL=2')
    expect(
      postProcessQuotaEnrichment(
        answer({ quota_period: 'month', quota_interval: 1 }),
        'x monthly',
        SLOTS,
      ).rrule,
    ).toBe('FREQ=MONTHLY')
  })

  test('an interval past the cap drops the period (not clamped)', () => {
    const plan = postProcessQuotaEnrichment(
      answer({ quota_period: 'day', quota_interval: 45, quota_target: 1 }),
      'sauna every 45 days',
      SLOTS,
    )
    expect(plan.rrule).toBeNull()
    expect(plan.progress_target).toBe(1)
    // Yearly allows only 1.
    expect(
      postProcessQuotaEnrichment(answer({ quota_period: 'year', quota_interval: 2 }), 'x', SLOTS)
        .rrule,
    ).toBeNull()
  })

  test('no period named → no rule (the provisional one stays)', () => {
    const plan = postProcessQuotaEnrichment(answer({ title: 'Piano scales' }), 'piano scales', [])
    expect(plan.rrule).toBeNull()
    expect(plan.progress_target).toBeNull()
  })

  test('fallback: a task-style weekly rule gives the period and the day count', () => {
    const plan = postProcessQuotaEnrichment(
      answer({ rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU,TH' }),
      'eggs twice a week',
      SLOTS,
    )
    expect(plan.rrule).toBe('FREQ=WEEKLY')
    expect(plan.progress_target).toBe(2)
  })

  test('fallback: a monthly BYMONTHDAY list counts its days; a stated target wins', () => {
    expect(
      postProcessQuotaEnrichment(answer({ rrule: 'FREQ=MONTHLY;BYMONTHDAY=1,15' }), 'x', SLOTS),
    ).toMatchObject({ rrule: 'FREQ=MONTHLY', progress_target: 2 })
    expect(
      postProcessQuotaEnrichment(
        answer({ rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR', quota_target: 4 }),
        'x',
        SLOTS,
      ),
    ).toMatchObject({ rrule: 'FREQ=WEEKLY', progress_target: 4 })
  })

  test('the quota fields win over a rule the model also wrote', () => {
    const plan = postProcessQuotaEnrichment(
      answer({ rrule: 'FREQ=WEEKLY;BYDAY=TU,TH', quota_period: 'day', quota_target: 1 }),
      'x',
      SLOTS,
    )
    expect(plan.rrule).toBe('FREQ=DAILY')
    expect(plan.progress_target).toBe(1)
  })
})

describe('postProcessQuotaEnrichment — labels, prompt period, text', () => {
  test('labels are explicit-only and capped at one', () => {
    expect(
      postProcessQuotaEnrichment(answer({ labels: ['kids'] }), 'vitamins for the kids', SLOTS)
        .labels,
    ).toEqual([])
    expect(
      postProcessQuotaEnrichment(
        answer({ labels: ['fitness', 'health'] }),
        'run 3 times a week, label it fitness',
        SLOTS,
      ).labels,
    ).toEqual(['fitness'])
  })

  test('a slot label matches case-insensitively; an HH:MM snaps to the nearest slot', () => {
    expect(
      postProcessQuotaEnrichment(answer({ quota_prompt_time: 'midday' }), 'x', SLOTS),
    ).toMatchObject({ prompt_slot_id: MIDDAY.id, prompt_slot_label: 'Midday' })
    // 19:45 is nearer Evening (20:30) than Afternoon (16:00).
    expect(
      postProcessQuotaEnrichment(answer({ quota_prompt_time: '19:45' }), 'x', SLOTS),
    ).toMatchObject({ prompt_slot_id: EVENING.id })
  })

  test('nothing said, or no match → no prompt period (never the default)', () => {
    expect(postProcessQuotaEnrichment(answer(), 'x', SLOTS).prompt_slot_id).toBeNull()
    expect(
      postProcessQuotaEnrichment(answer({ quota_prompt_time: 'Lunchtime' }), 'x', SLOTS)
        .prompt_slot_id,
    ).toBeNull()
  })

  test('"don\'t remind me" is carried as enabled false', () => {
    expect(
      postProcessQuotaEnrichment(answer({ quota_prompt_enabled: false }), 'x', SLOTS)
        .prompt_enabled,
    ).toBe(false)
  })

  test('title and notes are trimmed; empty notes are null', () => {
    const plan = postProcessQuotaEnrichment(answer({ title: '  Lift ', notes: '  ' }), 'x', SLOTS)
    expect(plan.title).toBe('Lift')
    expect(plan.notes).toBeNull()
  })
})

describe('quotaPromptConfigFor', () => {
  test('merges only what was said over the stored config, never numbers', () => {
    expect(
      quotaPromptConfigFor(
        { enabled: true, numbers: { '2': 4 } },
        {
          prompt_slot_id: 3,
          prompt_enabled: null,
        },
      ),
    ).toEqual({ enabled: true, numbers: { '2': 4 }, slot_id: 3 })
    expect(quotaPromptConfigFor(null, { prompt_slot_id: null, prompt_enabled: false })).toEqual({
      enabled: false,
    })
  })

  test('nothing said → null (nothing to write)', () => {
    expect(
      quotaPromptConfigFor({ slot_id: 2 }, { prompt_slot_id: null, prompt_enabled: null }),
    ).toBeNull()
  })
})

describe('quota words for the toast and the push', () => {
  test('quotaCadenceWords', () => {
    expect(quotaCadenceWords({ rrule: 'FREQ=WEEKLY', progress_target: 3 })).toBe('3× a week')
    expect(quotaCadenceWords({ rrule: 'FREQ=DAILY', progress_target: 1 })).toBe('Every day')
    expect(quotaCadenceWords({ rrule: 'FREQ=WEEKLY;INTERVAL=2', progress_target: 1 })).toBe(
      'Every 2 weeks',
    )
    expect(quotaCadenceWords({ rrule: 'FREQ=MONTHLY;INTERVAL=3', progress_target: 2 })).toBe(
      '2× every 3 months',
    )
    expect(quotaCadenceWords({ rrule: null, progress_target: 2 })).toBeNull()
  })

  test('quotaPromptWords', () => {
    expect(quotaPromptWords({ quota_prompt_config: { slot_id: MIDDAY.id } }, SLOTS)).toBe(
      'Reminds at Midday',
    )
    expect(quotaPromptWords({ quota_prompt_config: { enabled: false } }, SLOTS)).toBe('No reminder')
    expect(quotaPromptWords({ quota_prompt_config: null }, SLOTS)).toBeNull()
  })
})

describe('the task and reminder paths never carry quota fields', () => {
  const filled = answer({
    title: 'Call the dentist',
    quota_target: 2,
    quota_period: 'week',
    quota_interval: 2,
    quota_prompt_time: 'Midday',
    quota_prompt_enabled: false,
  })

  test('withoutQuotaFields nulls all five', () => {
    expect(withoutQuotaFields(filled)).toMatchObject({
      quota_target: null,
      quota_period: null,
      quota_interval: null,
      quota_prompt_time: null,
      quota_prompt_enabled: null,
    })
  })

  test('postProcessTaskEnrichment and sanitizeReminderEnrichment null them', () => {
    const task = postProcessTaskEnrichment(filled, 'call the dentist', 'America/Chicago', {
      morningTime: '09:00',
      todayTarget: '09:00',
      dayStart: CALENDAR_DAY_START,
    })
    expect(task.quota_target).toBeNull()
    expect(task.quota_period).toBeNull()
    const reminder = sanitizeReminderEnrichment(
      { ...filled, rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' },
      SLOTS,
      'Morning',
    )
    expect(reminder.quota_target).toBeNull()
    expect(reminder.quota_prompt_time).toBeNull()
  })
})
