'use client'

import { useState } from 'react'
import { JustAddedCard } from '@/components/JustAddedCard'
import { useJustAddedClock } from '@/hooks/useJustAddedClock'
import { useTimeSlots } from '@/hooks/useTimeSlots'
import { useTimezone } from '@/hooks/useTimezone'
import { justAddedEntryKey, selectJustAddedEntries } from '@/lib/just-added'
import type { Project, Task } from '@/types'

/**
 * THE JUST NOW CARD ON THE REMINDERS AND QUOTAS TABS (Trent, 2026-11-12:
 * "When you're on Reminders and you add a task, you get no indication that
 * the reminder you've entered is being enriched… you need to see the
 * enrichment progress the same way on the Reminders tab. Likewise for the
 * Quotas tab").
 *
 * The dashboard's own card (`JustAddedCard`, `src/lib/just-added.ts`), under
 * the tab's add control: the new item at once, "AI is filling in details…"
 * while enrichment runs, then where it landed ("Evening · Daily", "2 a week ·
 * Evening"); the same 15 minutes, the same Clear, a tap opens its details.
 *
 * Why the row's own pulse was not enough: a just-added reminder lands in the
 * DEFAULT period, which is rarely the one on screen — often a later period
 * further down the page, or "Not today" behind its fold — and the pulse is a
 * 1px border colour with no words. The card answers "did it land, and what
 * did the AI make of it?" without scrolling, as it does on the dashboard.
 *
 * WHAT IT LISTS: this tab's kind only — reminders on Reminders, quotas on
 * Quotas — added from anywhere (this tab, the API, a Shortcut). A task added
 * meanwhile is the dashboard card's; it has no row on these tabs. `tasks` is
 * what the surface already holds, so the card costs no request.
 *
 * Hidden while searching, like the dashboard's (the results are the question
 * then). "Clear" is this visit's, as on the dashboard.
 */
const NO_PROJECTS: Project[] = []

/**
 * RULE JN-TABS: The Reminders and Quotas tabs show the same Just now card under
 *   their add control, listing that tab's kind only, added from anywhere. A task
 *   added meanwhile is the dashboard card's.
 * Why: A just-added reminder lands in the default period, rarely the one on screen, and its
 *   row's pulse has no words.
 * Ruling: Trent 2026-11-12: "if you add a reminder, you need to see the enrichment
 *   progress the same way on the Reminders tab. Likewise for the Quotes tab."
 */
export function SurfaceJustAdded({
  tasks,
  searching,
}: {
  /** Every item of this tab's kind the surface holds (any order). */
  tasks: Task[]
  searching: boolean
}) {
  const now = useJustAddedClock(tasks)
  const timezone = useTimezone()
  const { timeSlots } = useTimeSlots(undefined, { revalidate: false })
  const [cleared, setCleared] = useState<Set<string>>(new Set())
  if (searching) return null
  const entries = selectJustAddedEntries(tasks, now).filter(
    (e) => !cleared.has(justAddedEntryKey(e)),
  )
  return (
    <JustAddedCard
      entries={entries}
      projects={NO_PROJECTS}
      now={now}
      timezone={timezone}
      timeSlots={timeSlots}
      // Never called: a reminder or quota entry opens its details itself.
      onShow={() => {}}
      onClear={() => setCleared((prev) => new Set([...prev, ...entries.map(justAddedEntryKey)]))}
    />
  )
}
