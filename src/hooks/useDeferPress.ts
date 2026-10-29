'use client'

import { useCallback, useState } from 'react'
import {
  useDayStart,
  useDayStartKnown,
  useSnoozePreferences,
} from '@/components/PreferencesProvider'
import { useSimpleLongPress } from '@/hooks/useLongPress'
import { useTimezone } from '@/hooks/useTimezone'
import { computeSnoozeTime, snoozeOptionNeedsDay } from '@/lib/snooze'
import type { TimeSlot } from '@/lib/time-slot-assign'

/**
 * A row's DEFER BUTTON press (the card row's clock, the lean row's clock on a
 * targeted task): a tap defers an overdue task by the default option; a tap
 * on a task not yet due opens the menu instead (an instant defer would pull
 * a future target back to now + offset); a hold (400ms) opens the menu.
 * `useSimpleLongPress` — the snooze-all trigger's hook — counts only the
 * primary button, so a right-click never defers. Its `onClick` is the
 * keyboard path (Enter/Space) and swallows the click a pointer press already
 * handled.
 *
 * The caller wires `press` into the button and `menuOpen` into its
 * `SnoozeMenu`, and stops propagation on every handler: the press must not
 * reach the row, whose own pointer handlers select, open and long-press.
 */
export function useDeferPress({
  taskId,
  isOverdue,
  onSnooze,
  timeSlots,
}: {
  taskId: number
  isOverdue?: boolean
  onSnooze: (taskId: number, until: string) => void
  timeSlots: TimeSlot[]
}) {
  const timezone = useTimezone()
  const dayStart = useDayStart()
  const dayKnown = useDayStartKnown()
  const { defaultSnoozeOption, morningTime } = useSnoozePreferences()
  const [menuOpen, setMenuOpen] = useState(false)
  const openMenu = useCallback(() => setMenuOpen(true), [])
  const deferNow = useCallback(() => {
    // Not due yet — or a day-dependent default ("tomorrow") before the
    // browser knows the user's day start: the menu, not a guess.
    if (!isOverdue || (!dayKnown && snoozeOptionNeedsDay(defaultSnoozeOption))) {
      setMenuOpen(true)
      return
    }
    onSnooze(
      taskId,
      computeSnoozeTime(defaultSnoozeOption, timezone, morningTime, dayStart, timeSlots),
    )
  }, [
    taskId,
    defaultSnoozeOption,
    timezone,
    morningTime,
    dayStart,
    dayKnown,
    timeSlots,
    onSnooze,
    isOverdue,
  ])
  const press = useSimpleLongPress({ onLongPress: openMenu, onShortPress: deferNow })
  return { menuOpen, setMenuOpen, press }
}
