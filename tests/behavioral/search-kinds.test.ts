/**
 * Search across kinds (2026-11-12, `src/lib/search-kinds.ts`): classifying
 * hits, the chips' fallback, the rows' words and where a tap goes.
 */
import { describe, expect, test } from 'vitest'
import {
  alsoMatchWords,
  countSearchKinds,
  dashboardSearchHref,
  effectiveKindFilter,
  matchedKinds,
  searchQueueWord,
  searchResultLift,
  searchWhere,
} from '@/lib/search-kinds'
import type { TimeSlot } from '@/lib/time-slot-assign'
import type { Task } from '@/types'

const TZ = 'America/Chicago'
const task = (o: Partial<Task> = {}): Task =>
  ({
    id: 1,
    title: 't',
    is_reminder: false,
    is_tracked: false,
    progress_target: 1,
    progress_current: 0,
    rrule: null,
    due_at: null,
    target_auto: false,
    deadline_at: null,
    horizon: null,
    on_deck_day: null,
    anchor_time: null,
    quota_prompt_config: null,
    labels: [],
    ...o,
  }) as Task
const reminder = (o: Partial<Task> = {}) => task({ is_reminder: true, rrule: 'FREQ=DAILY', ...o })
const quota = (o: Partial<Task> = {}) =>
  task({ is_tracked: true, progress_target: 2, rrule: 'FREQ=WEEKLY', ...o })
const SLOTS = [
  { id: 1, label: 'Morning', start_time: '08:00' },
  { id: 2, label: 'After School', start_time: '15:30' },
] as TimeSlot[]

describe('kinds', () => {
  test('counts by kind; a quota that is also flagged a reminder is a quota', () => {
    const counts = countSearchKinds([task(), task(), reminder(), quota({ is_reminder: true })])
    expect(counts).toEqual({ task: 2, reminder: 1, quota: 1 })
    expect(matchedKinds(counts)).toEqual(['task', 'reminder', 'quota'])
    expect(matchedKinds({ task: 0, reminder: 2, quota: 0 })).toEqual(['reminder'])
  })

  test('a chip whose kind has no hits left falls back to All', () => {
    const counts = { task: 2, reminder: 0, quota: 1 }
    expect(effectiveKindFilter('quota', counts)).toBe('quota')
    expect(effectiveKindFilter('reminder', counts)).toBe('all')
    expect(effectiveKindFilter('all', counts)).toBe('all')
  })
})

describe('the rows’ words', () => {
  test('a task the queue holds says its horizon; a dated one says nothing', () => {
    expect(searchQueueWord(task({ horizon: 'days' }))).toBe('Task queue · Days')
    expect(searchQueueWord(task({ horizon: null }))).toBe('Task queue · Weeks')
    expect(searchQueueWord(task({ due_at: '2026-11-20T15:00:00Z' }))).toBeNull()
    expect(searchQueueWord(task({ deadline_at: '2026-11-20T15:00:00Z' }))).toBeNull()
  })

  test('a reminder: its period and rhythm; a quota: target, done so far, its period', () => {
    expect(
      searchWhere(
        reminder({ rrule: 'FREQ=DAILY;BYHOUR=15;BYMINUTE=30', anchor_time: '15:30' }),
        SLOTS,
        TZ,
      ),
    ).toBe('After School · Daily')
    expect(
      searchWhere(quota({ progress_current: 1, quota_prompt_config: { slot_id: 2 } }), SLOTS, TZ),
    ).toBe('2 a week · 1 done · After School')
    expect(searchWhere(quota(), SLOTS, TZ)).toBe('2 a week · 0 done')
  })
})

describe('where a tap goes', () => {
  const groups = [
    {
      reminders: [{ id: 10 }],
      prompts: [
        { prompt_key: 'q:20:0:2026-11-12', task_id: 20, waiting: false },
        { prompt_key: 'q:21:0:2026-11-12', task_id: 21, waiting: true },
      ],
    },
  ]
  const waiting = (p: { waiting: boolean }) => p.waiting

  test('waiting today: the dashboard lift; otherwise its details (null)', () => {
    expect(searchResultLift(reminder({ id: 10 }), groups, waiting)).toEqual({
      kind: 'reminder',
      id: 10,
    })
    expect(searchResultLift(reminder({ id: 11 }), groups, waiting)).toBeNull()
    expect(searchResultLift(quota({ id: 21 }), groups, waiting)).toEqual({
      kind: 'prompt',
      key: 'q:21:0:2026-11-12',
    })
    // Its prompt was handled already: details.
    expect(searchResultLift(quota({ id: 20 }), groups, waiting)).toBeNull()
  })
})

describe('the tabs’ line', () => {
  test('names what else matches, or nothing', () => {
    expect(alsoMatchWords({ task: 3 })).toBe('3 tasks also match')
    expect(alsoMatchWords({ task: 1 })).toBe('1 task also matches')
    expect(alsoMatchWords({ task: 1, quota: 2 })).toBe('1 task and 2 quotas also match')
    expect(alsoMatchWords({ task: 2, reminder: 1, quota: 1 })).toBe(
      '2 tasks, 1 reminder and 1 quota also match',
    )
    expect(alsoMatchWords({})).toBeNull()
    expect(dashboardSearchHref('kids & co')).toBe('/?search=kids%20%26%20co')
  })
})
