/**
 * The Reminders headline, reminders and tasks counted apart (Trent,
 * 2026-10-26, ruling "B": "75 reminders · 84 tasks considered").
 *
 * `headlineCounts` sums the periods (reminders + quota prompts, through
 * `summarizeReminders`) as one half and every task segment the day bar draws
 * as the other, each segment by `segmentCounts` — the number its own header
 * shows. With no task half (the task queue off, or no segment drawn) every
 * string reads exactly as before the split. Pure: no database.
 */
import { describe, expect, test } from 'vitest'
import {
  dayCountLabel,
  dayCountParts,
  dayDoneText,
  headlineCounts,
  summarizeReminders,
  waitingSoFarRuns,
  waitingSoFarText,
  type HeadlineCounts,
} from '@/lib/reminders-summary'
import { segmentCounts } from '@/lib/task-segments'
import type { TimeSlot } from '@/lib/time-slot-assign'

const TZ = 'America/Chicago'
// 10:00 Chicago: Morning (08:00) has started, Evening (18:00) has not.
const NOW = new Date('2026-01-15T16:00:00Z')
const DAY_START = '03:00'

function slot(id: number, label: string, start: string): TimeSlot {
  return { id, user_id: 1, label, start_time: start, sort_order: id, created_at: '' }
}

function group(s: TimeSlot | null, waiting: number, considered: number) {
  return {
    slot: s,
    reminders: Array.from({ length: waiting }, (_, i) => ({ id: i + 1 })),
    considered,
  }
}

/** A drawn segment: `waiting` + `considered` + `deferred` rows. */
function segment(waiting: number, considered: number, deferred: number) {
  return {
    rows: Array.from({ length: waiting + considered + deferred }, () => ({})),
    considered,
    deferred,
  }
}

const full = (c: HeadlineCounts) =>
  dayCountParts(c, 'full')
    .map((p) => p.text)
    .join('')
const compact = (c: HeadlineCounts) =>
  dayCountParts(c, 'compact')
    .map((p) => p.text)
    .join('')

const morning = slot(1, 'Morning', '08:00')
const evening = slot(2, 'Evening', '18:00')

