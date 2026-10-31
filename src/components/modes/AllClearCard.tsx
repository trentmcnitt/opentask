'use client'

/**
 * TODAY'S ALL-CLEAR CARD (Trent, 2026-10-30, E2 of `.tmp/all-done/`: "there's
 * no inbox zero satisfaction. Everything about the tasks goes away, and
 * completing all your tasks for today should be rewarding"). With Late and
 * Today both empty, Today shows this in their place, and On deck carries on
 * below it unchanged:
 *
 * - a check in a green ring, "All clear for today";
 * - what happened today, over the tasks that were in Late or Today this
 *   OpenTask day — "4 done · 2 moved to tomorrow" (`GET /api/tasks/today-
 *   summary`), a zero part left out, no line on a day with nothing handled;
 * - a divider, then "Next: Morning, 8:30 AM · 2 targets" — or tomorrow's
 *   decks, or nothing (`allClearNext`).
 *
 * Restrained: no confetti, only the page's usual fade in. Scan and All never
 * show it.
 *
 * WHAT WAS DONE (Trent, 11:18 PM: "Is there any way to see what items were
 * completed for that day?"): the counts line opens, inside the card, today's
 * handled tasks, faded (E1-open's list) — done: a green check, struck
 * through, "Done 4:12 PM"; moved: an arrow and where it went, "Moved to
 * tomorrow 6:30 AM" (a queue-marked defer has no time of its own: "Moved to
 * tomorrow's queue"). The same rows the counts are (`today-summary`).
 *
 * WITH ON DECK STILL TO GO (A1, Trent 2026-10-31, `.tmp/left-side-2/`): the
 * card shows only when Late, Today AND On deck are all empty. With decks left,
 * a slim line takes its place instead — "✓ Targets done · 16 on deck"
 * (`TargetsDoneLine`) — and tapping it opens the same list of what was done or
 * moved today.
 */
import { useEffect, useState } from 'react'
import { ArrowRight, Check, ChevronDown } from 'lucide-react'
import { DateTime } from 'luxon'
import { cn } from '@/lib/utils'
import { useDayStart } from '@/components/PreferencesProvider'
import { allClearCounts, allClearNext } from '@/lib/modes/all-clear'
import type { TimeSlot } from '@/lib/time-slot-assign'
import type { Task } from '@/types'

export function AllClearCard({
  tasks,
  timeSlots,
  timezone,
  now,
}: {
  /** Every task (not narrowed by chips or search): what comes next is the day's, not the view's. */
  tasks: Task[]
  timeSlots: TimeSlot[]
  timezone: string
  now: Date
}) {
  const dayStart = useDayStart()
  const summary = useTodaySummary(tasks)
  const [open, setOpen] = useState(false)
  const counts = summary ? allClearCounts(summary) : null
  const next = allClearNext(tasks, timeSlots, { now, timezone, dayStart })
  return (
    <section
      aria-label="All clear for today"
      data-all-clear
      className="bg-muted/30 animate-in fade-in-0 mb-6 flex flex-col items-center rounded-2xl px-4 pt-6 pb-4 text-center duration-300"
    >
      <span className="flex size-12 items-center justify-center rounded-full border-2 border-green-600 text-green-600 dark:border-green-400 dark:text-green-400">
        <Check className="size-6" aria-hidden />
      </span>
      <h2 className="mt-3 text-lg font-semibold">All clear for today</h2>
      {counts && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          data-all-clear-counts
          className="text-muted-foreground hover:text-foreground mt-0.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-sm transition-colors"
        >
          {counts}
          <ChevronDown
            className={cn('size-3.5 transition-transform', open && 'rotate-180')}
            aria-hidden
          />
        </button>
      )}
      {open && summary && (
        <HandledList summary={summary} timezone={timezone} className="mt-3 w-full" />
      )}
      {next && (
        <p
          data-all-clear-next
          className="border-border/60 text-muted-foreground mt-4 w-full border-t pt-3 text-sm"
        >
          Next: <span className="text-foreground">{next}</span>
        </p>
      )}
    </section>
  )
}

