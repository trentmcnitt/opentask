/**
 * DEADLINE-ANCHORED REPEATS — the write side (2026-10-21; docs/TASK-MODEL.md
 * § Recurrence Model). The dates themselves come from ONE pure function,
 * `occurrenceDates` (src/lib/task-segments.ts); this module decides, for a
 * create, what schedule the new row has and refuses what can't be written:
 *
 *  - a rule WITH a deadline is deadline-anchored: its occurrence is the
 *    deadline (`deadline_at` mirrors `occurrence_at`) and its target sits
 *    `target_days_before` local days earlier at `target_time`. Inferred on
 *    create from `rrule` + `deadline_at` (API and AI callers create with the
 *    fields set; a 400 there would be friction); `repeat_anchor: 'target'`
 *    with a deadline is refused — a target-anchored repeat has none;
 *  - the rule is bound to the deadline's time: a timeless rule takes it, a
 *    rule at another time is refused;
 *  - the relative target: as sent; else the inverse of a `target_at` sent
 *    with it (`relativeTargetOf`); else the default (`defaultRelativeTarget`,
 *    A1). Validated (`relativeTargetProblem`): never after the deadline,
 *    never on or before the previous deadline;
 *  - never on a reminder or a quota (their date is their occurrence / they
 *    have none), never without a rule or a deadline; the offsets only with
 *    the 'deadline' anchor, and together.
 * The PATCH and bulk-edit side is `collectRepeatSchedule` in
 * helpers/collect-field-changes.ts, held to the same messages.
 */

import { ValidationError } from '@/core/errors'
import { parseRRule, ruleTimeOfDay } from '@/core/recurrence'
import { formatAnchorTime, utcToLocal } from '@/core/recurrence/timezone'
import {
  RELATIVE_TARGET_MESSAGES,
  defaultRelativeTarget,
  relativeTargetOf,
  relativeTargetProblem,
  type RelativeTarget,
  type RepeatRule,
} from '@/lib/task-segments'
import type { RepeatAnchor } from '@/types'

export const REPEAT_ANCHOR_KIND_MESSAGE =
  "repeat_anchor 'deadline' is for an ordinary repeating task: a reminder's date is its occurrence, and a quota has none"
export const REPEAT_ANCHOR_NEEDS_RULE_MESSAGE =
  "repeat_anchor 'deadline' needs a rule (rrule) and a deadline (deadline_at)"
export const TARGET_ANCHORED_DEADLINE_MESSAGE =
  "A repeating task anchored on its target has no deadline: send repeat_anchor 'deadline' to repeat the deadline, or no deadline_at"
export const RELATIVE_TARGET_NEEDS_DEADLINE_MESSAGE =
  "target_days_before and target_time are for a repeat anchored on its deadline (repeat_anchor 'deadline')"
export const RELATIVE_TARGET_PAIR_MESSAGE = 'Send target_days_before and target_time together'
export const RULE_NOT_ON_DEADLINE_MESSAGE =
  "A deadline-anchored rule repeats the deadline: its time (BYHOUR/BYMINUTE) must be the deadline's local time"
export const TARGET_AFTER_DEADLINE_MESSAGE = 'The target must not be after the deadline'

/** Whether the row a write leaves is an ordinary task (not a reminder, not a quota). */
export interface RowKind {
  isReminder: boolean
  isTracked: boolean
}

/**
 * The anchor a CREATE gives the row: 'deadline' when sent, or inferred from a
 * rule with a deadline on an ordinary task; else 'target'. Throws the 400s
 * that need no dates.
 */
export function createAnchor(
  input: {
    repeat_anchor?: RepeatAnchor
    target_days_before?: number
    target_time?: string
    deadline_at?: string | null
  },
  rrule: string | null | undefined,
  kind: RowKind,
): RepeatAnchor {
  const ordinary = !kind.isReminder && !kind.isTracked
  const hasDeadline = !!input.deadline_at
  if (input.repeat_anchor === 'deadline' && !ordinary) {
    throw new ValidationError(REPEAT_ANCHOR_KIND_MESSAGE)
  }
  if (input.repeat_anchor === 'deadline' && (!rrule || !hasDeadline)) {
    throw new ValidationError(REPEAT_ANCHOR_NEEDS_RULE_MESSAGE)
  }
  const anchor: RepeatAnchor =
    input.repeat_anchor ?? (rrule && hasDeadline && ordinary ? 'deadline' : 'target')
  if (anchor === 'target' && rrule && hasDeadline && ordinary) {
    throw new ValidationError(TARGET_ANCHORED_DEADLINE_MESSAGE)
  }
  const sentOffsets = [input.target_days_before, input.target_time].filter((v) => v !== undefined)
  if (sentOffsets.length > 0 && anchor !== 'deadline') {
    throw new ValidationError(RELATIVE_TARGET_NEEDS_DEADLINE_MESSAGE)
  }
  if (sentOffsets.length === 1) throw new ValidationError(RELATIVE_TARGET_PAIR_MESSAGE)
  return anchor
}

/** The local HH:MM of an instant. */
function localTime(iso: string, timezone: string): string {
  const local = utcToLocal(iso, timezone)
  return formatAnchorTime(local.hour, local.minute)
}

/**
 * A deadline-anchored rule must walk the deadline's time: refused when its
 * BYHOUR/BYMINUTE (or `anchorTime`) says another (`RULE_NOT_ON_DEADLINE_MESSAGE`).
 * The caller fills a timeless rule from the deadline first.
 */
export function assertRuleOnDeadline(
  rrule: string,
  anchorTime: string | null,
  deadlineAt: string,
  timezone: string,
): void {
  if (anchorTime === null && parseRRule(rrule).byhour === undefined) return
  const { hour, minute } = ruleTimeOfDay(rrule, anchorTime)
  if (formatAnchorTime(hour, minute) !== localTime(deadlineAt, timezone)) {
    throw new ValidationError(RULE_NOT_ON_DEADLINE_MESSAGE)
  }
}

/**
 * The relative target a deadline-anchored repeat is written with, validated
 * against its rule from its first deadline:
 *  - `sent`: the caller's own offsets;
 *  - else `targetAt` (a first target sent with the deadline `givenDeadline`):
 *    its inverse (`relativeTargetOf`) — refused when after the deadline;
 *  - else the default (`defaultRelativeTarget`, A1).
 */
export function resolveRelativeTarget(opts: {
  sent: RelativeTarget | null
  targetAt: string | null
  givenDeadline: string
  rule: RepeatRule
  firstDeadline: string
  timezone: string
  morningTime: string
}): RelativeTarget {
  const { rule, firstDeadline, timezone } = opts
  let offset = opts.sent
  if (!offset && opts.targetAt) {
    offset = relativeTargetOf(opts.targetAt, opts.givenDeadline, timezone)
    if (!offset) throw new ValidationError(TARGET_AFTER_DEADLINE_MESSAGE)
  }
  offset ??= defaultRelativeTarget(rule, firstDeadline, timezone, opts.morningTime)
  const problem = relativeTargetProblem(offset, rule, firstDeadline, timezone)
  if (problem) throw new ValidationError(RELATIVE_TARGET_MESSAGES[problem])
  return offset
}
