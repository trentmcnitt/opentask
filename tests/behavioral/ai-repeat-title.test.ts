/**
 * Repeat words left in an enriched title (stripRepeatPhrase, 2026-10-16):
 * stripped only when the phrase is the title's leading or trailing phrase AND
 * says exactly what the parsed rule says; otherwise the title is untouched.
 */
import { describe, test, expect } from 'vitest'
import { stripRepeatPhrase } from '@/core/ai/repeat-title'
import { postProcessTaskEnrichment } from '@/core/ai/enrichment'
import type { EnrichmentResult } from '@/core/ai/types'
import { CALENDAR_DAY_START } from '@/lib/opentask-day'

describe('stripped: the phrase matches the rule', () => {
  test.each([
    ['Water the ferns every other day', 'FREQ=DAILY;INTERVAL=2', 'Water the ferns'],
    ['Go to the gym twice a week', 'FREQ=WEEKLY;BYDAY=TU,TH', 'Go to the gym'],
    ['Take out the recycling every Monday', 'FREQ=WEEKLY;BYDAY=MO', 'Take out the recycling'],
    ['Stretch daily', 'FREQ=DAILY;BYHOUR=7;BYMINUTE=0', 'Stretch'],
    ['Take vitamins every day.', 'FREQ=DAILY', 'Take vitamins'],
    ['Take vitamins before bed every night', 'FREQ=DAILY;BYHOUR=22', 'Take vitamins before bed'],
    ['Clean the fish tank every 2 weeks', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR', 'Clean the fish tank'],
    ['Water the lawn every 3 days', 'FREQ=DAILY;INTERVAL=3', 'Water the lawn'],
    ['Piano every Tuesday and Thursday', 'FREQ=WEEKLY;BYDAY=TU,TH', 'Piano'],
    ['Check email on weekdays', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'Check email'],
    ['Review the budget monthly', 'FREQ=MONTHLY;BYMONTHDAY=16', 'Review the budget'],
    ['File taxes quarterly', 'FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=1', 'File taxes'],
    [
      'Renew the registration every year',
      'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=1',
      'Renew the registration',
    ],
    ['Every Monday, take out the recycling', 'FREQ=WEEKLY;BYDAY=MO', 'Take out the recycling'],
    ['every other day water the ferns', 'FREQ=DAILY;INTERVAL=2', 'water the ferns'],
    // Only the trailing phrase goes: "Weekly" inside the name stays.
    ['Read the Weekly Standard weekly', 'FREQ=WEEKLY;BYDAY=FR', 'Read the Weekly Standard'],
  ])('%s (%s) → %s', (title, rrule, want) => {
    expect(stripRepeatPhrase(title, rrule)).toBe(want)
  })
})

describe('untouched: the phrase and the rule disagree, or it is not at an end', () => {
  test.each([
    // The rule says something else: a model error to see, not to hide.
    ['Water the ferns every other day', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR'],
    ['Go to the gym twice a week', 'FREQ=WEEKLY;BYDAY=FR'],
    ['Take out the recycling every Monday', 'FREQ=WEEKLY;BYDAY=TU'],
    ['Take out the recycling every Monday', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO'],
    ['Stretch daily', 'FREQ=DAILY;INTERVAL=2'],
    ['Water the lawn every 3 days', 'FREQ=DAILY;INTERVAL=2'],
    ['Check email on weekdays', 'FREQ=WEEKLY;BYDAY=MO,WE,FR'],
    // In the middle: removing it would break the sentence.
    ['Check email every weekday at 9am', 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'],
    ['Go twice a week to the gym', 'FREQ=WEEKLY;BYDAY=TU,TH'],
    // A leading adjective is part of a name.
    ['Weekly standup', 'FREQ=WEEKLY;BYDAY=MO'],
    ['Daily review of the inbox', 'FREQ=DAILY'],
    ['Monthly report', 'FREQ=MONTHLY;BYMONTHDAY=1'],
    // "on Monday" names a day, not a repeat.
    ['Call mom on Monday', 'FREQ=WEEKLY;BYDAY=MO'],
    // Nothing would be left, or no phrase at all.
    ['Daily', 'FREQ=DAILY'],
    ['Water the ferns', 'FREQ=DAILY;INTERVAL=2'],
  ])('%s (%s)', (title, rrule) => {
    expect(stripRepeatPhrase(title, rrule)).toBe(title)
  })

  test('no rule: untouched', () => {
    expect(stripRepeatPhrase('Water the ferns every other day', null)).toBe(
      'Water the ferns every other day',
    )
  })
})

describe('in the shared post-process', () => {
  test('the stripped title is what enrichment stores', () => {
    const parsed: EnrichmentResult = {
      title: 'Water the ferns every other day',
      due_at: null,
      deadline_at: null,
      horizon: null,
      priority: 0,
      labels: [],
      project_name: null,
      rrule: 'FREQ=DAILY;INTERVAL=2',
      auto_snooze_minutes: null,
      recurrence_mode: null,
      notes: null,
      reasoning: 'test',
    }
    const out = postProcessTaskEnrichment(
      parsed,
      'water the ferns every other day',
      'America/Chicago',
      {
        dayStart: CALENDAR_DAY_START,
        morningTime: '09:00',
        todayTarget: '2026-10-16T19:30:00.000Z',
        now: new Date('2026-10-16T14:00:00-05:00'),
      },
    )
    expect(out.title).toBe('Water the ferns')
  })
})
