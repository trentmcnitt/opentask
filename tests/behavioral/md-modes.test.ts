/**
 * The dashboard modes' section rules (`src/lib/modes/`), on synthetic tasks,
 * so a reshuffle of the sections can't silently change who lands where.
 * Pinned: Wed 2026-10-28, noon in Chicago, a 3:00 AM day start — so 02:30
 * tomorrow is still today's OpenTask day, and 02:00 today is yesterday's.
 */
import { describe, expect, test } from 'vitest'
import { DateTime } from 'luxon'
import { nextStepSize, selectSections, SHOW_MORE_STEP } from '@/lib/modes/select'
import {
  DEFAULT_MODE,
  MODE_LABELS,
  MODE_ORDER,
  MODES,
  isModeId,
  listsEveryRow,
} from '@/lib/modes/registry'
import { HORIZON_DAYS_CAP, SECTION_CAP } from '@/lib/modes/sections'
import { DEFAULT_MODE_SORT, type ModeSort } from '@/lib/modes/sorts'
import type { ModeContext } from '@/lib/modes/types'
import { UNSET_HORIZON } from '@/lib/task-segments'
import type { Task } from '@/types'

const TZ = 'America/Chicago'
const at = (local: string) => DateTime.fromISO(local, { zone: TZ }).toUTC().toISO()!
const ctxAt = (local: string): ModeContext => ({
  now: new Date(at(local)),
  timezone: TZ,
  dayStart: '03:00',
})
const ctx = ctxAt('2026-10-28T12:00')

let nextId = 1
function task(overrides: Partial<Task> = {}): Task {
  return {
    id: nextId++,
    title: 'task',
    done: false,
    deleted_at: null,
    is_reminder: false,
    is_tracked: false,
    progress_target: 1,
    priority: 0,
    due_at: null,
    target_auto: false,
    deadline_at: null,
    horizon: null,
    rrule: null,
    on_deck_day: null,
    queued_at: null,
    queued_from_due_at: null,
    queued_from_deck_day: null,
    last_considered_at: null,
    updated_at: at('2026-09-01T09:00'),
    created_at: at('2026-09-01T09:00'),
    ...overrides,
  } as Task
}

const ids = (tasks: Task[]) => tasks.map((t) => t.id)
const today = (tasks: Task[], c = ctx) => selectSections(tasks, MODES.today.sections!, c)
const scan = (tasks: Task[], sort: ModeSort | null = null, extra = {}) =>
  selectSections(tasks, MODES['pick-mode'].sections!, ctx, sort, extra)
const section = (views: ReturnType<typeof scan>, id: string) => views.find((v) => v.id === id)!

describe('the modes', () => {
  test('Today | Scan | All; the middle mode is named in one place, its id stable', () => {
    expect(MODE_ORDER.map((m) => MODE_LABELS[m])).toEqual(['Today', 'Scan', 'All'])
    expect(DEFAULT_MODE).toBe('today')
    expect(isModeId('pick-mode')).toBe(true)
    expect(isModeId('Scan')).toBe(false)
    expect(MODES.all.sections).toBeNull()
  })

  test('All lists every row: no group is capped; the other modes and the modes off cap as before', () => {
    expect(listsEveryRow('all')).toBe(true)
    expect(listsEveryRow('today')).toBe(false)
    expect(listsEveryRow('pick-mode')).toBe(false)
    expect(listsEveryRow(null)).toBe(false)
  })
})

