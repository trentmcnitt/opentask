'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, CheckCheck, ChevronDown, Lightbulb, StickyNote } from 'lucide-react'
import { DateTime } from 'luxon'
import { cn } from '@/lib/utils'
import { currentSlot } from '@/lib/time-slot-assign'
import { summarizeReminders, type RemindersSummary } from '@/lib/reminders-summary'
import { useReminders, type ReminderGroup } from '@/hooks/useReminders'
import { useSelectionMode } from '@/hooks/useSelectionMode'
import { useTimezone } from '@/hooks/useTimezone'
import { ReminderSelectionBar } from '@/components/ReminderSelectionBar'
import type { Task } from '@/types'

/**
 * The Reminders surface (REDESIGN-V03 §6).
 *
 * Prompted thoughts — principles and considerations, "thoughts to have at the
 * right moment". They are not tasks, and this surface exists so they do not
 * LOOK like tasks: no due chip, no overdue styling, no snooze affordance. A row
 * is a circle and a sentence.
 *
 * How the screen stays "a handful" at any corpus size (the founding constraint:
 * the harness adapts to the scale, the user does not prune):
 *
 * 1. **The headline is "waiting so far", not the pile.** Trent's definition
 *    (2026-09-04): everything still waiting in a slot that has already
 *    started today, plus Anytime. The same number sits on the nav badge, and
 *    one tap — "Considered all so far" — clears exactly it. Later slots are
 *    named, not counted against him.
 * 2. **Each time slot is a container** with its own "Considered all"; only the
 *    current slot opens by default, the rest fold to a header with a badge:
 *    accent while the slot has started and holds something, muted "later"
 *    before its time.
 * 3. **Inside an open slot: the first five, then "Show all N".**
 * 4. **Progress fills, it never scolds.** A bar per slot and one for the day
 *    show what has been considered so far today (his add: "satisfying to get
 *    through all the reminders"). It only ever counts what he did — a bar that
 *    filled with misses would read intent from absence (L1).
 *
 * Selection works exactly as it does on the dashboard, on purpose: plain click
 * selects, shift-click a range, cmd/ctrl-click adds, Escape clears; the same
 * floating bar appears with the verbs that apply. A row click never navigates.
 *
 * Completed items leave immediately, and a slot that never had anything today
 * is not shown (on this surface there is no day to read, only thoughts still
 * waiting) — but a slot that has been fully considered stays as a full bar,
 * because that is the satisfying part.
 */

/** Un-slotted reminders (no anchor_time and no due time) group under this label. */
const UNSLOTTED_LABEL = 'Anytime'

/** How many rows an open slot shows before "Show all" — matches the dashboard (§7.3). */
const SLOT_PREVIEW_COUNT = 5

interface RemindersViewProps {
  /** Undo the last action — wired to the completion toast. */
  onUndo: () => void
  /** Called after a completion, so the page can keep its own undo counter in step. */
  onCompleted?: () => void
  /**
   * Registers this surface's refetch with the page, so an event that changes
   * reminders elsewhere (the sync stream, an undo) can refresh it. Without it an
   * undone completion would stay invisible until a reload.
   */
  refreshRef?: React.MutableRefObject<(() => void) | null>
}

/** Stable identity for a group across refetches — slot id, or the un-slotted bucket. */
function groupKey(group: ReminderGroup): string {
  return group.slot ? String(group.slot.id) : 'unslotted'
}

