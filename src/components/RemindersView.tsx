'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Check, CheckCheck, ChevronDown, Lightbulb, StickyNote } from 'lucide-react'
import { DateTime } from 'luxon'
import { cn } from '@/lib/utils'
import { currentSlot } from '@/lib/time-slot-assign'
import { useReminders, type ReminderGroup } from '@/hooks/useReminders'
import { useTimezone } from '@/hooks/useTimezone'
import type { Task } from '@/types'

/**
 * The Reminders surface (REDESIGN-V03 §6).
 *
 * Prompted thoughts — principles and considerations, "thoughts to have at the
 * right moment". They are not tasks, and this surface exists so they do not
 * LOOK like tasks: no due chip, no overdue styling, no snooze affordance, no
 * selection mode. A row is a circle and a sentence.
 *
 * How the screen stays "a handful" at any corpus size (the founding constraint:
 * the harness adapts to the scale, the user does not prune):
 *
 * 1. **Each time slot is a container.** Its header carries the count and a
 *    single "Considered all" action — the user's own framing was "my task is to
 *    do my reminders": one slot, one tap, one Undo. Individual circles remain
 *    for picking off one thought at a time.
 * 2. **Only the current slot opens by default.** The slot whose window contains
 *    the present moment is the one whose thoughts are timely; earlier and later
 *    slots render as a header with a count, one tap to open. Nothing is hidden,
 *    nothing is late — a reminder carries no debt, so a morning slot seen at
 *    4pm is simply still waiting, not overdue.
 * 3. **Inside an open slot: the first five, then "Show all N".** Same constant
 *    and same affordance as the dashboard's slot groups (§7.3).
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
    completeGroup,
    refresh,
  } = useReminders({ onUndo, onCompleted })
  const timezone = useTimezone()

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

  // The user's explicit open/close choices, layered over the default. Kept as
  // overrides rather than a plain "open set" so the default can be computed
  // from data that arrives after first render without a timing dance.
  const [openOverrides, setOpenOverrides] = useState<Map<string, boolean>>(new Map())
  const isOpen = (key: string) => openOverrides.get(key) ?? key === defaultOpenKey
  const toggleOpen = (key: string) =>
    setOpenOverrides((prev) => {
      const next = new Map(prev)
      next.set(key, !isOpen(key))
      return next
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
          <p className="text-muted-foreground/80 mb-4 px-2 text-xs">{total} to consider today</p>
          <div className="space-y-3">
            {visibleGroups.map((group) => {
              const key = groupKey(group)
              return (
                <ReminderSlotGroup
                  key={key}
                  group={group}
                  open={isOpen(key)}
                  onToggle={() => toggleOpen(key)}
                  completingIds={completingIds}
                  onComplete={complete}
                  onCompleteGroup={completeGroup}
                />
              )
            })}
          </div>
        </>
      )}
    </section>
  )
}

function ReminderSlotGroup({
  group,
  open,
  onToggle,
  completingIds,
  onComplete,
  onCompleteGroup,
}: {
  group: ReminderGroup
  open: boolean
  onToggle: () => void
  completingIds: Set<number>
  onComplete: (task: Task) => void
  onCompleteGroup: (group: ReminderGroup) => void
}) {
  const label = group.slot?.label ?? UNSLOTTED_LABEL
  const time = group.slot ? formatSlotTime(group.slot.start_time) : null
  const count = group.reminders.length

  // "Show all" is per slot and resets whenever the slot opens or closes —
  // reopening a slot should read as a fresh glance, not resume a deep scroll.
  // Adjusted during render (React's "derive from a prop change" pattern) rather
  // than in an effect, so there is no extra render with stale expansion.
  const [expanded, setExpanded] = useState(false)
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    setExpanded(false)
  }

  const visible = expanded ? group.reminders : group.reminders.slice(0, SLOT_PREVIEW_COUNT)
  const hiddenCount = count - visible.length

  return (
    <div className={cn('rounded-2xl transition-colors', open && 'bg-muted/30 pb-2')}>
      {/* Same header language as the dashboard's slot groups — one visual
          vocabulary for "morning", wherever it appears. */}
      <div className="flex min-h-11 items-center gap-2 px-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="hover:text-foreground flex min-w-0 flex-1 items-baseline gap-2 rounded-lg py-2 text-left transition-colors"
        >
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'text-muted-foreground/60 size-3.5 shrink-0 self-center transition-transform duration-200',
              !open && '-rotate-90',
            )}
          />
          <span className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
            {label}
          </span>
          {time && <span className="text-muted-foreground/50 text-xs">&middot; {time}</span>}
          <span className="text-muted-foreground/60 text-xs tabular-nums">
            {open ? count : `${count} waiting`}
          </span>
        </button>
        {open && (
          <button
            type="button"
            onClick={() => onCompleteGroup(group)}
            aria-label={`Mark all ${count} in ${label} as considered`}
            className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors"
          >
            <CheckCheck className="size-3.5" strokeWidth={2.5} />
            Considered all
          </button>
        )}
      </div>

      {open && (
        <>
          <ul className="space-y-0.5 px-1">
            {visible.map((reminder) => (
              <ReminderRow
                key={reminder.id}
                reminder={reminder}
                completing={completingIds.has(reminder.id)}
                onComplete={onComplete}
              />
            ))}
          </ul>
          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="text-muted-foreground hover:text-foreground w-full rounded-lg py-2 text-xs font-medium transition-colors"
            >
              Show all {count}
              <span className="text-muted-foreground/60"> ({hiddenCount} more)</span>
            </button>
          )}
          {expanded && count > SLOT_PREVIEW_COUNT && (
            <button
              type="button"
              onClick={() => setExpanded(false)}
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
  onComplete,
}: {
  reminder: Task
  completing: boolean
  onComplete: (task: Task) => void
}) {
  const router = useRouter()
  const hasNotes = !!reminder.notes?.trim()
  const href = `/tasks/${reminder.id}`

  return (
    <li
      data-reminder-id={reminder.id}
      className={cn(
        'transition-all duration-200 ease-out',
        completing && 'pointer-events-none translate-x-2 opacity-0',
      )}
    >
      {/* The whole row opens the thought. The circle and the title handle their
          own clicks and stop propagation, so the row's handler only fires for
          the "dead" space that a first-time visitor naturally taps. */}
      <div
        onClick={() => router.push(href)}
        className="group hover:bg-background flex cursor-pointer items-start gap-3 rounded-xl px-2 py-3 transition-colors"
      >
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
          <Link
            href={href}
            onClick={(e) => e.stopPropagation()}
            className={cn('text-pretty', prominenceClasses(reminder.priority))}
          >
            {reminder.title}
          </Link>
          {hasNotes && (
            <span className="text-muted-foreground/50 ml-1.5 inline-flex align-[-2px]">
              <StickyNote className="size-3.5" aria-label="Has notes" />
            </span>
          )}
        </p>
      </div>
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
