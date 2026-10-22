/**
 * What the Quick panel's THIS-ONE rows show (2026-10-22, editor plan §3; PR
 * 4c) — the props `ThisOneFields` takes, worked out from the panel's staged
 * state. Kept out of `QuickActionPanel.tsx` so the panel doesn't keep
 * growing (RT-10); the rows' rules are documented on `ThisOneFields`.
 */

import { DateTime } from 'luxon'
import { capAtDeadline, capsAt } from '@/lib/task-segments'
import { formatBulkRecurrence } from '@/lib/format-rrule'
import { deadlineRepeatLabel, repeatWords, type AutoTargetLabel } from '@/lib/editor-target-labels'
import { bulkEveryTimeGate, draftEnd, draftRule } from '@/lib/every-time'
import type { StagedSchedule } from '@/hooks/useEveryTime'
import type {
  DeadlineRowProps,
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
    return {
      words: allRepeat && summary && summary !== '—' ? summary : null,
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
}: {
  /** Bulk, a reminder or a quota: no Deadline row. */
  hidden: boolean
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
}): DeadlineRowProps | null {
  if (hidden) return null
  if (stagedAnchor === 'deadline') return { kind: 'text', value: stagedFirstDeadline }
  if (rule && !deadlineAnchored) {
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
    repeatLabel: deadlineRepeatLabel({
      rrule: rule,
      repeat_anchor: task?.repeat_anchor ?? null,
      target_days_before: task?.target_days_before ?? null,
      target_time: task?.target_time ?? null,
    }),
  }
}

/**
 * The Target row's value (§3): the staged target, the automatic one, "No
 * target" — or, a staged target after a deadline still ahead, the
 * deadline-cap preview "Sat Nov 7, 8:00 AM · stops at deadline": the
 * server's own cap (`capAtDeadline`), so the preview is the saved value.
 */
export function targetValueFor(s: {
  timezone: string
  queued: boolean
  dateDirty: boolean
  auto: { label: AutoTargetLabel; dirty: boolean } | null
  none: { dirty: boolean } | null
  header: string
  relative: string
  past: boolean
  delta: string | null
  /** The staged target (null: none staged) and the deadline it would stop at. */
  staged: string | null
  deadline: string | null
}): TargetValueProps {
  // A waiting repeating task has no live target (its occurrence is named on
  // the "This is the … one" line); the controls start from now.
  if (s.queued && !s.dateDirty) return { kind: 'none', dirty: false }
  if (s.auto)
    return { kind: 'auto', label: s.auto.label, dirty: s.auto.dirty, timezone: s.timezone }
  if (s.none) return { kind: 'none', dirty: s.none.dirty }
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
