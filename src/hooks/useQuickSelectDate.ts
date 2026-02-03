import { useState, useCallback, useEffect } from 'react'
import {
  initWorkingDate,
  adjustDate,
  snapToNextPreset,
  formatQuickSelectHeader,
  formatRelativeTime,
} from '@/lib/quick-select-dates'

interface UseQuickSelectDateOptions {
  dueAt: string | null
  timezone: string
}

interface UseQuickSelectDateResult {
  /** Current working date (UTC ISO string) */
  workingDate: string
  /** Whether the working date has changed from the initial value */
  isDirty: boolean
  /** Formatted header text: "Mon, Feb 2 at 6:50 PM" */
  headerText: string
  /** Formatted relative text: "in 26 mins" or "3h ago" */
  relativeText: string
  /** Whether the working date is in the past */
  isPast: boolean
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

  // Reset when the task's due_at changes externally
  if (dueAt !== prevDueAt) {
    setPrevDueAt(dueAt)
    const newInitial = initWorkingDate(dueAt)
    setInitialDate(newInitial)
    setWorkingDate(newInitial)
  }

  // Auto-refresh relative time every 15 seconds
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 15000)
    return () => clearInterval(interval)
  }, [])

  const applyPreset = useCallback(
    (hour: number, minute: number) => {
      setWorkingDate(snapToNextPreset(hour, minute, timezone))
    },
    [timezone],
  )

  const applyIncrement = useCallback(
    (increment: { minutes: number | null; days?: number }) => {
      setWorkingDate((prev) => adjustDate(prev, increment, timezone))
    },
    [timezone],
  )

  const reset = useCallback(() => {
    setWorkingDate(initialDate)
  }, [initialDate])

  const isDirty = workingDate !== initialDate

  // Force recalculation on tick changes
  void tick

  const now = new Date()
  const headerText = formatQuickSelectHeader(workingDate, timezone)
  const relativeText = formatRelativeTime(workingDate, now)
  const isPast = new Date(workingDate) < now

  return {
    workingDate,
    isDirty,
    headerText,
    relativeText,
    isPast,
    applyPreset,
    applyIncrement,
    reset,
    setWorkingDate,
  }
}