export function RemindersView({ onUndo, onCompleted, refreshRef }: RemindersViewProps) {
  const {
    groups,
    total,
    hasAny,
    loading,
    error,
    completingIds,
    consideredAny,
    complete,
    completeMany,
    completeGroup,
    refresh,
  } = useReminders({ onUndo, onCompleted })
  const timezone = useTimezone()
  const router = useRouter()
  const selection = useSelectionMode()
  const { selectedIds, clear } = selection

  useEffect(() => {
    if (!refreshRef) return
    refreshRef.current = () => void refresh()
    return () => {
      refreshRef.current = null
    }
  }, [refreshRef, refresh])

  // A slot shows while it has something waiting OR something considered today
  // (a full bar is worth seeing); a slot with neither is noise.
  const visibleGroups = useMemo(
    () => groups.filter((g) => g.reminders.length > 0 || g.considered > 0),
    [groups],
  )
  const summary = useMemo(
    () => summarizeReminders(visibleGroups, timezone),
    [visibleGroups, timezone],
  )

  // Which slot opens by default: the current one if it has anything waiting,
  // otherwise the first with something waiting.
  const defaultOpenKey = useMemo(() => {
    const withWaiting = visibleGroups.filter((g) => g.reminders.length > 0)
    const slots = withWaiting.flatMap((g) => (g.slot ? [g.slot] : []))
    const now = currentSlot(slots, timezone)
    if (now) return String(now.id)
    return withWaiting.length > 0 ? groupKey(withWaiting[0]) : null
  }, [visibleGroups, timezone])

  const { isOpen, toggleOpen, expandedKeys, setExpanded } = useSlotDisclosure(defaultOpenKey)

  // Rows actually rendered, in DOM order — the universe for range selection.
  const renderedRows = useMemo(
    () =>
      visibleGroups.flatMap((group) => {
        const key = groupKey(group)
        if (!isOpen(key)) return []
        return expandedKeys.has(key)
          ? group.reminders
          : group.reminders.slice(0, SLOT_PREVIEW_COUNT)
      }),
    [visibleGroups, isOpen, expandedKeys],
  )
  const orderedIds = useMemo(() => renderedRows.map((r) => r.id), [renderedRows])
  const selectedTasks = useMemo(
    () => renderedRows.filter((r) => selectedIds.has(r.id)),
    [renderedRows, selectedIds],
  )

  const actions = useReminderActions({
    selection,
    orderedIds,
    selectedTasks,
    startedGroups: summary.started,
    complete,
    completeMany,
    completeGroup,
  })

  return (
    <section aria-label="Reminders" className="w-full">
      {loading ? (
        <RemindersSkeleton />
      ) : error ? (
        <p className="text-muted-foreground py-16 text-center text-sm">{error}</p>
      ) : visibleGroups.length === 0 ? (
        <RemindersEmptyState allClear={consideredAny || hasAny} />
      ) : (
        <>
          <RemindersHeadline
            summary={summary}
            allWaitingDone={total === 0}
            onConsiderSoFar={actions.considerSoFar}
          />
          {total === 0 ? (
            <RemindersEmptyState allClear />
          ) : (
            <div className="space-y-3">
              {[...summary.started, ...summary.later].map((group) => {
                const key = groupKey(group)
                return (
                  <ReminderSlotGroup
                    key={key}
                    group={group}
                    started={summary.started.includes(group)}
                    open={isOpen(key) && group.reminders.length > 0}
                    expanded={expandedKeys.has(key)}
                    onToggle={() => toggleOpen(key)}
                    onExpand={(expanded) => setExpanded(key, expanded)}
                    completingIds={completingIds}
                    selectedIds={selectedIds}
                    onRowClick={actions.rowClick}
                    onComplete={actions.complete}
                    onCompleteGroup={actions.completeGroup}
                  />
                )
              })}
            </div>
          )}
        </>
      )}

      <ReminderSelectionBar
        selectedCount={selectedIds.size}
        onConsidered={actions.considerSelection}
        onDetails={
          selectedTasks.length === 1
            ? () => router.push(`/tasks/${selectedTasks[0].id}`)
            : undefined
        }
        onClear={clear}
      />
    </section>
  )
}

/**
 * The surface's verbs, wired to the selection so a row that leaves the screen
 * leaves the selection too, whichever path took it. Escape clears a selection,
 * as it does on the dashboard.
 */