describe('Today', () => {
  test('one section: over target, targeted later today and the deadline net, by time; then On deck', () => {
    const over = task({ due_at: at('2026-10-27T10:00') })
    const overThisMorning = task({ due_at: at('2026-10-28T09:00') })
    const later = task({ due_at: at('2026-10-28T18:00') })
    // 02:30 tomorrow is still today's OpenTask day (3:00 AM start).
    const tonight = task({ due_at: at('2026-10-29T02:30') })
    // A deadline tomorrow, no picked target: the safety net holds it today.
    const net = task({ deadline_at: at('2026-10-29T17:00') })
    const deck = task({ on_deck_day: '2026-10-28' })
    const tomorrow = task({ due_at: at('2026-10-29T09:00') })
    const undated = task({ priority: 3 })
    const views = today([net, tonight, later, deck, overThisMorning, over, tomorrow, undated])
    expect(views.map((s) => [s.id, ids(s.tasks)])).toEqual([
      // By time — the target, else the deadline: past times first.
      ['today', [over.id, overThisMorning.id, later.id, tonight.id, net.id]],
      ['on-deck', [deck.id]],
    ])
    expect(views.map((s) => s.rows)).toEqual(['full', 'compact'])
    expect(views.map((s) => s.complete)).toEqual([false, false])
  })

  test('a row never jumps sections: upcoming, then over target, it stays in Today', () => {
    const t = task({ due_at: at('2026-10-28T15:00') })
    const before = today([t], ctxAt('2026-10-28T14:00'))
    const after = today([t], ctxAt('2026-10-28T16:00'))
    expect(before.map((s) => s.id)).toEqual(['today'])
    expect(after.map((s) => s.id)).toEqual(['today'])
  })

  test('the 3 AM boundary: 02:59 is still yesterday; at 03:00 a target for 09:00 is today', () => {
    const nine = task({ due_at: at('2026-10-29T09:00') })
    expect(today([nine], ctxAt('2026-10-29T02:59'))).toEqual([])
    expect(ids(today([nine], ctxAt('2026-10-29T03:00'))[0].tasks)).toEqual([nine.id])
  })

  test('a task is listed once: Today takes a decked task already in it', () => {
    const both = task({ deadline_at: at('2026-10-29T17:00'), on_deck_day: '2026-10-28' })
    expect(today([both]).map((s) => s.id)).toEqual(['today'])
  })

  test('a deadline with a picked target is not in the net; reminders, quotas and done tasks never list', () => {
    const picked = task({ deadline_at: at('2026-10-29T17:00'), due_at: at('2026-10-30T09:00') })
    const reminder = task({ is_reminder: true, due_at: at('2026-10-27T10:00') })
    const quota = task({ is_tracked: true, progress_target: 3, due_at: at('2026-10-27T10:00') })
    const done = task({ done: true, due_at: at('2026-10-27T10:00') })
    expect(today([picked, reminder, quota, done])).toEqual([])
  })

  test('the sort pill re-orders On deck, never Today, unless every section is sorted', () => {
    const lowDeck = task({
      on_deck_day: '2026-10-28',
      priority: 1,
      created_at: at('2026-10-27T09:00'),
    })
    const highDeck = task({
      on_deck_day: '2026-10-28',
      priority: 4,
      created_at: at('2026-10-01T09:00'),
    })
    // Both over target and of one rank (no "!"), so Today's own order is time.
    const early = task({ due_at: at('2026-10-28T09:00'), priority: 1 })
    const laterMedium = task({ due_at: at('2026-10-28T10:00'), priority: 2 })
    const sorted = (everywhere: boolean) =>
      selectSections([lowDeck, highDeck, early, laterMedium], MODES.today.sections!, ctx, {
        id: 'priority',
        everywhere,
      })
    const views = sorted(false)
    expect(ids(section(views, 'today').tasks)).toEqual([early.id, laterMedium.id])
    expect(ids(section(views, 'on-deck').tasks)).toEqual([highDeck.id, lowDeck.id])
    expect(ids(section(sorted(true), 'today').tasks)).toEqual([laterMedium.id, early.id])
  })
})

