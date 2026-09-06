'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { trackState, periodLabel } from '@/lib/track'
import type { Task } from '@/types'

/**
 * The editor for a quota (REDESIGN-V03 §5) — "eat beef four times a week".
 *
 * It exists for the same reason ReminderDetail does. A quota is an ordinary
 * task row (a `progress_target` above 1 is the whole difference), so before
 * this it fell through to the task editor and was shown a due date, a snooze
 * grid and a Done button — none of which mean anything for a count against a
 * period. Trent, 2026-09-06, looking at exactly that screen: "this is what I
 * see, which is very confusing… They're just weekly things. I don't even know
 * if they have reminders."
 *
 * So: no date, no snooze, no Done. A quota is never late and never notifies
 * (`overdue-checker.ts` and `currently-due.ts` both exclude tracked items),
 * and nothing here should imply otherwise.
 *
 * The `due_at` the row still carries is deliberately not shown and not
 * touched: the iOS Track widget reads it to draw its pace tick
 * (`TrackWidget.elapsedFraction`). It can be cleared once the widget learns to
 * read `progress_period_start` instead.
 */

const PERIODS = [
  { value: 'DAILY', label: 'Every day' },
  { value: 'WEEKLY', label: 'Every week' },
  { value: 'MONTHLY', label: 'Every month' },
] as const

type PeriodValue = (typeof PERIODS)[number]['value']

function periodOf(rrule: string | null): PeriodValue {
  const freq = /(?:^|;)FREQ=([A-Z]+)/i.exec(rrule ?? '')?.[1]?.toUpperCase()
  return freq === 'DAILY' || freq === 'MONTHLY' ? freq : 'WEEKLY'
}

export interface QuotaDetailProps {
  task: Task
  onSaveAll: (changes: Record<string, unknown>) => void | Promise<void>
  onDelete?: () => void
  onDirtyChange?: (dirty: boolean) => void
  saveRef?: React.MutableRefObject<(() => void) | null>
}