/**
 * THE SLIM LINE (A1, 2026-10-31): Late and Today are empty but On deck is
 * not — "✓ Targets done · 16 on deck" where the card would be. When today
 * handled anything, the line is a button that opens the card's list
 * (`HandledList`); otherwise it is just the line.
 */
export function TargetsDoneLine({
  tasks,
  onDeck,
  timezone,
}: {
  /** Every task: the summary is re-read when they change. */
  tasks: Task[]
  /** How many are on deck (the section's count). */
  onDeck: number
  timezone: string
}) {
  const summary = useTodaySummary(tasks)
  const [open, setOpen] = useState(false)
  const handled = !!summary && summary.items.length > 0
  const words = (
    <>
      <Check className="size-4 shrink-0 text-green-600 dark:text-green-400" aria-hidden />
      <span className="text-foreground font-medium">Targets done</span>
      <span className="text-muted-foreground">· {onDeck} on deck</span>
    </>
  )
  return (
    <div data-targets-done className="animate-in fade-in-0 mb-3 duration-300">
      {handled ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          data-targets-done-toggle
          className="hover:bg-foreground/5 -mx-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm transition-colors"
        >
          {words}
          <ChevronDown
            className={cn(
              'text-muted-foreground size-3.5 transition-transform',
              open && 'rotate-180',
            )}
            aria-hidden
          />
        </button>
      ) : (
        <p className="inline-flex items-center gap-1.5 py-1 text-sm">{words}</p>
      )}
      {open && summary && <HandledList summary={summary} timezone={timezone} className="mt-2" />}
    </div>
  )
}

/** Today's handled tasks (`GET /api/tasks/today-summary`), re-read when the tasks change. */
function useTodaySummary(tasks: Task[]): TodaySummary | null {
  const [summary, setSummary] = useState<TodaySummary | null>(null)
  // Re-read when the tasks change: a put-back or an undo moves the counts.
  useEffect(() => {
    let live = true
    fetch('/api/tasks/today-summary')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (live && json?.data) setSummary(json.data)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [tasks])
  return summary
}

/** The list of what was done or moved today, faded (the card's and the line's). */
function HandledList({
  summary,
  timezone,
  className,
}: {
  summary: TodaySummary
  timezone: string
  className?: string
}) {
  return (
    <ul data-all-clear-items className={cn('space-y-2.5 text-left opacity-75', className)}>
      {summary.items.map((item) => (
        <HandledItem
          key={`${item.kind}:${item.task_id}:${item.happened_at}`}
          item={item}
          timezone={timezone}
        />
      ))}
    </ul>
  )
}

interface TodaySummaryItem {
  kind: 'done' | 'moved'
  task_id: number
  title: string
  happened_at: string
  due_at: string | null
  queued: boolean
}
interface TodaySummary {
  done: number
  moved: number
  items: TodaySummaryItem[]
}

/** One handled task in the opened list. */
function HandledItem({ item, timezone }: { item: TodaySummaryItem; timezone: string }) {
  const time = (iso: string) => DateTime.fromISO(iso).setZone(timezone).toFormat('h:mm a')
  const done = item.kind === 'done'
  const where = item.queued
    ? "Moved to tomorrow's queue"
    : `Moved to tomorrow${item.due_at ? ` ${time(item.due_at)}` : ''}`
  return (
    <li data-all-clear-item={item.kind} className="flex items-start gap-3">
      {done ? (
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-green-600 text-white dark:bg-green-500">
          <Check className="size-3" aria-hidden />
        </span>
      ) : (
        <span className="border-muted-foreground/60 text-muted-foreground mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border">
          <ArrowRight className="size-3" aria-hidden />
        </span>
      )}
      <span className="min-w-0">
        <span className={cn('block text-sm break-words', done && 'line-through')}>
          {item.title}
        </span>
        <span className="text-muted-foreground block text-xs">
          {done ? `Done ${time(item.happened_at)}` : where}
        </span>
      </span>
    </li>
  )
}
