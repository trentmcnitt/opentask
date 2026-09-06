'use client'

import { useCallback, useEffect, useMemo, useState, type MutableRefObject } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { trackState } from '@/lib/track'
import type { Task } from '@/types'

/**
 * The editor for a quota (REDESIGN-V03 §5) — "eat beef four times a week".
 *
 * Deliberately shaped like `ReminderDetail`, which is the sibling this should
 * have been copied from in the first place: one component that handles one
 * quota, several at once, or a new one, rendered full-size by the page and
 * inside `QuotaDetailModal` everywhere else. Where the two differ, it is
 * because a quota differs — not because this was written separately.
 *
 * A quota is never late and never notifies (`overdue-checker.ts` and
 * `currently-due.ts` both exclude tracked items), so there is no date here, no
 * snooze and no Done. Editing several applies only what is touched: a target
 * left alone stays per-quota, and a period the selection disagrees about shows
 * nothing pressed until one is chosen.
 *
 * The `due_at` these rows still carry is deliberately untouched — the iOS Track
 * widget reads it for its pace tick (`TrackWidget.elapsedFraction`).
 */

export type QuotaPeriod = 'DAILY' | 'WEEKLY' | 'MONTHLY'

export const QUOTA_PERIODS: [QuotaPeriod, string][] = [
  ['DAILY', 'Every day'],
  ['WEEKLY', 'Every week'],
  ['MONTHLY', 'Every month'],
]

/** The FREQ a quota counts against; weekly for anything unreadable. */
export function quotaPeriodOf(rrule: string | null): QuotaPeriod {
  const freq = /(?:^|;)FREQ=([A-Z]+)/i.exec(rrule ?? '')?.[1]?.toUpperCase()
  return freq === 'DAILY' || freq === 'MONTHLY' ? freq : 'WEEKLY'
}

export interface QuotaCreateDraft {
  title: string
}

/** What a save carries. `ids` is empty when creating. */
export interface QuotaChanges {
  title?: string
  notes?: string | null
  progress_target?: number
  is_tracked?: true
  rrule?: string
}

export interface QuotaDetailProps {
  /** The quota(s) being edited. Empty with `create` set is the new-quota form. */
  tasks: Task[]
  create?: QuotaCreateDraft | null
  /** One or several: save in one request. Rejects on failure so edits are kept. */
  onSave?: (changes: QuotaChanges) => void | Promise<void>
  onCreate?: (changes: QuotaChanges) => void | Promise<void>
  onDelete?: () => void
  /** Modal host only: dismiss, dropping staged edits. */
  onCancel?: () => void
  /** Modal host only: continue on the full page. */
  onOpenPage?: () => void
  /** Modal host only: show the "Quota" eyebrow, since no page header says so. */
  showKind?: boolean
  onDirtyChange?: (dirty: boolean) => void
  saveRef?: MutableRefObject<(() => Promise<void> | void) | null>
}

export function QuotaDetail({
  tasks,
  create,
  onSave,
  onCreate,
  onDelete,
  onCancel,
  onOpenPage,
  showKind = false,
  onDirtyChange,
  saveRef,
}: QuotaDetailProps) {
  const creating = tasks.length === 0 && !!create
  const single = tasks.length === 1 ? tasks[0] : null

  /** What the selection agrees on; '' / null where it does not. */
  const base = useMemo(() => {
    if (creating)
      return {
        title: create?.title ?? '',
        target: '3',
        period: 'WEEKLY' as QuotaPeriod | null,
        notes: '',
      }
    const targets = new Set(tasks.map((t) => String(Math.max(1, t.progress_target ?? 1))))
    const periods = new Set(tasks.map((t) => quotaPeriodOf(t.rrule)))
    return {
      title: single?.title ?? '',
      target: targets.size === 1 ? [...targets][0] : '',
      period: periods.size === 1 ? [...periods][0] : null,
      notes: single?.notes ?? '',
    }
  }, [creating, create, tasks, single])

  const [title, setTitle] = useState(base.title)
  const [target, setTarget] = useState(base.target)
  const [period, setPeriod] = useState<QuotaPeriod | null>(base.period)
  const [notes, setNotes] = useState(base.notes)

  const { targetNumber, titleTouched, notesTouched, schedulePart, dirty, targetOk, canSave } =
    describeDraft({ creating, base, title, target, period, notes })

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  const buildChanges = useCallback((): QuotaChanges => {
    const changes: QuotaChanges = {}
    if (creating || titleTouched) changes.title = title.trim()
    if (creating || notesTouched) changes.notes = notes.trim() || null
    if (creating || schedulePart) {
      changes.progress_target = targetNumber
      changes.is_tracked = true
      changes.rrule = `FREQ=${period}`
    }
    return changes
  }, [creating, titleTouched, notesTouched, schedulePart, title, notes, targetNumber, period])

  const handleSave = useCallback(async () => {
    if (!canSave) return
    const changes = buildChanges()
    if (creating) await onCreate?.(changes)
    else await onSave?.(changes)
  }, [canSave, buildChanges, creating, onCreate, onSave])

  useEffect(() => {
    if (!saveRef) return
    saveRef.current = handleSave
    return () => {
      saveRef.current = null
    }
  }, [saveRef, handleSave])

  function handleReset() {
    setTitle(base.title)
    setTarget(base.target)
    setPeriod(base.period)
    setNotes(base.notes)
  }

  return (
    <div className="space-y-4" data-quota-detail={single?.id ?? (creating ? 'new' : 'many')}>
      {showKind && (
        <p className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
          {creating ? 'New quota' : single ? 'Quota' : `${tasks.length} quotas`}
        </p>
      )}

      {(creating || single) && (
        <div className="space-y-2">
          <label htmlFor="quota-title" className="text-sm font-medium">
            Title
          </label>
          <Input
            id="quota-title"
            autoFocus={creating}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What are you counting?"
            className="text-[16px]"
          />
        </div>
      )}

      {!creating && !single && (
        <p className="text-muted-foreground text-sm">
          Editing {tasks.length} quotas. Only what you change is applied.
        </p>
      )}

      <CadenceField
        target={target}
        onTargetChange={setTarget}
        period={period}
        onPeriodChange={setPeriod}
        showError={schedulePart && !targetOk}
      />

      {(creating || single) && (
        <div className="space-y-2">
          <label htmlFor="quota-notes" className="text-sm font-medium">
            Notes
          </label>
          <Textarea
            id="quota-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="What does this one actually mean?"
            className="resize-none text-[16px]"
          />
        </div>
      )}

      {single && <QuotaStats task={single} />}

      <QuotaActions
        creating={creating}
        canSave={canSave}
        dirty={dirty}
        onSave={() => void handleSave()}
        onReset={handleReset}
        onCancel={onCancel}
        onOpenPage={onOpenPage}
        onDelete={onDelete}
      />
    </div>
  )
}