describe('Scan', () => {
  test('the sections in order; empty ones dropped; the horizon lists overlap the sections above', () => {
    const pulled = task({
      queued_at: at('2026-10-28T03:00'),
      queued_from_due_at: at('2026-10-26T09:00'),
      horizon: 'days',
    })
    const fresh = task({ created_at: at('2026-10-27T08:00'), horizon: 'weeks' })
    const soon = task({ deadline_at: at('2026-10-30T17:00'), horizon: 'months' })
    const unset = task()
    const later = task({ horizon: 'eventually' })
    const views = scan([pulled, fresh, soon, unset, later])
    expect(views.map((s) => [s.id, ids(s.tasks)])).toEqual([
      ['pulled', [pulled.id]],
      ['newest', [fresh.id, pulled.id, soon.id, unset.id, later.id]],
      ['coming-up', [soon.id]],
      ['horizon-days', [pulled.id]],
      ['horizon-weeks', [fresh.id]],
      // Unset is its own section, right after the horizon it counts as.
      ['horizon-unset', [unset.id]],
      // `soon` has a deadline: no horizon section governs it.
      ['horizon-eventually', [later.id]],
    ])
    expect(views.map((s) => s.title).slice(3)).toEqual([
      'Horizon: Days',
      'Horizon: Weeks',
      'Horizon: Weeks (Unset)',
      'Horizon: Eventually',
    ])
    // Counts only where a section claims its rows: Pulled and Coming up.
    expect(views.filter((s) => !s.complete).map((s) => s.id)).toEqual(['pulled', 'coming-up'])
  })

  test('Unset follows UNSET_HORIZON, never a literal', () => {
    const order = MODES['pick-mode'].sections!.map((s) => s.id)
    expect(order.indexOf('horizon-unset')).toBe(order.indexOf(`horizon-${UNSET_HORIZON}`) + 1)
  })

  test('a horizon section holds only the one-offs it governs: no picked target, deadline or repeat', () => {
    const plain = task({ created_at: at('2026-10-01T09:00') })
    const targeted = task({ due_at: at('2026-11-05T09:00') })
    const auto = task({
      due_at: at('2026-11-05T09:00'),
      target_auto: true,
      created_at: at('2026-10-02T09:00'),
    })
    const deadline = task({ deadline_at: at('2026-11-20T17:00') })
    const repeating = task({ rrule: 'FREQ=WEEKLY', due_at: at('2026-11-05T09:00') })
    const unset = section(scan([plain, targeted, auto, deadline, repeating]), 'horizon-unset')
    expect(ids(unset.tasks)).toEqual([auto.id, plain.id])
  })

  test('Days shows 10, the rest 5; "Show 5 more" reveals five at a time, "Show less" puts it back', () => {
    const many = (horizon: Task['horizon']) => Array.from({ length: 12 }, () => task({ horizon }))
    const views = scan([...many('days'), ...many('weeks')])
    expect(section(views, 'horizon-days').visible).toHaveLength(HORIZON_DAYS_CAP)
    const weeks = section(views, 'horizon-weeks')
    expect(weeks.visible).toHaveLength(SECTION_CAP)
    expect(nextStepSize(weeks.hidden)).toBe(5)
    const once = section(
      scan([...many('weeks')], null, { 'horizon-weeks': SHOW_MORE_STEP }),
      'horizon-weeks',
    )
    expect(once.visible).toHaveLength(SECTION_CAP + 5)
    expect(nextStepSize(once.hidden)).toBe(2)
    const back = section(scan([...many('weeks')], null, { 'horizon-weeks': 0 }), 'horizon-weeks')
    expect(back.visible).toHaveLength(SECTION_CAP)
  })

  test('Pulled: in the queue, pulled off a target or a deck; latest pull first, then the latest day missed', () => {
    const rollover = at('2026-10-28T03:00')
    const offTarget = task({ queued_at: rollover, queued_from_due_at: at('2026-10-26T09:00') })
    const offDeck = task({ queued_at: rollover, queued_from_deck_day: '2026-10-27' })
    const yesterday = task({
      queued_at: at('2026-10-27T03:00'),
      queued_from_due_at: at('2026-10-20T09:00'),
    })
    // Re-targeted since: out of the queue, so no longer Pulled.
    const retargeted = task({ queued_at: null, queued_from_due_at: at('2026-10-25T09:00') })
    // Pulled more than 14 OpenTask days ago.
    const old = task({
      queued_at: at('2026-10-13T03:00'),
      queued_from_due_at: at('2026-10-12T09:00'),
    })
    const [pulled] = scan([yesterday, offTarget, offDeck, retargeted, old])
    expect(pulled.id).toBe('pulled')
    expect(ids(pulled.tasks)).toEqual([offDeck.id, offTarget.id, yesterday.id])
  })

  test('Newest: every task, newest first, the 3 AM boundary no matter', () => {
    const today_ = task({ created_at: at('2026-10-28T09:00') })
    const lastNight = task({ created_at: at('2026-10-28T02:00') })
    const old = task({ created_at: at('2025-03-13T09:00') })
    expect(ids(section(scan([old, lastNight, today_]), 'newest').tasks)).toEqual([
      today_.id,
      lastNight.id,
      old.id,
    ])
  })

  test('Coming up: a deadline or picked target within three OpenTask days, soonest first; not automatic, not past', () => {
    const inTwo = task({ deadline_at: at('2026-10-30T17:00') })
    const tomorrow = task({ due_at: at('2026-10-29T09:00') })
    const inFive = task({ deadline_at: at('2026-11-02T17:00') })
    const auto = task({ due_at: at('2026-10-29T09:00'), target_auto: true })
    const passed = task({ deadline_at: at('2026-10-27T17:00') })
    // 02:30 on the 31st is still the 30th's OpenTask day: within three days.
    const lateNight = task({ deadline_at: at('2026-10-31T02:30') })
    const coming = section(scan([inTwo, tomorrow, inFive, auto, passed, lateNight]), 'coming-up')
    expect(ids(coming.tasks)).toEqual([tomorrow.id, inTwo.id, lateNight.id])
  })
})

