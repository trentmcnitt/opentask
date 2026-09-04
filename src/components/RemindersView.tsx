'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Check, CheckCheck, ChevronDown, Lightbulb, StickyNote } from 'lucide-react'
import { DateTime } from 'luxon'
import { cn } from '@/lib/utils'
import { currentSlot } from '@/lib/time-slot-assign'
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
 * 1. **Each time slot is a container.** Its header carries the count and a
 *    single "Considered all" action — the user's own framing was "my task is to
 *    do my reminders": one slot, one tap, one Undo.
 * 2. **Only the current slot opens by default.** The slot whose window contains
 *    the present moment is the one whose thoughts are timely; earlier and later
 *    slots fold to a header with a count badge, one tap to open. Nothing is
 *    hidden, nothing is late — a reminder carries no debt, so a morning slot
 *    seen at 4pm is simply still waiting, not overdue.
 * 3. **Inside an open slot: the first five, then "Show all N".** Same constant
 *    and same affordance as the dashboard's slot groups (§7.3).
 *
 * Selection works exactly as it does on the dashboard, on purpose: a plain
 * click selects the row (and only it), shift-click selects the range from the
 * anchor, cmd/ctrl-click adds one, Escape clears. A selection raises the same
 * floating bar the dashboard uses, with the verbs that apply to reminders. A
 * row click never navigates — opening an item is an explicit "Details" from
 * the bar, so a stray tap on a sentence cannot yank the user off the screen.
 * The circle still considers one item directly.
 *
 * Two deliberate departures from the task list stay as before: completed items
 * leave immediately (leaving them greyed out would bury the rest), and empty
 * slots are hidden here (there is no day to read on this surface, only
 * thoughts still waiting).
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
  const { selectedIds, isSelectionMode, toggle, rangeSelect, selectOnly, removeAll, clear } =
    useSelectionMode()

  useEffect(() => {
    if (!refreshRef) return
    refreshRef.current = () => void refresh()
    return () => {
      refreshRef.current = null
    }
  }, [refreshRef, refresh])

  const visibleGroups = groups.filter((group) => group.reminders.length > 0)

  // Which slot opens by default: the current one if it has anything waiting,
  // otherwise the first with content (before the day's first slot, or when
  // the current slot is already clear, there is still something to read).
  const defaultOpenKey = useMemo(() => {
    const slots = visibleGroups.flatMap((g) => (g.slot ? [g.slot] : []))
    const now = currentSlot(slots, timezone)
    if (now) return String(now.id)
    return visibleGroups.length > 0 ? groupKey(visibleGroups[0]) : null
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

  // Escape clears a selection, as it does on the dashboard.
  useEffect(() => {
    if (!isSelectionMode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clear()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isSelectionMode, clear])

  const handleRowClick = useCallback(
    (task: Task, e: React.MouseEvent) => {
      if (e.shiftKey) rangeSelect(task.id, orderedIds)
      else if (e.metaKey || e.ctrlKey) toggle(task.id)
      else selectOnly(task.id)
    },
    [rangeSelect, toggle, selectOnly, orderedIds],
  )

  // A row leaving the surface leaves the selection too, whichever path took it.
  const handleComplete = useCallback(
    (task: Task) => {
      removeAll([task.id])
      void complete(task)
    },
    [removeAll, complete],
  )
  const handleCompleteGroup = useCallback(
    (group: ReminderGroup) => {
      removeAll(group.reminders.map((r) => r.id))
      void completeGroup(group)
    },
    [removeAll, completeGroup],
  )
  const handleConsiderSelection = useCallback(() => {
    const tasks = selectedTasks
    clear()
    void completeMany(tasks)
  }, [selectedTasks, clear, completeMany])

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
          <p className="text-muted-foreground/80 mb-4 px-2 text-xs">{total} to consider today</p>
          <div className="space-y-3">
            {visibleGroups.map((group) => {
              const key = groupKey(group)
              return (
                <ReminderSlotGroup
                  key={key}
                  group={group}
                  open={isOpen(key)}
                  expanded={expandedKeys.has(key)}
                  onToggle={() => toggleOpen(key)}
                  onExpand={(expanded) => setExpanded(key, expanded)}
                  completingIds={completingIds}
                  selectedIds={selectedIds}
                  onRowClick={handleRowClick}
                  onComplete={handleComplete}
                  onCompleteGroup={handleCompleteGroup}
                />
              )
            })}
          </div>
        </>
      )}

      <ReminderSelectionBar
        selectedCount={selectedIds.size}
        onConsidered={handleConsiderSelection}
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
  const visible = expanded ? group.reminders : group.reminders.slice(0, SLOT_PREVIEW_COUNT)
  const hiddenCount = count - visible.length

  return (
    <div className={cn('rounded-2xl transition-colors', open && 'bg-muted/30 pb-2')}>
      {/* Same header language as the dashboard's slot groups — one visual
          vocabulary for "morning", wherever it appears. A folded slot carries
          its count as a badge so "still waiting" is obvious at a glance. */}
      <div className="flex min-h-11 items-center gap-2 px-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="hover:text-foreground flex min-w-0 flex-1 items-center gap-2 rounded-lg py-2 text-left transition-colors"
        >
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'text-muted-foreground/60 size-3.5 shrink-0 transition-transform duration-200',
              !open && '-rotate-90',
            )}
          />
          <span className="text-muted-foreground text-xs font-semibold tracking-wider whitespace-nowrap uppercase">
            {label}
          </span>
          {time && (
            <span className="text-muted-foreground/50 text-xs whitespace-nowrap">
              &middot; {time}
            </span>
          )}
          {open ? (
            <span className="text-muted-foreground/60 text-xs tabular-nums">{count}</span>
          ) : (
            <span
              className="bg-foreground/10 text-foreground/80 ml-1 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums"
              aria-label={`${count} waiting`}
            >
              {count}
            </span>
          )}
        </button>
        {open && (
          <button
            type="button"
            onClick={() => onCompleteGroup(group)}
            aria-label={`Mark all ${count} in ${label} as considered`}
            className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors"
          >
            <CheckCheck className="size-3.5" strokeWidth={2.5} />
            {/* The label folds to the icon on narrow screens so the slot header
                never wraps; the aria-label carries the full verb regardless. */}
            <span className="hidden sm:inline">Considered all</span>
          </button>
        )}
      </div>

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
              className="text-muted-foreground hover:text-foreground w-full rounded-lg py-2 text-xs font-medium transition-colors"
            >
              Show all {count}
              <span className="text-muted-foreground/60"> ({hiddenCount} more)</span>
            </button>
          )}
          {expanded && count > SLOT_PREVIEW_COUNT && (
            <button
              type="button"
              onClick={() => onExpand(false)}
              className="text-muted-foreground hover:text-foreground w-full rounded-lg py-2 text-xs font-medium transition-colors"
            >
              Show less
            </button>
          )}
        </>
      )}
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
        'group flex cursor-pointer items-start gap-3 rounded-xl px-2 py-3 transition-all duration-200 ease-out select-none',
        selected ? 'ring-ring bg-accent ring-2' : 'hover:bg-background',
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
        className="border-muted-foreground/30 hover:border-foreground/60 hover:bg-foreground/5 mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors"
      >
        <Check
          className="group-hover:text-foreground/40 size-3.5 text-transparent transition-colors"
          strokeWidth={3}
        />
      </button>
      {/* The notes marker sits inline after the title rather than pinned to
          the right edge: on a wide screen a lone icon across the row reads as
          an unrelated control, and this one is only ever a footnote. */}
      <p className="min-w-0 flex-1 text-[16px] leading-relaxed">
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