/** "N times · every week", shared by every mode of the editor. */
function CadenceField({
  target,
  onTargetChange,
  period,
  onPeriodChange,
  showError,
}: {
  target: string
  onTargetChange: (value: string) => void
  period: QuotaPeriod | null
  onPeriodChange: (value: QuotaPeriod) => void
  showError: boolean
}) {
  const n = Number.parseInt(target, 10)
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">How often</legend>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Times per period"
          inputMode="numeric"
          value={target}
          onChange={(e) => onTargetChange(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder="—"
          className="w-20 text-center text-[16px] tabular-nums"
        />
        <span className="text-muted-foreground text-sm">{n === 1 ? 'time' : 'times'}</span>
        <div className="flex flex-wrap gap-1.5">
          {QUOTA_PERIODS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => onPeriodChange(value)}
              aria-pressed={period === value}
              data-period-chip={value}
              className={cn(
                'rounded-full border px-3 py-1 text-sm transition-colors',
                period === value
                  ? 'border-foreground bg-foreground text-background'
                  : 'hover:border-foreground/40',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {showError && (
        <p className="text-destructive text-xs">A target is a whole number from 1 to 1000.</p>
      )}
    </fieldset>
  )
}

/** The read-only history. "Never yet" is a real answer, and usually the useful one. */
function QuotaStats({ task }: { task: Task }) {
  const state = trackState(task)
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t pt-3 text-sm">
      <div>
        <dt className="text-muted-foreground text-xs">Logged so far</dt>
        <dd className="tabular-nums">
          <span className="font-medium">{state.current}</span> of {state.target}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground text-xs">Periods met</dt>
        <dd className="tabular-nums">
          {task.completion_count > 0 ? `${task.completion_count}×` : 'Never yet'}
        </dd>
      </div>
    </dl>
  )
}

function QuotaActions({
  creating,
  canSave,
  dirty,
  onSave,
  onReset,
  onCancel,
  onOpenPage,
  onDelete,
}: {
  creating: boolean
  canSave: boolean
  dirty: boolean
  onSave: () => void
  onReset: () => void
  onCancel?: () => void
  onOpenPage?: () => void
  onDelete?: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t pt-3">
      <Button onClick={onSave} disabled={!canSave}>
        {creating ? 'Create' : 'Save'}
      </Button>
      {!creating && (
        <Button variant="outline" onClick={onReset} disabled={!dirty}>
          Reset
        </Button>
      )}
      {onCancel && (
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      )}
      {onOpenPage && (
        <Button variant="ghost" onClick={onOpenPage} className="ml-auto">
          Open full page
        </Button>
      )}
      {onDelete && !creating && (
        <Button
          variant="ghost"
          onClick={onDelete}
          className={cn('text-destructive', !onOpenPage && 'ml-auto')}
        >
          Move to Trash
        </Button>
      )}
    </div>
  )
}

/**
 * What the draft is, and whether it can be saved — pulled out of the component
 * because it is nearly all of its branching.
 *
 * Creating needs every field. Editing needs only what is being changed to be
 * valid, and a schedule edit needs BOTH halves: validation refuses a bare
 * `FREQ=` rule that does not also say the task is tracked, so a target and a
 * period always travel together.
 */
function describeDraft({
  creating,
  base,
  title,
  target,
  period,
  notes,
}: {
  creating: boolean
  base: { title: string; target: string; period: QuotaPeriod | null; notes: string }
  title: string
  target: string
  period: QuotaPeriod | null
  notes: string
}) {
  const targetNumber = Number.parseInt(target, 10)
  const targetTouched = target !== base.target
  const periodTouched = period !== base.period
  const titleTouched = title !== base.title
  const notesTouched = notes !== base.notes
  const schedulePart = targetTouched || periodTouched
  const dirty = titleTouched || notesTouched || schedulePart
  const targetOk = target.length > 0 && targetNumber >= 1 && targetNumber <= 1000
  const scheduleOk = targetOk && period !== null
  const canSave = creating
    ? title.trim().length > 0 && scheduleOk
    : dirty && (!schedulePart || scheduleOk)
  return { targetNumber, titleTouched, notesTouched, schedulePart, dirty, targetOk, canSave }
}
