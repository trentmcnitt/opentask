/**
 * RELATIVE TARGETS — the write side (2026-10-24; docs/TASK-MODEL.md
 * § Relative targets; plan `plan-relative-targets-1024.md` §1).
 *
 * A relative target is the pair (`target_days_before`, `target_time`) plus
 * the period the time follows (`target_slot_id`, or NULL for a custom time).
 * One-offs with a deadline and deadline-anchored repeats store the same three
 * columns; the date maths is ONE pure function, `relativeTargetAt`
 * (src/lib/task-segments.ts). This module decides what a write sends:
 *
 *  - THE LINK (`linkTargetTime`), resolved at WRITE time through anchor-times'
 *    `resolveTime`: `target_slot_id` sets `target_time` to that period's
 *    current start (a different `target_time` in the same body is a 400);
 *    `target_time` alone is a custom time and clears the link. The period
 *    must be the task OWNER's (on a shared task too — a collaborator's own
 *    period is a 400). Invariant: a linked row's `target_time` IS its
 *    period's start, so every reader (and every advance) reads stored columns
 *    and never looks a period up; the period retime keeps it so.
 *  - THE ONE-OFF 400s (`assertOneOffRelative`): offsets with no deadline,
 *    only one of the pair, `target_at` with offsets (ruling 7),
 *    `deadline_at: null` with offsets, offsets on a reminder or a quota, a
 *    deck write with offsets, and a same-day time after the deadline (a later
 *    deadline move alone clamps instead). `{target_days_before: null,
 *    target_time: null}` alone makes the target fixed where it is.
 *  - STOP REPEATING (ruling 6, `stopKeepsRelative`): a deadline-anchored
 *    repeat whose rule goes keeps its offsets and link — a relative one-off —
 *    when its deadline stays, this occurrence's target wasn't moved and it
 *    isn't on deck.
 *  - THE LINK THE WRITE LEAVES (`linkAfter`): kept only while the time is
 *    still the linked one.
 *  - A PERIOD RETIME a row can't take (`retimeRefused`), and THE REOPEN
 *    re-derivation (`rederiveOnReopen`) for a closed row a retime moved.
 */

import { ValidationError } from '@/core/errors'
import { listTimeSlots } from '@/core/time-slots'
import { resolveTime } from '@/lib/anchor-times'
import {
  RELATIVE_TARGET_MESSAGES,
  isDeadlineAnchored,
  isRelativeOneOff,
  relativeOf,
  relativeOneOffProblem,
  relativeTargetAt,
  relativeTargetProblem,
  targetMoved,
  type RelativeTarget,
} from '@/lib/task-segments'
import type { TimeSlot } from '@/lib/time-slot-assign'
import type { Task } from '@/types'
import { getTargetContext } from './target-context'

export const TARGET_SLOT_NOT_OWNED_MESSAGE =
  "target_slot_id must name one of the task owner's reminder periods"
export const TARGET_SLOT_TIME_MESSAGE =
  "target_slot_id sets target_time to that period's start: send one or the other"
export const RELATIVE_WITH_TARGET_MESSAGE =
  'Send target_at or target_days_before / target_time, not both: a picked date makes the target fixed'
export const RELATIVE_NEEDS_DEADLINE_MESSAGE =
  'A relative target (target_days_before / target_time) needs a deadline: it is derived from it'
export const RELATIVE_WITH_DEADLINE_CLEAR_MESSAGE =
  'Removing the deadline makes the target fixed: send deadline_at null without target_days_before / target_time'
export const RELATIVE_KIND_MESSAGE =
  'A reminder or a quota has no relative target (target_days_before / target_time)'
export const RELATIVE_WITH_DECK_MESSAGE =
  'Send on_deck_day without target_days_before / target_time: a deck has no target'
export const RELATIVE_PAIR_MESSAGE = 'Send target_days_before and target_time together'

