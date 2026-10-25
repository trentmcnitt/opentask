/**
 * RELATIVE TARGETS IN THE EDITOR (2026-10-24, plan-relative-targets §9; the
 * model is docs/TASK-MODEL.md § Relative targets). The pure half of the web
 * UI, tested in tests/behavioral/rt-web.test.ts:
 *
 *  - a PICK is `{ days, time, slot_id }`: local days before the deadline, the
 *    time, and the reminder period the time follows (null: a custom time —
 *    `time` is then the user's own). One shape for one-offs and
 *    deadline-anchored repeats (the stored `target_days_before` /
 *    `target_time` / `target_slot_id`);
 *  - THE WIRE: a linked pick sends the period alone (`target_slot_id`; the
 *    server sets the time to its start), a custom one the time alone (which
 *    drops a stored link) — never both, never with a `target_at` (ruling 7);
 *  - THE CHIPS of the target picker's "Before the deadline" block — "The day
 *    before" and "The deadline day", one per period ("Evening · 8:30 PM"); a
 *    moment already past is left out, a deadline-day time after the deadline
 *    is greyed ("after the deadline");
 *  - THE DEFAULT pick: the day before at "Default task time", copied as the
 *    setting has it — linked or custom (ruling 10);
 *  - THE ROW's words: "· the day before, Evening · moves with the deadline"
 *    (custom: "· the day before · moves with the deadline").
 *
 * No date maths on the offsets here: every moment comes from
 * `relativeTargetAt` (guard RT-G01 — src/lib/task-segments.ts only).
 */

import { relativeDaysWords } from '@/lib/editor-target-labels'
import { relativeOneOffProblem, relativeTargetAt } from '@/lib/task-segments'
import { sortSlotsByStart, type TimeSlot } from '@/lib/time-slot-assign'
import { formatClockTime } from '@/lib/time-utils'

/** A relative target as the editor stages it. */
export interface RelativePick {
  /** Local calendar days before the deadline (0 = the deadline's own day). */
  days: number
  /** HH:MM — the linked period's start, or a custom time. */
  time: string
  /** The period the time follows, or null for a custom time. */
  slot_id: number | null
}

/** The period fields the editor reads. */
export type SlotChoice = Pick<TimeSlot, 'id' | 'label' | 'start_time'>

export const MOVES_WITH_DEADLINE = 'moves with the deadline'
export const AFTER_THE_DEADLINE = 'after the deadline'
export const BEFORE_THE_DEADLINE = 'Before the deadline'

/** "Evening · 8:30 PM" — a period as the chips and the time select name it. */
export function periodChoiceLabel(slot: Pick<SlotChoice, 'label' | 'start_time'>): string {
  return `${slot.label} · ${formatClockTime(slot.start_time)}`
}

/** The stored pick on a row (both offsets), or null. */
export function pickOf(task: {
  target_days_before: number | null
  target_time: string | null
  target_slot_id?: number | null
}): RelativePick | null {
  if (task.target_days_before === null || task.target_time === null) return null
  return {
    days: task.target_days_before,
    time: task.target_time,
    slot_id: task.target_slot_id ?? null,
  }
}

/** Two picks that save the same thing. */
export function samePick(a: RelativePick | null, b: RelativePick | null): boolean {
  if (!a || !b) return a === b
  return a.days === b.days && a.time === b.time && a.slot_id === b.slot_id
}

/**
 * A pick's link as the viewer can show it: the period it names when that is
 * one of `slots` (the viewer's own), else null — read as a custom time. A
 * collaborator never has the owner's periods, so an owner's link reads as
 * its time.
 */
export function pickSlot(pick: RelativePick, slots: readonly SlotChoice[]): SlotChoice | null {
  if (pick.slot_id === null) return null
  return slots.find((s) => s.id === pick.slot_id) ?? null
}

/**
 * THE WIRE (the server's `linkTargetTime`): linked → `{ target_days_before,
 * target_slot_id }`; custom → `{ target_days_before, target_time }`.
 */
export function pickFields(
  pick: RelativePick,
):
  | { target_days_before: number; target_slot_id: number }
  | { target_days_before: number; target_time: string } {
  return pick.slot_id !== null
    ? { target_days_before: pick.days, target_slot_id: pick.slot_id }
    : { target_days_before: pick.days, target_time: pick.time }
}

