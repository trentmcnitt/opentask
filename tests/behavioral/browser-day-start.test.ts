/**
 * The browser's day boundary before the preferences load
 * (`src/lib/browser-day-start.ts`, "Day starts at" PR 2 review).
 *
 * Until GET /api/user/preferences answers, `useDayStart` used to read
 * midnight and then flip to the user's 03:00 — and a Defer → Tomorrow in that
 * window, between midnight and the day start, landed a day late. The
 * boundary is now remembered (like the queue switch, `last-known-queue.ts`);
 * with nothing remembered it is unknown, and the day-dependent defers wait
 * (`useDayStartKnown`, `snoozeOptionNeedsDay`).
 */
import { describe, test, expect, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import {
  UNKNOWN_DAY_START,
  browserDayStart,
  readLastKnownDayStart,
  rememberDayStart,
} from '@/lib/browser-day-start'
import { CALENDAR_DAY_START } from '@/lib/opentask-day'
import { computeSnoozeTime, snoozeOptionNeedsDay } from '@/lib/snooze'
import {
  DAY_UNKNOWN_CAPTION,
  deckMenuDays,
  deckTomorrowIfKnown,
  gateDeckDays,
} from '@/lib/deck-menu'

const TZ = 'America/Chicago'

function fakeStorage(): Storage {
  const data = new Map<string, string>()
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size
    },
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('the remembered day start', () => {
  test('BDS-01: remembered once loaded, read back on the next load', () => {
    vi.stubGlobal('window', { localStorage: fakeStorage() })
    expect(readLastKnownDayStart()).toBeNull()
    rememberDayStart('03:00')
    expect(readLastKnownDayStart()).toBe('03:00')
    rememberDayStart('23:00')
    expect(readLastKnownDayStart()).toBe('23:00')
    // The switch off remembers midnight, a real answer too.
    rememberDayStart(CALENDAR_DAY_START)
    expect(readLastKnownDayStart()).toBe('00:00')
  })

  test('BDS-02: storage that throws, a malformed value, no window — nothing remembered, nothing breaks', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    vi.stubGlobal('window', { localStorage: throwing })
    expect(() => rememberDayStart('03:00')).not.toThrow()
    expect(readLastKnownDayStart()).toBeNull()
    const storage = fakeStorage()
    storage.setItem('opentask.dayStart', 'soon')
    vi.stubGlobal('window', { localStorage: storage })
    expect(readLastKnownDayStart()).toBeNull()
    rememberDayStart('3am')
    expect(storage.getItem('opentask.dayStart')).toBe('soon')
    vi.stubGlobal('window', undefined)
    expect(readLastKnownDayStart()).toBeNull()
  })

  test('BDS-03: the rule — loaded: the day start with the switch on, midnight off; before: the remembered one, else unknown', () => {
    const p = { taskQueue: true, rolloverTime: '03:00', remembered: '06:30' }
    expect(browserDayStart({ ...p, loaded: true })).toBe('03:00')
    expect(browserDayStart({ ...p, loaded: true, taskQueue: false })).toBe(CALENDAR_DAY_START)
    expect(browserDayStart({ ...p, loaded: false })).toBe('06:30')
    expect(browserDayStart({ ...p, loaded: false, remembered: null })).toBeNull()
    expect(UNKNOWN_DAY_START).toBe(CALENDAR_DAY_START)
  })

  test('BDS-04: why — at 01:30 before the load, a remembered 03:00 gives this morning; midnight would be a day late, so it waits', () => {
    const at0130 = DateTime.fromISO('2026-10-25T01:30', { zone: TZ }).toJSDate()
    const remembered = browserDayStart({
      loaded: false,
      taskQueue: false,
      rolloverTime: null,
      remembered: '03:00',
    })!
    expect(computeSnoozeTime('tomorrow', TZ, '08:30', remembered, [], at0130)).toBe(
      DateTime.fromISO('2026-10-25T08:30', { zone: TZ }).toUTC().toISO(),
    )
    expect(computeSnoozeTime('tomorrow', TZ, '08:30', UNKNOWN_DAY_START, [], at0130)).toBe(
      DateTime.fromISO('2026-10-26T08:30', { zone: TZ }).toUTC().toISO(),
    )
    // The options that wait for the day start; the rest never depend on it.
    expect(snoozeOptionNeedsDay('tomorrow')).toBe(true)
    expect(snoozeOptionNeedsDay('next_period')).toBe(true)
    expect(snoozeOptionNeedsDay('60')).toBe(false)
  })
})

describe('decks wait for the day start too', () => {
  test('BDS-05: before the day start is known, "On deck tomorrow" commits nothing and the hold menu\'s days are not choosable', () => {
    const at0130 = DateTime.fromISO('2026-10-25T01:30', { zone: TZ }).toJSDate()
    // Known (3:00 AM): tomorrow is Sunday Oct 25, the day after the one ending.
    expect(deckTomorrowIfKnown(TZ, at0130, '03:00', true)).toBe('2026-10-25')
    // Unknown: midnight's tomorrow would be Monday — a day late — so nothing.
    expect(deckTomorrowIfKnown(TZ, at0130, UNKNOWN_DAY_START, false)).toBeNull()
    const days = deckMenuDays(TZ, at0130, UNKNOWN_DAY_START)
    const gated = gateDeckDays(days, false)
    expect(gated).toHaveLength(days.length)
    expect(gated.every((d) => d.disabled && d.caption === DAY_UNKNOWN_CAPTION)).toBe(true)
    expect(gateDeckDays(days, true)).toBe(days)
  })
})