function useReminderActions({
  selection,
  orderedIds,
  selectedTasks,
  startedGroups,
  complete,
  completeMany,
  completeGroup,
}: {
  selection: ReturnType<typeof useSelectionMode>
  orderedIds: number[]
  selectedTasks: Task[]
  startedGroups: ReminderGroup[]
  complete: (task: Task) => Promise<void>
  completeMany: (tasks: Task[]) => Promise<void>
  completeGroup: (group: ReminderGroup) => Promise<void>
}) {
  const { isSelectionMode, toggle, rangeSelect, selectOnly, removeAll, clear } = selection

  useEffect(() => {
    if (!isSelectionMode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clear()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isSelectionMode, clear])

  const rowClick = useCallback(
    (task: Task, e: React.MouseEvent) => {
      if (e.shiftKey) rangeSelect(task.id, orderedIds)
      else if (e.metaKey || e.ctrlKey) toggle(task.id)
      else selectOnly(task.id)
    },
    [rangeSelect, toggle, selectOnly, orderedIds],
  )
  const completeOne = useCallback(
    (task: Task) => {
      removeAll([task.id])
      void complete(task)
    },
    [removeAll, complete],
  )
  const completeSlot = useCallback(
    (group: ReminderGroup) => {
      removeAll(group.reminders.map((r) => r.id))
      void completeGroup(group)
    },
    [removeAll, completeGroup],
  )
  const considerSelection = useCallback(() => {
    const tasks = selectedTasks
    clear()
    void completeMany(tasks)
  }, [selectedTasks, clear, completeMany])
  const considerSoFar = useCallback(() => {
    const tasks = startedGroups.flatMap((g) => g.reminders)
    clear()
    void completeMany(tasks)
  }, [startedGroups, clear, completeMany])

  return {
    rowClick,
    complete: completeOne,
    completeGroup: completeSlot,
    considerSelection,
    considerSoFar,
  }
}

/**
 * The headline: one short line for "what now" (never a breakdown — the slot
 * headers below ARE the breakdown, one per line), the one-tap "Considered all
 * so far", and the day's bar.
 *
 * The bar is segmented, one segment per slot in the same order as the groups
 * below and sized by how much each slot held today, so the shape of the day
 * is readable at a glance and every considered thought visibly moves it.
 * Slots that haven't started yet are drawn fainter: "not yet" must not read
 * as "not done". A segment turns green when its slot is finished — a small
 * win each time — and the number goes green when the day is.
 */
function RemindersHeadline({
  summary,
  allWaitingDone,
  onConsiderSoFar,
}: {
  summary: RemindersSummary<ReminderGroup>
  allWaitingDone: boolean
  onConsiderSoFar: () => void
}) {
  let line: React.ReactNode
  if (allWaitingDone) {
    line = <span className="text-foreground font-medium">All clear for today</span>
  } else if (summary.waitingSoFar === 0 && summary.nextUp) {
    line = (
      <>
        <span className="text-foreground font-medium">
          Caught up until {summary.nextUp.slot.label}
        </span>
        <span className="text-muted-foreground">
          {' '}
          &middot; {formatSlotTime(summary.nextUp.slot.start_time)}
        </span>
      </>
    )
  } else {
    line = (
      <span className="text-foreground font-medium" data-waiting-so-far={summary.waitingSoFar}>
        {summary.waitingSoFar} waiting so far
      </span>
    )
  }

  const segments = [...summary.started, ...summary.later]
  const dayDone = summary.dayTotal > 0 && summary.consideredTotal >= summary.dayTotal

  return (
    <div className="mb-4 px-2" data-reminders-headline>
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 text-sm">{line}</p>
        {summary.waitingSoFar > 0 && (
          <button
            type="button"
            onClick={onConsiderSoFar}
            aria-label={`Mark all ${summary.waitingSoFar} waiting so far as considered`}
            className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors"
          >
            <CheckCheck className="size-3.5" strokeWidth={2.5} />
            <span className="hidden sm:inline">Considered all so far</span>
            <span className="sm:hidden">All so far</span>
          </button>
        )}
      </div>

      <div className="mt-3 flex items-center">
        <div
          className="flex h-2 w-full items-stretch gap-[3px]"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={summary.dayTotal}
          aria-valuenow={summary.consideredTotal}
          aria-label={`${summary.consideredTotal} of ${summary.dayTotal} considered today`}
        >
          {segments.map((g) => {
            const slotTotal = g.reminders.length + g.considered
            const done = slotTotal > 0 && g.considered >= slotTotal
            const label = g.slot?.label ?? UNSLOTTED_LABEL
            const started = summary.started.includes(g)
            return (
              <div
                key={groupKey(g)}
                aria-hidden="true"
                title={`${label} · ${g.considered} of ${slotTotal} considered`}
                style={{ flexGrow: slotTotal }}
                className={cn(
                  'relative min-w-[6px] overflow-hidden rounded-full',
                  started ? 'bg-muted' : 'bg-muted/50',
                )}
              >
                <div
                  className={cn(
                    'h-full rounded-full transition-[width,background-color] duration-500 ease-out',
                    done ? 'bg-green-600' : 'bg-foreground/50',
                  )}
                  style={{ width: `${slotTotal > 0 ? (g.considered / slotTotal) * 100 : 0}%` }}
                />
              </div>
            )
          })}
        </div>
        <span className="ml-3 shrink-0 text-xs tabular-nums">
          {dayDone ? (
            <span className="text-green-700 dark:text-green-400">
              All {summary.dayTotal} considered today
            </span>
          ) : (
            <>
              <span className="text-foreground font-medium">{summary.consideredTotal}</span>
              <span className="text-muted-foreground hidden sm:inline">
                {' '}
                of {summary.dayTotal} considered
              </span>
              <span className="text-muted-foreground sm:hidden"> / {summary.dayTotal}</span>
            </>
          )}
        </span>
      </div>
    </div>
  )
}

/**
 * Which slots are open and which are showing all their rows.
 *
 * The user's explicit open/close choices are layered over the default (the
 * current slot) as overrides rather than a plain "open set", so the default
 * can be computed from data that arrives after first render without a timing
 * dance. "Show all" is tracked here too, so the view knows exactly which rows
 * are on screen — shift-click ranges must never sweep up rows the user cannot
 * see. Reopening a slot resets its "show all": it reads as a fresh glance, not
 * a resumed deep scroll.
 */
function useSlotDisclosure(defaultOpenKey: string | null) {
  const [openOverrides, setOpenOverrides] = useState<Map<string, boolean>>(new Map())
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())
  const isOpen = useCallback(
    (key: string) => openOverrides.get(key) ?? key === defaultOpenKey,
    [openOverrides, defaultOpenKey],
  )
  const toggleOpen = useCallback(
    (key: string) => {
      const nextOpen = !isOpen(key)
      setOpenOverrides((prev) => new Map(prev).set(key, nextOpen))
      setExpandedKeys((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    },
    [isOpen],
  )
  const setExpanded = useCallback((key: string, expanded: boolean) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev)
      if (expanded) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])
  return { isOpen, toggleOpen, expandedKeys, setExpanded }
}

