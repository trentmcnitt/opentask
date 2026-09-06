'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Gauge, Pencil, Plus, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useRouter } from 'next/navigation'
import { useTrackProgress } from '@/hooks/useTrackProgress'
import { useSelectionMode } from '@/hooks/useSelectionMode'
import { isTracked, trackState, periodLabel } from '@/lib/track'
import { showToast } from '@/lib/toast'
import { log } from '@/lib/logger'
import { cn } from '@/lib/utils'
import type { Task } from '@/types'

/**
 * Quotas as a place, not just an instrument (REDESIGN-V03 §5).
 *
 * Trent, 2026-09-06: "track needs to have its own item in the left-hand panel,
 * where we can easily work with these things… I can go to quotas and I can
 * easily remove items and the like."
 *
 * The Track panel on the dashboard stays what it was — the thing you tap during
 * the day. This is where you *manage* them: see every quota with its real
 * history, make one, retire one. The split is the same one Reminders has
 * between its slot cards and its own surface.
 *
 * "Quota" is the word, settled the same day: "I guess you call it quota. Yeah
 * I guess quota is a fine name."
 */
export type QuotaPeriod = 'DAILY' | 'WEEKLY' | 'MONTHLY'

const PERIOD_OPTIONS: [QuotaPeriod, string][] = [
  ['DAILY', 'Every day'],
  ['WEEKLY', 'Every week'],
  ['MONTHLY', 'Every month'],
]

/** The FREQ a quota counts against, defaulting to weekly for an unreadable rule. */
function periodOf(rrule: string | null): QuotaPeriod {
  const freq = /(?:^|;)FREQ=([A-Z]+)/i.exec(rrule ?? '')?.[1]?.toUpperCase()
  return freq === 'DAILY' || freq === 'MONTHLY' ? freq : 'WEEKLY'
}

export function QuotasView() {
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  // The dashboard's selection model, the same one Reminders uses: click
  // selects, shift-click takes a range, a floating bar acts on the set.
  const router = useRouter()
  const selection = useSelectionMode()
  const { selectedIds, toggle, rangeSelect, selectOnly, clear } = selection
  const orderedIds = useMemo(() => (tasks ?? []).map((t) => t.id), [tasks])
  const [editing, setEditing] = useState(false)

  /** What the selection agrees on; null where it does not. */
  const shared = useMemo(() => {
    const chosen = (tasks ?? []).filter((t) => selectedIds.has(t.id))
    if (chosen.length === 0) return { target: '', period: null as QuotaPeriod | null }
    const targets = new Set(chosen.map((t) => String(Math.max(1, t.progress_target ?? 1))))
    const periods = new Set(chosen.map((t) => periodOf(t.rrule)))
    return {
      target: targets.size === 1 ? [...targets][0] : '',
      period: periods.size === 1 ? [...periods][0] : null,
    }
  }, [tasks, selectedIds])

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/tasks?done=false&limit=1000')
      if (!res.ok) throw new Error(`GET /api/tasks ${res.status}`)
      const body = await res.json()
      setTasks((body.data.tasks as Task[]).filter(isTracked))
      setError(null)
    } catch (err) {
      log.error('ui', 'Loading quotas failed:', err)
      setError('Could not load quotas.')
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (error) return <p className="text-muted-foreground py-16 text-center text-sm">{error}</p>
  if (tasks === null)
    return <p className="text-muted-foreground py-16 text-center text-sm">Loading…</p>

  return (
    <section aria-label="Quotas" data-quotas-view className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          {tasks.length === 0
            ? 'No quotas yet.'
            : `${tasks.length} quota${tasks.length === 1 ? '' : 's'}`}
        </p>
        <Button size="sm" onClick={() => setCreating(true)} disabled={creating}>
          <Plus className="size-4" />
          New quota
        </Button>
      </div>

      {creating && (
        <NewQuotaForm
          onCancel={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false)
            await refresh()
          }}
        />
      )}

      {editing && selectedIds.size > 0 && (
        <BulkQuotaEditor
          ids={[...selectedIds]}
          shared={shared}
          onCancel={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false)
            clear()
            await refresh()
          }}
        />
      )}

      {tasks.length === 0 && !creating ? (
        <EmptyState />
      ) : (
        <ul className="space-y-2" role="listbox" aria-multiselectable="true" aria-label="Quotas">
          {tasks.map((task) => (
            <QuotaRow
              key={task.id}
              task={task}
              selected={selectedIds.has(task.id)}
              // The house rules, identical to Reminders' rowClick: shift takes
              // a range, cmd/ctrl toggles one, a plain click selects only that
              // one. It used to toggle on a plain click, which put the page in
              // multi-select from the first click and never let go (Trent,
              // 2026-09-06: "as I select, if I just go and use my mouse, it's
              // already in multi-select mode, which is weird").
              onSelect={(e) => {
                if (e.shiftKey) rangeSelect(task.id, orderedIds)
                else if (e.metaKey || e.ctrlKey) toggle(task.id)
                else selectOnly(task.id)
              }}
              onOpen={() => router.push(`/tasks/${task.id}`)}
            />
          ))}
        </ul>
      )}

      {selectedIds.size > 0 && (
        <QuotaSelectionBar
          count={selectedIds.size}
          onEdit={() => setEditing(true)}
          onClear={() => {
            setEditing(false)
            clear()
          }}
          onDelete={async () => {
            const ids = [...selectedIds]
            try {
              const res = await fetch('/api/tasks/bulk/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids }),
              })
              if (!res.ok) throw new Error(`bulk/delete ${res.status}`)
              showToast({
                message: `${ids.length} quota${ids.length === 1 ? '' : 's'} moved to Trash`,
                type: 'success',
              })
              clear()
              await refresh()
            } catch (err) {
              log.error('ui', 'Deleting quotas failed:', err)
              showToast({ message: 'Could not move those to Trash', type: 'error' })
            }
          }}
        />
      )}
    </section>
  )
}