/** The link fields of a write (PATCH, bulk edit, create, a period hook). */
export interface LinkInput {
  target_days_before?: number | null
  target_time?: string | null
  target_slot_id?: number | null
  /**
   * Server-internal: the period RETIME's write (`src/core/time-slots/edit.ts`,
   * which sends the period again, at its new start) — the stamp keeps
   * `target_set_at` (decision 11).
   */
  retime?: boolean
}

/** A period lookup, by owner (bulk callers memoize it: one read per owner). */
export type SlotsFor = (ownerId: number) => readonly TimeSlot[]

export const ownerSlots: SlotsFor = (ownerId) => listTimeSlots(ownerId)

/**
 * THE LINK, resolved at write time (`resolveTime`): the input with
 * `target_time` filled from a sent period, and what the write does to the
 * link — a period id, null (unlinked: a custom time sent, or `target_slot_id:
 * null`), or undefined (left as stored). Throws the ownership and conflict
 * 400s. A period the owner doesn't have is refused, never kept as a snapshot.
 */
export function linkTargetTime<I extends LinkInput>(
  ownerId: number,
  input: I,
  slotsFor: SlotsFor = ownerSlots,
): { input: I; link: number | null | undefined } {
  const slotId = input.target_slot_id
  if (slotId === undefined) {
    return { input, link: input.target_time !== undefined ? null : undefined }
  }
  if (slotId === null) return { input, link: null }
  const resolved = resolveTime(
    { time: input.target_time ?? '', slot_id: slotId },
    slotsFor(ownerId),
  )
  if (resolved.slot_id === null) throw new ValidationError(TARGET_SLOT_NOT_OWNED_MESSAGE)
  if (input.target_time != null && input.target_time !== resolved.time) {
    throw new ValidationError(TARGET_SLOT_TIME_MESSAGE)
  }
  return { input: { ...input, target_time: resolved.time }, link: slotId }
}

/**
 * The link the write LEAVES, judged on the resulting offsets: none without a
 * relative target; the one sent; else the stored one while the time is still
 * the linked time (a target derived from another source — a `target_at` a
 * repeat took its offsets from — is custom).
 */
export function linkAfter(
  task: Pick<Task, 'target_slot_id' | 'target_time'>,
  relative: RelativeTarget | null,
  link: number | null | undefined,
): number | null {
  if (!relative) return null
  if (link !== undefined) return link
  return task.target_slot_id !== null && relative.time === task.target_time
    ? task.target_slot_id
    : null
}

/** Whether a write sends the offsets (or their time). */
export function sendsRelative(input: LinkInput): boolean {
  return input.target_days_before !== undefined || input.target_time !== undefined
}

/** What `assertOneOffRelative` judges: the row the write leaves. */
export interface OneOffWrite {
  /** The stored offsets (null on a create). */
  stored: { target_days_before: number | null; target_time: string | null }
  /** Ordinary: not a reminder, not a quota. */
  ordinary: boolean
  /** The deadline the write leaves. */
  deadlineAt: string | null
  /** The owner's zone. */
  timezone: string
}

/**
 * A ONE-OFF's offsets (the row the write leaves has no rule): the merged pair
 * — the sent over the stored — or null, after the 400s (see the header).
 * Undefined when the write sends no offsets (the stored ones stand, for
 * `resolveTarget` to keep or clear).
 */
