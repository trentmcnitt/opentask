'use client'

import { Bookmark, CalendarDays, XCircle } from 'lucide-react'
import { DateTime } from 'luxon'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Calendar } from '@/components/ui/calendar'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { OptionMenu, type OptionMenuItem } from '@/components/OptionMenu'
import { useCheckInDay } from '@/components/PreferencesProvider'
import { useSimpleLongPress } from '@/hooks/useLongPress'
import { deckLatestDay, deckMenuDays, deckTapDay } from '@/lib/deck-menu'
import { DECK_DAY_FORMAT, calendarToday, deckIsToday } from '@/lib/task-segments'
import type { Task } from '@/types'

/**
 * ON DECK (D2, 2026-10-20; spec rules 7–8, docs/TASK-MODEL.md § On deck): a
 * target's DAY without its nag — "I'd like to get to this today; if it gets
 * done it gets done."
 *
 * The button is Today's twin (`TargetTodayButton`), with the same gesture
 * rule — TAP = the default, HOLD (the app's 400ms long-press) or RIGHT-CLICK
 * = choose:
 *  - tap: on deck for today (the calendar day; red-team A2). On a task
 *    already on deck for today the tap takes it OFF deck (A10) — the button
 *    is drawn FILLED while the task is on deck, so the toggle is visible.
 *  - hold: the day menu (`DeckMenu`): Tomorrow, the next few days by name,
 *    the check-in day, a date, and Remove while on deck. Re-deck = hold →
 *    Tomorrow.
 *
 * `onDeck(task, day)` gets the day to send: undefined = today (the server's
 * default), a yyyy-MM-dd day, or null = take off deck. The caller sends
 * `POST /api/tasks/deck` (or stages it, in the Quick panel) and toasts.
 *
 * Everything TargetTodayButton's comment says about events holds here too,
 * and for the same reasons: the hold never also taps; a finger that moves
 * abandons the press; the wrapper stops clicks and keys reaching the row
 * (whose click considers or activates); the pointerdown is NOT stopped (the
 * dashboard row's swipe needs it), and `data-no-row-press` keeps the row from
 * starting its own long-press here.
 */
