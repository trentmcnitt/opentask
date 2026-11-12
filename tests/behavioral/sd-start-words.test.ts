/**
 * THE START DATE'S WORDS (2026-11-12, src/lib/start-date-words.ts): the
 * Starts row's line, the open-window row's words, the "Starts Jan 1" note,
 * and the Due page's two headings (`deadlineGroupBefore`). Pure; synthetic.
 */
import { describe, test, expect } from 'vitest'
import { DateTime } from 'luxon'
import {
  cadenceWord,
  openWindowRowWords,
  startsDateWords,
  startsNote,
  timeLeftWords,
} from '@/lib/start-date-words'
import { deadlineGroupBefore } from '@/components/TaskSegmentRow'
import type { SegmentRow } from '@/hooks/useTaskSegments'

const tz = 'America/Chicago'
const ROLLOVER = '03:00'
const SAT = 6
const DEADLINE = DateTime.fromISO('2027-03-31T23:59', { zone: tz }).toUTC().toISO()!

describe('SD-W the start date’s words', () => {
  test('SD-W01: the cadence word is the set horizon’s; unset reads as weeks', () => {
    expect(
      [null, 'days', 'weeks', 'months', 'eventually'].map((h) => cadenceWord(h as never)),
    ).toEqual(['weekly', 'daily', 'weekly', 'monthly', 'quarterly'])
  })

  test('SD-W02: the line names the first cadence round, a full step after the start', () => {
    const words = (start: string, horizon: 'days' | 'weeks' | 'months' | 'eventually' | null) =>
      startsDateWords(start, DEADLINE, horizon, SAT, tz, ROLLOVER)
    expect(words('2027-01-01', 'weeks')).toEqual({
      chip: 'Fri Jan 1',
      daysBefore: 89,
      line: 'Comes round weekly from Sat Jan 9 until Sat Mar 27, then daily',
    })
    expect(words('2027-01-01', null).line).toBe(
      'Comes round weekly from Sat Jan 9 until Sat Mar 27, then daily',
    )
    expect(words('2027-01-01', 'days').line).toBe(
      'Comes round daily from Sat Jan 2 until Sat Mar 27, then daily',
    )
    expect(words('2027-01-01', 'months').line).toBe(
      'Comes round monthly from Sat Feb 6 until Sat Mar 27, then daily',
    )
    // No quarterly round before the daily day: say so plainly.
    expect(words('2027-01-01', 'eventually').line).toBe(
      'Shows on Fri Jan 1, then daily from Sat Mar 27',
    )
    // A late start: its own day, then the safety net's first day (the daily
    // day is never later than D−1).
    expect(words('2027-03-28', 'weeks')).toMatchObject({
      daysBefore: 3,
      line: 'Shows on Sun Mar 28, then daily from Tue Mar 30',
    })
  })

  test('SD-W03: what is left: weeks from two weeks out, else days', () => {
    expect([89, 14, 13, 2, 1, 0].map(timeLeftWords)).toEqual([
      '12 weeks left',
      '2 weeks left',
      '13 days left',
      '2 days left',
      '1 day left',
      '0 days left',
    ])
  })

  test('SD-W04: an open-window row: its cadence, the next round, what is left', () => {
    const words = (nextRound: string | null, today: string) =>
      openWindowRowWords({ horizon: 'weeks', nextRound }, DEADLINE, today, tz, ROLLOVER).join(' · ')
    expect(words('2027-01-09', '2027-01-02')).toBe('weekly · next Sat · 12 weeks left')
    expect(words('2027-01-16', '2027-01-09')).toBe('weekly · next Sat · 11 weeks left')
    // Further than a week: the date. No round left: nothing.
    expect(
      openWindowRowWords(
        { horizon: 'months', nextRound: '2027-02-06' },
        DEADLINE,
        '2027-01-09',
        tz,
        ROLLOVER,
      ),
    ).toEqual(['monthly', 'next Feb 6', '11 weeks left'])
    expect(words(null, '2027-03-20')).toBe('weekly · 11 days left')
  })

  test('SD-W05: "Starts Jan 1" only before a picked start date', () => {
    expect(startsNote({ deadline_window: 'before_start', start_date: '2027-01-01' }, tz)).toBe(
      'Starts Jan 1',
    )
    expect(startsNote({ deadline_window: 'before_start', start_date: null }, tz)).toBeNull()
    expect(startsNote({ deadline_window: 'open', start_date: '2027-01-01' }, tz)).toBeNull()
    expect(startsNote({ start_date: '2027-01-01' }, tz)).toBeNull()
  })

  test('SD-W06: the Due page’s headings show only when both groups have rows', () => {
    const row = (open: boolean) => ({ openWindow: open }) as unknown as SegmentRow
    const mixed = [row(false), row(false), row(true)]
    expect(mixed.map((_, i) => deadlineGroupBefore('deadlines', mixed, i))).toEqual([
      { open: false, count: 2 },
      null,
      { open: true, count: 1 },
    ])
    const due = [row(false), row(false)]
    expect(due.map((_, i) => deadlineGroupBefore('deadlines', due, i))).toEqual([null, null])
    const open = [row(true)]
    expect(deadlineGroupBefore('deadlines', open, 0)).toBeNull()
    expect(deadlineGroupBefore('weeks', mixed, 0)).toBeNull()
  })
})
