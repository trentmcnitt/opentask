/**
 * What the Quick panel's THIS-ONE rows show (2026-10-22, editor plan §3; PR
 * 4c) — the props `ThisOneFields` takes, worked out from the panel's staged
 * state. Kept out of `QuickActionPanel.tsx` so the panel doesn't keep
 * growing (RT-10); the rows' rules are documented on `ThisOneFields`.
 */

import { DateTime } from 'luxon'
import { capAtDeadline, capsAt, openTaskToday } from '@/lib/task-segments'
import { planRepeatSchedule } from '@/core/tasks/repeat-schedule'
import { formatBulkRecurrence } from '@/lib/format-rrule'
import {
  deadlineRepeatLabel,
  leadLine,
  leadLineWords,
  repeatWords,
  upcomingLeadLine,
  upcomingLeadWords,
} from '@/lib/editor-target-labels'
import { openTaskDayOf } from '@/lib/opentask-day'
import { bulkEveryTimeGate, draftEnd, draftRule } from '@/lib/every-time'
import type { StagedSchedule } from '@/hooks/useEveryTime'
import type {
  DeadlineRowProps,
  LeadRowProps,
  RepeatLinkProps,
  TargetValueProps,
} from '@/components/quick-panel/ThisOneFields'
import type { Task } from '@/types'

const SAVE_FIRST = 'Save or reset your changes first'

/**
 * The this-one link (§2.2, A8, A11, A12): null where every-time mode isn't
 * offered — read-only, a reminder or a quota, a done task. In bulk, offered
 * only when every selected task can take one rule (`bulkEveryTimeGate`).
 */
export function repeatLinkFor({
  canEdit,
  isBulkMode,
  isCreateMode,
  task,
  isReminderLike,
  selectedTasks,
  bulkSummary,
  staged,
  editingBlocked,
  onOpen,
}: {
  canEdit: boolean
  isBulkMode: boolean
  isCreateMode: boolean
  task: Task | null
  isReminderLike: boolean
  selectedTasks: Task[]
  /** The selection sheet's own summary of the rules (else computed here). */
  bulkSummary: string | null
  staged: StagedSchedule | null
  editingBlocked: boolean
  onOpen: () => void
}): RepeatLinkProps | null {
  if (!canEdit) return null
  const blocked = editingBlocked ? SAVE_FIRST : null
  if (isBulkMode) {
    const gate = bulkEveryTimeGate(selectedTasks)
    const summary = bulkSummary ?? formatBulkRecurrence(selectedTasks)
    const allRepeat = selectedTasks.every((t) => !!t.rrule)
    const someRepeat = selectedTasks.some((t) => !!t.rrule)
    // Different rules (or a repeat beside a one-off): "Repeats — mixed", not
    // "Make it repeat" — and its untouched placeholder never saves (`useEveryTime`).
    const words = allRepeat && summary && summary !== '—' ? summary : someRepeat ? 'mixed' : null
    return {
      words,
      disabled: !gate.offered || editingBlocked,
      disabledReason: gate.reason ?? blocked,
      onOpen,
    }
  }
  if ((!task && !isCreateMode) || isReminderLike || task?.done) return null
  let words: string | null = null
  if (staged) {
    const end = draftEnd(staged.draft)
    words = repeatWords({
      rrule: draftRule(staged.draft),
      repeat_anchor: staged.draft.anchor,
      repeat_count: end.count,
      repeat_until: end.until,
    })
  } else if (task?.rrule) {
    words = repeatWords({ ...task, rrule: task.rrule })
  }
  return {
    words,
    short: !!staged,
    dirty: !!staged,
    disabled: editingBlocked,
    disabledReason: blocked,
    onOpen,
  }
}

/** The Deadline row by kind of task (§3 — see `ThisOneFields`). */
export function deadlineRowFor({
  hidden,
  canEdit,
  task,
  stagedAnchor,
  stagedFirstDeadline,
  rule,
  deadlineAnchored,
  editingBlocked,
  value,
  dirty,
  onChange,
  onOpenEveryTime,
  targetSlotLabel = null,
}: {
  /** Bulk, a reminder or a quota: no Deadline row. */
  hidden: boolean
  /** Read-only: a target-anchored repeat's "None" opens nothing. */
  canEdit: boolean
  task: Task | null
  /** Create mode's staged schedule's anchor, if any. */
  stagedAnchor: 'target' | 'deadline' | null
  stagedFirstDeadline: string | null
  /** The rule shown (the task's, or create mode's staged one). */
  rule: string | null
  deadlineAnchored: boolean
  editingBlocked: boolean
  value: string | null
  dirty: boolean
  onChange: (value: string | null) => void
  onOpenEveryTime: () => void
  /** The label of the period a deadline-anchored target follows (null: custom). */
  targetSlotLabel?: string | null
}): DeadlineRowProps | null {
  if (hidden) return null
  if (stagedAnchor === 'deadline') return { kind: 'text', value: stagedFirstDeadline }
  if (rule && !deadlineAnchored) {
    // A done or read-only task has no every-time mode: the row just says none.
    if (task?.done || !canEdit) return { kind: 'text', value: null }
    return {
      kind: 'everyTime',
      onOpen: onOpenEveryTime,
      disabled: editingBlocked,
      disabledReason: editingBlocked ? SAVE_FIRST : null,
    }
  }
  return {
    kind: 'picker',
    value,
    dirty,
    onChange,
    // A deadline-anchored repeat's deadline IS its schedule: no Clear
    // (DEADLINE_CLEAR_MESSAGE) — "Repeats on: Target" removes it.
    allowClear: !deadlineAnchored,
    repeatLabel: deadlineRepeatLabel(
      {
        rrule: rule,
        repeat_anchor: task?.repeat_anchor ?? null,
        target_days_before: task?.target_days_before ?? null,
        target_time: task?.target_time ?? null,
      },
      targetSlotLabel,
    ),
  }
}

