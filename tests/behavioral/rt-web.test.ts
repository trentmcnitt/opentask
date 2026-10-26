/**
 * RELATIVE TARGETS IN THE EDITOR (2026-10-24, plan-relative-targets §9) — the
 * pure half of PR B: the picker's "Before the deadline" chips, the default
 * pick (ruling 10), the wire shape, the Target row's preview and words, and
 * every-time mode's link (one control, one stored shape for repeats and
 * one-offs). Every date is a LOCAL time in America/Chicago.
 */
import { describe, expect, test } from 'vitest'
import { DateTime } from 'luxon'
import {
  deadlineChipRows,
  defaultPick,
  periodChoiceLabel,
  pickAfterDeadline,
  pickAt,
  pickFields,
  pickOf,
  pickWords,
  relativePreview,
  samePick,
} from '@/lib/relative-target-ui'
import {
  createModeTask,
  draftFromTask,
  draftReducer,
  draftToCreateFields,
  draftToPatch,
  draftsEqual,
  type EveryTimeContext,
  type EveryTimeTask,
} from '@/lib/every-time'
import { deadlineRepeatLabel, relativeDaysWords } from '@/lib/editor-target-labels'
import { formatEditDescription } from '@/lib/field-labels'
import { CALENDAR_DAY_START } from '@/lib/opentask-day'

const TZ = 'America/Chicago'
const at = (local: string) => DateTime.fromISO(local, { zone: TZ }).toUTC().toISO()!
const same = (a: string, b: string) => expect(Date.parse(a)).toBe(Date.parse(b))

const SLOTS = [
  { id: 13, label: 'Evening', start_time: '20:30' },
  { id: 11, label: 'Morning', start_time: '06:30' },
  { id: 12, label: 'Afternoon', start_time: '12:00' },
]

/** Mon Oct 26 2026, 10:00 AM Chicago. */
const NOW = new Date(at('2026-10-26T10:00'))
/** Tue Nov 3, 8:30 AM — after the Nov 1 fall-back. */
const DEADLINE = at('2026-11-03T08:30')

describe('RT-WEB-01: the "Before the deadline" chips', () => {
  test('two rows of the periods in start order; a deadline-day period after the deadline is greyed', () => {
    const rows = deadlineChipRows(DEADLINE, SLOTS, TZ, NOW)
    expect(rows.map((r) => r.title)).toEqual(['The day before', 'The deadline day'])
    expect(rows[0].chips.map((c) => periodChoiceLabel(c.slot))).toEqual([
      'Morning · 6:30 AM',
      'Afternoon · 12:00 PM',
      'Evening · 8:30 PM',
    ])
    same(rows[0].chips[2].at, at('2026-11-02T20:30'))
    expect(rows[0].chips.every((c) => !c.afterDeadline)).toBe(true)
    expect(rows[1].chips.map((c) => [c.slot.label, c.afterDeadline])).toEqual([
      ['Morning', false],
      ['Afternoon', true],
      ['Evening', true],
    ])
    expect(rows[1].chips[0].pick).toEqual({ days: 0, time: '06:30', slot_id: 11 })
  })

  test('a moment already past is left out; a row with nothing left goes', () => {
    // Deadline tomorrow (Tue Oct 27) at 8:30: the day before is today — only
    // Afternoon and Evening are still ahead at 10 AM; the deadline day's
    // Morning (6:30) is ahead, its later periods are greyed.
    const rows = deadlineChipRows(at('2026-10-27T08:30'), SLOTS, TZ, NOW)
    expect(rows[0].chips.map((c) => c.slot.label)).toEqual(['Afternoon', 'Evening'])
    expect(rows[1].chips.map((c) => c.slot.label)).toEqual(['Morning', 'Afternoon', 'Evening'])
    // Deadline today at 11 PM: no day-before row; the deadline day's Evening is ahead.
    const today = deadlineChipRows(at('2026-10-26T23:00'), SLOTS, TZ, NOW)
    expect(today.map((r) => r.title)).toEqual(['The deadline day'])
    expect(today[0].chips.map((c) => c.slot.label)).toEqual(['Afternoon', 'Evening'])
    // Only greyed chips left: the row goes too.
    expect(deadlineChipRows(at('2026-10-26T11:00'), SLOTS, TZ, NOW)).toEqual([])
    expect(deadlineChipRows(DEADLINE, [], TZ, NOW)).toEqual([])
  })
})

