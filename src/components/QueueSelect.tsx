'use client'

import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { Check, CheckCheck, FileText, Forward, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { BarAction, SelectionBarShell } from '@/components/SelectionBarShell'
import { DeckVerb, MoreVerb, TargetVerb } from '@/components/SelectionBarVerbs'
import { NOT_TODAY } from '@/lib/task-model-words'
import { useBulkDeck } from '@/hooks/useBulkDeck'
import type { TaskSegmentActions } from '@/hooks/useTaskSegments'
import type { Task } from '@/types'

/**
 * THE TASK QUEUE'S SELECT MODE (Trent, 2026-10-30; mockups
 * `.tmp/select-bar/`, U1): "Select" in the queue card's header, left of the
 * count, turns it on — white while on — and again off. While it is on every
 * row trades its circle for a checkbox and hides its buttons, and a tap picks
 * the row. The bar (`QueueSelectionBar`) comes up once something is picked —
 * never for "nothing picked yet" — and its Cancel, like the header's Select,
 * leaves the mode.
 *
 * The card provides the state (`QueueSelectContext`) and `TaskSegmentRow`
 * reads it, so every list the card draws (Heads up's sections, Pulled's,
 * Aged out's groups) picks the same way with nothing threaded through.
 * /reminders provides none: its rows are as they were.
 */
export interface QueueSelectState {
  selected: ReadonlySet<number>
  toggle: (id: number) => void
}

export const QueueSelectContext = createContext<QueueSelectState | null>(null)

/** The select mode around a row, or null when it is off (or not the card). */
export function useQueueSelect(): QueueSelectState | null {
  return useContext(QueueSelectContext)
}

/**
 * Details with several picked: the dashboard's bulk editor (the list's
 * Details sheet). The card asks the dashboard for it with this event (detail:
 * the ids); `DashboardClient` selects them in its list and opens the sheet.
 */
export const QUEUE_BULK_DETAILS_EVENT = 'queue-bulk-details'

/**
 * The card's select mode: on/off, the picked ids, the context its rows read,
 * and the bar. Each verb acts on the picked rows and clears them; the mode
 * stays on (tap the header's Select, or Cancel, to leave).
 */
export function useQueueSelectMode({
  actions,
  timezone,
  onUndo,
}: {
  actions: TaskSegmentActions
  timezone: string
  /** The toast's Undo (the dashboard's undo). */
  onUndo: () => void
}) {
  const [on, setOn] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set())
  const toggle = useCallback(
    (id: number) =>
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      }),
    [],
  )
  const clear = useCallback(() => setSelected(new Set()), [])
  const leave = useCallback(() => {
    setOn(false)
    setSelected(new Set())
  }, [])
  const state = useMemo(() => (on ? { selected, toggle } : null), [on, selected, toggle])
  const deck = useBulkDeck({ onUndo, onFinished: () => void actions.refresh() })
  // The picked rows' tasks, from the card's segments (a row in two lists once).
  const tasks = new Map<number, Task>()
  for (const segment of actions.segments) {
    for (const row of segment.rows) if (selected.has(row.task.id)) tasks.set(row.task.id, row.task)
  }
  const picked = [...tasks.values()]
  const ids = picked.map((t) => t.id)
  const act = (fn: () => unknown) => {
    void fn()
    clear()
  }
  const bar =
    on && picked.length > 0 ? (
      <QueueSelectionBar
        selectedTasks={picked}
        timezone={timezone}
        onConsider={() => act(() => actions.considerMany(ids))}
        onDone={() => act(() => actions.doneMany(ids))}
        onTarget={(until) => act(() => actions.targetMany(ids, until))}
        onNotToday={() => act(() => actions.notTodayMany(ids))}
        onDeck={(day) => act(() => deck(ids, day))}
        onDetails={() => {
          if (picked.length === 1) actions.openDetails(picked[0])
          else window.dispatchEvent(new CustomEvent(QUEUE_BULK_DETAILS_EVENT, { detail: ids }))
          leave()
        }}
        onDelete={() => act(() => actions.removeMany(ids))}
        onRemoveTargets={(some) => act(() => actions.removeTargetsMany(some))}
        onSkipUntil={async (some, until) => {
          await actions.skipUntilMany(some, until)
          clear()
        }}
        onCancel={leave}
      />
    ) : null
  return {
    on,
    toggleMode: () => (on ? leave() : setOn(true)),
    state,
    bar,
  }
}

/** The header's "Select": a quiet word, a white pill while the mode is on. */
export function QueueSelectToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      data-queue-select-toggle
      className={cn(
        'shrink-0 rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
        on
          ? 'bg-foreground text-background'
          : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
      )}
    >
      Select
    </button>
  )
}

/**
 * The queue's U1 bar: Consider · Done · Target · Not today · Deck · Details ·
 * Delete · More — the list's bar (`SelectionActionSheet`) with the queue's
 * own two, Consider and Not today.
 */
export function QueueSelectionBar({
  selectedTasks,
  timezone,
  onConsider,
  onDone,
  onTarget,
  onNotToday,
  onDeck,
  onDetails,
  onDelete,
  onRemoveTargets,
  onSkipUntil,
  onCancel,
}: {
  selectedTasks: Task[]
  timezone: string
  onConsider: () => void
  onDone: () => void
  onTarget: (until: string) => void
  onNotToday: () => void
  onDeck: (day: string | null) => void
  onDetails: () => void
  onDelete: () => void
  onRemoveTargets: (ids: number[]) => void
  onSkipUntil?: (ids: number[], until: string | null) => Promise<void>
  onCancel: () => void
}) {
  const count = selectedTasks.length
  return (
    <SelectionBarShell count={count} onClear={onCancel} testAttr="data-queue-selection-bar">
      <BarAction icon={<CheckCheck />} label="Consider" onClick={onConsider} data-bar-consider />
      <BarAction tone="done" icon={<Check />} label="Done" onClick={onDone} />
      <TargetVerb count={count} onTarget={onTarget} />
      <BarAction icon={<Forward />} label={NOT_TODAY} onClick={onNotToday} data-bar-not-today />
      <DeckVerb timezone={timezone} onDeck={onDeck} />
      <BarAction icon={<FileText />} label="Details" onClick={onDetails} data-bar-details />
      <BarAction
        tone="danger"
        icon={<Trash2 />}
        label="Delete"
        onClick={onDelete}
        ariaLabel={`Delete ${count} ${count === 1 ? 'task' : 'tasks'}`}
      />
      <MoreVerb
        selectedTasks={selectedTasks}
        timezone={timezone}
        onRemoveTargets={onRemoveTargets}
        onSkipUntil={onSkipUntil}
      />
    </SelectionBarShell>
  )
}