/**
 * The Target row's value (§3): the staged target, "No target" (since
 * 2026-10-22 never an automatic one — a deadline task with no target goes on
 * the deadlines page, the Lead row) — or, a staged target after a deadline still ahead, the
 * deadline-cap preview "Sat Nov 7, 8:00 AM · stops at deadline": the
 * server's own cap (`capAtDeadline`), so the preview is the saved value.
 */
export function targetValueFor(s: {
  timezone: string
  queued: boolean
  dateDirty: boolean
  none: { dirty: boolean } | null
  header: string
  relative: string
  past: boolean
  delta: string | null
  /** The staged target (null: none staged) and the deadline it would stop at. */
  staged: string | null
  deadline: string | null
  /** A deadline-anchored repeat's target, re-derived from a staged deadline (`derivedTargetFor`). */
  derived?: string | null
  /**
   * A one-off's RELATIVE target (2026-10-24, `relativePreview`): its date in
   * the row's words, where it sits ("the day before, Evening"), and whether
   * it is staged (a pick, or a deadline that moves it) — blue.
   */
  relativeTarget?: {
    header: string
    relative: string
    words: string
    dirty: boolean
    past: boolean
  } | null
}): TargetValueProps {
  // A waiting repeating task has no live target (its occurrence is named on
  // the "This is the … one" line); the controls start from now.
  if (s.queued && !s.dateDirty) return { kind: 'none', dirty: false }
  if (s.none) return { kind: 'none', dirty: s.none.dirty }
  if (s.relativeTarget) {
    const r = s.relativeTarget
    return {
      kind: 'date',
      header: r.header,
      relative: r.relative,
      dirty: r.dirty,
      past: r.past,
      delta: null,
      capped: null,
      relativeWords: r.words,
    }
  }
  if (s.derived && !s.dateDirty) {
    const at = DateTime.fromISO(s.derived, { zone: 'utc' }).setZone(s.timezone)
    return {
      kind: 'date',
      header: at.toFormat('ccc, LLL d, h:mm a'),
      relative: 'moves with the deadline',
      dirty: true,
      past: false,
      delta: null,
      capped: null,
    }
  }
  const capped =
    s.staged && s.deadline && capsAt(s.staged, s.deadline)
      ? DateTime.fromISO(capAtDeadline(s.staged, s.deadline))
          .setZone(s.timezone)
          .toFormat('ccc LLL d, h:mm a')
      : null
  return {
    kind: 'date',
    header: s.header,
    relative: s.relative,
    dirty: s.dateDirty,
    past: s.past,
    delta: s.delta,
    capped,
  }
}

/**
 * THE LEAD TIME ROW's props (`ThisOneFields`), in one of two forms, for one
 * existing task (not bulk, not create, not a reminder or quota, not done —
 * `show`):
 *
 * - UPCOMING (2026-10-25, the Upcoming split): the task has a target the user
 *   picked — stored or staged, a relative target and a repeat's occurrence
 *   included — or a deck day, still ahead: when it shows in Upcoming's Later
 *   and Tomorrow sections (`upcomingLeadLine`). Whatever the task-queue
 *   switch says (decision 10).
 * - DEADLINE (the deadlines page, 2026-10-22): with the task queue on, no
 *   target (staged) and a deadline (staged) that has a lead (`leadLine` — not
 *   a repeat with a relative target): when it goes on the deadlines page.
 *
 * Null otherwise (a target today or overdue: not in Upcoming, nothing to say).
 * `upcomingAnchor`: the STAGED anchor (undefined: the stored one; null: none
 * — a target staged for removal, a queued occurrence); `restamp`: Save will
 * restamp `target_set_at` (a staged target, deck or deadline).
 */
