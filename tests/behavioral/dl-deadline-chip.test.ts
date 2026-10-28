/**
 * The deadline chip's words and tone (the deadlines page, 2026-10-22, plan
 * §9; `src/lib/deadline-chip.ts`): red once passed, solid teal on the
 * deadline's own day, teal otherwise (the time chips, 2026-10-28; the day
 * before was amber until then); the
 * day by name within the week; L9 — a deadline before the rollover reads as
 * the evening before ("Thu night").
 */
import { describe, expect, test } from 'vitest'
import { DateTime } from 'luxon'
import { deadlineChip } from '@/lib/deadline-chip'

const TZ = 'America/Chicago'
const at = (local: string) => DateTime.fromISO(local, { zone: TZ }).toUTC().toISO()!
// Tue Oct 20 2026, noon CDT.
const NOW = new Date(at('2026-10-20T12:00'))

describe('deadlineChip', () => {
  test('ahead: teal, the weekday within the week, the date beyond', () => {
    expect(deadlineChip(at('2026-10-23T17:00'), TZ, NOW, null)).toMatchObject({
      text: 'Deadline Fri',
      tone: 'ahead',
      title: 'Deadline Fri Oct 23, 5:00 PM',
    })
    expect(deadlineChip(at('2026-10-30T17:00'), TZ, NOW, null).text).toBe('Deadline Oct 30')
  })

  test('only the deadline\'s own day stands out: "today" is solid, "tomorrow" is like any day', () => {
    expect(deadlineChip(at('2026-10-21T17:00'), TZ, NOW, null)).toMatchObject({
      text: 'Deadline tomorrow',
      tone: 'ahead',
    })
    expect(deadlineChip(at('2026-10-20T17:00'), TZ, NOW, null)).toMatchObject({
      text: 'Deadline today',
      tone: 'today',
    })
  })

  test('passed: red, said as past', () => {
    expect(deadlineChip(at('2026-10-20T09:00'), TZ, NOW, null)).toMatchObject({
      text: 'Past deadline today',
      tone: 'passed',
    })
    expect(deadlineChip(at('2026-10-19T17:00'), TZ, NOW, null).text).toBe('Past deadline yesterday')
    expect(deadlineChip(at('2026-10-10T17:00'), TZ, NOW, null).text).toBe('Past deadline Oct 10')
  })

  test('L9: a deadline before the rollover is the evening before, and its day comes a day early', () => {
    // Fri Oct 23 00:00 with a 04:00 rollover counts on Thu Oct 22.
    const midnight = at('2026-10-23T00:00')
    expect(deadlineChip(midnight, TZ, NOW, '04:00')).toMatchObject({
      text: 'Deadline Thu night',
      tone: 'ahead',
    })
    // On Thu Oct 22 (its own OpenTask day) it is today's.
    const thu = new Date(at('2026-10-22T12:00'))
    expect(deadlineChip(midnight, TZ, thu, '04:00')).toMatchObject({
      text: 'Deadline tonight',
      tone: 'today',
    })
    // Just passed, before the rollover: its own evening-before day, by name.
    const after = new Date(at('2026-10-23T01:00'))
    expect(deadlineChip(midnight, TZ, after, '04:00')).toMatchObject({
      text: 'Past deadline Thu night',
      tone: 'passed',
    })
    // With no rollover (calendar days) it is plain Friday.
    expect(deadlineChip(midnight, TZ, NOW, null).text).toBe('Deadline Fri')
  })
})
