/**
 * RD-WI: a weekly rule's words keep its interval (2026-11-22). "Weekdays",
 * "Weekends" and "Daily" were shortcuts that skipped the INTERVAL, so a task
 * repeating every 2 weeks on Saturday and Sunday read "Weekends at 6:30 AM"
 * on its row and in the details. The words match the native summary
 * (ios/Shared/RecurrenceSummary.swift: "every 2 weeks on weekends").
 */
import { describe, expect, test } from 'vitest'
import { formatRRule, formatRRuleCompact, weeklyDaySet } from '@/lib/format-rrule'

describe('RD-WI: weekly rules keep their interval', () => {
  test('RD-WI01: the row (compact) and the details (full) say every 2 weeks', () => {
    const rule = 'FREQ=WEEKLY;INTERVAL=2;BYDAY=SA,SU;BYHOUR=6;BYMINUTE=30'
    expect(formatRRuleCompact(rule)).toBe('Every 2 weeks on weekends at 6:30 AM')
    expect(formatRRule(rule)).toBe('Every 2 weeks on weekends at 6:30 AM')
    expect(formatRRuleCompact('FREQ=WEEKLY;INTERVAL=3;BYDAY=MO,TU,WE,TH,FR')).toBe(
      'Every 3 weeks on weekdays',
    )
    expect(formatRRuleCompact('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR,SA,SU')).toBe(
      'Every 2 weeks, every day',
    )
  })

  test('RD-WI02: every week keeps the short words', () => {
    expect(formatRRuleCompact('FREQ=WEEKLY;BYDAY=SA,SU;BYHOUR=6;BYMINUTE=30')).toBe(
      'Weekends at 6:30 AM',
    )
    expect(formatRRule('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')).toBe('Weekdays')
    expect(formatRRuleCompact('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU')).toBe('Daily')
  })

  test('RD-WI03: other day sets are not shortcuts', () => {
    expect(weeklyDaySet(2, ['SA'])).toBeNull()
    expect(weeklyDaySet(1, ['MO', 'TU'])).toBeNull()
    expect(formatRRuleCompact('FREQ=WEEKLY;INTERVAL=2;BYDAY=SA')).toBe('Every 2 weeks on Sa')
  })
})
