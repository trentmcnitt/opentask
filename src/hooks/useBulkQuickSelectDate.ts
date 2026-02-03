import { useState, useCallback, useEffect, useMemo } from 'react'
import { DateTime } from 'luxon'
import {
  formatQuickSelectHeader,
  formatRelativeTime,
  formatDeltaText,
  snapToNextPreset,
} from '@/lib/quick-select-dates'
import type { Task } from '@/types'

interface UseBulkQuickSelectDateOptions {
  tasks: Task[]
  timezone: string
}

type OperationType = 'preset' | 'delta' | null

type OperationResult =
  | { type: 'absolute'; until: string }
  | { type: 'relative'; deltaMinutes: number }

interface UseBulkQuickSelectDateResult {
  /** Formatted header text: "Today, Feb 3, 10:00 AM" or "Today, —" or "—" */
  headerText: string
  /** Formatted relative text: "in 2h" or "Earliest: in 1h" or "+1h 30m from each" */
  relativeText: string
  /** Whether any task's due date is in the past */
  isPast: boolean
  /** Whether user has made changes */
  isDirty: boolean
  /** Whether tasks have different due dates */
  hasMixedDates: boolean
  /** Current operation type */
  operationType: OperationType
  /** Accumulated delta minutes (for delta mode) */
  deltaMinutes: number
  /** Target time (for preset mode) */
  presetTime: string | null
  /** Apply a preset time (absolute mode) */
  applyPreset: (hour: number, minute: number) => void
  /** Apply an increment (delta mode) */
  applyIncrement: (increment: { minutes: number | null; days?: number }) => void
  /** Reset to initial state */
  reset: () => void
  /** Get the result for API call */
  getResult: () => OperationResult | null
}

/**
 * Get the day label for a date: "Today", "Tomorrow", "Yesterday", or short weekday
 */
function getDayLabel(dt: DateTime, timezone: string): string {
  const now = DateTime.now().setZone(timezone)
  const target = dt.setZone(timezone)

  if (target.hasSame(now, 'day')) return 'Today'
  if (target.hasSame(now.plus({ days: 1 }), 'day')) return 'Tomorrow'
  if (target.hasSame(now.minus({ days: 1 }), 'day')) return 'Yesterday'

  return target.toFormat('EEE') // Mon, Tue, etc.
}

/**
 * Analyze tasks' due dates and compute static display information.
 * Note: relativeText and isPast are computed fresh in the hook body (outside useMemo)
 * so they can be recalculated when tick changes for auto-refresh.
 */
function computeInitialDisplay(
  tasks: Task[],
  timezone: string,
): {
  headerText: string
  hasMixedDates: boolean
  earliestDueAt: string | null
  /** All dates identical? Used for display logic. */
  allSame: boolean
} {
  const dueDates = tasks.map((t) => t.due_at).filter((d): d is string => d !== null)

  if (dueDates.length === 0) {
    return {
      headerText: 'No due date',
      hasMixedDates: false,
      earliestDueAt: null,
      allSame: true,
    }
  }

  const unique = new Set(dueDates)

  // All dates are identical
  if (unique.size === 1) {
    const dueAt = dueDates[0]
    return {
      headerText: formatQuickSelectHeader(dueAt, timezone),
      hasMixedDates: false,
      earliestDueAt: dueAt,
      allSame: true,
    }
  }

  // Mixed dates - check what parts match
  const dateTimes = dueDates.map((d) => DateTime.fromISO(d, { zone: timezone }))
  const sortedDueDates = [...dueDates].sort()
  const earliest = sortedDueDates[0]
  const earliestDt = DateTime.fromISO(earliest, { zone: timezone })

  // Check if all are on the same calendar day
  const allSameDay = dateTimes.every((dt) => dt.hasSame(dateTimes[0], 'day'))

  if (allSameDay) {
    // Same day, different times: "Today, —" or "Tomorrow, —"
    const dayLabel = getDayLabel(earliestDt, timezone)
    const datePart = earliestDt.toFormat('LLL d') // "Feb 3"
    return {
      headerText: `${dayLabel}, ${datePart}, —`,
      hasMixedDates: true,
      earliestDueAt: earliest,
      allSame: false,
    }
  }

  // Completely different days
  return {
    headerText: '—',
    hasMixedDates: true,
    earliestDueAt: earliest,
    allSame: false,
  }
}

