/**
 * THE NATIVE APPS' SHARED LABEL CASES (TQ-LN, native catch-up PR 2,
 * 2026-10-26) — the night rule's FACTS and DAY WORDS from
 * `src/lib/night-day.ts`, checked by both platforms: this test against the
 * TS helper, and the Swift `NightDayTests` (`ios/Tests/Logic/`, the macOS
 * `OpenTaskLogicTests` bundle) against `ios/Shared/NightDay.swift`. So the
 * two can only drift apart by one of them failing.
 *
 * The grid is TQ-LN21's (`tq-late-night.test.ts`): in America/Chicago, a
 * 3:00 AM start, an 11 PM start and the switch off (midnight), six "now"s
 * (the fall-back night among them), every day from 9 before to 9 after and
 * seven times of day. Each case stores what a label is BUILT from, not the
 * label: the moment's OpenTask day and its gap from today's, whether it is
 * in that day's night, its own calendar date and that date's gap, whether a
 * relative word may name it (`wordsAgree`), the timed weekday
 * ("Tue", "Mon night"), the whole-day weekday (`nightWeekday`), and the day
 * words for a future and a past label (`nightDayWords`: "tomorrow night",
 * "last night", "Sat"). Each native surface builds its own string from
 * these, and its own tests pin the strings.
 *
 * `tests/fixtures/opentask-day/label-cases.json`, rows of
 * [dayStart, now, at, day, gap, night, date, dateGap, wordsAgree,
 *  timedWeekday, nightWeekday, futureWords, pastWords].
 *
 * Without `LABEL_CASES_WRITE=1` this test fails on any drift between the TS
 * helper and the committed table. A deliberate change to the label rules
 * rewrites it:
 *
 *   LABEL_CASES_WRITE=1 npx vitest run tests/behavioral/tq-label-native-cases.test.ts
 *
 * then re-run the Swift tests (ios/AGENTS.md § Tests).
 */

import fs from 'node:fs'
import path from 'node:path'
import prettier from 'prettier'
import { describe, expect, test } from 'vitest'
import { DateTime } from 'luxon'
import { CALENDAR_DAY_START } from '@/lib/opentask-day'
import { nightDay, nightDayWords, nightWeekday, timedWeekday, wordsAgree } from '@/lib/night-day'

const TZ = 'America/Chicago'
const STARTS = ['03:00', '23:00', CALENDAR_DAY_START]
// TQ-LN21's "now"s and times of day.
const NOWS = [
  '2026-10-24T12:30',
  '2026-10-25T23:30',
  '2026-10-26T00:30',
  '2026-10-26T02:00',
  '2026-10-31T23:30', // the fall-back night (Sun Nov 1, CDT → CST)
  '2026-11-01T00:30',
]
const TIMES = ['00:30', '01:00', '02:30', '09:00', '22:30', '23:30', '23:47']
const FILE = path.join(process.cwd(), 'tests/fixtures/opentask-day/label-cases.json')

type Row = [
  string, // dayStart
  string, // now (ISO)
  string, // at (ISO)
  string, // day: the OpenTask date the moment counts on
  number, // gap: OpenTask days from today's
  boolean, // night
  string, // date: the moment's own calendar date
  number, // dateGap: days from today's OpenTask date to `date`
  boolean, // wordsAgree
  string, // timedWeekday
  string, // nightWeekday
  string, // nightDayWords(n, false)
  string, // nightDayWords(n, true)
]
type Cases = { timezone: string; cases: Row[] }

const local = (s: string) => DateTime.fromISO(s, { zone: TZ })

function build(): Cases {
  const cases: Row[] = []
  for (const dayStart of STARTS) {
    for (const nowLocal of NOWS) {
      const now = local(nowLocal)
      for (let d = -9; d <= 9; d++) {
        const day = now.startOf('day').plus({ days: d }).toISODate()!
        for (const time of TIMES) {
          const at = local(`${day}T${time}`).toJSDate()
          const n = nightDay(at, TZ, dayStart, now.toJSDate())
          cases.push([
            dayStart,
            now.toJSDate().toISOString(),
            at.toISOString(),
            n.day.toISODate()!,
            n.gap,
            n.night,
            n.date.toISODate()!,
            n.dateGap,
            wordsAgree(n),
            timedWeekday(n),
            nightWeekday(n),
            nightDayWords(n, false),
            nightDayWords(n, true),
          ])
        }
      }
    }
  }
  return { timezone: TZ, cases }
}

describe('TQ-LN: the native apps share the TS night-label table', () => {
  test('TQ-LN30: the committed cases are the TS helper’s answers', async () => {
    const live = build()
    if (process.env.LABEL_CASES_WRITE === '1') {
      fs.mkdirSync(path.dirname(FILE), { recursive: true })
      const options = (await prettier.resolveConfig(FILE)) ?? {}
      fs.writeFileSync(
        FILE,
        await prettier.format(JSON.stringify(live), { ...options, filepath: FILE }),
      )
    }
    const committed = JSON.parse(fs.readFileSync(FILE, 'utf-8')) as Cases
    expect(
      committed,
      'The night-label table drifted from src/lib/night-day.ts. If intended, re-run with ' +
        'LABEL_CASES_WRITE=1 and re-run the Swift NightDayTests.',
    ).toEqual(live)
  })

  test('TQ-LN31: the table holds every kind of day word', () => {
    const rows = build().cases
    const words = new Set(rows.flatMap((r) => [r[11], r[12]]))
    for (const w of ['today', 'tonight', 'tomorrow', 'tomorrow night', 'yesterday', 'last night']) {
      expect(words, w).toContain(w)
    }
    // A night pair names the evening: Tue Oct 27 01:00 with a 3:00 AM start is Monday night's.
    const tueOne = rows.find(
      (r) => r[0] === '03:00' && r[2] === local('2026-10-27T01:00').toJSDate().toISOString(),
    )!
    expect(tueOne[3]).toBe('2026-10-26')
    expect(tueOne[5]).toBe(true)
    expect(tueOne[9]).toBe('Mon night')
    // An 11 PM start: a moment after the start on the evening before its
    // OpenTask date can't take a relative word — its own weekday instead.
    expect(rows.some((r) => r[0] === '23:00' && r[8] === false)).toBe(true)
    // The switch off: never night.
    expect(rows.filter((r) => r[0] === CALENDAR_DAY_START).every((r) => r[5] === false)).toBe(true)
  })
})