function ReminderSlotGroup({
  group,
  started,
  open,
  expanded,
  onToggle,
  onExpand,
  completingIds,
  selectedIds,
  onRowClick,
  onComplete,
  onCompleteGroup,
}: {
  group: ReminderGroup
  started: boolean
  open: boolean
  expanded: boolean
  onToggle: () => void
  onExpand: (expanded: boolean) => void
  completingIds: Set<number>
  selectedIds: Set<number>
  onRowClick: (task: Task, e: React.MouseEvent) => void
  onComplete: (task: Task) => void
  onCompleteGroup: (group: ReminderGroup) => void
}) {
  const label = group.slot?.label ?? UNSLOTTED_LABEL
  const time = group.slot ? formatSlotTime(group.slot.start_time) : null
  const count = group.reminders.length
  const slotTotal = count + group.considered
  const finished = count === 0 && group.considered > 0
  const visible = expanded ? group.reminders : group.reminders.slice(0, SLOT_PREVIEW_COUNT)
  const hiddenCount = count - visible.length

  const headerRow = (
    <SlotHeaderRow
      label={label}
      time={time}
      count={count}
      considered={group.considered}
      open={open}
      started={started}
    />
  )

  return (
    <div
      className={cn(
        'bg-muted/30 rounded-2xl transition-colors',
        open && 'pb-2',
        !started && 'opacity-70',
      )}
      data-slot-group={label}
      data-slot-started={started}
    >
      <div className="flex min-h-11 items-center gap-2 px-3">
        {finished ? (
          <div className="flex min-w-0 flex-1 items-center gap-2 py-2">{headerRow}</div>
        ) : (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="hover:text-foreground flex min-w-0 flex-1 items-center gap-2 rounded-lg py-2 text-left transition-colors"
          >
            {headerRow}
          </button>
        )}
        {open && (
          <button
            type="button"
            onClick={() => onCompleteGroup(group)}
            aria-label={`Mark all ${count} in ${label} as considered`}
            className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors"
          >
            <CheckCheck className="size-3.5" strokeWidth={2.5} />
            <span className="hidden sm:inline">Considered all</span>
          </button>
        )}
      </div>

      <SlotHairline label={label} considered={group.considered} total={slotTotal} />

      {open && (
        <>
          <ul
            className="space-y-0.5 px-1"
            role="listbox"
            aria-multiselectable="true"
            aria-label={label}
          >
            {visible.map((reminder) => (
              <ReminderRow
                key={reminder.id}
                reminder={reminder}
                completing={completingIds.has(reminder.id)}
                selected={selectedIds.has(reminder.id)}
                onClick={onRowClick}
                onComplete={onComplete}
              />
            ))}
          </ul>
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => onExpand(true)}
              className="text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground w-full rounded-lg py-2 pl-11 text-left text-xs font-medium transition-colors"
            >
              Show all {count}
              <span className="text-muted-foreground/60"> ({hiddenCount} more)</span>
            </button>
          )}
          {expanded && count > SLOT_PREVIEW_COUNT && (
            <button
              type="button"
              onClick={() => onExpand(false)}
              className="text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground w-full rounded-lg py-2 pl-11 text-left text-xs font-medium transition-colors"
            >
              Show less
            </button>
          )}
        </>
      )}
    </div>
  )
}

