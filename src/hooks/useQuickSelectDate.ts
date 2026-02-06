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
  /** Delta display string (e.g., "+30 min", "-1 hr") computed from initialDate vs workingDate, null when not dirty */
  deltaDisplay: string | null
  /** Snap to a preset time (next occurrence from now) */
  applyPreset: (hour: number, minute: number) => void
  /** Apply a minute-based or day-based increment */
  applyIncrement: (increment: { minutes: number | null; days?: number }) => void
  /** Set an absolute target time directly (for smart buttons like "Now", "Next Hour") */
  setAbsoluteTarget: (isoUtc: string) => void
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

  const setAbsoluteTarget = useCallback((isoUtc: string) => {
    setWorkingDate(isoUtc)
  }, [])

  const reset = useCallback(() => {
    setWorkingDate(initialDate)
  }, [initialDate])

  const isDirty = workingDate !== initialDate

  // Force recalculation on tick changes
  void tick

  const now = new Date()
  const headerText = formatQuickSelectHeader(workingDate, timezone)
  const isPast = new Date(workingDate) < now

  const relativeText = formatRelativeTime(workingDate, now)

  // Compute delta from actual difference between initialDate and workingDate.
  // This works for all change types (preset, relative, smart buttons) and
  // accumulates correctly from the original date, not from each button press.
  let deltaDisplay: string | null = null
  if (isDirty) {
    const diffMs = new Date(workingDate).getTime() - new Date(initialDate).getTime()
    const diffMinutes = Math.round(diffMs / 60000)
    if (diffMinutes !== 0) {
      deltaDisplay = formatDeltaText(diffMinutes)
    }
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
    setAbsoluteTarget,
    reset,
    setWorkingDate,
  }
}