/**
 * THE DEFAULT pick (ruling 10): the day before at "Default task time" — its
 * link copied when the setting follows a period the viewer may link to
 * (`linkable`: the user owns the task); else its time as a custom one.
 */
export function defaultPick(
  morning: { time: string; slot_id: number | null },
  linkable: boolean,
): RelativePick {
  return { days: 1, time: morning.time, slot_id: linkable ? morning.slot_id : null }
}

/** When the pick puts the target for `deadlineAt` (clamped to it: never after). */
export function pickAt(pick: RelativePick, deadlineAt: string, timezone: string): string {
  return relativeTargetAt(deadlineAt, { days_before: pick.days, time: pick.time }, timezone)
}

/** Whether the server would refuse the pick: the deadline's own day, a time after it. */
export function pickAfterDeadline(
  pick: Pick<RelativePick, 'days' | 'time'>,
  deadlineAt: string,
  timezone: string,
): boolean {
  return relativeOneOffProblem({ days_before: pick.days, time: pick.time }, deadlineAt, timezone)
    ? true
    : false
}

export interface DeadlineChip {
  slot: SlotChoice
  pick: RelativePick
  /** When it puts the target (UTC ISO). */
  at: string
  /** Greyed: a deadline-day time after the deadline's. */
  afterDeadline: boolean
}

export interface DeadlineChipRow {
  /** "The day before" / "The deadline day". */
  title: string
  days: 1 | 0
  chips: DeadlineChip[]
}

/**
 * THE "BEFORE THE DEADLINE" CHIP ROWS: "The day before" and "The deadline
 * day", one chip per period in start order. A moment already past is left
 * out (a row with none left goes); a deadline-day period after the deadline
 * stays, greyed. Empty with no periods (or none the viewer may link to).
 */
export function deadlineChipRows(
  deadlineAt: string,
  slots: readonly SlotChoice[],
  timezone: string,
  now: Date = new Date(),
): DeadlineChipRow[] {
  const rows: DeadlineChipRow[] = []
  for (const [days, title] of [
    [1, 'The day before'],
    [0, 'The deadline day'],
  ] as const) {
    const chips = sortSlotsByStart(slots).flatMap((slot): DeadlineChip[] => {
      const pick = { days, time: slot.start_time, slot_id: slot.id }
      const afterDeadline = pickAfterDeadline(pick, deadlineAt, timezone)
      const at = pickAt(pick, deadlineAt, timezone)
      if (!afterDeadline && Date.parse(at) <= now.getTime()) return []
      return [{ slot, pick, at, afterDeadline }]
    })
    if (chips.some((c) => !c.afterDeadline)) rows.push({ title, days, chips })
  }
  return rows
}

/**
 * THE ROW's words after the target's date: "the day before, Evening" — or,
 * a custom time (or a period the viewer can't see), "the day before".
 */
export function pickWords(pick: RelativePick, slots: readonly SlotChoice[]): string {
  const slot = pickSlot(pick, slots)
  const days = relativeDaysWords(pick.days)
  return slot ? `${days}, ${slot.label}` : days
}

/**
 * The relative target the Target row shows (`targetValueFor`): the staged
 * pick, else the stored one — re-derived from the staged deadline, the
 * target the Save stores. Null when the row's target isn't relative after
 * the staged edits: a date staged (any pick or pad tap makes it fixed,
 * ruling 1), the target or the deadline removed (ruling 5), or no deadline.
 */
export function relativePreview(s: {
  stored: RelativePick | null
  staged: RelativePick | null
  /** The deadline the Save leaves (the staged one, else the stored one). */
  deadline: string | null
  /** A fixed date, a removed target or a deck is staged. */
  fixedStaged: boolean
  /** The deadline is staged (changed or removed). */
  deadlineStaged: boolean
  storedTarget: string | null
  timezone: string
}): { pick: RelativePick; at: string; dirty: boolean } | null {
  if (s.fixedStaged || !s.deadline) return null
  const pick = s.staged ?? s.stored
  if (!pick) return null
  // A stored relative target with nothing staged reads its own stored date
  // (the server's, which a period retime keeps current).
  if (!s.staged && !s.deadlineStaged && s.storedTarget) {
    return { pick, at: s.storedTarget, dirty: false }
  }
  const at = pickAt(pick, s.deadline, s.timezone)
  const dirty =
    !!s.staged || s.storedTarget === null || Date.parse(at) !== Date.parse(s.storedTarget)
  return { pick, at, dirty }
}
