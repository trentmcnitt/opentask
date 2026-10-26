/**
 * UP-130+: the editor's LEAD TIME ROW, Upcoming form (2026-10-25, the
 * Upcoming split PR B): `upcomingLeadLine` reads the Upcoming rule
 * (`upcomingDays`) for a task with a target or a deck day, with what is
 * staged, and `upcomingLeadWords` says it in Trent's words. Every date is a
 * local day in America/Chicago; the anchor's days are OpenTask days.
 */
import { describe, expect, test } from 'vitest'
import { DateTime } from 'luxon'
import {
  upcomingLeadLine,
  upcomingLeadWords,
  type UpcomingLeadTask,
} from '@/lib/editor-target-labels'
import { stagedUpcomingAnchor } from '@/components/quick-panel/this-one-props'
import { CALENDAR_DAY_START } from '@/lib/opentask-day'

const TZ = 'America/Chicago'
const at = (local: string) => DateTime.fromISO(local, { zone: TZ }).toUTC().toISO()!
const noon = (day: string) => new Date(at(`${day}T12:00`))

function task(over: Partial<UpcomingLeadTask> = {}): UpcomingLeadTask {
  return {
    due_at: at('2026-10-23T09:00'),
    deadline_at: null,
    target_auto: false,
    rrule: null,
    // Set Thu Oct 15: a wait of 8 to Fri Oct 23 → the default lead, 3.
    target_set_at: at('2026-10-15T10:00'),
    created_at: at('2026-10-01T10:00'),
    last_completed_at: null,
    on_deck_day: null,
    lead_days: null,
    ...over,
  }
}

type Staged = Parameters<typeof upcomingLeadLine>[1]
const nothing: Staged = { anchor: undefined, restamp: false, leadDays: undefined }

function words(
  t: UpcomingLeadTask,
  staged: Staged = nothing,
  today = '2026-10-17',
  dayStart?: string,
) {
  const line = upcomingLeadLine(t, staged, TZ, dayStart ?? CALENDAR_DAY_START, noon(today))
  return line ? upcomingLeadWords(line, TZ, today) : null
}