export function assertOneOffRelative(
  input: LinkInput & {
    due_at?: string | null
    deadline_at?: string | null
    on_deck_day?: string | null
  },
  w: OneOffWrite,
): RelativeTarget | null | undefined {
  if (!sendsRelative(input)) return undefined
  const days =
    input.target_days_before !== undefined ? input.target_days_before : w.stored.target_days_before
  const time = input.target_time !== undefined ? input.target_time : w.stored.target_time
  if (days === null && time === null) return null
  if (!w.ordinary) throw new ValidationError(RELATIVE_KIND_MESSAGE)
  if (days === null || time === null) throw new ValidationError(RELATIVE_PAIR_MESSAGE)
  if (input.due_at !== undefined) throw new ValidationError(RELATIVE_WITH_TARGET_MESSAGE)
  if (input.deadline_at === null) throw new ValidationError(RELATIVE_WITH_DEADLINE_CLEAR_MESSAGE)
  if (w.deadlineAt === null) throw new ValidationError(RELATIVE_NEEDS_DEADLINE_MESSAGE)
  if (typeof input.on_deck_day === 'string') throw new ValidationError(RELATIVE_WITH_DECK_MESSAGE)
  const relative = { days_before: days, time }
  const problem = relativeOneOffProblem(relative, w.deadlineAt, w.timezone)
  if (problem) throw new ValidationError(RELATIVE_TARGET_MESSAGES[problem])
  return relative
}

/**
 * STOP REPEATING (ruling 6, 2026-10-24; a behaviour change): `rrule: null` on
 * a deadline-anchored repeat with a relative target keeps the offsets and the
 * link — the task becomes a relative one-off — when the deadline stays, this
 * occurrence's target wasn't moved (`targetMoved`, read on the row BEFORE the
 * write) and it isn't on deck. Otherwise they go (a fixed target).
 */
export function stopKeepsRelative(
  task: Task,
  input: { rrule?: string | null; deadline_at?: string | null; due_at?: string | null },
  left: { ordinary: boolean; timezone: string },
): boolean {
  if (input.rrule !== null || !task.rrule || !left.ordinary) return false
  if (!isDeadlineAnchored(task) || !relativeOf(task) || task.due_at === null) return false
  if (input.deadline_at === null || input.due_at !== undefined || task.on_deck_day) return false
  return !targetMoved(task, left.timezone)
}

/**
 * Whether a period RETIME to `time` would be refused for this linked row —
 * the write-time validation a sent time gets: a one-off's same day after its
 * deadline; a deadline-anchored repeat's `after_deadline` / `overlaps_previous`
 * against its rule. Such a row is unlinked and keeps its old time instead
 * (decision 13): the retime never fails because of a task.
 */
export function retimeRefused(task: Task, time: string, timezone: string): boolean {
  const days = task.target_days_before
  if (days === null) return false
  const relative = { days_before: days, time }
  if (!task.rrule) {
    return (
      task.deadline_at !== null &&
      relativeOneOffProblem(relative, task.deadline_at, timezone) !== null
    )
  }
  const first = task.occurrence_at ?? task.deadline_at
  if (!isDeadlineAnchored(task) || !first) return false
  const rule = {
    rrule: task.rrule,
    recurrence_mode: task.recurrence_mode,
    anchor_time: task.anchor_time,
  }
  return relativeTargetProblem(relative, rule, first, timezone) !== null
}

/** A reopen's re-derivation, as the reopen's own UPDATE and snapshot take it. */
export interface RelativeRederive {
  sql: string
  values: unknown[]
  fields: (keyof Task)[]
  before: Partial<Task>
  after: Partial<Task>
}

/**
 * A RELATIVE ONE-OFF REOPENED (put back, restored from the trash): its target
 * re-derived from its current offsets — a period retime while it was closed
 * moved only its `target_time` (one compare-and-set statement over closed
 * rows), never its `due_at`. Null when the target already is the derived one
 * (or the row is not a relative one-off). Derived in the OWNER's zone.
 */
export function rederiveOnReopen(task: Task, ownerTimezone?: string): RelativeRederive | null {
  if (!isRelativeOneOff(task)) return null
  const timezone = ownerTimezone ?? getTargetContext(task.user_id).timezone
  const derived = relativeTargetAt(task.deadline_at!, relativeOf(task)!, timezone)
  if (task.due_at !== null && Date.parse(task.due_at) === Date.parse(derived)) return null
  return {
    sql: 'due_at = ?',
    values: [derived],
    fields: ['due_at'],
    before: { due_at: task.due_at },
    after: { due_at: derived },
  }
}