/**
 * The slot header's row: one shape whether the slot is open, folded, finished,
 * or not yet started — chevron box (so the label lands on the rows' x), label,
 * time, spacer, count. The count reads the same open or folded; a later slot
 * says "later"; a finished slot says so in green. Never a pill that changes
 * colour when the section folds.
 */
function SlotHeaderRow({
  label,
  time,
  count,
  considered,
  open,
  started,
}: {
  label: string
  time: string | null
  count: number
  considered: number
  open: boolean
  started: boolean
}) {
  const finished = count === 0 && considered > 0
  return (
    <>
      <span className="flex size-6 shrink-0 items-center justify-center">
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'text-muted-foreground/60 size-3.5 transition-transform duration-200',
            !open && '-rotate-90',
            count === 0 && 'invisible',
          )}
        />
      </span>
      <span className="text-muted-foreground text-xs font-semibold tracking-wider whitespace-nowrap uppercase">
        {label}
      </span>
      {time && (
        <span className="text-muted-foreground/50 text-xs whitespace-nowrap">&middot; {time}</span>
      )}
      <span className="flex-1" />
      {finished ? (
        <span className="text-xs whitespace-nowrap text-green-700 tabular-nums dark:text-green-400">
          all {considered} considered
        </span>
      ) : (
        <span
          className="text-muted-foreground text-xs whitespace-nowrap tabular-nums"
          aria-label={started ? `${count} waiting` : `${count} later`}
        >
          {count}
          {!started && ' later'}
        </span>
      )}
    </>
  )
}

/** Full-width hairline under a slot header: considered over what the slot held today. Long enough that one thought visibly moves it. */
function SlotHairline({
  label,
  considered,
  total,
}: {
  label: string
  considered: number
  total: number
}) {
  const fraction = total > 0 ? considered / total : 0
  return (
    <div
      className="bg-muted mx-3 mb-2 h-1 overflow-hidden rounded-full"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={considered}
      aria-label={`${considered} of ${total} considered in ${label}`}
    >
      <div
        className={cn(
          'h-full rounded-full transition-[width,background-color] duration-500 ease-out',
          fraction >= 1 ? 'bg-green-600' : 'bg-foreground/50',
        )}
        style={{ width: `${Math.min(1, fraction) * 100}%` }}
      />
    </div>
  )
}

