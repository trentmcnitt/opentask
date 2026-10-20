/**
 * A repeating task WAITING in the task queue (B3) shows the occurrence it
 * stands for — on its queue row and in its details — not the target the
 * rollover moved on to the next occurrence, and the details drop the
 * "Occurrence … · target moved" line (Trent, 2026-10-20). Everything else
 * keeps the moved-target line.
 */
import { describe, test, expect, afterEach, vi } from 'vitest'
import { adjustDate, initWorkingDate } from '@/lib/quick-select-dates'
import {
  movedOccurrenceLabel,
  pickerBaseDueAt,
  queuedRepeatOccurrence,
  repeatButtonState,
} from '@/lib/editor-target-labels'

const tz = 'America/Chicago'
// Fri Oct 16 2026, 4:00 PM CDT, missed; the next Friday is the moved target.
const missed = '2026-10-16T21:00:00.000Z'
const next = '2026-10-23T21:00:00.000Z'
const rrule = 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0'

describe('queuedRepeatOccurrence', () => {
  test('a waiting repeating task: its occurrence, and no moved-target line', () => {
    const task = { rrule, due_at: next, occurrence_at: missed, queued_at: '2026-10-20T11:30:00Z' }
    expect(queuedRepeatOccurrence(task)).toBe(missed)
    expect(movedOccurrenceLabel(task, tz)).toBeNull()
  })

  test('a repeating task NOT in the queue with a moved target keeps today’s display', () => {
    const task = { rrule, due_at: next, occurrence_at: missed, queued_at: null }
    expect(queuedRepeatOccurrence(task)).toBeNull()
    expect(movedOccurrenceLabel(task, tz)).toBe('Fri, Oct 16, 4:00 PM')
  })

  test('a queued one-off (stripped) is not this case', () => {
    expect(
      queuedRepeatOccurrence({
        rrule: null,
        occurrence_at: null,
        queued_at: '2026-10-20T11:30:00Z',
      }),
    ).toBeNull()
  })
})

describe('repeatButtonState (the Quick panel Repeat button)', () => {
  test('a repeating task reads active and leads its label with the rule', () => {
    expect(
      repeatButtonState({
        rule: rrule,
        selectedTasks: undefined,
        recurrenceText: 'Fridays at 4:00 PM',
        editing: false,
      }),
    ).toEqual({
      repeatActive: true,
      repeatButtonLabel: 'Repeats: Fridays at 4:00 PM · Edit recurrence',
    })
  })

  test('a one-off reads plain', () => {
    expect(
      repeatButtonState({
        rule: null,
        selectedTasks: undefined,
        recurrenceText: 'One time',
        editing: false,
      }),
    ).toEqual({ repeatActive: false, repeatButtonLabel: 'Edit recurrence' })
  })

  test('open editor: the label says what a tap does, the rule state stays', () => {
    expect(
      repeatButtonState({
        rule: rrule,
        selectedTasks: undefined,
        recurrenceText: null,
        editing: true,
      }),
    ).toEqual({ repeatActive: true, repeatButtonLabel: 'Close recurrence editor' })
  })

  test('multi-selection: active only when every task repeats (or a rule is staged)', () => {
    const both = [{ rrule }, { rrule: 'FREQ=DAILY' }]
    const mixed = [{ rrule }, { rrule: null }]
    const base = { recurrenceText: '—', editing: false }
    expect(repeatButtonState({ ...base, rule: undefined, selectedTasks: both })).toEqual({
      repeatActive: true,
      repeatButtonLabel: 'Repeats · Edit recurrence',
    })
    expect(repeatButtonState({ ...base, rule: undefined, selectedTasks: mixed }).repeatActive).toBe(
      false,
    )
    expect(repeatButtonState({ ...base, rule: rrule, selectedTasks: mixed }).repeatActive).toBe(
      true,
    )
    expect(repeatButtonState({ ...base, rule: null, selectedTasks: both }).repeatActive).toBe(false)
  })
})

describe('pickerBaseDueAt (the Quick panel date controls on a waiting repeating task)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const waiting = { rrule, due_at: next, occurrence_at: missed, queued_at: '2026-10-20T11:30:00Z' }

  test('"+1 day" on a waiting Friday task at Tue 10:00 stages Wed ~10:00, never a past date', () => {
    // Tue Oct 20 2026, 10:00 AM CDT
    const now = new Date('2026-10-20T15:00:00Z')
    vi.setSystemTime(now)
    const base = pickerBaseDueAt(waiting, true)
    expect(base).toBeNull()
    const staged = adjustDate(initWorkingDate(base, now), { minutes: null, days: 1 }, tz)
    // "Now" snaps to the 5-minute mark (as for a task with no target).
    expect(staged).toBe('2026-10-21T15:05:00.000Z')
    expect(Date.parse(staged)).toBeGreaterThan(now.getTime())
  })

  test('with the queue switch off, or not queued, the controls start from the target', () => {
    expect(pickerBaseDueAt(waiting, false)).toBe(next)
    expect(pickerBaseDueAt({ ...waiting, queued_at: null }, true)).toBe(next)
  })
})
