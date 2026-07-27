'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { Check, Lightbulb, StickyNote } from 'lucide-react'
import { DateTime } from 'luxon'
import { cn } from '@/lib/utils'
import { useReminders, type ReminderGroup } from '@/hooks/useReminders'
import type { Task } from '@/types'

/**
 * The Reminders surface (REDESIGN-V03 §6).
 *
 * Prompted thoughts — principles and considerations, "thoughts to have at the
 * right moment". They are not tasks, and this surface exists so they do not
 * LOOK like tasks: no due chip, no overdue styling, no snooze affordance, no
 * selection mode, no bulk bar. A row is a circle and a sentence.
 *
 * Three deliberate departures from the task list:
 *
 * 1. **Priority is prominence, not interruption.** Higher priority sorts first
 *    (server-side) and renders heavier — never red, never badged. The canonical
 *    high-priority reminder ("morning supplements — you don't have to, but
 *    consistency matters") is important without being an interrupt.
 * 2. **Completed items leave immediately.** §6: a completed reminder drops out
 *    of its slot rather than sitting there greyed out, because leaving it would
 *    bury the ones still worth considering.
 * 3. **Empty slots are hidden here**, unlike the dashboard (§7.3), which keeps
 *    them because an empty "Midday" is still part of how the user reads their
 *    day. On this surface there is no day to read — only thoughts still waiting
 *    — so an empty container is pure noise.
 */

/** Un-slotted reminders (no anchor_time and no due time) group under this label. */
const UNSLOTTED_LABEL = 'Anytime'

interface RemindersViewProps {
  /** Undo the last action — wired to the completion toast. */
  onUndo: () => void
  /** Called after a completion so the dashboard can resync its own state. */
  onCompleted?: () => void
  /**
   * Registers this surface's refetch with the parent, so the dashboard's
   * refresh chain (SSE sync, undo, redo) also refreshes reminders. Without it
   * an undone completion would stay invisible until a reload.
   */
  refreshRef?: React.MutableRefObject<(() => void) | null>
  /**
   * Whether the user has any reminders at all among their open tasks. Only the
   * empty-state wording depends on it: an account with no reminders needs the
   * surface explained, while a user who has simply finished today's needs to be
   * told they are done, not taught what reminders are.
   */
  hasReminderTasks?: boolean
}

export function RemindersView({
  onUndo,
  onCompleted,
  refreshRef,
  hasReminderTasks = false,
}: RemindersViewProps) {
  const { groups, total, loading, error, completingIds, consideredAny, complete, refresh } =
    useReminders({ onUndo, onCompleted })

  useEffect(() => {
    if (!refreshRef) return
    refreshRef.current = () => void refresh()
    return () => {
      refreshRef.current = null
    }
  }, [refreshRef, refresh])

  const visibleGroups = groups.filter((group) => group.reminders.length > 0)

  return (
    <section aria-label="Reminders" className="w-full">
      {loading ? (
        <RemindersSkeleton />
      ) : error ? (
        <p className="text-muted-foreground py-16 text-center text-sm">{error}</p>
      ) : visibleGroups.length === 0 ? (
        <RemindersEmptyState allClear={consideredAny || hasReminderTasks} />
      ) : (
        <>
          <p className="text-muted-foreground/80 mb-5 px-2 text-xs">{total} to consider today</p>
          <div className="space-y-7">
            {visibleGroups.map((group) => (
              <ReminderSlotGroup
                key={group.slot?.id ?? 'unslotted'}
                group={group}
                completingIds={completingIds}
                onComplete={complete}
              />
            ))}
          </div>
        </>
      )}
    </section>
  )
}

function ReminderSlotGroup({
  group,
  completingIds,
  onComplete,
}: {
  group: ReminderGroup
  completingIds: Set<number>
  onComplete: (task: Task) => void
}) {
  const label = group.slot?.label ?? UNSLOTTED_LABEL
  const time = group.slot ? formatSlotTime(group.slot.start_time) : null

  return (
    <div>
      {/* Same header language as the dashboard's slot groups — one visual
          vocabulary for "morning", wherever it appears. */}
      <h2 className="mb-1.5 flex items-baseline gap-2 px-2">
        <span className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
          {label}
        </span>
        {time && <span className="text-muted-foreground/50 text-xs">&middot; {time}</span>}
      </h2>
      <ul className="space-y-0.5">
        {group.reminders.map((reminder) => (
          <ReminderRow
            key={reminder.id}
            reminder={reminder}
            completing={completingIds.has(reminder.id)}
            onComplete={onComplete}
          />
        ))}
      </ul>
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
  const hasNotes = !!reminder.notes?.trim()

  return (
    <li
      data-reminder-id={reminder.id}
      className={cn(
        'transition-all duration-200 ease-out',
        completing && 'pointer-events-none translate-x-2 opacity-0',
      )}
    >
      <div className="group hover:bg-muted/40 flex items-center gap-3 rounded-xl px-2 py-2.5 transition-colors">
        <button
          type="button"
          onClick={() => onComplete(reminder)}
          aria-label={`Mark "${reminder.title}" as considered`}
          title="Considered"
          className="border-muted-foreground/30 hover:border-foreground/60 hover:bg-foreground/5 flex size-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors"
        >
          <Check
            className="group-hover:text-foreground/50 size-3.5 text-transparent transition-colors"
            strokeWidth={3}
          />
        </button>
        {/* The notes marker sits inline after the title rather than pinned to
            the right edge: on a wide screen a lone icon across the row reads as
            an unrelated control, and this one is only ever a footnote. */}
        <p className="min-w-0 flex-1">
          <Link
            href={`/tasks/${reminder.id}`}
            className={cn(
              'text-[15px] leading-snug hover:underline',
              prominenceClasses(reminder.priority),
            )}
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
    <div className="space-y-7" aria-hidden="true">
      {[0, 1].map((group) => (
        <div key={group}>
          <div className="bg-muted/70 mb-3 ml-2 h-3 w-28 rounded" />
          <div className="space-y-2.5">
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex items-center gap-3 px-2">
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