describe('RT-WEB-02: the pick — default, wire, words', () => {
  test('the default is the day before at Default task time, copied linked or custom (ruling 10)', () => {
    expect(defaultPick({ time: '06:30', slot_id: 11 }, true)).toEqual({
      days: 1,
      time: '06:30',
      slot_id: 11,
    })
    expect(defaultPick({ time: '06:30', slot_id: 11 }, false)).toEqual({
      days: 1,
      time: '06:30',
      slot_id: null,
    })
    expect(defaultPick({ time: '07:15', slot_id: null }, true).slot_id).toBeNull()
  })

  test('the wire: a link sends the period alone, a custom time the time alone', () => {
    expect(pickFields({ days: 1, time: '20:30', slot_id: 13 })).toEqual({
      target_days_before: 1,
      target_slot_id: 13,
    })
    expect(pickFields({ days: 2, time: '18:00', slot_id: null })).toEqual({
      target_days_before: 2,
      target_time: '18:00',
    })
  })

  test('the moment (clamped to the deadline) and the after-deadline refusal', () => {
    same(pickAt({ days: 1, time: '20:30', slot_id: 13 }, DEADLINE, TZ), at('2026-11-02T20:30'))
    expect(pickAfterDeadline({ days: 0, time: '08:45' }, DEADLINE, TZ)).toBe(true)
    expect(pickAfterDeadline({ days: 0, time: '08:30' }, DEADLINE, TZ)).toBe(false)
    expect(pickAfterDeadline({ days: 1, time: '23:00' }, DEADLINE, TZ)).toBe(false)
  })

  test('the row words: "the day before, Evening"; a custom time (or an unseen period) has none', () => {
    expect(pickWords({ days: 1, time: '20:30', slot_id: 13 }, SLOTS)).toBe(
      'the day before, Evening',
    )
    expect(pickWords({ days: 1, time: '18:00', slot_id: null }, SLOTS)).toBe('the day before')
    expect(pickWords({ days: 0, time: '06:30', slot_id: 11 }, SLOTS)).toBe(
      'the deadline day, Morning',
    )
    // A collaborator sees no periods: the owner's link reads as its time.
    expect(pickWords({ days: 3, time: '20:30', slot_id: 13 }, [])).toBe('3 days before')
  })

  test('pickOf reads a row; samePick compares all three', () => {
    expect(pickOf({ target_days_before: 1, target_time: '20:30', target_slot_id: 13 })).toEqual({
      days: 1,
      time: '20:30',
      slot_id: 13,
    })
    expect(pickOf({ target_days_before: null, target_time: null })).toBeNull()
    expect(
      samePick({ days: 1, time: '20:30', slot_id: 13 }, { days: 1, time: '20:30', slot_id: null }),
    ).toBe(false)
  })
})

describe('RT-WEB-03: the Target row preview (staging)', () => {
  const stored = { days: 1, time: '20:30', slot_id: 13 }
  const base = {
    stored,
    staged: null,
    deadline: DEADLINE,
    fixedStaged: false,
    deadlineStaged: false,
    storedTarget: at('2026-11-02T20:30'),
    timezone: TZ,
  }

  test('a stored relative target, nothing staged: its stored date, not blue', () => {
    expect(relativePreview(base)).toEqual({
      pick: stored,
      at: at('2026-11-02T20:30'),
      dirty: false,
    })
  })

  test('a staged deadline re-derives it (blue): the target follows', () => {
    const p = relativePreview({ ...base, deadline: at('2026-11-05T08:30'), deadlineStaged: true })
    same(p!.at, at('2026-11-04T20:30'))
    expect(p!.dirty).toBe(true)
  })

  test('a staged pick is derived from the (staged) deadline', () => {
    const p = relativePreview({
      ...base,
      stored: null,
      storedTarget: null,
      staged: { days: 0, time: '06:30', slot_id: 11 },
    })
    same(p!.at, at('2026-11-03T06:30'))
    expect(p!.dirty).toBe(true)
  })

  test('a staged date, Remove target or a deck makes it fixed; the deadline removed too (ruling 5)', () => {
    expect(relativePreview({ ...base, fixedStaged: true })).toBeNull()
    expect(relativePreview({ ...base, deadline: null, deadlineStaged: true })).toBeNull()
    expect(relativePreview({ ...base, stored: null })).toBeNull()
  })
})

