'use client'

import { SunSolid } from '@/components/icons/SunSolid'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { DateTimePicker } from '@/components/DateTimePicker'
import { SnoozeMenu } from '@/components/SnoozeMenu'
import { computeSnoozeTime } from '@/lib/snooze'
import { useSimpleLongPress } from '@/hooks/useLongPress'
import { useSnoozePreferences } from '@/components/PreferencesProvider'
import { deadlineDayPick } from '@/lib/editor-target-labels'
import type { Task } from '@/types'

/**
 * The TARGET MENU (2026-10-14): the bulk snooze's own list (`SnoozeMenu`:
 * next period, 1 and 2 hours, the other periods, tomorrow morning, the
 * deadline's day) titled "Target", whose Custom... opens the date-time picker
 * ("Set target", with the deadline's day as a quick pick, ruling Q8). Shared by
 * the Today button's hold (segment rows and dashboard rows) and the dashboard
 * row's "Move…" on its target time, so every way of picking a target time
 * looks and behaves the same. `onPick` gets the UTC ISO moment chosen.
 *
 * `current` is the task's target, if any: the picker opens on it (Move…). With
 * none it opens on tomorrow at the user's morning time.
 *
 * `children` is the anchor (the desktop dropdown and the picker's popover
 * position against it); open state is the caller's.
 */
export function TargetMenu({
  task,
  timezone,
  open,
  onOpenChange,
  onPick,
  current = null,
  children,
}: {
  task: Pick<Task, 'deadline_at'>
  timezone: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (at: string) => void
  current?: string | null
  children: React.ReactNode
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [anchor, setAnchor] = useState<string | null>(null)
  const { morningTime } = useSnoozePreferences()
  // "Deadline day" (ruling Q8), read as the picker opens.
  const [deadlineDay, setDeadlineDay] = useState<{ label: string; at: string } | null>(null)
  const openPicker = () => {
    setAnchor(computeSnoozeTime('tomorrow', timezone, morningTime))
    setDeadlineDay(deadlineDayPick(task.deadline_at, { timezone, morningTime }))
    setPickerOpen(true)
  }
  return (
    <SnoozeMenu
      open={open}
      onOpenChange={onOpenChange}
      title="Target"
      deadlineAt={task.deadline_at}
      onSnooze={onPick}
      onCustom={openPicker}
    >
      <DateTimePicker
        value={current}
        emptyAnchor={anchor}
        timezone={timezone}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        allowClear={false}
        quickPick={deadlineDay}
        submitLabel="Set target"
        onChange={(at) => {
          if (at) onPick(at)
        }}
      >
        {children}
      </DateTimePicker>
    </SnoozeMenu>
  )
}

/**
 * "Today": a tap targets the task today at the time Snooze-all would go to
 * (`targetTodayTime`, server side). A HOLD (touch or mouse, the app's 400ms
 * long-press, `useSimpleLongPress`) or a RIGHT-CLICK opens the TARGET MENU
 * (`TargetMenu` above) instead (Trent, 2026-10-14: "I'd rather have a dropdown
 * that allowed me to target different periods, the same way the bulk snooze
 * does"). Every choice goes to `POST /api/task-segments/target-today` (with
 * `at` for a chosen time), so the stamp, the undo entry, the sync and the
 * toast all come from the one server path.
 *
 * Used by the task segment rows (`TaskSegmentRow`, icon + "Today" from `sm`)
 * and by the dashboard rows (`TaskRow`, icon only, on hover).
 *
 * The hold never also taps: once it fires, the pointerup and the click are
 * swallowed. A finger that moves (a scroll or a swipe of the panel pager)
 * abandons the press — neither fires. Right-click never taps (primary button
 * only). The affordance is in the words, not a glyph (Trent's rule): the
 * tooltip and the accessible name say "hold for a time".
 *
 * The menu and the picker are portalled, but React events still bubble
 * through the tree to the row, whose click considers (segments) or activates
 * (dashboard) the task, and whose Enter/Space too — so the wrapper stops
 * clicks and keys from them reaching it.
 *
 * Its pointerdown is NOT stopped: the dashboard row's swipe (use-gesture with
 * `filterTaps`) swallows any click whose pointerdown it never saw, which would
 * eat the tap; on the segment rows the panel pager's swipe may start here, and
 * a swipe's move abandons the hold. `data-no-row-press` tells the dashboard
 * row not to start its own long-press (selection) from it instead.
 */
export function TargetTodayButton({
  task,
  timezone,
  onTargetToday,
  onTargetAt,
  className,
  iconClassName,
  boxClassName,
  showLabel = false,
}: {
  task: Task
  timezone: string
  onTargetToday: (task: Task) => void
  onTargetAt: (task: Task, at: string) => void
  /** Layout and hit-target classes of the button. */
  className?: string
  iconClassName?: string
  /**
   * The HOVER BOX (segment rows): the hover background goes on an inner box
   * of these classes instead of the whole button, so a hit target taller
   * than its row (44px on a 33px panel row) keeps its size while the grey
   * block stays inside the row — the row buttons' 32px box (2026-10-20).
   */
  boxClassName?: string
  /** Show the word "Today" from `sm` up (segment rows); icon-only otherwise. */
  showLabel?: boolean
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const press = useSimpleLongPress({
    onLongPress: () => setMenuOpen(true),
    onShortPress: () => onTargetToday(task),
    // The tap can take the row off its list; acting on pointerup let the
    // click that follows land on the next row's Today (see `tapOn`).
    tapOn: 'click',
  })
  return (
    <span
      className="contents"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <TargetMenu
        task={task}
        timezone={timezone}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        onPick={(at) => onTargetAt(task, at)}
      >
        <button
          type="button"
          data-target-today
          data-no-row-press
          onClick={(e) => {
            e.stopPropagation()
            press.onClick()
          }}
          onPointerDown={press.onPointerDown}
          onPointerUp={press.onPointerUp}
          onPointerLeave={press.onPointerLeave}
          onPointerMove={press.onPointerMove}
          onPointerCancel={press.onPointerCancel}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setMenuOpen(true)
          }}
          title="Target today · hold for a time"
          aria-label={`Target "${task.title}" today (hold for a time)`}
          // No text selection or iOS callout under a held finger.
          className={cn(
            'text-muted-foreground hover:text-foreground flex shrink-0 touch-manipulation items-center justify-center gap-1 rounded-md text-xs font-medium select-none [-webkit-touch-callout:none]',
            boxClassName ? 'group/today' : 'hover:bg-foreground/5',
            className,
          )}
        >
          {boxClassName ? (
            <span
              data-target-today-box
              className={cn(
                'group-hover/today:bg-foreground/5 flex items-center justify-center gap-1 rounded-md transition-colors',
                boxClassName,
              )}
            >
              <TodayFace iconClassName={iconClassName} showLabel={showLabel} />
            </span>
          ) : (
            <TodayFace iconClassName={iconClassName} showLabel={showLabel} />
          )}
        </button>
      </TargetMenu>
    </span>
  )
}

/** Today's icon (`SunSolid`), and its word from `sm` up when `showLabel`. */
function TodayFace({ iconClassName, showLabel }: { iconClassName?: string; showLabel: boolean }) {
  return (
    <>
      {/* A sun with a solid core (Trent, 2026-10-20): "today", beside On deck. */}
      <SunSolid className={iconClassName} strokeWidth={1.75} />
      {showLabel ? (
        // Icon-only on a phone, so the title keeps the width.
        <span className="sr-only sm:not-sr-only">Today</span>
      ) : null}
    </>
  )
}
