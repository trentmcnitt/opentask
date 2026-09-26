'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuotasData } from '@/hooks/useQuotasData'
import { useNavigationGuard } from '@/components/NavigationGuardProvider'
import { useRouter } from 'next/navigation'
import { Gauge, Minus, Plus, Trash2, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { QuotaDetailModal } from '@/components/QuotaDetailModal'
import type { QuotaCreateDraft } from '@/components/QuotaDetail'
import { useTrackProgress } from '@/hooks/useTrackProgress'
import { useSelectionMode } from '@/hooks/useSelectionMode'
import { useQuotaMutations } from '@/hooks/useQuotaMutations'
import { quotaGroupSummary, groupByLabel, periodLabel, periodShort } from '@/lib/track'
import { useLabelConfig } from '@/components/PreferencesProvider'
import { getLabelClasses } from '@/lib/label-colors'
import { SelectionBarShell } from '@/components/SelectionBarShell'
import { scrollRowIntoView } from '@/lib/scroll-row-into-view'
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
 * The grouping is by LABEL (Trent, 2026-09-08: "I think we need to have one
 * label for quotas… there's a bunch of stuff for the kids and there are other
 * things"). This page is where quotas are worked on as a set, and the set that
 * matters there is the domain — kids, health, house — not the cadence. The
 * dashboard's Track panel keeps `groupByPeriod`: it answers "what is left this
 * week", where the period IS the question. So the two surfaces group
 * differently on purpose, and each row here carries its own period tag, since
 * a label group mixes days, weeks and months.
 */
export function QuotasView({
  onUndo,
  onCompleted,
  refreshRef,
  viewSwitch,
}: {
  /** Undo the last action — wired to the toasts, as on every other surface. */
  onUndo: () => void
  /** Tell the host an undoable thing happened, so its Undo count is right. */
  onCompleted: () => void
  /** Populated with this view's refresh, so the page's undo/redo can call it. */
  refreshRef?: React.MutableRefObject<(() => void) | null>
  /** The page's Summary/Details switch, set into the header row. */
  viewSwitch?: React.ReactNode
}) {
  const router = useRouter()
  const { requestNavigation } = useNavigationGuard()
  const { tasks, error, refresh } = useQuotasData(refreshRef)
  const selection = useSelectionMode()
  const { selectedIds, toggle, rangeSelect, selectOnly, clear } = selection

  /** A snapshot handed to the modal, so a refresh cannot move it underneath. */
  const [editing, setEditing] = useState<Task[] | null>(null)
  const [creating, setCreating] = useState<QuotaCreateDraft | null>(null)

  // `?quota=<id>` — the Track widget's deep link (`WidgetLink.quota` →
  // `opentask://quota/<id>` → `/quotas?quota=<id>`, resolved in
  // `OpenTaskApp.handleWidgetLink`). Brings that quota into view and flashes
  // it once; opens nothing — mirrors RemindersView's `?reminder=<id>` and
  // the dashboard's `?task=<id>&highlight=1`.
  //
  // Bare, no `highlight` flag: unlike `/?task=`, nothing else currently
  // links into `/quotas` with a query param — no notification tap, no Web
  // Push — so there is no second meaning `?quota=<id>` has to be told apart
  // from. If that changes, match the flag convention rather than inventing
  // a third one.
  //
  // Read from `window.location.search` directly rather than
  // `useSearchParams()` — same reasoning as RemindersView's identical
  // comment: it keeps this component out of a Suspense boundary it would
  // otherwise need, and the param is stripped with a raw history rewrite
  // below regardless of how it was read.
  //
  // Read in `useState`'s initializer, on the first render, rather than in an
  // effect once the list has loaded (2026-09-25): the page now reads the same
  // param to open this view rather than the summary, and a `setState` in an
  // effect is a second render for nothing. An id that is not a quota simply
  // matches no row. The strip still waits for the list, so the param outlives
  // a remount before the data arrives.
  const [highlightId, setHighlightId] = useState<number | null>(readQuotaParam)
  const clearHighlight = useCallback(() => setHighlightId(null), [])
  const loaded = tasks !== null
  useEffect(() => {
    if (!loaded || !new URLSearchParams(window.location.search).has('quota')) return
    window.history.replaceState(window.history.state, '', window.location.pathname)
  }, [loaded])

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

  const groups = useMemo(() => groupByLabel(tasks ?? []), [tasks])
  const orderedIds = useMemo(() => groups.flatMap((g) => g.tasks.map((t) => t.id)), [groups])

  if (tasks === null)
    return (
      <p className="text-muted-foreground py-16 text-center text-sm">{error ?? 'Loading\u2026'}</p>
    )

  const selected = tasks.filter((t) => selectedIds.has(t.id))

  return (
    <section aria-label="Quotas" data-quotas-view className="space-y-3 pb-24">
      <QuotasHeaderRow
        count={tasks.length}
        onNew={() => setCreating({ title: '' })}
        viewSwitch={viewSwitch}
      />

      {tasks.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="space-y-2.5">
          {groups.map((group) => (
            <QuotaGroupCard
              key={group.label ?? 'unlabelled'}
              label={group.label}
              tasks={group.tasks}
              selectedIds={selectedIds}
              onSelect={(task, e) => {
                if (e.shiftKey) rangeSelect(task.id, orderedIds)
                else if (e.metaKey || e.ctrlKey) toggle(task.id)
                else selectOnly(task.id)
              }}
              onOpen={(task) => setEditing([task])}
              highlightId={highlightId}
              onHighlightDone={clearHighlight}
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

/** `?quota=<id>` as a number, or null — see `QuotasView`'s deep-link comment. */
function readQuotaParam(): number | null {
  if (typeof window === 'undefined') return null
  const id = Number.parseInt(new URLSearchParams(window.location.search).get('quota') ?? '', 10)
  return Number.isNaN(id) ? null : id
}

/**
 * The page's header row, shared by both of its views (`QuotasView`, the
 * detailed list, and `QuotasSummary`, the dashboard's panel) so switching
 * between them never moves the count, the switch or "New quota".
 *
 * The switch is only offered when there is something to switch between views
 * OF — with no quotas both views are the same empty state, and a control that
 * changes nothing on screen is chrome for something that isn't there.
 */
export function QuotasHeaderRow({
  count,
  onNew,
  viewSwitch,
}: {
  count: number
  onNew: () => void
  viewSwitch?: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-1">
      {/* The page's h1, exactly as the Reminders headline is: this one line
          is the surface's summary, so it is the heading rather than a
          paragraph sitting where a heading should be. */}
      <h1 className="text-muted-foreground min-w-0 truncate text-sm">
        {count === 0 ? 'No quotas yet.' : `${count} quota${count === 1 ? '' : 's'}`}
      </h1>
      <div className="flex shrink-0 items-center gap-2">
        {count > 0 && viewSwitch}
        <Button size="sm" onClick={onNew}>
          <Plus className="size-4" />
          New quota
        </Button>
      </div>
    </div>
  )
}

export function EmptyState() {
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
 * One label's quotas, in the same card the periods used to sit in: the name
 * top-left, a count top-right.
 *
 * The count is quotas, NOT progress. The card used to carry the dashboard's
 * summed bar ("7 of 23"), which was honest while a card held one period and is
 * meaningless now that it holds several: two a day plus three a week plus one a
 * month adds up to nothing anybody can act on. "3 quotas · 1 met" is the same
 * information at a granularity that survives mixing, and each row still shows
 * its own bar. `met` is `trackState`'s met — reached the target, still open.
 */
function QuotaGroupCard({
  label,
  tasks,
  selectedIds,
  onSelect,
  onOpen,
  highlightId,
  onHighlightDone,
}: {
  label: string | null
  tasks: Task[]
  selectedIds: Set<number>
  onSelect: (task: Task, e: React.MouseEvent) => void
  onOpen: (task: Task) => void
  /** `?quota=<id>` — the one row to scroll to and flash. See `QuotasView`'s effect. */
  highlightId?: number | null
  onHighlightDone?: () => void
}) {
  const { labelConfig } = useLabelConfig()
  // "Unlabelled" rather than "no label": it is a group of things, named the way
  // the other groups are named. It always sorts last (see `groupByLabel`).
  const name = label ?? 'Unlabelled'
  const colorClasses = label ? getLabelClasses(label, labelConfig) : null
  const { count, met } = quotaGroupSummary(tasks)

  return (
    <div
      className="bg-muted/30 rounded-2xl px-2 pt-2 pb-2.5"
      data-quota-group={label ?? 'unlabelled'}
    >
      <div className="flex items-center gap-2 px-1 pb-2.5">
        {/* The label wears its registry colour, exactly as its chip does in the
            filter bar and the task editor; a label with no colour configured
            reads as the plain group heading the periods used to have. */}
        <span
          className={cn(
            'text-[11px] font-semibold tracking-widest uppercase',
            colorClasses ? cn('rounded-full px-2 py-0.5', colorClasses) : 'text-muted-foreground',
          )}
        >
          {name}
        </span>
        <span className="text-muted-foreground ml-auto text-xs whitespace-nowrap">
          <span className="text-foreground font-medium tabular-nums">{count}</span>{' '}
          {count === 1 ? 'quota' : 'quotas'}
          {met > 0 && <span className="text-green-700 dark:text-green-400"> · {met} met</span>}
        </span>
      </div>
      <ul role="listbox" aria-multiselectable="true" aria-label={name} className="space-y-1">
        {tasks.map((task) => (
          <QuotaRow
            key={task.id}
            task={task}
            selected={selectedIds.has(task.id)}
            onSelect={(e) => onSelect(task, e)}
            onOpen={() => onOpen(task)}
            highlighted={highlightId === task.id}
            onHighlightDone={onHighlightDone}
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
  highlighted = false,
  onHighlightDone,
}: {
  task: Task
  selected: boolean
  onSelect: (e: React.MouseEvent) => void
  onOpen: () => void
  /**
   * Deep-linked from the Track widget (`?quota=<id>`): scroll to it and
   * flash it once, mirroring `RemindersView`'s `ReminderRow`. A plain ref
   * (via `scrollRowIntoView`), not the dashboard's `ResizeObserver` effect:
   * this page has nothing that fetches and mounts content above a row
   * AFTER it renders (no side panels, no AI annotations — see
   * `TaskRow.tsx`'s identical decision point for the contrast), so there is
   * nothing here that could push the row back off-screen the way the
   * dashboard's panels do.
   */
  highlighted?: boolean
  /** The deep link's flash has played; it must not play again on a remount. */
  onHighlightDone?: () => void
}) {
  // `state` already reflects the optimistic count — re-wrapping it in
  // trackState was a no-op.
  const { state, log: logProgress } = useTrackProgress(task)
  const period = periodLabel(task.rrule)

  return (
    <li
      data-quota-row={task.id}
      data-quota-highlight={highlighted ? '' : undefined}
      ref={highlighted ? scrollRowIntoView : undefined}
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
      onAnimationEnd={(e) => {
        // Filtered the same way TaskRow's is: nothing else on this row
        // animates today, but the guard is cheap and keeps the two rows'
        // patterns identical.
        if (e.target === e.currentTarget && e.animationName === 'row-highlight') {
          onHighlightDone?.()
        }
      }}
      className={cn(
        // Wraps like TrackRow: on a phone the title takes the whole first line
        // and the bar/count/buttons sit beneath it. Five fixed-width things on
        // one 375px line truncated every title to "Broc…".
        'flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl px-2 py-2 transition-colors',
        selected ? 'bg-primary/10 ring-primary/40 ring-1' : 'hover:bg-background/60',
        highlighted && 'animate-row-highlight',
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

        {/* The period, on the row rather than on the card: the groups are
            labels now, so a card holds a daily quota next to a monthly one and
            "0 / 2" alone would not say which. Deliberately OUTSIDE
            `data-quota-count` — that hook is asserted on exactly. A quota with
            no rule says so instead of showing a blank column. */}
        <span
          data-quota-period
          className="text-muted-foreground w-16 shrink-0 text-xs whitespace-nowrap"
        >
          · {period ? periodShort(period) : 'no period'}
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