export function leadRowFor(s: {
  show: boolean
  task: Task | null
  queueEnabled: boolean
  showsNoTarget: boolean
  upcomingAnchor: { target: string } | { deck: string } | null | undefined
  restamp: boolean
  pendingDeadline: string | null | undefined
  pendingLeadDays: number | null | undefined
  timezone: string
  rolloverTime: string | null
  dayStart: string
  onLeadDays: (days: number | null) => void
  disabled: boolean
}): LeadRowProps | null {
  if (!s.show || !s.task) return null
  const now = new Date()
  const shared = {
    // A repeat's lead is series-wide: every-time mode's (Trent, 10-22).
    editable: !s.task.rrule,
    onLeadDays: s.onLeadDays,
    disabled: s.disabled,
  }
  const upcoming = upcomingLeadLine(
    s.task,
    { anchor: s.upcomingAnchor, restamp: s.restamp, leadDays: s.pendingLeadDays },
    s.timezone,
    s.dayStart,
    now,
  )
  if (upcoming) {
    const today = openTaskDayOf(now, s.timezone, s.dayStart)
    return {
      ...shared,
      form: 'upcoming',
      words: upcomingLeadWords(upcoming, s.timezone, today),
      deferred: null,
      staged: upcoming.staged,
      leadDays: upcoming.leadDays,
      clamped: upcoming.clamped,
      override: upcoming.override,
      max: upcoming.max,
    }
  }
  if (!s.queueEnabled || !s.showsNoTarget) return null
  const line = leadLine(
    s.task,
    { deadline: s.pendingDeadline, leadDays: s.pendingLeadDays },
    s.timezone,
    s.rolloverTime,
    now,
  )
  if (!line) return null
  return {
    ...shared,
    form: 'deadline',
    words: leadLineWords(line, s.timezone, openTaskToday(s.timezone, now, s.rolloverTime)),
    deferred: line.deferredTo
      ? DateTime.fromISO(line.deferredTo, { zone: s.timezone }).toFormat('ccc')
      : null,
    staged: line.staged,
    leadDays: line.leadDays,
    clamped: line.clamped,
    override: line.override,
    max: line.max,
  }
}

/**
 * The Lead time row's STAGED Upcoming anchor (`leadRowFor`), from the panel's
 * staged state — what Save would leave the task anchored on:
 * - a staged deck day: the deck (it drops a staged target, rule 1);
 * - a target staged for removal: none;
 * - a staged fixed target: it, stopped at the deadline (`capAtDeadline`, the
 *   server's own cap, as the Target row previews);
 * - a waiting (queued) repeat with nothing else staged: none (no live target);
 * - a staged relative target, or one a staged deadline moves: its preview;
 * - a deadline-anchored repeat's target a staged deadline re-derives;
 * - nothing staged: undefined (the stored anchor).
 */
export function stagedUpcomingAnchor(s: {
  queued: boolean
  deck: string | null
  cleared: boolean
  fixed: string | null
  deadline: string | null
  relative: string | null
  derived: string | null
}): { target: string } | { deck: string } | null | undefined {
  if (s.deck) return { deck: s.deck }
  if (s.cleared) return null
  if (s.fixed) {
    const capped =
      s.deadline && capsAt(s.fixed, s.deadline) ? capAtDeadline(s.fixed, s.deadline) : s.fixed
    return { target: capped }
  }
  if (s.queued) return null
  if (s.relative) return { target: s.relative }
  if (s.derived) return { target: s.derived }
  return undefined
}

/**
 * THE TARGET A STAGED DEADLINE GIVES THIS OCCURRENCE (plan §3): on a
 * deadline-anchored repeat a deadline pick reschedules this occurrence and
 * re-derives an unmoved target — asked of the server's own planner
 * (`planRepeatSchedule`, browser-safe), so the preview is the saved value.
 * Null when nothing is staged, the target is the user's own (kept), or the
 * planner refuses (the Save's 400 says why).
 */
export function derivedTargetFor(
  task: Task | null,
  stagedDeadline: string | null | undefined,
  ctx: { timezone: string; morningTime: string; dayStart: string },
): string | null {
  if (!task?.rrule || task.repeat_anchor !== 'deadline' || !stagedDeadline) return null
  try {
    const plan = planRepeatSchedule(
      task,
      { deadline_at: stagedDeadline },
      { ...ctx, now: new Date(), isReminder: false, isTracked: false },
    )
    return plan.kind === 'deadline' && plan.dueAt && plan.dueAt !== task.due_at ? plan.dueAt : null
  } catch {
    return null
  }
}

/**
 * Scroll the nearest scrolling ancestor (a phone's sheet, a dialog) back to
 * its top, so entering every-time mode shows its banner — the
 * `editor-recurrence.spec` "sheet scrolls back to the top" fix, kept (§11).
 */
export function scrollParentToTop(el: HTMLElement | null): void {
  let node = el?.parentElement ?? null
  while (node) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      node.scrollTop = 0
      return
    }
    node = node.parentElement
  }
}