describe('upcomingLeadLine — the Lead time row, Upcoming form (2026-10-25)', () => {
  test('UP-130: both sections — "Later on …(3 days before) · Tomorrow on …"; "since" once passed', () => {
    expect(words(task())).toBe('Later on Tue Oct 20 (3 days before) · Tomorrow on Thu Oct 22')
    expect(words(task(), nothing, '2026-10-20')).toBe(
      'Later on Tue Oct 20 (3 days before) · Tomorrow on Thu Oct 22',
    )
    expect(words(task(), nothing, '2026-10-21')).toBe(
      'Later since Tue Oct 20 (3 days before) · Tomorrow on Thu Oct 22',
    )
    const line = upcomingLeadLine(task(), nothing, TZ, CALENDAR_DAY_START, noon('2026-10-17'))!
    expect(line).toMatchObject({
      anchor: 'target',
      later: '2026-10-20',
      laterDaysBefore: 3,
      tomorrow: '2026-10-22',
      leadDays: 3,
      clamped: false,
      override: null,
      max: 90,
      staged: false,
    })
  })

  test('UP-131: no Later — "Tomorrow on … (the day before)"; made today for tomorrow — not in Upcoming', () => {
    // Set Mon Oct 19: a wait of 4 → the default lead, the day before.
    const short = task({ target_set_at: at('2026-10-19T10:00') })
    expect(words(short, nothing, '2026-10-20')).toBe('Tomorrow on Thu Oct 22 (the day before)')
    expect(
      upcomingLeadLine(short, nothing, TZ, CALENDAR_DAY_START, noon('2026-10-20'))!.leadDays,
    ).toBe(1)
    // A lead of 1 on a long wait: no Later either.
    expect(words(task({ lead_days: 1 }))).toBe('Tomorrow on Thu Oct 22 (the day before)')
    // A target staged today for tomorrow (Save restamps): no rows at all.
    const staged = {
      anchor: { target: at('2026-10-23T09:00') },
      restamp: false,
      leadDays: undefined,
    }
    expect(words(task(), staged, '2026-10-22')).toBe('Not in Upcoming (the target is tomorrow)')
  })

  test('UP-132: an override counts from the target; longer than the wait it is clamped', () => {
    expect(words(task({ lead_days: 5 }))).toBe(
      'Later on Sun Oct 18 (5 days before) · Tomorrow on Thu Oct 22',
    )
    // Set Mon Oct 19, lead 10: Later = max(Oct 13, Oct 20) — as early as it can be.
    const clamped = upcomingLeadLine(
      task({ target_set_at: at('2026-10-19T10:00'), lead_days: 10 }),
      nothing,
      TZ,
      CALENDAR_DAY_START,
      noon('2026-10-19'),
    )!
    expect(clamped).toMatchObject({ later: '2026-10-20', leadDays: 3, clamped: true, override: 10 })
    expect(upcomingLeadWords(clamped, TZ, '2026-10-19')).toBe(
      'Later on Tue Oct 20 (3 days before) · Tomorrow on Thu Oct 22',
    )
  })

  test('UP-133: a staged lead keeps the stored set day (no restamp); a staged target counts from today', () => {
    const lead = { anchor: undefined, restamp: false, leadDays: 5 }
    const line = upcomingLeadLine(task(), lead, TZ, CALENDAR_DAY_START, noon('2026-10-17'))!
    expect(line).toMatchObject({ later: '2026-10-18', override: 5, staged: true })
    // Default staged over a stored override: the table again, still staged.
    const back = upcomingLeadLine(
      task({ lead_days: 5 }),
      { anchor: undefined, restamp: false, leadDays: null },
      TZ,
      CALENDAR_DAY_START,
      noon('2026-10-17'),
    )!
    expect(back).toMatchObject({ later: '2026-10-20', override: null, staged: true })
    // A target staged Tue Oct 20 for Fri Nov 6: a wait of 17 from today → 4.
    const moved = upcomingLeadLine(
      task(),
      { anchor: { target: at('2026-11-06T09:00') }, restamp: false, leadDays: undefined },
      TZ,
      CALENDAR_DAY_START,
      noon('2026-10-20'),
    )!
    expect(moved).toMatchObject({ later: '2026-11-02', tomorrow: '2026-11-05', staged: true })
    // A staged deadline restamps too.
    const restamped = upcomingLeadLine(
      task(),
      { anchor: undefined, restamp: true, leadDays: undefined },
      TZ,
      CALENDAR_DAY_START,
      noon('2026-10-19'),
    )!
    // Set "today" Mon Oct 19 → wait 4 → no Later.
    expect(restamped).toMatchObject({ later: null, tomorrow: '2026-10-22', staged: true })
  })

  test('UP-134: a deck day is an anchor; on deck tomorrow, made today — not in Upcoming', () => {
    const decked = task({ due_at: null, on_deck_day: '2026-10-24' })
    expect(words(decked)).toBe('Later on Wed Oct 21 (3 days before) · Tomorrow on Fri Oct 23')
    const staged = { anchor: { deck: '2026-10-24' }, restamp: false, leadDays: undefined }
    expect(words(task(), staged, '2026-10-23')).toBe('Not in Upcoming (on deck tomorrow)')
    expect(
      upcomingLeadLine(decked, nothing, TZ, CALENDAR_DAY_START, noon('2026-10-17'))!.anchor,
    ).toBe('deck')
  })

  test('UP-135: nothing to say — no target, an automatic one, a target today or past, removed', () => {
    const none = (t: UpcomingLeadTask, staged: Staged = nothing, today = '2026-10-17') =>
      upcomingLeadLine(t, staged, TZ, CALENDAR_DAY_START, noon(today))
    expect(none(task({ due_at: null }))).toBeNull()
    expect(none(task({ target_auto: true, deadline_at: at('2026-10-26T17:00') }))).toBeNull()
    expect(none(task(), nothing, '2026-10-23')).toBeNull()
    expect(none(task(), nothing, '2026-10-25')).toBeNull()
    expect(none(task(), { anchor: null, restamp: false, leadDays: undefined })).toBeNull()
    // A deck today: on deck, not in Upcoming.
    expect(none(task({ due_at: null, on_deck_day: '2026-10-17' }))).toBeNull()
  })

  test('UP-136: a repeat — the stepper stops below its rule’s wait', () => {
    const weekly = task({
      rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0',
      occurrence_at: at('2026-10-23T09:00'),
    })
    const line = upcomingLeadLine(weekly, nothing, TZ, CALENDAR_DAY_START, noon('2026-10-17'))!
    expect(line.max).toBe(6)
    expect(line.tomorrow).toBe('2026-10-22')
  })

  test('UP-137: OpenTask days — with the day starting at 03:00 a 02:00 target is the day before’s', () => {
    // Sat Oct 24 02:00 is Friday Oct 23's OpenTask day: the same days as a
    // Friday target.
    const late = task({ due_at: at('2026-10-24T02:00') })
    expect(words(late, nothing, '2026-10-17', '03:00')).toBe(
      'Later on Tue Oct 20 (3 days before) · Tomorrow on Thu Oct 22',
    )
  })
})

describe('stagedUpcomingAnchor — what Save would leave the task anchored on', () => {
  const base = {
    queued: false,
    deck: null,
    cleared: false,
    fixed: null,
    deadline: null,
    relative: null,
    derived: null,
  }
  test('UP-138: deck, then removal, then a fixed target (capped at the deadline), relative, derived', () => {
    expect(stagedUpcomingAnchor(base)).toBeUndefined()
    expect(stagedUpcomingAnchor({ ...base, deck: '2026-10-24', fixed: 'x' })).toEqual({
      deck: '2026-10-24',
    })
    expect(stagedUpcomingAnchor({ ...base, cleared: true })).toBeNull()
    expect(
      stagedUpcomingAnchor({
        ...base,
        fixed: at('2026-11-10T09:00'),
        deadline: at('2026-11-07T17:00'),
      }),
    ).toEqual({ target: at('2026-11-07T17:00') })
    expect(stagedUpcomingAnchor({ ...base, queued: true })).toBeNull()
    expect(stagedUpcomingAnchor({ ...base, relative: 'r', derived: 'd' })).toEqual({ target: 'r' })
    expect(stagedUpcomingAnchor({ ...base, derived: 'd' })).toEqual({ target: 'd' })
  })
})
