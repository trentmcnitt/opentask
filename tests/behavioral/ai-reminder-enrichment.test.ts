/**
 * Reminder enrichment guards (REDESIGN-V03 §6)
 *
 * The prompt asks the model for a rule pinned to one of the user's time slots
 * and for every task-shaped field to be left empty. `sanitizeReminderEnrichment`
 * is what makes that true regardless of what came back, in the same
 * belt-and-suspenders spirit as `filterExplicitLabels`. These tests are the
 * spec for it, and they need no AI: the sanitizer is pure.
 */

import { describe, test, expect } from 'vitest'
import { sanitizeReminderEnrichment } from '@/core/ai/enrichment'
import { DEFAULT_TIME_SLOTS } from '@/lib/time-slot-assign'
import type { EnrichmentResult } from '@/core/ai/types'
import type { TimeSlot } from '@/lib/time-slot-assign'

const SLOTS: TimeSlot[] = DEFAULT_TIME_SLOTS.map((slot, index) => ({
  id: index + 1,
  user_id: 1,
  label: slot.label,
  start_time: slot.start_time,
  sort_order: index,
  created_at: '2026-01-01T00:00:00.000Z',
}))

function result(overrides: Partial<EnrichmentResult> = {}): EnrichmentResult {
  return {
    title: 'Notice what I am grateful for',
    due_at: null,
    priority: 0,
    labels: [],
    project_name: null,
    rrule: 'FREQ=DAILY;BYHOUR=16;BYMINUTE=0',
    auto_snooze_minutes: null,
    recurrence_mode: null,
    notes: null,
    reasoning: 'test',
    ...overrides,
  }
}

describe('sanitizeReminderEnrichment', () => {
  test('clears every field a reminder does not carry', () => {
    const out = sanitizeReminderEnrichment(
      result({
        due_at: '2026-09-08T16:00:00',
        labels: ['health', 'ai-monitored'],
        project_name: 'Personal',
        auto_snooze_minutes: 30,
        recurrence_mode: 'from_completion',
      }),
      SLOTS,
      'Afternoon',
    )
    expect(out.due_at).toBeNull()
    expect(out.labels).toEqual([])
    expect(out.project_name).toBeNull()
    expect(out.auto_snooze_minutes).toBeNull()
    expect(out.recurrence_mode).toBeNull()
  })

  test('keeps the title, notes and priority the model produced', () => {
    const out = sanitizeReminderEnrichment(
      result({ title: 'Text my brother', notes: 'my therapist suggested it', priority: 2 }),
      SLOTS,
      'Afternoon',
    )
    expect(out.title).toBe('Text my brother')
    expect(out.notes).toBe('my therapist suggested it')
    expect(out.priority).toBe(2)
  })

  test('a near miss snaps to the nearest slot, not the one it falls inside', () => {
    // 19:00 is a generic "evening" — this user's Evening starts at 20:30, and
    // that is what was meant. Rounding down would land it in Afternoon.
    const out = sanitizeReminderEnrichment(
      result({ rrule: 'FREQ=WEEKLY;BYDAY=FR,SU;BYHOUR=19;BYMINUTE=0' }),
      SLOTS,
      'Morning',
    )
    expect(out.rrule).toBe('FREQ=WEEKLY;BYDAY=FR,SU;BYHOUR=20;BYMINUTE=30')
  })

  test('a time earlier than every slot snaps up to the earliest slot', () => {
    const out = sanitizeReminderEnrichment(
      result({ rrule: 'FREQ=DAILY;BYHOUR=5;BYMINUTE=30' }),
      SLOTS,
      'Evening',
    )
    expect(out.rrule).toBe('FREQ=DAILY;BYHOUR=7;BYMINUTE=0')
  })

  test('a rule with no time of day lands in the slot the user is in now', () => {
    const out = sanitizeReminderEnrichment(result({ rrule: 'FREQ=DAILY' }), SLOTS, 'Midday')
    expect(out.rrule).toBe('FREQ=DAILY;BYHOUR=12;BYMINUTE=0')
  })

  test('an exact slot time is left where the model put it', () => {
    const out = sanitizeReminderEnrichment(
      result({ rrule: 'FREQ=WEEKLY;BYDAY=FR,SU;BYHOUR=20;BYMINUTE=30' }),
      SLOTS,
      'Morning',
    )
    expect(out.rrule).toBe('FREQ=WEEKLY;BYDAY=FR,SU;BYHOUR=20;BYMINUTE=30')
  })

  test('canonicalizes noise so an unchanged schedule stays unchanged', () => {
    // A model that answers INTERVAL=1 to a rule that already reads without it
    // would otherwise produce a write, an undo entry and a toast for nothing.
    const out = sanitizeReminderEnrichment(
      result({ rrule: 'FREQ=DAILY;INTERVAL=1;BYHOUR=16;BYMINUTE=0' }),
      SLOTS,
      'Afternoon',
    )
    expect(out.rrule).toBe('FREQ=DAILY;BYHOUR=16;BYMINUTE=0')
  })

  test('monthly rules keep their day of the month', () => {
    const out = sanitizeReminderEnrichment(
      result({ rrule: 'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=12;BYMINUTE=0' }),
      SLOTS,
      'Midday',
    )
    expect(out.rrule).toBe('FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=12;BYMINUTE=0')
  })

  test('a missing or unusable rule leaves the existing schedule alone', () => {
    expect(sanitizeReminderEnrichment(result({ rrule: null }), SLOTS, 'Morning').rrule).toBeNull()
    expect(
      sanitizeReminderEnrichment(result({ rrule: 'BYHOUR=9;BYMINUTE=0' }), SLOTS, 'Morning').rrule,
    ).toBeNull()
  })
})
