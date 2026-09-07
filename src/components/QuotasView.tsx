'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSyncStream } from '@/hooks/useSyncStream'
import { useNavigationGuard } from '@/components/NavigationGuardProvider'
import { useRouter } from 'next/navigation'
import { Gauge, Minus, Plus, Trash2, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { QuotaDetailModal } from '@/components/QuotaDetailModal'
import type { QuotaChanges, QuotaCreateDraft } from '@/components/QuotaDetail'
import { useTrackProgress } from '@/hooks/useTrackProgress'
import { useSelectionMode } from '@/hooks/useSelectionMode'
import { trackSummary, groupByPeriod, periodShort } from '@/lib/track'
import { trackedItems } from '@/lib/slot-view'
import { showToast } from '@/lib/toast'
import { log } from '@/lib/logger'
import { SelectionBarShell } from '@/components/SelectionBarShell'
import { cn, fromRowControl } from '@/lib/utils'
import type { Task } from '@/types'

/**
 * Quotas as a place, not just the instrument on the dashboard (§5).
 *
 * Trent, 2026-09-06: "track needs to have its own item in the left-hand panel,
 * where we can easily work with these things."
 *
 * Everything here follows the Reminders surface, which is the sibling this was
 * built beside: a click selects and never navigates, a double-click opens the
 * editor as a MODAL, the floating bar acts on the selection, and the full page
 * exists for deep links rather than as the way in. The first cut of this page
 * invented all of that separately and got every one of them different; the
 * rule is copy the pattern, then justify each deviation.
 *
 * The grouping is the dashboard's own: quotas sit under their period, with the
 * same header word and the same progress bar, using `groupByPeriod` from
 * TrackPanel rather than a second copy of it. That is also why the period is
 * no longer repeated on every row — the card it sits in already says it.
 */
export function QuotasView({
  onUndo,
  onCompleted,
  refreshRef,
}: {
  /** Undo the last action — wired to the toasts, as on every other surface. */
  onUndo: () => void
  /** Tell the host an undoable thing happened, so its Undo count is right. */
  onCompleted: () => void
  /** Populated with this view's refresh, so the page's undo/redo can call it. */
  refreshRef?: React.MutableRefObject<(() => void) | null>
}) {
  const router = useRouter()
  const { requestNavigation } = useNavigationGuard()
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const selection = useSelectionMode()
  const { selectedIds, toggle, rangeSelect, selectOnly, clear } = selection

  /** A snapshot handed to the modal, so a refresh cannot move it underneath. */
  const [editing, setEditing] = useState<Task[] | null>(null)
  const [creating, setCreating] = useState<QuotaCreateDraft | null>(null)

  const refresh = useCallback(async () => {
    try {
      // This surface's OWN endpoint, the way Reminders has one. It used to ask
      // for `/api/tasks?done=false&limit=1000` and filter in the browser: 512
      // tasks over the wire to render eight, on every sync event — and a +1
      // emits a sync event, so the phone paid it for every tap.
      const res = await fetch('/api/quotas')
      if (!res.ok) throw new Error(`GET /api/quotas ${res.status}`)
      const body = await res.json()
      // Still trackedItems, not the server's order: the dashboard sorts quotas
      // by title so the order cannot jump as counts change (commit 9bcf03d,
      // "frozen order"), and the two views of the same eight things must agree.
      setTasks(trackedItems(body.data.quotas as Task[]))
      setError(null)
    } catch (err) {
      log.error('ui', 'Loading quotas failed:', err)
      // A failed BACKGROUND refresh over data we already have is not an error
      // state — the same rule useReminders keeps. This runs on every sync
      // event, so a transient 500 used to replace the list AND an open editor,
      // losing staged edits, with nothing to retry. Only a failure with
      // nothing on screen is worth showing.
      setTasks((current) => {
        if (current === null) setError('Could not load quotas.')
        return current
      })
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!refreshRef) return
    refreshRef.current = () => void refresh()
    return () => {
      refreshRef.current = null
    }
  }, [refreshRef, refresh])

  // A quota is logged from the widget, the watch, a notification action and
  // other tabs. Every one of those emits a sync event, and this surface has to
  // hear them the way Reminders and the dashboard do.
  useSyncStream({ onSync: () => void refresh() })

  // The sidebar's button and the phone's plus reach this surface through an
  // event, the way Reminders does, so "add" on /quotas makes a quota.
  useEffect(() => {
    // Idempotent: a second event while the form is already open is a no-op
    // rather than a fresh draft. A double-tap on the phone's plus dispatches
    // twice, and re-setting the draft threw away anything already typed and
    // re-ran the modal's open effects.
    const open = () => setCreating((current) => current ?? { title: '' })
    window.addEventListener('open-add-quota', open)
    return () => window.removeEventListener('open-add-quota', open)
  }, [])

  // Escape clears the selection, as on the dashboard and Reminders.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && selectedIds.size > 0) clear()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedIds, clear])

  const { saveQuotas, createQuota, deleteQuotas } = useQuotaMutations({
    refresh,
    clear,
    onUndo,
    onCompleted,
  })

  const groups = useMemo(() => groupByPeriod(tasks ?? []), [tasks])
  const orderedIds = useMemo(() => groups.flatMap((g) => g.tasks.map((t) => t.id)), [groups])

  if (tasks === null)
    return (
      <p className="text-muted-foreground py-16 text-center text-sm">{error ?? 'Loading\u2026'}</p>
    )

  const selected = tasks.filter((t) => selectedIds.has(t.id))

  return (
    <section aria-label="Quotas" data-quotas-view className="space-y-3 pb-24">
      <div className="flex items-center justify-between gap-2 px-1">
        {/* The page's h1, exactly as the Reminders headline is: this one line
            is the surface's summary, so it is the heading rather than a
            paragraph sitting where a heading should be. Same size and colour
            as before — the change is semantic, not visual. */}
        <h1 className="text-muted-foreground text-sm">
          {tasks.length === 0
            ? 'No quotas yet.'
            : `${tasks.length} quota${tasks.length === 1 ? '' : 's'}`}
        </h1>
        <Button size="sm" onClick={() => setCreating({ title: '' })}>
          <Plus className="size-4" />
          New quota
        </Button>
      </div>

      {tasks.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="space-y-2.5">
          {groups.map((group) => (
            <QuotaPeriodCard
              key={group.period ?? 'none'}
              period={group.period}
              tasks={group.tasks}
              selectedIds={selectedIds}
              onSelect={(task, e) => {
                if (e.shiftKey) rangeSelect(task.id, orderedIds)
                else if (e.metaKey || e.ctrlKey) toggle(task.id)
                else selectOnly(task.id)
              }}
              onOpen={(task) => setEditing([task])}
            />
          ))}
        </div>
      )}

      {selected.length > 0 && (
        <QuotaSelectionBar
          count={selected.length}
          onEdit={() => setEditing(selected)}
          onClear={clear}
          onDelete={() => void deleteQuotas(selected)}
        />
      )}

      <QuotaDetailModal
        tasks={editing ?? []}
        create={creating}
        open={editing !== null || creating !== null}
        onClose={() => {
          setEditing(null)
          setCreating(null)
        }}
        onSave={saveQuotas}
        onCreate={createQuota}
        onDelete={(targets) => void deleteQuotas(targets)}
        onOpenPage={(id) => {
          // Through the navigation guard, like every other route change, so an
          // unsaved editor still gets to ask before the page changes.
          if (requestNavigation(`/tasks/${id}`)) router.push(`/tasks/${id}`)
        }}
      />
    </section>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <div className="bg-muted text-muted-foreground flex size-11 items-center justify-center rounded-full">
        <Gauge className="size-5" />
      </div>
      <p className="text-muted-foreground max-w-xs text-sm leading-relaxed">
        A quota is something you do a set number of times in a period — &ldquo;eat beef four times a
        week&rdquo;. It counts instead of completing, and it is never late.
      </p>
    </div>
  )
}