/** "4 times · every week" — the whole sentence on one line. */
function CadenceField({
  target,
  onTargetChange,
  targetNumber,
  targetValid,
  period,
  onPeriodChange,
}: {
  target: string
  onTargetChange: (value: string) => void
  targetNumber: number
  targetValid: boolean
  period: PeriodValue
  onPeriodChange: (value: PeriodValue) => void
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">How often</legend>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Times per period"
          inputMode="numeric"
          value={target}
          onChange={(e) => onTargetChange(e.target.value.replace(/[^0-9]/g, ''))}
          className="w-20 text-center text-[16px] tabular-nums"
        />
        <span className="text-muted-foreground text-sm">
          {targetNumber === 1 ? 'time' : 'times'}
        </span>
        <div className="flex flex-wrap gap-1.5">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => onPeriodChange(p.value)}
              aria-pressed={period === p.value}
              data-period-chip={p.value}
              className={cn(
                'rounded-full border px-3 py-1 text-sm transition-colors',
                period === p.value
                  ? 'border-foreground bg-foreground text-background'
                  : 'hover:border-foreground/40',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {!targetValid && (
        <p className="text-destructive text-xs">A target is a whole number from 1 to 1000.</p>
      )}
    </fieldset>
  )
}

export function QuotaDetail({
  task,
  onSaveAll,
  onDelete,
  onDirtyChange,
  saveRef,
}: QuotaDetailProps) {
  const [title, setTitle] = useState(task.title)
  const [target, setTarget] = useState(String(Math.max(1, task.progress_target ?? 1)))
  const [period, setPeriod] = useState<PeriodValue>(periodOf(task.rrule))
  const [notes, setNotes] = useState(task.notes ?? '')

  // The last-saved values live in state, not a ref: `dirty` is derived from
  // them during render, and the React Compiler rules (rightly) forbid reading
  // a ref there. Same shape ReminderDetail uses for its `base`.
  const [saved, setSaved] = useState({
    title: task.title,
    target: String(Math.max(1, task.progress_target ?? 1)),
    period: periodOf(task.rrule),
    notes: task.notes ?? '',
  })

  const targetNumber = Number.parseInt(target, 10)
  const targetValid = Number.isFinite(targetNumber) && targetNumber >= 1 && targetNumber <= 1000
  const dirty =
    title !== saved.title ||
    target !== saved.target ||
    period !== saved.period ||
    notes !== saved.notes

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  const state = trackState(task)
  const periodWord = periodLabel(task.rrule)

  const handleSave = useCallback(() => {
    if (!dirty || !targetValid) return
    const changes: Record<string, unknown> = {}
    if (title !== saved.title) changes.title = title.trim()
    if (notes !== saved.notes) changes.notes = notes.trim() || null
    // Target and period travel together, always. Validation refuses a bare
    // `FREQ=` rrule unless the same request also says the task is tracked
    // (see validateTaskUpdate), so sending one without the others is rejected.
    if (target !== saved.target || period !== saved.period) {
      changes.progress_target = targetNumber
      changes.is_tracked = true
      changes.rrule = `FREQ=${period}`
    }
    void onSaveAll(changes)
    setSaved({ title, target, period, notes })
    onDirtyChange?.(false)
  }, [
    dirty,
    targetValid,
    targetNumber,
    onSaveAll,
    onDirtyChange,
    saved,
    title,
    target,
    period,
    notes,
  ])

  // Assigned in an effect, never during render — the page's header Save calls
  // through this ref, and ReminderDetail wires its own the same way.
  useEffect(() => {
    if (!saveRef) return
    saveRef.current = handleSave
    return () => {
      saveRef.current = null
    }
  }, [saveRef, handleSave])

  function handleReset() {
    setTitle(saved.title)
    setTarget(saved.target)
    setPeriod(saved.period)
    setNotes(saved.notes)
  }

  return (
    <div
      className={cn('rounded-lg border p-4', dirty && '[box-shadow:inset_4px_0_0_rgb(59_130_246)]')}
      data-quota-detail={task.id}
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <label htmlFor="quota-title" className="text-sm font-medium">
            Title
          </label>
          <Input
            id="quota-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="text-[16px]"
          />
        </div>

        <CadenceField
          target={target}
          onTargetChange={setTarget}
          targetNumber={targetNumber}
          targetValid={targetValid}
          period={period}
          onPeriodChange={setPeriod}
        />

        <div className="space-y-2">
          <label htmlFor="quota-notes" className="text-sm font-medium">
            Notes
          </label>
          <Textarea
            id="quota-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            placeholder="What does this one actually mean?"
            className="resize-none text-[16px]"
          />
        </div>

        {/* Read-only history. No due date and no snooze: a quota is never late. */}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t pt-4 text-sm">
          <div>
            <dt className="text-muted-foreground text-xs">Logged so far</dt>
            <dd className="tabular-nums">
              <span className="font-medium">{state.current}</span> of {state.target}
              {periodWord && <span className="text-muted-foreground"> {periodWord}</span>}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Periods met</dt>
            <dd className="tabular-nums">
              {task.completion_count > 0 ? `${task.completion_count}×` : 'Never yet'}
            </dd>
          </div>
        </dl>

        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
          <Button onClick={handleSave} disabled={!dirty || !targetValid}>
            Save
          </Button>
          <Button variant="outline" onClick={handleReset} disabled={!dirty}>
            Reset
          </Button>
          {/* No "stop tracking". A quota is its own kind of thing, not a task
              wearing a counter you can take off — Trent, 2026-09-06: "I think a
              quota can be something totally different… I'm just trying to keep
              things simple." Converting also could not be honest:
              `completion_count` means "times done" on a task and "periods met"
              on a quota, so carrying it across either direction would quietly
              change what the number claims. Retiring one is Trash, like
              anything else; making one is the Quotas page. */}
          {onDelete && (
            <Button variant="ghost" onClick={onDelete} className="text-destructive ml-auto">
              Move to Trash
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
