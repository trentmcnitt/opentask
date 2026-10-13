import { describe, expect, test } from 'vitest'
import { recurrenceSummary } from '@/lib/recurrence-summary'

/**
 * The web's copy of the native `RecurrenceSummary`: these cases mirror
 * `ios/Tests/Logic/RecurrenceSummaryTests.swift` one for one, so a repeating
 * Upcoming row reads the same on the web, the widget and the watch.
 */
describe('recurrenceSummary (same words as the widget)', () => {
  test('every case the Swift tests pin', () => {
    expect(recurrenceSummary('FREQ=DAILY')).toBe('daily')
    expect(recurrenceSummary('FREQ=DAILY;BYHOUR=9;BYMINUTE=0')).toBe('daily at 9 AM')
    expect(recurrenceSummary('FREQ=DAILY;BYHOUR=19;BYMINUTE=30')).toBe('daily at 7:30 PM')
    expect(recurrenceSummary('FREQ=DAILY;INTERVAL=3')).toBe('every 3 days')
    expect(recurrenceSummary('FREQ=DAILY;INTERVAL=3;BYHOUR=9;BYMINUTE=0')).toBe(
      'every 3 days at 9 AM',
    )
    expect(recurrenceSummary('RRULE:freq=daily')).toBe('daily')
    expect(recurrenceSummary('FREQ=DAILY', '08:15')).toBe('daily at 8:15 AM')
    expect(recurrenceSummary('FREQ=WEEKLY;BYDAY=SU', '12:00')).toBe('every Sun at noon')
    expect(recurrenceSummary('FREQ=DAILY', '00:00')).toBe('daily at midnight')
    expect(recurrenceSummary('FREQ=DAILY;BYHOUR=6;BYMINUTE=0', '21:00')).toBe('daily at 6 AM')
    expect(recurrenceSummary('FREQ=DAILY', 'nonsense')).toBe('daily')
    expect(recurrenceSummary('FREQ=WEEKLY;BYDAY=WE')).toBe('every Wed')
    expect(recurrenceSummary('FREQ=WEEKLY;BYDAY=WE', '09:00')).toBe('every Wed at 9 AM')
    expect(recurrenceSummary('FREQ=WEEKLY')).toBe('weekly')
    expect(recurrenceSummary('FREQ=WEEKLY;BYDAY=FR,MO,WE')).toBe('every Mon, Wed, Fri')
    expect(recurrenceSummary('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')).toBe('weekdays')
    expect(recurrenceSummary('FREQ=WEEKLY;BYDAY=SA,SU')).toBe('weekends')
    expect(recurrenceSummary('FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU')).toBe('daily')
    expect(recurrenceSummary('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO')).toBe('every 2 weeks on Mon')
    expect(recurrenceSummary('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH')).toBe(
      'every 2 weeks on Tue, Thu',
    )
    expect(recurrenceSummary('FREQ=WEEKLY;INTERVAL=3')).toBe('every 3 weeks')
    expect(recurrenceSummary('FREQ=MONTHLY;BYMONTHDAY=1')).toBe('monthly on the 1st')
    expect(recurrenceSummary('FREQ=MONTHLY;BYMONTHDAY=1,15')).toBe('monthly on the 1st, 15th')
    expect(recurrenceSummary('FREQ=MONTHLY;BYMONTHDAY=22', '12:00')).toBe(
      'monthly on the 22nd at noon',
    )
    expect(recurrenceSummary('FREQ=MONTHLY;BYMONTHDAY=-1')).toBe('monthly on the last day')
    expect(recurrenceSummary('FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=11')).toBe(
      'every 3 months on the 11th',
    )
    expect(recurrenceSummary('FREQ=MONTHLY')).toBe('monthly')
    expect(recurrenceSummary('FREQ=MONTHLY;BYDAY=2TU')).toBe('monthly on the 2nd Tue')
    expect(recurrenceSummary('FREQ=MONTHLY;BYDAY=-1FR')).toBe('monthly on the last Fri')
    expect(recurrenceSummary('FREQ=MONTHLY;BYDAY=+1MO')).toBe('monthly on the 1st Mon')
    expect(recurrenceSummary('FREQ=MONTHLY;BYDAY=TH;BYSETPOS=3')).toBe('monthly on the 3rd Thu')
    expect(recurrenceSummary('FREQ=MONTHLY;BYDAY=SA')).toBe('monthly on Sat')
    expect(recurrenceSummary('FREQ=YEARLY')).toBe('yearly')
    expect(recurrenceSummary('FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15')).toBe('yearly on Mar 15')
    expect(recurrenceSummary('FREQ=YEARLY;INTERVAL=2')).toBe('every 2 years')
    expect(recurrenceSummary(null)).toBe('repeats')
    expect(recurrenceSummary('')).toBe('repeats')
    expect(recurrenceSummary('garbage')).toBe('repeats')
    expect(recurrenceSummary('FREQ=HOURLY')).toBe('repeats')
    expect(recurrenceSummary('FREQ=WEEKLY;BYDAY=XX')).toBe('repeats')
    expect(recurrenceSummary('FREQ=DAILY;INTERVAL=0')).toBe('repeats')
    expect(recurrenceSummary('FREQ=MONTHLY;BYDAY=9TU')).toBe('repeats')
    expect(recurrenceSummary('BYDAY=MO')).toBe('repeats')
  })
})