describe('the headline counts reminders and tasks apart', () => {
  test("the segments' header numbers are the tasks half", () => {
    // Tonight's example: Previous pulls 9, Daily 9, Upcoming 4, Weekly 62.
    const summary = summarizeReminders(
      [group(morning, 14, 40), group(evening, 21, 0)],
      TZ,
      NOW,
      DAY_START,
    )
    const segs = [segment(3, 6, 0), segment(0, 8, 1), segment(0, 4, 0), segment(10, 50, 2)]
    const c = headlineCounts(summary, segs.map(segmentCounts))

    expect(c.reminders).toEqual({ waiting: 14, handled: 40, total: 75 })
    expect(c.tasks).toEqual({ waiting: 13, handled: 71, total: 84 })
    // The progressbar: both halves.
    expect(c.handled).toBe(111)
    expect(c.total).toBe(159)
    expect(c.done).toBe(false)

    expect(waitingSoFarText(c)).toBe('14 reminders · 13 tasks waiting so far')
    // A phone's line: the count's short word, wrapping only between the runs.
    expect(waitingSoFarText(c, 'compact')).toBe('14 rem · 13 tasks waiting so far')
    expect(waitingSoFarRuns(c, 'compact')).toEqual(['14 rem', '13 tasks waiting so far'])
    expect(full(c)).toBe('40 of 75 reminders · 71 of 84 tasks considered')
    expect(compact(c)).toBe('40/75 rem · 71/84 tasks')
    expect(dayCountLabel(c)).toBe('40 of 75 reminders and 71 of 84 tasks considered today')
    // The handled numbers are the emphasised runs.
    expect(
      dayCountParts(c, 'full')
        .filter((p) => p.strong)
        .map((p) => p.text),
    ).toEqual(['40', '71'])
  })

  test('done only when both halves are handled', () => {
    const summary = summarizeReminders([group(morning, 0, 75)], TZ, NOW, DAY_START)

    const tasksLeft = headlineCounts(summary, [{ handled: 80, total: 84 }])
    expect(tasksLeft.done).toBe(false)
    expect(waitingSoFarText(tasksLeft)).toBe('4 tasks waiting so far')
    expect(full(tasksLeft)).toBe('75 of 75 reminders · 80 of 84 tasks considered')

    const allDone = headlineCounts(summary, [
      { handled: 22, total: 22 },
      { handled: 62, total: 62 },
    ])
    expect(allDone.done).toBe(true)
    expect(dayDoneText(allDone, 'full')).toBe('All 75 reminders · 84 tasks considered today')
    expect(dayDoneText(allDone, 'compact')).toBe('All 75 rem · 84 tasks')
    expect(dayCountLabel(allDone)).toBe('75 of 75 reminders and 84 of 84 tasks considered today')

    const remindersLeft = headlineCounts(
      summarizeReminders([group(morning, 1, 74)], TZ, NOW, DAY_START),
      [{ handled: 84, total: 84 }],
    )
    expect(remindersLeft.done).toBe(false)
    expect(waitingSoFarText(remindersLeft)).toBe('1 reminder waiting so far')
  })

  test('an empty half is dropped, never "0 tasks"', () => {
    const summary = summarizeReminders([group(morning, 2, 3)], TZ, NOW, DAY_START)

    // Every segment drawn and empty (an empty one is done).
    const noTasks = headlineCounts(summary, [
      { handled: 0, total: 0 },
      { handled: 0, total: 0 },
    ])
    expect(noTasks.tasks).toEqual({ waiting: 0, handled: 0, total: 0 })
    expect(waitingSoFarText(noTasks)).toBe('2 reminders waiting so far')
    // One half alone keeps its full word on a phone too: it fits.
    expect(waitingSoFarText(noTasks, 'compact')).toBe('2 reminders waiting so far')
    expect(full(noTasks)).toBe('3 of 5 reminders considered')
    expect(compact(noTasks)).toBe('3/5 rem')
    expect(dayCountLabel(noTasks)).toBe('3 of 5 reminders considered today')

    // Tasks there, but none waiting: the waiting line drops them, the count keeps them.
    const tasksHandled = headlineCounts(summary, [{ handled: 4, total: 4 }])
    expect(waitingSoFarText(tasksHandled)).toBe('2 reminders waiting so far')
    expect(full(tasksHandled)).toBe('3 of 5 reminders · 4 of 4 tasks considered')

    const doneNoTasks = headlineCounts(
      summarizeReminders([group(morning, 0, 5)], TZ, NOW, DAY_START),
      [{ handled: 0, total: 0 }],
    )
    expect(doneNoTasks.done).toBe(true)
    expect(dayDoneText(doneNoTasks, 'full')).toBe('All 5 reminders considered today')
    expect(dayDoneText(doneNoTasks, 'compact')).toBe('All 5 rem')

    // One of each: singular.
    const one = headlineCounts(summarizeReminders([group(morning, 1, 0)], TZ, NOW, DAY_START), [
      { handled: 0, total: 1 },
    ])
    expect(waitingSoFarText(one)).toBe('1 reminder · 1 task waiting so far')
    expect(full(one)).toBe('0 of 1 reminder · 0 of 1 task considered')
  })

  test('reminders in a later period are not "so far"; every task waiting is', () => {
    const summary = summarizeReminders(
      [group(morning, 0, 4), group(evening, 6, 0)],
      TZ,
      NOW,
      DAY_START,
    )
    const c = headlineCounts(summary, [{ handled: 1, total: 3 }])
    expect(c.reminders.waiting).toBe(0)
    expect(waitingSoFarText(c)).toBe('2 tasks waiting so far')
    expect(full(c)).toBe('4 of 10 reminders · 1 of 3 tasks considered')
  })

  test('no task half (the task queue off, or no segment drawn): exactly as before', () => {
    const summary = summarizeReminders(
      [group(morning, 14, 40), group(evening, 21, 0)],
      TZ,
      NOW,
      DAY_START,
    )
    for (const c of [headlineCounts(summary, null), headlineCounts(summary, [])]) {
      expect(c.tasks).toBeNull()
      expect(c.handled).toBe(40)
      expect(c.total).toBe(75)
      expect(waitingSoFarText(c)).toBe('14 waiting so far')
      expect(full(c)).toBe('40 of 75 considered')
      expect(compact(c)).toBe('40 / 75')
      expect(dayCountLabel(c)).toBe('40 of 75 considered today')
    }

    const done = headlineCounts(
      summarizeReminders([group(morning, 0, 75)], TZ, NOW, DAY_START),
      null,
    )
    expect(done.done).toBe(true)
    expect(dayDoneText(done, 'full')).toBe('All 75 considered today')
    expect(dayDoneText(done, 'compact')).toBe('All 75 considered today')
  })

  test('segmentCounts: handled is considered + deferred, total every row drawn', () => {
    expect(segmentCounts(segment(3, 5, 2))).toEqual({ handled: 7, total: 10 })
    expect(segmentCounts(segment(0, 0, 0))).toEqual({ handled: 0, total: 0 })
  })
})
