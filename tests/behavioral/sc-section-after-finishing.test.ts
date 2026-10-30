/**
 * The Reminders surface scrolls to the next unfinished section when one is
 * finished (2026-10-29): `sectionAfterFinishing`, the dashboard pager's
 * `pageAfterFinishing` answered as a section key.
 */
import { describe, expect, test } from 'vitest'
import { sectionAfterFinishing } from '@/lib/time-slot-assign'

const page = (key: string, waiting: number) => ({ key, waiting })

describe('sectionAfterFinishing', () => {
  // Three periods (Early morning, Morning, Midday), the clock in Midday (2),
  // then the task segments.
  const slots = [page('1', 0), page('2', 3), page('3', 0)]

  test('SC-01: a finished period goes to the earliest period up to now still waiting', () => {
    expect(sectionAfterFinishing([...slots, page('tasks:days', 2)], 3, '3', 2)).toBe('2')
  })

  test('SC-02: no period up to now waiting: the first task segment still waiting, in screen order', () => {
    const pages = [
      page('1', 0),
      page('2', 0),
      page('3', 0),
      page('tasks:deadlines', 0),
      page('tasks:upcoming', 4),
      page('tasks:days', 1),
    ]
    expect(sectionAfterFinishing(pages, 3, '2', 2)).toBe('tasks:upcoming')
  })

  test('SC-03: a period that has not started is never next', () => {
    // The clock in Early morning (0): Midday's waiting rows are not due yet.
    const pages = [page('1', 0), page('2', 0), page('3', 5), page('tasks:days', 1)]
    expect(sectionAfterFinishing(pages, 3, '1', 0)).toBe('tasks:days')
  })

  test('SC-04: a finished task segment goes to the next segment still waiting', () => {
    const pages = [page('1', 0), page('tasks:upcoming', 0), page('tasks:queue_today', 2)]
    expect(sectionAfterFinishing(pages, 1, 'tasks:upcoming', 0)).toBe('tasks:queue_today')
  })

  test('SC-05: nothing left waiting anywhere: stay (no scroll to a finished section)', () => {
    const pages = [page('1', 0), page('2', 0), page('tasks:days', 0)]
    expect(sectionAfterFinishing(pages, 2, '1', 1)).toBeNull()
    expect(sectionAfterFinishing(pages, 2, '2', 1)).toBeNull()
  })

  test('SC-06: an unknown section: stay', () => {
    expect(sectionAfterFinishing([page('1', 2)], 1, 'tasks:gone', 0)).toBeNull()
  })
})