/**
 * One period's quotas, in the dashboard's own card: the word top-left, the
 * count top-right, a hairline that fills as the period's targets are met.
 * Identical to `PeriodCard` in TrackPanel by design — the two surfaces show the
 * same thing and should look like it.
 */
function QuotaPeriodCard({
  period,
  tasks,
  selectedIds,
  onSelect,
  onOpen,
}: {
  period: string | null
  tasks: Task[]
  selectedIds: Set<number>
  onSelect: (task: Task, e: React.MouseEvent) => void
  onOpen: (task: Task) => void
}) {
  const word = period ? periodShort(period) : 'no period'
  const s = trackSummary(tasks)
  const met = s.total > 0 && s.done >= s.total

  return (
    <div className="bg-muted/30 rounded-2xl px-2 pt-2 pb-2.5" data-quota-period={word}>
      <div className="flex items-center gap-2 px-1 pb-1.5">
        <span className="text-muted-foreground text-[11px] font-semibold tracking-widest uppercase">
          {word}
        </span>
        <span
          className={cn(
            'ml-auto text-xs whitespace-nowrap tabular-nums',
            met ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground',
          )}
        >
          <span className="text-foreground font-medium">{s.done}</span> of {s.total}
        </span>
      </div>
      <div
        className="bg-muted mx-1 mb-2.5 h-1 overflow-hidden rounded-full"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={s.total}
        aria-valuenow={s.done}
        aria-label={`${s.done} of ${s.total} ${period ?? ''}`.trim()}
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width,background-color] duration-500 ease-out',
            met ? 'bg-green-600' : 'bg-foreground/50',
          )}
          style={{ width: `${s.total > 0 ? (s.done / s.total) * 100 : 0}%` }}
        />
      </div>
      <ul role="listbox" aria-multiselectable="true" aria-label={word} className="space-y-1">
        {tasks.map((task) => (
          <QuotaRow
            key={task.id}
            task={task}
            selected={selectedIds.has(task.id)}
            onSelect={(e) => onSelect(task, e)}
            onOpen={() => onOpen(task)}
          />
        ))}
      </ul>
    </div>
  )
}