export function useBulkQuickSelectDate({
  tasks,
  timezone,
}: UseBulkQuickSelectDateOptions): UseBulkQuickSelectDateResult {
  const [tick, setTick] = useState(0)
  const [operationType, setOperationType] = useState<OperationType>(null)
  const [deltaMinutes, setDeltaMinutes] = useState(0)
  const [presetTime, setPresetTime] = useState<string | null>(null)

  // Compute initial display state from tasks
  const initialDisplay = useMemo(() => computeInitialDisplay(tasks, timezone), [tasks, timezone])

  // Auto-refresh relative time every 15 seconds
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 15000)
    return () => clearInterval(interval)
  }, [])

  // Reset when tasks change
  const [prevTaskIds, setPrevTaskIds] = useState(() => tasks.map((t) => t.id).join(','))
  const currentTaskIds = tasks.map((t) => t.id).join(',')
  if (currentTaskIds !== prevTaskIds) {
    setPrevTaskIds(currentTaskIds)
    setOperationType(null)
    setDeltaMinutes(0)
    setPresetTime(null)
  }

  const applyPreset = useCallback(
    (hour: number, minute: number) => {
      const target = snapToNextPreset(hour, minute, timezone)
      setOperationType('preset')
      setPresetTime(target)
      setDeltaMinutes(0)
    },
    [timezone],
  )

  const applyIncrement = useCallback((increment: { minutes: number | null; days?: number }) => {
    setOperationType('delta')
    setPresetTime(null)

    // Convert day-based increments to minutes for accumulation
    let minutesToAdd: number
    if (increment.minutes === null && increment.days) {
      minutesToAdd = increment.days * 24 * 60
    } else {
      minutesToAdd = increment.minutes ?? 0
    }

    setDeltaMinutes((prev) => prev + minutesToAdd)
  }, [])

  const reset = useCallback(() => {
    setOperationType(null)
    setDeltaMinutes(0)
    setPresetTime(null)
  }, [])

  const getResult = useCallback((): OperationResult | null => {
    if (operationType === 'preset' && presetTime) {
      return { type: 'absolute', until: presetTime }
    }
    if (operationType === 'delta' && deltaMinutes !== 0) {
      return { type: 'relative', deltaMinutes }
    }
    return null
  }, [operationType, presetTime, deltaMinutes])

  // Compute display values based on current state
  const isDirty = operationType !== null

  // Compute time-sensitive values fresh on each render (tick dependency ensures refresh)
  // This is intentionally outside useMemo so it updates when tick changes
  void tick // eslint sees tick as used for the auto-refresh interval
  const now = new Date()

  // Compute relativeText and isPast for initial display (reacts to tick)
  const computeInitialRelativeDisplay = (): { relativeText: string; isPast: boolean } => {
    const { earliestDueAt, allSame, hasMixedDates } = initialDisplay
    if (!earliestDueAt) {
      return { relativeText: '', isPast: false }
    }
    if (allSame) {
      return {
        relativeText: formatRelativeTime(earliestDueAt, now),
        isPast: new Date(earliestDueAt) < now,
      }
    }
    // Mixed dates - just show relative time of earliest, no "Earliest:" prefix
    const dueDates = tasks.map((t) => t.due_at).filter((d): d is string => d !== null)
    return {
      relativeText: formatRelativeTime(earliestDueAt, now),
      isPast: hasMixedDates && dueDates.some((d) => new Date(d) < now),
    }
  }

  let headerText: string
  let relativeText: string
  let isPast: boolean

  if (operationType === 'preset' && presetTime) {
    // Show the absolute target time
    headerText = formatQuickSelectHeader(presetTime, timezone)
    relativeText = formatRelativeTime(presetTime, now)
    isPast = new Date(presetTime) < now
  } else if (operationType === 'delta' && deltaMinutes !== 0) {
    // Delta mode: show actual new time if all tasks share the same due date,
    // otherwise show "+Xh from each" for mixed dates
    const { allSame, earliestDueAt } = initialDisplay

    if (allSame && earliestDueAt) {
      // Single task or all tasks have same due date: show the computed new time
      const newTime = new Date(new Date(earliestDueAt).getTime() + deltaMinutes * 60 * 1000)
      const newTimeIso = newTime.toISOString()
      headerText = formatQuickSelectHeader(newTimeIso, timezone)
      // Combined: "in 2h (snoozing +1h)" or "1h ago (snoozing +1h)"
      const relativeFromNow = formatRelativeTime(newTimeIso, now)
      const deltaStr = formatDeltaText(deltaMinutes)
      relativeText = `${relativeFromNow} (snoozing ${deltaStr})`
      isPast = newTime < now
    } else {
      // Mixed dates: show original header with "+Xh from each"
      headerText = initialDisplay.headerText
      relativeText = `${formatDeltaText(deltaMinutes)} from each`
      isPast = false
    }
  } else {
    // Initial state - show actual task dates (computed fresh for tick updates)
    headerText = initialDisplay.headerText
    const initialRelative = computeInitialRelativeDisplay()
    relativeText = initialRelative.relativeText
    isPast = initialRelative.isPast
  }

  return {
    headerText,
    relativeText,
    isPast,
    isDirty,
    hasMixedDates: initialDisplay.hasMixedDates,
    operationType,
    deltaMinutes,
    presetTime,
    applyPreset,
    applyIncrement,
    reset,
    getResult,
  }
}