/**
 * The floating bar, the same shape the Reminders and dashboard selections use.
 * Deleting is the only bulk action for now: it is the one Trent asked for
 * ("I can go to quotas and I can easily remove items"), and changing several
 * quotas' targets at once is a heavier idea that should wait for a real need.
 */
function QuotaSelectionBar({
  count,
  onEdit,
  onClear,
  onDelete,
}: {
  count: number
  onEdit: () => void
  onClear: () => void
  onDelete: () => void | Promise<void>
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-30 flex justify-center px-4 md:bottom-6">
      <div
        data-quota-selection-bar
        className="bg-primary text-primary-foreground pointer-events-auto flex items-center gap-2 rounded-xl px-4 py-3 shadow-xl"
      >
        <span className="text-sm font-medium tabular-nums">{count} selected</span>
        <Button
          size="sm"
          variant="ghost"
          onClick={onEdit}
          className="text-primary-foreground hover:bg-primary-foreground/15 hover:text-primary-foreground"
        >
          <Pencil className="size-4" />
          Edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void onDelete()}
          className="text-primary-foreground hover:bg-destructive active:bg-destructive hover:text-white"
        >
          <Trash2 className="size-4" />
          Trash
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onClear}
          aria-label="Clear selection"
          className="text-primary-foreground/60 hover:text-primary-foreground hover:bg-primary-foreground/10"
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <div className="bg-muted text-muted-foreground flex size-11 items-center justify-center rounded-full">
        <Gauge className="size-5" />
      </div>
      <p className="text-muted-foreground max-w-xs text-sm leading-relaxed">
        A quota is a task you do a set number of times in a period — &ldquo;eat beef four times a
        week&rdquo;. It counts instead of completing, and it is never late.
      </p>
    </div>
  )
}

/**
 * One quota, with the numbers that say whether it is working. `Periods met` is
 * the honest one: a routine that has never once been met is the thing worth
 * seeing on this page.
 */
function QuotaRow({
  task,
  selected,
  onSelect,
  onOpen,
}: {
  task: Task
  selected: boolean
  onSelect: (e: React.MouseEvent) => void
  onOpen: () => void
}) {
  const { state, log: logProgress } = useTrackProgress(task)
  const period = periodLabel(task.rrule)
  const displayed = trackState(task, state.current)

  return (
    <li
      data-quota-row={task.id}
      role="option"
      aria-selected={selected}
      aria-label={task.title}
      // The house selection model, shared with the dashboard and Reminders: a
      // click selects and NEVER navigates, and a double-click opens. The title
      // is deliberately not a link — as one it spanned the row and swallowed
      // every click into a navigation.
      onClick={(e) => {
        if (e.detail > 1) return
        onSelect(e)
      }}
      onDoubleClick={onOpen}
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3 py-2.5 transition-colors',
        selected ? 'border-primary bg-primary/5' : 'hover:bg-muted/40',
      )}
    >
      <div className="min-w-0 flex-1 basis-full sm:basis-0">
        <p className="truncate text-[15px]">{task.title}</p>
        <p className="text-muted-foreground text-xs">
          {state.target}× {period ?? 'per period'} ·{' '}
          {task.completion_count > 0 ? `met ${task.completion_count}×` : 'never met'}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <span
          data-quota-count
          className={cn(
            'text-sm tabular-nums',
            displayed.met ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground',
          )}
        >
          <span className="text-foreground font-medium">{displayed.current}</span> / {state.target}
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={(e) => {
            e.stopPropagation()
            void logProgress(1)
          }}
          aria-label={`Log one more for "${task.title}"`}
        >
          +1
        </Button>
        {/* The explicit, keyboard-reachable door. Double-click does the same,
            but a double-click is not a thing you can do from a keyboard. */}
        <Button
          size="sm"
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation()
            onOpen()
          }}
          aria-label={`Open "${task.title}"`}
        >
          Open
        </Button>
      </div>
    </li>
  )
}

/**
 * The "N times · every week" control, shared by the create form and the bulk
 * editor so the two can never drift apart.
 *
 * `period` may be null in the bulk editor, meaning "the selection disagrees and
 * nothing has been chosen yet" — picking one then applies it to all of them.
 */