/**
 * One quota. `Periods met` is the honest number here: a routine that has never
 * once been met is exactly what this page exists to show.
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
  // `state` already reflects the optimistic count — re-wrapping it in
  // trackState was a no-op.
  const { state, log: logProgress } = useTrackProgress(task)

  return (
    <li
      data-quota-row={task.id}
      role="option"
      aria-selected={selected}
      // No aria-label: the row's own content is its accessible name, so a
      // screen reader still hears the count and "never met". ReminderRow does
      // the same.
      //
      // The house model: a click selects and never navigates, a double-click
      // opens the editor. Both clicks go through deliberately — the second
      // selectOnly on an already-sole selection clears it, so the modal opens
      // over an empty selection rather than leaving a row lit underneath. The
      // modal is handed the task directly, not the selection, so it still gets
      // the right one.
      onClick={onSelect}
      // Not when the double-click was on the +1/-1 buttons: those stop the
      // row's click, but dblclick is its own event and bubbles regardless.
      onDoubleClick={(e) => {
        if (fromRowControl(e)) return
        onOpen()
      }}
      className={cn(
        // Wraps like TrackRow: on a phone the title takes the whole first line
        // and the bar/count/buttons sit beneath it. Five fixed-width things on
        // one 375px line truncated every title to "Broc…".
        'flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl px-2 py-2 transition-colors',
        selected ? 'bg-primary/10 ring-primary/40 ring-1' : 'hover:bg-background/60',
      )}
    >
      <div className="min-w-0 basis-full sm:flex-1 sm:basis-0">
        <p className="truncate text-[15px]">{task.title}</p>
        <p className="text-muted-foreground text-xs">
          {task.completion_count > 0 ? `met ${task.completion_count}×` : 'never met'}
        </p>
      </div>

      {/* One cluster, flush right: the same columns on every line. */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <div className="bg-muted relative h-1.5 w-20 shrink-0 overflow-hidden rounded-full sm:w-28">
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-300 ease-out',
              state.met ? 'bg-green-600' : 'bg-foreground/60',
            )}
            style={{ width: `${state.fraction * 100}%` }}
          />
        </div>

        <span
          data-quota-count
          className={cn(
            'w-12 shrink-0 text-right text-sm tabular-nums',
            state.met ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground',
          )}
        >
          <span className="text-foreground font-medium">{state.current}</span> / {state.target}
        </span>

        {/* Both directions. This was the only surface where a mis-log could not
          be taken back except through the toast — and "minus buttons" is the
          title of the commit that fixed exactly that on the widgets. */}
        <Button
          size="icon"
          variant="outline"
          disabled={state.current === 0}
          onClick={(e) => {
            e.stopPropagation()
            void logProgress(-1)
          }}
          aria-label={`Remove one from "${task.title}"`}
          className="size-8 shrink-0"
        >
          <Minus className="size-4" />
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={(e) => {
            e.stopPropagation()
            void logProgress(1)
          }}
          aria-label={`Log one more for "${task.title}"`}
          className="shrink-0"
        >
          +1
        </Button>
      </div>
    </li>
  )
}

