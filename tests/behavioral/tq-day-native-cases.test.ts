/**
 * THE NATIVE APPS' SHARED DAY CASES (TQ-DN, "Day starts at" PR 3,
 * 2026-10-24) — one table of answers from `src/lib/opentask-day.ts`, checked
 * by both platforms: this test against the TS helper, and the Swift
 * `OpenTaskDayTests` (`ios/Tests/Logic/`, the macOS `OpenTaskLogicTests`
 * bundle) against `ios/Shared/OpenTaskDay.swift`. So the two helpers can only
 * drift apart by one of them failing.
 *
 * The table (`tests/fixtures/opentask-day/opentask-day-cases.json`) pins, in
 * America/Chicago, the day starts 00:00, 01:30, 02:30, 03:00, 06:30, 12:00,
 * 12:01 and 23:00 around an ordinary day and both DST nights (spring forward
 * 2027-03-14, fall back 2026-11-01):
 *
 * - `dayStartMoments`: [date, dayStart, the instant that day starts];
 * - `openTaskDays`: [instant, dayStart, its OpenTask date] — every half hour
 *   from noon the day before to noon the day after, plus 1 ms before, at and
 *   1 ms after each day start;
 * - `periodOpensAt`: [date, dayStart, period start, the instant it opens].
 *
 * Without `DAY_CASES_WRITE=1` this test fails on any drift between the TS
 * helper and the committed table. A deliberate change to the day rules
 * rewrites it:
 *
 *   DAY_CASES_WRITE=1 npx vitest run tests/behavioral/tq-day-native-cases.test.ts
 *
 * then re-run the Swift tests (ios/AGENTS.md § Tests).
 */

import fs from 'node:fs'
import path from 'node:path'
import prettier from 'prettier'
import { describe, expect, test } from 'vitest'
import { DateTime } from 'luxon'
import { addDays, dayStartMoment, openTaskDayOf, periodOpensAt } from '@/lib/opentask-day'

const TZ = 'America/Chicago'
const STARTS = ['00:00', '01:30', '02:30', '03:00', '06:30', '12:00', '12:01', '23:00']
const DATES = ['2026-10-20', '2027-03-14', '2026-11-01']
const PERIODS = ['00:30', '01:00', '02:30', '03:00', '06:30', '07:00', '12:00', '20:30', '23:30']
const FILE = path.join(process.cwd(), 'tests/fixtures/opentask-day/opentask-day-cases.json')

type Cases = {
  timezone: string
  dayStartMoments: [string, string, string][]
  openTaskDays: [string, string, string][]
  periodOpensAt: [string, string, string, string][]
}

function iso(d: Date): string {
  return d.toISOString()
}

function build(): Cases {
  const dayStartMoments: Cases['dayStartMoments'] = []
  const openTaskDays: Cases['openTaskDays'] = []
  const periods: Cases['periodOpensAt'] = []
  for (const start of STARTS) {
    for (const date of DATES) {
      for (const d of [addDays(date, -1), date, addDays(date, 1)]) {
        const b = dayStartMoment(d, TZ, start)
        dayStartMoments.push([d, start, iso(b)])
        for (const delta of [-1, 0, 1]) {
          const x = new Date(b.getTime() + delta)
          openTaskDays.push([iso(x), start, openTaskDayOf(x, TZ, start)])
        }
      }
      const from = DateTime.fromISO(`${addDays(date, -1)}T12:00`, { zone: TZ }).toMillis()
      const to = DateTime.fromISO(`${addDays(date, 1)}T12:00`, { zone: TZ }).toMillis()
      for (let t = from; t <= to; t += 30 * 60_000) {
        const x = new Date(t)
        openTaskDays.push([iso(x), start, openTaskDayOf(x, TZ, start)])
      }
      for (const p of PERIODS) {
        periods.push([date, start, p, iso(periodOpensAt(date, p, TZ, start))])
      }
    }
  }
  return { timezone: TZ, dayStartMoments, openTaskDays, periodOpensAt: periods }
}

describe('TQ-DN: the native apps share the TS day table', () => {
  test('TQ-DN01: the committed cases are the TS helper’s answers', async () => {
    const live = build()
    if (process.env.DAY_CASES_WRITE === '1') {
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
      'The OpenTask day table drifted from src/lib/opentask-day.ts. If intended, re-run with ' +
        'DAY_CASES_WRITE=1 and re-run the Swift OpenTaskDayTests.',
    ).toEqual(live)
  })

  test('TQ-DN02: the table covers both DST nights and both naming directions', () => {
    const live = build()
    // The spring-forward 02:30 start is the next valid minute, 03:00 CDT.
    expect(live.dayStartMoments).toContainEqual(['2027-03-14', '02:30', '2027-03-14T08:00:00.000Z'])
    // The fall-back 01:30 start is the first 01:30 (CDT).
    expect(live.dayStartMoments).toContainEqual(['2026-11-01', '01:30', '2026-11-01T06:30:00.000Z'])
    // 23:00 names the day by the next date: 2026-10-20 starts 2026-10-19 23:00.
    expect(live.dayStartMoments).toContainEqual(['2026-10-20', '23:00', '2026-10-20T04:00:00.000Z'])
  })
})