function CadenceControls({
  target,
  onTargetChange,
  period,
  onPeriodChange,
}: {
  target: string
  onTargetChange: (value: string) => void
  period: QuotaPeriod | null
  onPeriodChange: (value: QuotaPeriod) => void
}) {
  const n = Number.parseInt(target, 10)
  return (
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
      {PERIOD_OPTIONS.map(([value, label]) => (
        <button
          key={value}
          type="button"
          onClick={() => onPeriodChange(value)}
          aria-pressed={period === value}
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
  )
}

/**
 * Change several quotas at once — the reason the page has selection at all
 * beyond retiring things (Trent, 2026-09-06: "the ability to multi-select
 * allows us to change multiple at once. We can change them all to have the
 * same quota").
 *
 * Only what you touch is applied: leave the target blank and the periods
 * alone, and each quota keeps its own. That is the same rule the Reminders
 * bulk editor follows, so the two behave alike.
 */
function BulkQuotaEditor({
  ids,
  shared,
  onCancel,
  onSaved,
}: {
  ids: number[]
  /** Target and period where the whole selection already agrees, else null. */
  shared: { target: string; period: QuotaPeriod | null }
  onCancel: () => void
  onSaved: () => void | Promise<void>
}) {
  const [target, setTarget] = useState(shared.target)
  const [period, setPeriod] = useState<QuotaPeriod | null>(shared.period)
  const [saving, setSaving] = useState(false)

  const targetNumber = Number.parseInt(target, 10)
  const targetTouched = target !== shared.target && target.length > 0
  const periodTouched = period !== shared.period && period !== null
  const targetValid = !targetTouched || (targetNumber >= 1 && targetNumber <= 1000)
  const dirty = targetTouched || periodTouched

  async function save() {
    if (!dirty || !targetValid) return
    setSaving(true)
    try {
      // Target, flag and rule travel together: validation refuses a bare FREQ
      // rule that does not also say the task is tracked. When only one of the
      // two was touched, the other is re-sent at its current shared value.
      const changes: Record<string, unknown> = { is_tracked: true }
      changes.progress_target = targetTouched ? targetNumber : Number.parseInt(shared.target, 10)
      changes.rrule = `FREQ=${periodTouched ? period : shared.period}`
      // POST, not PATCH — every bulk endpoint in this app is a POST.
      const res = await fetch('/api/tasks/bulk/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, changes }),
      })
      if (!res.ok) throw new Error(`bulk/edit ${res.status}`)
      showToast({
        message: `${ids.length} quota${ids.length === 1 ? '' : 's'} updated`,
        type: 'success',
      })
      await onSaved()
    } catch (err) {
      log.error('ui', 'Bulk-editing quotas failed:', err)
      showToast({ message: 'Could not update those quotas', type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  // Only sendable when both halves are known — a selection that disagrees about
  // its period cannot be given a target without also being given a period.
  const complete =
    (periodTouched ? period : shared.period) !== null &&
    (targetTouched ? target : shared.target).length > 0

  return (
    <div className="space-y-3 rounded-xl border p-3" data-bulk-quota-editor>
      <p className="text-muted-foreground text-sm">
        Editing {ids.length} quota{ids.length === 1 ? '' : 's'}. Only what you change is applied.
      </p>
      <CadenceControls
        target={target}
        onTargetChange={setTarget}
        period={period}
        onPeriodChange={setPeriod}
      />
      {!targetValid && (
        <p className="text-destructive text-xs">A target is a whole number from 1 to 1000.</p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={save} disabled={!dirty || !targetValid || !complete || saving}>
          {saving ? 'Saving…' : 'Apply'}
        </Button>
      </div>
    </div>
  )
}

/** Make a quota. The one thing that had no UI at all until 2026-09-06. */
function NewQuotaForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('')
  const [target, setTarget] = useState('3')
  const [period, setPeriod] = useState<QuotaPeriod>('WEEKLY')
  const [saving, setSaving] = useState(false)

  const targetNumber = Number.parseInt(target, 10)
  const valid = title.trim().length > 0 && targetNumber >= 1 && targetNumber <= 1000

  async function create() {
    if (!valid) return
    setSaving(true)
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          // The three travel together: validation refuses a bare `FREQ=` rule
          // unless the same request says the task is tracked.
          progress_target: targetNumber,
          is_tracked: true,
          rrule: `FREQ=${period}`,
        }),
      })
      if (!res.ok) throw new Error(`POST /api/tasks ${res.status}`)
      showToast({ message: `“${title.trim()}” is now a quota`, type: 'success' })
      onCreated()
    } catch (err) {
      log.error('ui', 'Creating a quota failed:', err)
      showToast({ message: 'Could not create the quota', type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3 rounded-xl border p-3" data-new-quota>
      <Input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && valid) void create()
          if (e.key === 'Escape') onCancel()
        }}
        placeholder="What are you counting?"
        aria-label="Quota title"
        className="text-[16px]"
      />
      <CadenceControls
        target={target}
        onTargetChange={setTarget}
        period={period}
        onPeriodChange={setPeriod}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={create} disabled={!valid || saving}>
          {saving ? 'Creating…' : 'Create'}
        </Button>
      </div>
    </div>
  )
}