/**
 * The Quotas surface's verbs inside the shared selection bar. Position, count,
 * Clear and the double-click guard all live in `SelectionBarShell`, so this bar
 * cannot drift from the Reminders and dashboard ones again.
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
  onDelete: () => void
}) {
  return (
    <SelectionBarShell
      count={count}
      onClear={onClear}
      onDoubleClickIntent={onEdit}
      testAttr="data-quota-selection-bar"
    >
      <Button size="sm" variant="secondary" onClick={onEdit}>
        <Pencil className="size-4" />
        Details
      </Button>
      <Button
        size="sm"
        variant="secondary"
        onClick={onDelete}
        aria-label={count === 1 ? 'Move to Trash' : `Move ${count} quotas to Trash`}
        className="bg-primary-foreground/10 text-primary-foreground hover:bg-destructive active:bg-destructive hover:text-white"
      >
        <Trash2 className="size-4" />
      </Button>
    </SelectionBarShell>
  )
}

/**
 * The three writes this surface makes. A hook rather than three callbacks in
 * the component, so `QuotasView` stays layout — the same reason `useReminders`
 * exists next to `RemindersView`.
 */
function useQuotaMutations({
  refresh,
  clear,
  onUndo,
  onCompleted,
}: {
  refresh: () => Promise<void>
  clear: () => void
  onUndo: () => void
  onCompleted: () => void
}) {
  /** Every one of these goes through an undoable core mutation, so every one
   *  offers the Undo — the same contract `useReminders` keeps. */
  const undoAction = useCallback(() => ({ label: 'Undo', onClick: () => onUndo() }), [onUndo])
  const saveQuotas = useCallback(
    async (ids: number[], changes: QuotaChanges) => {
      // One quota is a PATCH; several is the bulk endpoint — one request, one
      // undo entry — exactly as the Reminders editor does it.
      const res =
        ids.length === 1
          ? await fetch(`/api/tasks/${ids[0]}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(changes),
            })
          : await fetch('/api/tasks/bulk/edit', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ids, changes }),
            })
      if (!res.ok) {
        showToast({ message: 'Could not save those quotas', type: 'error' })
        throw new Error(`save quotas ${res.status}`)
      }
      showToast({
        message: ids.length === 1 ? 'Quota updated' : `Updated ${ids.length} quotas`,
        type: 'success',
        action: undoAction(),
      })
      onCompleted()
      clear()
      await refresh()
    },
    [clear, refresh, undoAction, onCompleted],
  )

  const createQuota = useCallback(
    async (changes: QuotaChanges) => {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes),
      })
      if (!res.ok) {
        showToast({ message: 'Could not create the quota', type: 'error' })
        throw new Error(`create quota ${res.status}`)
      }
      showToast({ message: 'Quota created', type: 'success', action: undoAction() })
      onCompleted()
      await refresh()
    },
    [refresh, undoAction, onCompleted],
  )

  const deleteQuotas = useCallback(
    async (targets: Task[]) => {
      const ids = targets.map((t) => t.id)
      try {
        const res = await fetch('/api/tasks/bulk/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        })
        if (!res.ok) throw new Error(`bulk/delete ${res.status}`)
        showToast({
          message:
            targets.length === 1
              ? `Moved \u201c${targets[0].title}\u201d to Trash`
              : `Moved ${targets.length} quotas to Trash`,
          type: 'success',
          action: undoAction(),
        })
        onCompleted()
        clear()
        await refresh()
      } catch (err) {
        log.error('ui', 'Deleting quotas failed:', err)
        showToast({ message: 'Could not move those to Trash', type: 'error' })
      }
    },
    [clear, refresh, undoAction, onCompleted],
  )

  return { saveQuotas, createQuota, deleteQuotas }
}
