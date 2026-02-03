import { useState, useCallback, useEffect } from 'react'
import {
  initWorkingDate,
  adjustDate,
  snapToNextPreset,
  formatQuickSelectHeader,
  formatRelativeTime,
  formatDeltaText,
} from '@/lib/quick-select-dates'

interface UseQuickSelectDateOptions {
  dueAt: string | null
  timezone: string
}

type OperationType = 'preset' | 'delta' | null

interface UseQuickSelectDateResult {
  /** Current working date (UTC ISO string) */
  workingDate: string
  /** Whether the working date has changed from the initial value */
  isDirty: boolean
  /** Formatted header text: "Mon, Feb 2 at 6:50 PM" */
  headerText: string
  /** Formatted relative text: "in 26 mins" or "3h ago" or "in 2h (snoozing +1h)" */
  relativeText: string
  /** Whether the working date is in the past */
  isPast: boolean
  /** Delta display string (e.g., "+30 min", "-1 hr") when in delta mode, null otherwise */
  deltaDisplay: string | null
  /** Snap to a preset time (next occurrence from now) */
  applyPreset: (hour: number, minute: number) => void
  /** Apply a minute-based or day-based increment */
  applyIncrement: (increment: { minutes: number | null; days?: number }) => void
  /** Reset working date to initial value */
  reset: () => void
  /** Set working date directly */
  setWorkingDate: (iso: string) => void
}

export function useQuickSelectDate({
  dueAt,
  timezone,
}: UseQuickSelectDateOptions): UseQuickSelectDateResult {
  const [initialDate, setInitialDate] = useState(() => initWorkingDate(dueAt))
  const [workingDate, setWorkingDate] = useState(() => initWorkingDate(dueAt))
  const [tick, setTick] = useState(0)
  const [prevDueAt, setPrevDueAt] = useState(dueAt)
  const [operationType, setOperationType] = useState<OperationType>(null)
  const [deltaMinutes, setDeltaMinutes] = useState(0)

  // Reset when the task's due_at changes externally
  if (dueAt !== prevDueAt) {
    setPrevDueAt(dueAt)
    const newInitial = initWorkingDate(dueAt)
    setInitialDate(newInitial)
    setWorkingDate(newInitial)
    setOperationType(null)
    setDeltaMinutes(0)
  }

  // Auto-refresh relative time every 15 seconds
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 15000)
    return () => clearInterval(interval)
  }, [])

  const applyPreset = useCallback(
    (hour: number, minute: number) => {
      setWorkingDate(snapToNextPreset(hour, minute, timezone))
      setOperationType('preset')
      setDeltaMinutes(0)
    },
    [timezone],
  )

  const applyIncrement = useCallback(
    (increment: { minutes: number | null; days?: number }) => {
      setWorkingDate((prev) => adjustDate(prev, increment, timezone))
      setOperationType('delta')

      // Convert day-based increments to minutes for accumulation
      let minutesToAdd: number
      if (increment.minutes === null && increment.days) {
        minutesToAdd = increment.days * 24 * 60
      } else {
        minutesToAdd = increment.minutes ?? 0
      }

      setDeltaMinutes((prev) => prev + minutesToAdd)
    },
    [timezone],
  )

  const reset = useCallback(() => {
    setWorkingDate(initialDate)
    setOperationType(null)
    setDeltaMinutes(0)
  }, [initialDate])

  const isDirty = workingDate !== initialDate

  // Force recalculation on tick changes
  void tick

  const now = new Date()
  const headerText = formatQuickSelectHeader(workingDate, timezone)
  const isPast = new Date(workingDate) < now

  // Compute relativeText based on operation type
  let relativeText: string
  let deltaDisplay: string | null = null
  if (operationType === 'delta' && deltaMinutes !== 0) {
    // Delta mode: show "in 2h (snoozing +1h)" like bulk mode
    const relativeFromNow = formatRelativeTime(workingDate, now)
    const deltaStr = formatDeltaText(deltaMinutes)
    relativeText = `${relativeFromNow} (snoozing ${deltaStr})`
    deltaDisplay = deltaStr
  } else {
    relativeText = formatRelativeTime(workingDate, now)
  }

  return {
    workingDate,
    isDirty,
    headerText,
    relativeText,
    isPast,
    deltaDisplay,
    applyPreset,
    applyIncrement,
    reset,
    setWorkingDate,
  }
}