describe('RT-WEB-04: every-time mode keeps one shape — the offsets and the link', () => {
  const ctx: EveryTimeContext = {
    timezone: TZ,
    morningTime: '06:30',
    morningSlotId: 11,
    now: NOW,
    dayStart: CALENDAR_DAY_START,
  }
  const BASE: EveryTimeTask = {
    rrule: null,
    recurrence_mode: 'from_due',
    anchor_time: null,
    deadline_at: null,
    due_at: null,
    occurrence_at: null,
    repeat_anchor: null,
    target_days_before: null,
    target_time: null,
    on_deck_day: null,
  }
  const RELATIVE_ONE_OFF: EveryTimeTask = {
    ...BASE,
    deadline_at: DEADLINE,
    due_at: at('2026-11-02T20:30'),
    target_days_before: 1,
    target_time: '20:30',
    target_slot_id: 13,
  }
  const LINKED_REPEAT: EveryTimeTask = {
    ...BASE,
    rrule: 'FREQ=WEEKLY;BYDAY=TU;BYHOUR=8;BYMINUTE=30',
    anchor_time: '08:30',
    deadline_at: DEADLINE,
    occurrence_at: DEADLINE,
    due_at: at('2026-11-02T20:30'),
    repeat_anchor: 'deadline',
    target_days_before: 1,
    target_time: '20:30',
    target_slot_id: 13,
  }

  test('a linked deadline-anchored repeat opens on its link; a period pick sends the period alone', () => {
    const draft = draftFromTask(LINKED_REPEAT, ctx)
    expect(draft).toMatchObject({ daysBefore: 1, targetTime: '20:30', targetSlotId: 13 })
    expect(draftToPatch(LINKED_REPEAT, draft, ctx)).toEqual({})
    const morning = draftReducer(draft, { type: 'targetTime', time: '06:30', slotId: 11 })
    expect(draftToPatch(LINKED_REPEAT, morning, ctx)).toEqual({
      target_days_before: 1,
      target_slot_id: 11,
    })
    // "Custom time…" keeps the time and drops the link: the time alone.
    const custom = draftReducer(draft, { type: 'targetTime', time: '20:30', slotId: null })
    expect(draftsEqual(custom, draft)).toBe(false)
    expect(draftToPatch(LINKED_REPEAT, custom, ctx)).toEqual({
      target_days_before: 1,
      target_time: '20:30',
    })
    // A days change on a linked target keeps the link.
    const two = draftReducer(draft, { type: 'daysBefore', days: 2 })
    expect(draftToPatch(LINKED_REPEAT, two, ctx)).toEqual({
      target_days_before: 2,
      target_slot_id: 13,
    })
  })

  test('"Make it repeat" on a relative one-off reads its stored offsets AND keeps the link', () => {
    const draft = draftFromTask(RELATIVE_ONE_OFF, ctx)
    expect(draft).toMatchObject({
      anchor: 'deadline',
      deadlineTime: '08:30',
      daysBefore: 1,
      targetTime: '20:30',
      targetSlotId: 13,
    })
    expect(draftToPatch(RELATIVE_ONE_OFF, draft, ctx)).toMatchObject({
      repeat_anchor: 'deadline',
      target_days_before: 1,
      target_slot_id: 13,
    })
  })

  test('a default relative target at Default task time copies its link (ruling 10)', () => {
    // A one-off with a deadline and no target (the deadlines page off): the default.
    const far = { ...BASE, deadline_at: DEADLINE }
    const draft = draftFromTask(far, ctx)
    expect(draft).toMatchObject({ anchor: 'deadline', targetTime: '06:30', targetSlotId: 11 })
    // Not the user's task (no link to offer): custom.
    const theirs = draftFromTask(far, { ...ctx, morningSlotId: null })
    expect(theirs.targetSlotId).toBeNull()
  })

  test('leaving the deadline anchor drops the link; a target-anchored rule time has none', () => {
    const draft = draftFromTask(LINKED_REPEAT, ctx)
    const left = draftReducer(draft, { type: 'anchor', anchor: 'target', ctx })
    expect(left).toMatchObject({ anchor: 'target', targetSlotId: null })
    const fridays = draftFromTask(
      { ...BASE, rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0', anchor_time: '16:00' },
      ctx,
    )
    expect(
      draftReducer(fridays, { type: 'targetTime', time: '12:00', slotId: 12 }).targetSlotId,
    ).toBeNull()
  })

  test('create mode: a staged relative pick rides into "Make it repeat" and the create fields', () => {
    const staged = {
      dueAt: at('2026-11-02T20:30'),
      deadlineAt: DEADLINE,
      relative: { days: 1, time: '20:30', slot_id: 13 },
    }
    const task = createModeTask(staged)
    expect(task).toMatchObject({ target_days_before: 1, target_time: '20:30', target_slot_id: 13 })
    const draft = draftFromTask(task, ctx)
    expect(draftToCreateFields(staged, draft, ctx)).toMatchObject({
      repeat_anchor: 'deadline',
      target_days_before: 1,
      target_slot_id: 13,
    })
    // No deadline staged: the pick is not carried.
    expect(createModeTask({ ...staged, deadlineAt: null }).target_days_before).toBeNull()
  })

  test('0 days reads "the deadline day" everywhere (Trent, 2026-10-24)', () => {
    expect(relativeDaysWords(0)).toBe('the deadline day')
    expect(pickWords({ days: 0, time: '06:30', slot_id: null }, SLOTS)).toBe('the deadline day')
    expect(
      deadlineRepeatLabel({ ...LINKED_REPEAT, target_days_before: 0, target_time: '06:30' }),
    ).toBe('target the deadline day at 6:30 AM')
    // The activity / undo description.
    expect(
      formatEditDescription('Task', ['target_days_before', 'target_time'], {
        beforeState: { id: 1, target_days_before: 1, target_time: '20:30' },
        afterState: { id: 1, target_days_before: 0, target_time: '06:30' },
        userTimezone: TZ,
        isSnooze: false,
        dayStart: CALENDAR_DAY_START,
        targetSlotLabel: 'Morning',
      }),
    ).toBe('Target the deadline day at Morning (6:30 AM) — "Task"')
  })

  test("the repeat's Deadline line names the period it follows", () => {
    expect(deadlineRepeatLabel(LINKED_REPEAT, 'Evening')).toBe(
      'target the day before at Evening (8:30 PM)',
    )
    expect(deadlineRepeatLabel(LINKED_REPEAT)).toBe('target the day before at 8:30 PM')
  })
})