export function OnDeckButton({
  task,
  timezone,
  onDeck,
  className,
  iconClassName,
  boxClassName,
  showLabel = false,
}: {
  task: Task
  timezone: string
  onDeck: (task: Task, day: string | null | undefined) => void
  className?: string
  iconClassName?: string
  /** The inner HOVER BOX (segment rows), as on `TargetTodayButton`. */
  boxClassName?: string
  /** The word "On deck" from `sm` up (segment rows); icon-only otherwise. */
  showLabel?: boolean
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const press = useSimpleLongPress({
    onLongPress: () => setMenuOpen(true),
    onShortPress: () => onDeck(task, deckTapDay(task, timezone, new Date())),
    // The tap can take the row off its list (see `TargetTodayButton`).
    tapOn: 'click',
  })
  const active = !!task.on_deck_day
  const forToday = active && deckIsToday(task, timezone, new Date())
  const title = forToday
    ? 'On deck today · tap to take off · hold for a day'
    : 'On deck today · hold for a day'
  return (
    <span
      className="contents"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <DeckMenu
        task={task}
        timezone={timezone}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        onPick={(day) => onDeck(task, day)}
      >
        <button
          type="button"
          data-on-deck
          data-on-deck-active={active ? '' : undefined}
          data-no-row-press
          aria-pressed={active}
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
          title={title}
          aria-label={
            forToday
              ? `Take "${task.title}" off deck (hold for a day)`
              : `Put "${task.title}" on deck today (hold for a day)`
          }
          className={cn(
            'flex shrink-0 touch-manipulation items-center justify-center gap-1 rounded-md text-xs font-medium select-none [-webkit-touch-callout:none]',
            active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            boxClassName ? 'group/deck' : 'hover:bg-foreground/5',
            className,
          )}
        >
          {boxClassName ? (
            <span
              data-on-deck-box
              className={cn(
                'group-hover/deck:bg-foreground/5 flex items-center justify-center gap-1 rounded-md transition-colors',
                boxClassName,
              )}
            >
              <DeckFace active={active} iconClassName={iconClassName} showLabel={showLabel} />
            </span>
          ) : (
            <DeckFace active={active} iconClassName={iconClassName} showLabel={showLabel} />
          )}
        </button>
      </DeckMenu>
    </span>
  )
}

/** The bookmark, filled while the task is on deck (A10), and its word from `sm`. */
function DeckFace({
  active,
  iconClassName,
  showLabel,
}: {
  active: boolean
  iconClassName?: string
  showLabel: boolean
}) {
  return (
    <>
      <Bookmark
        className={iconClassName}
        strokeWidth={1.75}
        fill={active ? 'currentColor' : 'none'}
      />
      {showLabel ? <span className="sr-only sm:not-sr-only">On deck</span> : null}
    </>
  )
}

const PICK_DATE = 'deck-pick-date'
const REMOVE = 'deck-remove'

/**
 * The On deck HOLD MENU (spec rule 7): the days from `deckMenuDays`, "Pick a
 * date…" (a date-only calendar — a deck has no time), and Remove while the
 * task is on deck. In the shared hold-menu shell (`OptionMenu`), titled "On
 * deck". A deadline task's days after its automatic target's start are
 * greyed (A1, `deckLatestDay`), and so are they in the calendar.
 */
export function DeckMenu({
  task,
  timezone,
  open,
  onOpenChange,
  onPick,
  children,
}: {
  task: Pick<Task, 'on_deck_day' | 'deadline_at' | 'due_at' | 'target_auto'>
  timezone: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** A yyyy-MM-dd day, or null for Remove. */
  onPick: (day: string | null) => void
  children: React.ReactNode
}) {
  const { checkInDay } = useCheckInDay()
  const [pickerOpen, setPickerOpen] = useState(false)
  const latest = deckLatestDay(task, timezone)
  const now = new Date()
  const days = deckMenuDays(timezone, now, checkInDay, latest)
  const options: OptionMenuItem[] = [
    ...days.map((d) => ({
      label: d.label,
      option: d.day,
      disabled: d.disabled,
      icon: <Bookmark />,
    })),
    { label: 'Pick a date…', option: PICK_DATE, icon: <CalendarDays /> },
    ...(task.on_deck_day ? [{ label: 'Remove', option: REMOVE, icon: <XCircle /> }] : []),
  ]
  const select = (option: string) => {
    onOpenChange(false)
    if (option === PICK_DATE) setPickerOpen(true)
    else onPick(option === REMOVE ? null : option)
  }
  return (
    <OptionMenu
      open={open}
      onOpenChange={onOpenChange}
      title="On deck"
      options={options}
      onSelect={select}
      after={
        <DeckDatePicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          timezone={timezone}
          current={task.on_deck_day}
          latest={latest}
          onPick={(day) => {
            setPickerOpen(false)
            onPick(day)
          }}
        />
      }
    >
      {children}
    </OptionMenu>
  )
}

/**
 * "Pick a date…": a calendar and nothing else — a deck is a day. Today (the
 * calendar day) is the earliest; a deadline task's later days are greyed
 * (A1). Opens on the current deck day, else tomorrow.
 */
function DeckDatePicker({
  open,
  onOpenChange,
  timezone,
  current,
  latest,
  onPick,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  timezone: string
  current: string | null
  latest: string | null
  onPick: (day: string) => void
}) {
  // The calendar works in the browser's local dates; a deck day is the
  // user's. Convert through the date's parts, never through an instant.
  const toLocal = (day: string) => {
    const d = DateTime.fromISO(day)
    return new Date(d.year, d.month - 1, d.day)
  }
  const fromLocal = (d: Date) =>
    DateTime.local(d.getFullYear(), d.getMonth() + 1, d.getDate()).toFormat(DECK_DAY_FORMAT)
  const today = calendarToday(timezone, new Date())
  const initial = current ?? DateTime.fromISO(today).plus({ days: 1 }).toFormat(DECK_DAY_FORMAT)
  const [selected, setSelected] = useState<Date | undefined>(undefined)
  const shown = selected ?? toLocal(initial)
  const disabled = [{ before: toLocal(today) }, ...(latest ? [{ after: toLocal(latest) }] : [])]
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setSelected(undefined)
        onOpenChange(next)
      }}
    >
      <DialogContent className="max-w-sm" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>On deck for…</DialogTitle>
          <DialogDescription className="sr-only">Choose the day</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center">
          <Calendar
            mode="single"
            selected={shown}
            onSelect={(date) => {
              if (date) setSelected(date)
            }}
            defaultMonth={shown}
            disabled={disabled}
          />
        </div>
        <Button data-deck-date-submit onClick={() => onPick(fromLocal(shown))} className="w-full">
          <Bookmark className="mr-1.5 size-4" />
          Put on deck
        </Button>
      </DialogContent>
    </Dialog>
  )
}