describe('the sort pill', () => {
  test('re-orders the category sections; Newest and Coming up keep their order', () => {
    const low = task({ created_at: at('2026-10-27T09:00'), priority: 1 })
    const high = task({ created_at: at('2026-10-01T09:00'), priority: 3 })
    const soonLow = task({ deadline_at: at('2026-10-29T17:00'), priority: 1, horizon: 'days' })
    const laterHigh = task({ deadline_at: at('2026-10-30T17:00'), priority: 4, horizon: 'days' })
    const views = scan([low, high, soonLow, laterHigh], { id: 'priority', everywhere: false })
    const unset = section(views, 'horizon-unset')
    expect(ids(unset.tasks)).toEqual([high.id, low.id])
    expect(unset.sortedByMode).toBe(true)
    expect(section(views, 'newest').sortedByMode).toBe(false)
    expect(section(views, 'newest').tasks[0].id).toBe(low.id)
    expect(ids(section(views, 'coming-up').tasks)).toEqual([soonLow.id, laterHigh.id])
  })

  test('"Sort every section" re-orders Newest and Coming up too', () => {
    const soonLow = task({ deadline_at: at('2026-10-29T17:00'), priority: 1 })
    const laterHigh = task({ deadline_at: at('2026-10-30T17:00'), priority: 4 })
    const views = scan([soonLow, laterHigh], { id: 'priority', everywhere: true })
    expect(ids(section(views, 'coming-up').tasks)).toEqual([laterHigh.id, soonLow.id])
  })

  test('each sort orders by its field: newest, oldest, horizon (unset after weeks), deadline, target, last touched', () => {
    const everywhere = (tasks: Task[], id: ModeSort['id']) =>
      ids(section(scan(tasks, { id, everywhere: true }), 'newest').tasks)
    const a = task({ created_at: at('2026-10-01T09:00') })
    const b = task({ created_at: at('2026-10-20T09:00') })
    expect(everywhere([a, b], 'newest')).toEqual([b.id, a.id])
    expect(everywhere([b, a], 'oldest')).toEqual([a.id, b.id])
    const weeks = task({ horizon: 'weeks' })
    const unset = task({ horizon: null })
    const days = task({ horizon: 'days' })
    const months = task({ horizon: 'months' })
    expect(everywhere([months, unset, weeks, days], 'horizon')).toEqual([
      days.id,
      weeks.id,
      unset.id,
      months.id,
    ])
    const dlLate = task({ deadline_at: at('2026-11-20T17:00') })
    const dlSoon = task({ deadline_at: at('2026-11-02T17:00') })
    const none = task()
    expect(everywhere([none, dlLate, dlSoon], 'deadline')).toEqual([dlSoon.id, dlLate.id, none.id])
    const auto = task({ due_at: at('2026-10-29T09:00'), target_auto: true })
    const picked = task({ due_at: at('2026-11-01T09:00') })
    // An automatic target is not a target the user picked: it sorts last.
    expect(everywhere([auto, picked], 'target')).toEqual([picked.id, auto.id])
    const touchedOld = task({ updated_at: at('2026-10-01T09:00') })
    const touchedNew = task({ updated_at: at('2026-10-28T08:00') })
    expect(everywhere([touchedOld, touchedNew], 'touched')).toEqual([touchedNew.id, touchedOld.id])
  })

  test('the default is Newest, category sections only', () => {
    expect(DEFAULT_MODE_SORT).toEqual({ id: 'newest', everywhere: false })
  })
})

