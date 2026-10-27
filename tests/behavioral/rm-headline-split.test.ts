/**
 * The Reminders headline, reminders and tasks counted apart (Trent,
 * 2026-10-26, ruling "B": "75 reminders · 84 tasks considered").
 *
 * `headlineCounts` sums the periods (reminders + quota prompts, through
 * `summarizeReminders`) as one half and every task segment the day bar draws
 * as the other, each segment by `segmentCounts` — the number its own header
 * shows. With no task half (the task queue off, or no segment drawn) every
 * string reads as before the split. Full words at every width (layout "b",
 * 2026-10-26: no "rem" abbreviation; a phone puts the count on its own line
 * instead). Pure: no database.
 */
import { describe, expect, test } from 'vitest'
import {
  dayCountLabel,
  dayCountRuns,
  dayCountText,
  dayDoneRuns,
  dayDoneText,
  headlineCounts,
  summarizeReminders,
  tasksWaitingText,
  waitingSoFarRuns,
  waitingSoFarText,
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
    // A phone wraps only between the runs, never inside one.
    expect(waitingSoFarRuns(c)).toEqual(['14 reminders', '13 tasks waiting so far'])
    expect(dayCountText(c)).toBe('40 of 75 reminders · 71 of 84 tasks considered')
    expect(dayCountLabel(c)).toBe('40 of 75 reminders and 71 of 84 tasks considered today')
    // One run per half; the handled numbers are the emphasised parts.
    const runs = dayCountRuns(c)
    expect(runs.map((r) => r.map((p) => p.text).join(''))).toEqual([
      '40 of 75 reminders',
      '71 of 84 tasks considered',
    ])
    expect(
      runs
        .flat()
        .filter((p) => p.strong)
        .map((p) => p.text),
    ).toEqual(['40', '71'])
  })

  test('no "rem" abbreviation anywhere', () => {
    const summary = summarizeReminders([group(morning, 14, 40)], TZ, NOW, DAY_START)
    const open = headlineCounts(summary, [{ handled: 30, total: 84 }])
    const done = headlineCounts(summarizeReminders([group(morning, 0, 75)], TZ, NOW, DAY_START), [
      { handled: 84, total: 84 },
    ])
    for (const text of [
      waitingSoFarText(open),
      dayCountText(open),
      dayCountLabel(open),
      dayDoneText(done),
    ]) {
      expect(text).not.toMatch(/\brem\b|\d\/\d/)
    }
  })

  test('done only when both halves are handled', () => {
    const summary = summarizeReminders([group(morning, 0, 75)], TZ, NOW, DAY_START)

    const tasksLeft = headlineCounts(summary, [{ handled: 80, total: 84 }])
    expect(tasksLeft.done).toBe(false)
    expect(waitingSoFarText(tasksLeft)).toBe('4 tasks waiting so far')
    expect(dayCountText(tasksLeft)).toBe('75 of 75 reminders · 80 of 84 tasks considered')

    const allDone = headlineCounts(summary, [
      { handled: 22, total: 22 },
      { handled: 62, total: 62 },
    ])
    expect(allDone.done).toBe(true)
    expect(dayDoneText(allDone)).toBe('All 75 reminders · 84 tasks considered today')
    expect(dayDoneRuns(allDone)).toEqual(['All 75 reminders', '84 tasks considered today'])
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
    expect(dayCountText(noTasks)).toBe('3 of 5 reminders considered')
    expect(dayCountLabel(noTasks)).toBe('3 of 5 reminders considered today')

    // Tasks there, but none waiting: the waiting line drops them, the count keeps them.
    const tasksHandled = headlineCounts(summary, [{ handled: 4, total: 4 }])
    expect(waitingSoFarText(tasksHandled)).toBe('2 reminders waiting so far')
    expect(dayCountText(tasksHandled)).toBe('3 of 5 reminders · 4 of 4 tasks considered')

    const doneNoTasks = headlineCounts(
      summarizeReminders([group(morning, 0, 5)], TZ, NOW, DAY_START),
      [{ handled: 0, total: 0 }],
    )
    expect(doneNoTasks.done).toBe(true)
    expect(dayDoneText(doneNoTasks)).toBe('All 5 reminders considered today')

    // One of each: singular.
    const one = headlineCounts(summarizeReminders([group(morning, 1, 0)], TZ, NOW, DAY_START), [
      { handled: 0, total: 1 },
    ])
    expect(waitingSoFarText(one)).toBe('1 reminder · 1 task waiting so far')
    expect(dayCountText(one)).toBe('0 of 1 reminder · 0 of 1 task considered')
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
    expect(dayCountText(c)).toBe('4 of 10 reminders · 1 of 3 tasks considered')
  })

  test('caught up until a later period, tasks waiting: the phrase stays, the tasks appended', () => {
    // Morning done, Evening (not started) holds 6: "Caught up until Evening ·
    // 6:00 PM" — and with tasks waiting, "· 2 tasks waiting" after it
    // (Trent, 2026-10-26). The phrase is the component's; its parts are here.
    const summary = summarizeReminders(
      [group(morning, 0, 4), group(evening, 6, 0)],
      TZ,
      NOW,
      DAY_START,
    )
    expect(summary.waitingSoFar).toBe(0)
    expect(summary.nextUp?.slot.label).toBe('Evening')
    const c = headlineCounts(summary, [{ handled: 1, total: 3 }])
    expect(c.tasks?.waiting).toBe(2)
    expect(tasksWaitingText(c.tasks!.waiting)).toBe('2 tasks waiting')
    expect(tasksWaitingText(1)).toBe('1 task waiting')
    expect(tasksWaitingText(3)).toBe('3 tasks waiting')
  })

  test('no task half (the task queue off, or no segment drawn): the words as before', () => {
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
      expect(dayCountText(c)).toBe('40 of 75 considered')
      expect(dayCountLabel(c)).toBe('40 of 75 considered today')
    }

    const done = headlineCounts(
      summarizeReminders([group(morning, 0, 75)], TZ, NOW, DAY_START),
      null,
    )
    expect(done.done).toBe(true)
    expect(dayDoneText(done)).toBe('All 75 considered today')
  })

  test('segmentCounts: handled is considered + deferred, total every row drawn', () => {
    expect(segmentCounts(segment(3, 5, 2))).toEqual({ handled: 7, total: 10 })
    expect(segmentCounts(segment(0, 0, 0))).toEqual({ handled: 0, total: 0 })
  })
})
