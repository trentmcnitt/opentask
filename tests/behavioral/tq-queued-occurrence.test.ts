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
  occurrenceDiffers,
  pickerBaseDueAt,
  queuedRepeatOccurrence,
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
    // The editor names the occurrence it stands for (4c: "This is the Fri Oct 16 one").
    expect(occurrenceDiffers(task, tz, true)).toBe('Fri Oct 16')
  })

  test('a repeating task NOT in the queue with a moved target keeps today’s display', () => {
    const task = { rrule, due_at: next, occurrence_at: missed, queued_at: null }
    expect(queuedRepeatOccurrence(task)).toBeNull()
    expect(occurrenceDiffers(task, tz, true)).toBe('Fri Oct 16')
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