describe("Scan's age steps (which sections draw them)", () => {
  const pulled = () =>
    task({
      queued_at: at('2026-10-28T03:00'),
      queued_from_due_at: at('2026-10-27T09:00'),
      horizon: 'weeks',
    })
  const coming = () => task({ deadline_at: at('2026-10-29T17:00') })
  const plain = () => task({ horizon: 'weeks' })

  test('Pulled, Newest and the horizon sections, under "Newest" (the default)', () => {
    const views = scan([pulled(), coming(), plain()], { id: 'newest', everywhere: false })
    expect(section(views, 'pulled').ageSteps).toBe(true)
    expect(section(views, 'newest').ageSteps).toBe(true)
    expect(section(views, 'horizon-weeks').ageSteps).toBe(true)
    // Coming up runs by its date, never the created one.
    expect(section(views, 'coming-up').ageSteps).toBe(false)
  })

  test('another sort re-orders the sortable sections: no breaks there; Newest keeps them', () => {
    const views = scan([pulled(), plain()], { id: 'priority', everywhere: false })
    expect(section(views, 'pulled').ageSteps).toBe(false)
    expect(section(views, 'horizon-weeks').ageSteps).toBe(false)
    expect(section(views, 'newest').ageSteps).toBe(true)
  })

  test("Today's sections never draw them", () => {
    const views = today([task({ due_at: at('2026-10-28T09:00') })])
    expect(views.every((v) => !v.ageSteps)).toBe(true)
  })
})

describe('Today: Late, then Today in O3 order (2026-10-29)', () => {
  // ctx: Wed 2026-10-28 12:00 Chicago.
  test('Late: only a passed DEADLINE; "!!", then "!", then the oldest deadline', () => {
    const oldLow = task({ deadline_at: at('2026-10-20T17:00'), priority: 1 })
    const newHigh = task({ deadline_at: at('2026-10-27T17:00'), priority: 3 })
    const urgent = task({ deadline_at: at('2026-10-28T09:00'), priority: 4 })
    const newerLow = task({ deadline_at: at('2026-10-25T17:00') })
    // Deadline passed with its target still ahead (the rental car): Late too.
    const rental = task({
      deadline_at: at('2026-10-27T17:00'),
      due_at: at('2026-10-29T09:00'),
    })
    // Over target alone is not late.
    const overOnly = task({ due_at: at('2026-10-28T08:00'), priority: 4 })
    const views = today([oldLow, newHigh, urgent, newerLow, rental, overOnly])
    expect(views.map((v) => v.id)).toEqual(['late', 'today'])
    expect(ids(section(views, 'late').tasks)).toEqual([
      urgent.id,
      newHigh.id,
      oldLow.id,
      newerLow.id,
      rental.id,
    ])
    expect(ids(section(views, 'today').tasks)).toEqual([overOnly.id])
  })

  test('no passed deadline: no Late section (its heading shows only with rows)', () => {
    const views = today([task({ due_at: at('2026-10-28T08:00') })])
    expect(views.map((v) => v.id)).toEqual(['today'])
  })

  test('Today: due rows by mark, then attempts, then time; later today by time; the net by deadline', () => {
    const due = (h: string, o: Partial<Task> = {}) => task({ due_at: at(`2026-10-28T${h}`), ...o })
    const plain1x = due('07:00', { attempts: 1 })
    const plain3x = due('09:00', { attempts: 3 })
    const high = due('11:00', { priority: 3 })
    const urgent = due('11:30', { priority: 4 })
    const later2 = due('18:00')
    const later1 = due('15:00')
    const netLate = task({ deadline_at: at('2026-10-29T20:00') })
    const netEarly = task({ deadline_at: at('2026-10-29T09:00') })
    const views = today([netLate, later2, plain1x, high, netEarly, plain3x, later1, urgent])
    expect(ids(section(views, 'today').tasks)).toEqual([
      urgent.id,
      high.id,
      plain3x.id,
      plain1x.id,
      later1.id,
      later2.id,
      netEarly.id,
      netLate.id,
    ])
  })
})
