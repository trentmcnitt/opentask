'use client'

import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { Check, CheckCheck, FileText, Forward, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { BarAction, SelectionBarShell } from '@/components/SelectionBarShell'
import { DeckVerb, MoreVerb, TargetVerb } from '@/components/SelectionBarVerbs'
import { BarHorizonControl, SelectionDetailLines } from '@/components/SelectionDetail'
import { requestShowInList } from '@/lib/show-in-list'
import type { HorizonValue } from '@/lib/task-segments'
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
 * A HOLD ENTERS SELECT MODE (L1, Trent 2026-10-30): a long-press on a card
 * row turns the mode on with that row picked — the long-press bubble is
 * retired there; the bar's details (`SelectionDetailLines`) took its place.
 * The main list's long-press already selected, so a hold means one thing
 * everywhere. Provided by the card whether the mode is on or off; null off
 * the card (/reminders' rows keep their bubble: there is no select mode
 * there to enter).
 */
export const QueueSelectEnterContext = createContext<((id: number) => void) | null>(null)

export function useQueueSelectEnter(): ((id: number) => void) | null {
  return useContext(QueueSelectEnterContext)
}

/**
 * CMD- AND SHIFT-CLICK PICK (Trent, 2026-11-02: "anytime you're on the task
 * queue, Shift-clicking or Command-clicking … should enable select mode and
 * select that, just like it does on tasks"), the main list's rule
 * (`useRowPress`):
 *
 * - Cmd-click (Ctrl-click off a Mac): with the mode off, it comes on with the
 *   row picked; on, the row toggles.
 * - Shift-click: the rows from the last-clicked one (the anchor) to this one,
 *   in the page on screen (`range`, the waiting rows the card draws, in
 *   order); with no anchor there, the row alone, as a Cmd-click.
 *
 * A selection a modifier started is the hold's (`held`): one action, then
 * out — the list's rule for anything but Select All. Provided by the card;
 * null off it.
 */
export type QueueModifierPick = (id: number, range: readonly number[] | null) => void

export const QueueSelectModifierContext = createContext<QueueModifierPick | null>(null)

export function useQueueModifierPick(): QueueModifierPick | null {
  return useContext(QueueSelectModifierContext)
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
  /**
   * HOW THE MODE STARTED (Trent, 2026-10-30: "it was annoying… for individual
   * items because then I have to go back and deselect select mode… It only
   * stays in select mode if you enter select mode with the select button"):
   * `held` — a hold on a row (`enter`) — is one action, then out: any verb
   * that lands, or deselecting the last row, leaves the mode. The header's
   * Select keeps it on through the verbs, as before, until Cancel or Select.
   */
  const [held, setHeld] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set())
  // The last row picked or unpicked: a Shift-click's range starts here.
  const [anchor, setAnchor] = useState<number | null>(null)
  const toggleRow = useCallback(
    (id: number) =>
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        // A hold's selection ends with its last row.
        if (next.size === 0 && held) {
          setOn(false)
          setHeld(false)
        }
        return next
      }),
    [held],
  )
  const toggle = useCallback(
    (id: number) => {
      setAnchor(id)
      toggleRow(id)
    },
    [toggleRow],
  )
  const clear = useCallback(() => setSelected(new Set()), [])
  const enter = useCallback(
    (id: number) => {
      // A hold inside a mode the Select button started picks the row, nothing more.
      if (!on) setHeld(true)
      setOn(true)
      setAnchor(id)
      setSelected((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
    },
    [on],
  )
  const modifierPick = useCallback<QueueModifierPick>(
    (id, range) => {
      const from = range && anchor !== null ? range.indexOf(anchor) : -1
      const to = range ? range.indexOf(id) : -1
      if (from === -1 || to === -1) {
        // Cmd-click, or a Shift-click with no anchor on this page.
        if (on) toggle(id)
        else enter(id)
        return
      }
      // The range, added to what is picked; the anchor stays (the list's rule).
      const span = range!.slice(Math.min(from, to), Math.max(from, to) + 1)
      if (!on) setHeld(true)
      setOn(true)
      setSelected((prev) => new Set([...prev, ...span]))
    },
    [anchor, on, toggle, enter],
  )
  const leave = useCallback(() => {
    setOn(false)
    setHeld(false)
    setSelected(new Set())
    setAnchor(null)
  }, [])
  /** After a verb lands: out for a hold, the picks cleared for the Select button. */
  const finished = held ? leave : clear
  const state = useMemo(() => (on ? { selected, toggle } : null), [on, selected, toggle])
  const deck = useBulkDeck({ onUndo, onFinished: () => void actions.refresh() })
  // The picked rows' tasks, from the card's segments (a row in two lists once).
  const tasks = new Map<number, Task>()
  // THE SAFETY NET (Trent, 2026-11-02): a deadlines-page row from the day
  // before its deadline leaves only by a target or done, so Consider, Deck
  // and Not today leave it out — they act on the other picks (`loose`), and
  // the bar drops each one when every pick is in the net.
  const net = new Set<number>()
  for (const segment of actions.segments) {
    for (const row of segment.rows) {
      if (!selected.has(row.task.id)) continue
      tasks.set(row.task.id, row.task)
      if (row.safetyNet) net.add(row.task.id)
    }
  }
  const picked = [...tasks.values()]
  const ids = picked.map((t) => t.id)
  const loose = ids.filter((id) => !net.has(id))
  const anyLoose = loose.length > 0
  const act = (fn: () => unknown) => {
    void fn()
    finished()
  }
  const bar =
    on && picked.length > 0 ? (
      <QueueSelectionBar
        selectedTasks={picked}
        timezone={timezone}
        onConsider={anyLoose ? () => act(() => actions.considerMany(loose)) : undefined}
        onDone={() => act(() => actions.doneMany(ids))}
        onTarget={(until) => act(() => actions.targetMany(ids, until))}
        onNotToday={anyLoose ? () => act(() => actions.notTodayMany(loose)) : undefined}
        onDeck={anyLoose ? (day) => act(() => deck(loose, day)) : undefined}
        onDetails={() => {
          if (picked.length === 1) actions.openDetails(picked[0])
          else window.dispatchEvent(new CustomEvent(QUEUE_BULK_DETAILS_EVENT, { detail: ids }))
          leave()
        }}
        onDelete={() => act(() => actions.removeMany(ids))}
        // The Select button's mode keeps the picks (the change is drawn on the
        // rows they are); a hold's leaves once it lands.
        onHorizon={(h) =>
          void actions.horizonMany(ids, h).then(() => {
            if (held) leave()
          })
        }
        onOpen={() => {
          actions.openDetails(picked[0])
          leave()
        }}
        onShowInList={() => {
          requestShowInList(picked[0].id)
          leave()
        }}
        onRemoveTargets={(some) => act(() => actions.removeTargetsMany(some))}
        onHeadsUp={(some, on) => act(() => actions.headsUpMany(some, on))}
        onSkipUntil={async (some, until) => {
          await actions.skipUntilMany(some, until)
          finished()
        }}
        onCancel={leave}
      />
    ) : null
  return {
    on,
    toggleMode: () => {
      if (on) return leave()
      setHeld(false)
      setOn(true)
    },
    enter,
    modifierPick,
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
        'shrink-0 rounded-full px-1.5 py-1 text-xs font-medium transition-colors',
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
 * Delete — the list's bar (`SelectionActionSheet`) with the queue's own two,
 * Consider and Not today — and More as the "⋯" beside Cancel (seven verbs
 * keep their words at full size on a 375 phone; eight did not).
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
  onHeadsUp,
  onSkipUntil,
  onCancel,
  onHorizon,
  onOpen,
  onShowInList,
}: {
  selectedTasks: Task[]
  timezone: string
  /** Consider, Not today and Deck: absent when every pick is a safety-net row. */
  onConsider?: () => void
  onDone: () => void
  onTarget: (until: string) => void
  onNotToday?: () => void
  onDeck?: (day: string | null) => void
  onDetails: () => void
  onDelete: () => void
  onRemoveTargets: (ids: number[]) => void
  /** Heads up (2026-11-02, ⋯ More): the picked tasks' `heads_up`, one request. */
  onHeadsUp: (ids: number[], on: boolean) => void
  onSkipUntil?: (ids: number[], until: string | null) => Promise<void>
  onCancel: () => void
  onHorizon: (horizon: HorizonValue | null) => void
  onOpen: () => void
  onShowInList: () => void
}) {
  const count = selectedTasks.length
  const one = count === 1 ? selectedTasks[0] : null
  return (
    <SelectionBarShell
      count={count}
      onClear={onCancel}
      testAttr="data-queue-selection-bar"
      title={one?.title}
      detail={
        one && (
          <SelectionDetailLines
            task={one}
            timezone={timezone}
            onHorizon={onHorizon}
            onOpen={onOpen}
            onShowInList={onShowInList}
          />
        )
      }
      aside={!one && <BarHorizonControl tasks={selectedTasks} onChange={onHorizon} />}
      more={
        <MoreVerb
          selectedTasks={selectedTasks}
          timezone={timezone}
          onRemoveTargets={onRemoveTargets}
          onHeadsUp={onHeadsUp}
          onSkipUntil={onSkipUntil}
        />
      }
    >
      {onConsider && (
        <BarAction icon={<CheckCheck />} label="Consider" onClick={onConsider} data-bar-consider />
      )}
      <BarAction tone="done" icon={<Check />} label="Done" onClick={onDone} />
      <TargetVerb count={count} targets={selectedTasks.map((t) => t.due_at)} onTarget={onTarget} />
      {onNotToday && (
        <BarAction icon={<Forward />} label={NOT_TODAY} onClick={onNotToday} data-bar-not-today />
      )}
      {onDeck && <DeckVerb timezone={timezone} onDeck={onDeck} />}
      <BarAction icon={<FileText />} label="Details" onClick={onDetails} data-bar-details />
      <BarAction
        tone="danger"
        icon={<Trash2 />}
        label="Delete"
        onClick={onDelete}
        ariaLabel={`Delete ${count} ${count === 1 ? 'task' : 'tasks'}`}
      />
    </SelectionBarShell>
  )
}
