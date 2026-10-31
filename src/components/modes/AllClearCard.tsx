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
 */
import { useEffect, useState } from 'react'
import { Check } from 'lucide-react'
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
  const [summary, setSummary] = useState<{ done: number; moved: number } | null>(null)
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
        <p data-all-clear-counts className="text-muted-foreground mt-0.5 text-sm">
          {counts}
        </p>
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