function ReminderRow({
  reminder,
  completing,
  selected,
  onClick,
  onComplete,
}: {
  reminder: Task
  completing: boolean
  selected: boolean
  onClick: (task: Task, e: React.MouseEvent) => void
  onComplete: (task: Task) => void
}) {
  const hasNotes = !!reminder.notes?.trim()

  return (
    <li
      data-reminder-id={reminder.id}
      role="option"
      aria-selected={selected}
      onClick={(e) => onClick(reminder, e)}
      className={cn(
        'group flex cursor-pointer items-start gap-3 rounded-xl px-2 py-2.5 transition-all duration-200 ease-out select-none',
        selected ? 'ring-ring bg-accent ring-2' : 'hover:bg-foreground/[0.04]',
        completing && 'pointer-events-none translate-x-2 opacity-0',
      )}
    >
      {/* The circle considers this one item directly and never touches the
          selection, so it stops the row's click from reaching the handler. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onComplete(reminder)
        }}
        aria-label={`Mark "${reminder.title}" as considered`}
        title="Considered"
        className="border-foreground/20 hover:border-foreground/60 hover:bg-foreground/5 mt-[3px] flex size-6 shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors"
      >
        <Check
          className="group-hover:text-foreground/40 size-3.5 text-transparent transition-colors"
          strokeWidth={3}
        />
      </button>
      {/* The notes marker sits inline after the title rather than pinned to
          the right edge: on a wide screen a lone icon across the row reads as
          an unrelated control, and this one is only ever a footnote. */}
      <p className="min-w-0 flex-1 text-[16px] leading-6">
        <span className={cn('text-pretty', prominenceClasses(reminder.priority))}>
          {reminder.title}
        </span>
        {hasNotes && (
          <span className="text-muted-foreground/50 ml-1.5 inline-flex align-[-2px]">
            <StickyNote className="size-3.5" aria-label="Has notes" />
          </span>
        )}
      </p>
    </li>
  )
}

/**
 * §6: priority is expressed as weight and contrast, never as alarm.
 *
 * The scale is deliberately shallow — three steps across five priorities — so
 * the top of a slot reads as "start here", not as "this one is shouting".
 */
function prominenceClasses(priority: number): string {
  if (priority >= 3) return 'text-foreground font-medium'
  if (priority === 2) return 'text-foreground'
  return 'text-foreground/70'
}

/** "07:00" → "7:00 AM". Falls back to the raw value if it isn't HH:MM. */
function formatSlotTime(startTime: string): string {
  const parsed = DateTime.fromFormat(startTime, 'HH:mm')
  return parsed.isValid ? parsed.toFormat('h:mm a') : startTime
}

function RemindersEmptyState({ allClear }: { allClear: boolean }) {
  if (allClear) {
    return (
      <div className="flex flex-col items-center gap-2 py-20 text-center">
        <div className="bg-muted text-muted-foreground flex size-11 items-center justify-center rounded-full">
          <Check className="size-5" strokeWidth={2.5} />
        </div>
        <h2 className="text-foreground text-base font-medium">All clear</h2>
        <p className="text-muted-foreground max-w-xs text-sm leading-relaxed">
          Nothing left to consider today. Anything that recurs comes back at its own time.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <div className="bg-muted text-muted-foreground flex size-11 items-center justify-center rounded-full">
        <Lightbulb className="size-5" />
      </div>
      <h2 className="text-foreground text-base font-medium">Reminders are thoughts, not tasks</h2>
      <p className="text-muted-foreground max-w-sm text-sm leading-relaxed">
        Principles and considerations you want in mind at a certain time of day. They never go
        overdue, never reach the badge, and completing one only means you considered it.
      </p>
      <p className="text-muted-foreground/70 max-w-sm text-xs leading-relaxed">
        Open any task, then turn on <span className="text-foreground/80">Reminder</span> in its
        &ldquo;More options&rdquo; menu. Give it a time of day and it lands in that slot.
      </p>
    </div>
  )
}

/** Quiet placeholder while the first fetch is in flight — no spinner, no jump. */
function RemindersSkeleton() {
  return (
    <div className="space-y-3" aria-hidden="true">
      {[0, 1].map((group) => (
        <div key={group} className="px-2">
          <div className="bg-muted/70 mb-3 h-3 w-28 rounded" />
          <div className="space-y-2.5">
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex items-center gap-3">
                <div className="bg-muted/70 size-6 shrink-0 rounded-full" />
                <div className="bg-muted/70 h-3.5 flex-1 rounded" style={{ maxWidth: '70%' }} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
