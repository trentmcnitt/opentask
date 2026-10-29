/**
 * The compact row's deadline words (`src/lib/compact-row-words.ts`): the day
 * only, within a week either side. Wed 2026-10-28, noon, Chicago, a 3:00 AM
 * day start.
 */
import { describe, expect, test } from 'vitest'
import { DateTime } from 'luxon'
import { compactDeadline } from '@/lib/compact-row-words'

const TZ = 'America/Chicago'
const now = DateTime.fromISO('2026-10-28T12:00', { zone: TZ }).toJSDate()
const words = (local: string) =>
  compactDeadline(DateTime.fromISO(local, { zone: TZ }).toUTC().toISO(), TZ, '03:00', now)

describe('compactDeadline', () => {
  test('a day word, never a time', () => {
    expect(words('2026-10-28T17:00')).toEqual({ words: 'Today', passed: false })
    expect(words('2026-10-29T09:00')).toEqual({ words: 'Tomorrow', passed: false })
    expect(words('2026-10-30T17:00')).toEqual({ words: 'Fri', passed: false })
    // 02:30 on Thursday is Wednesday's night (3:00 AM start).
    expect(words('2026-10-29T02:30')).toEqual({ words: 'Tonight', passed: false })
  })

  test('within a week either side; a passed one says so', () => {
    expect(words('2026-11-03T17:00')).toEqual({ words: 'Tue', passed: false })
    expect(words('2026-11-04T17:00')).toBeNull()
    expect(words('2026-10-27T17:00')).toEqual({ words: 'Yesterday', passed: true })
    expect(words('2026-10-20T17:00')).toBeNull()
    expect(compactDeadline(null, TZ, '03:00', now)).toBeNull()
  })
})
