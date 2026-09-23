'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { getTimezoneDayBoundaries } from '@/lib/format-date'
import { isTracked } from '@/lib/track'

interface CompletionEntry {
  task_id: number
  project_id: number
  is_reminder: boolean
  is_tracked: boolean
  progress_target: number
}

/**
 * Today's real completions — the numerator for the dashboard's completion
 * fill (Today chip + project chips, REDESIGN-V03-adjacent, Trent 2026-09-23:
 * "I even thought about having the Today chip fill up or each of the
 * projects fill up... depending on if all the things for the day are done").
 *
 * "Today" is the user's LOCAL day, not a UTC calendar date — `/api/completions`
 * also supports `?date=YYYY-MM-DD`, but that matches the UTC date the row was
 * stored under and can misclassify completions near local midnight. This asks
 * for the exact instant range instead (`getTimezoneDayBoundaries`), which is
 * how due-date bucketing (`classifyTaskDueDate`) already draws "today" for
 * the chips this fill sits behind — the numerator and denominator must agree
 * on what day boundary they're using, or the fill can show >100% or "finished"
 * with tasks still open.
 *
 * "Done today" is read literally: every completion whose `completed_at` falls
 * in today's window counts, regardless of what the task was originally due
 * (a task due next week that gets finished early still counts as something
 * done today). It does NOT count reminders or quotas — considering a
 * reminder or logging a quota +1 writes an ordinary `completions` row through
 * the same `markDone` path, and Trent's ~dozen daily reminder considerations
 * would otherwise make the Today chip read "finished" by breakfast. Those are
 * filtered out here using the `is_reminder`/`is_tracked`/`progress_target`
 * fields `/api/completions` now returns alongside each row (see that route's
 * doc comment).
 */
export function useTodayCompletions(timezone: string | undefined) {
  const [completions, setCompletions] = useState<CompletionEntry[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!timezone) return
    const { todayStart, tomorrowStart } = getTimezoneDayBoundaries(timezone)
    try {
      const res = await fetch(
        `/api/completions?since=${todayStart.toISOString()}&until=${tomorrowStart.toISOString()}`,
      )
      if (!res.ok) return
      const data = await res.json()
      const rows = (data.data?.completions ?? []) as CompletionEntry[]
      setCompletions(
        rows.filter(
          (c) =>
            !c.is_reminder &&
            !isTracked({ progress_target: c.progress_target, is_tracked: c.is_tracked }),
        ),
      )
    } catch {
      // Silent fail — the fill simply doesn't move until the next refresh.
    } finally {
      setLoading(false)
    }
  }, [timezone])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const doneTodayTotal = completions.length

  const doneTodayByProject = useMemo(() => {
    const counts = new Map<number, number>()
    for (const c of completions) {
      counts.set(c.project_id, (counts.get(c.project_id) ?? 0) + 1)
    }
    return counts
  }, [completions])

  return { doneTodayTotal, doneTodayByProject, loading, refresh }
}
