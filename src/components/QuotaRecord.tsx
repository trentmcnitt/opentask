'use client'

import { useEffect, useState } from 'react'
import { useTimezone } from '@/hooks/useTimezone'
import { formatLastLogged, openTaskDateLabel } from '@/lib/format-date'
import { cn } from '@/lib/utils'
import type { TrackState } from '@/lib/track'
import type { QuotaStats } from '@/core/tasks/quotas'
import type { Task } from '@/types'
import { useDayStart } from '@/components/PreferencesProvider'

/**
 * The quota's record — in a chip's bubble (`TrackChipPopover`) since the Quotas
 * page's Details list went (Trent, 2026-10-16: "that Details view is
 * pointless"), and at the TOP of the quota editor (`QuotaDetail`, one quota)
 * since the same day, so it is found without knowing the bubble has it. That
 * list's one real content was "met 2×" / "never met"; this answers the same
 * question a little more fully — met, missed, the streak, the last tap — from
 * `GET /api/tasks/:id/quota-stats`, fetched as it mounts (only while the
 * bubble or the editor is open). Not on the
 * task payload: nothing else wants these numbers, and that payload is the
 * native apps' contract.
 *
 * Met and missed are CLOSED periods only, so together they are the periods it
 * has been tracked for. The streak also counts the period in progress once it
 * is met — a run being kept alive right now should not read one short until
 * the period closes — but an open period that is not met yet never breaks it.
 *
 * "Tracking since" is the day it was made (`created_at`), not the first
 * recorded period: a quota's first period is anchored, not recorded
 * (`period-rollover.ts`), so the two can be a period apart.
 */
export function QuotaRecord({
  task,
  state,
  className,
}: {
  task: Task
  state: TrackState
  /** The bubble draws a rule above it; the editor does not. */
  className?: string
}) {
  const stats = useQuotaStats(task.id)
  const timezone = useTimezone()
  const dayStart = useDayStart()
  const loading = stats === undefined
  const streak = stats ? stats.current_streak + (state.met ? 1 : 0) : null
  const longest = stats && streak !== null ? Math.max(stats.longest_streak, streak) : null
  // `…` while the fetch is out, `—` if it failed: the bubble opens either way.
  const show = (n: number | null, render: (n: number) => string) =>
    loading ? '…' : n === null ? '—' : render(n)

  return (
    <dl
      className={cn('grid grid-cols-2 gap-x-3 gap-y-2 text-xs', className)}
      data-quota-record={loading ? 'loading' : 'ready'}
    >
      <div>
        <dt className="text-muted-foreground">Periods met</dt>
        {/* "Never yet" is a real answer and usually the useful one. */}
        <dd className="tabular-nums" data-quota-met>
          {show(stats?.periods_met ?? null, (n) => (n > 0 ? `${n}×` : 'Never yet'))}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Missed</dt>
        <dd className="tabular-nums" data-quota-missed>
          {show(stats?.periods_missed ?? null, (n) => (n > 0 ? `${n}×` : 'Never'))}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Streak</dt>
        <dd className="tabular-nums" data-quota-streak>
          {/* "None yet" only when there has never been a run; after one, a
              broken streak still says what the best was. */}
          {show(streak, (n) =>
            longest !== null && longest > n
              ? `${n} in a row · best ${longest}`
              : n > 0
                ? `${n} in a row`
                : 'None yet',
          )}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">Tracking since</dt>
        <dd>{openTaskDateLabel(task.created_at, timezone, dayStart, { year: true })}</dd>
      </div>
      {/* When the last tap that still stands was logged (2026-10-16) — the
          server's `last_logged_at`, which skips a tap that was undone or
          subtracted. Nothing at all when nothing stands: no "Never". */}
      {stats?.last_logged_at && (
        <p className="text-muted-foreground col-span-2" data-quota-last>
          Last: {formatLastLogged(stats.last_logged_at, timezone, dayStart)}
        </p>
      )}
    </dl>
  )
}

/**
 * `GET /api/tasks/:id/quota-stats`: `undefined` while loading, `null` if it
 * failed (the bubble says "—" rather than show a wrong number).
 */
function useQuotaStats(taskId: number): QuotaStats | null | undefined {
  const [stats, setStats] = useState<{ id: number; data: QuotaStats | null } | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch(`/api/tasks/${taskId}/quota-stats`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!cancelled) setStats({ id: taskId, data: (json?.data as QuotaStats) ?? null })
      })
      .catch(() => {
        if (!cancelled) setStats({ id: taskId, data: null })
      })
    return () => {
      cancelled = true
    }
  }, [taskId])
  return stats?.id === taskId ? stats.data : undefined
}
