'use client'

import { CalendarDays, Layers2, XCircle } from 'lucide-react'
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
import { deckLimit, deckMenuDays, deckTapDay, type DeckLimit } from '@/lib/deck-menu'
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
  limit,
  className,
  iconClassName,
  boxClassName,
}: {
  task: Task
  timezone: string
  onDeck: (task: Task, day: string | null | undefined) => void
  /**
   * The A1 limit for the hold menu (`deckLimit`). Omitted: worked out from
   * the task. The Quick panel passes it from a STAGED deadline.
   */
  limit?: DeckLimit | null
  className?: string
  iconClassName?: string
  /** The inner HOVER BOX (segment rows), as on `TargetTodayButton`. */
  boxClassName?: string
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const press = useSimpleLongPress({
    onLongPress: () => setMenuOpen(true),
    onShortPress: () => onDeck(task, deckTapDay(task, timezone, new Date())),
    // The tap can take the row off its list (see `TargetTodayButton`).
    tapOn: 'click',
  })
  const active = !!task.on_deck_day
  // What a tap toggles: on deck for TODAY. A later deck wears the active chip (the
  // row's only sign of it) but is not "pressed" — a tap moves it to today.
  const forToday = active && deckIsToday(task, timezone, new Date())
  const title = forToday
    ? 'On deck — today · tap to take off · hold for a day'
    : 'On deck — today · hold for a day'
  return (
    <span
      className="contents"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <DeckMenu
        task={task}
        timezone={timezone}
        limit={limit}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        onPick={(day) => onDeck(task, day)}
      >
        <button
          type="button"
          data-on-deck
          data-on-deck-active={active ? '' : undefined}
          data-no-row-press
          // The state is in aria-pressed; the name stays the same.
          aria-pressed={forToday}
          aria-label={`On deck: “${task.title}” (hold for a day)`}
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
          className={cn(
            'flex shrink-0 touch-manipulation items-center justify-center gap-1 rounded-md text-xs font-medium select-none [-webkit-touch-callout:none]',
            active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            // The ACTIVE CHIP (on deck): a grey fill behind a full-strength
            // icon — on the inner hover box where there is one.
            boxClassName
              ? 'group/deck'
              : active
                ? 'bg-foreground/10 hover:bg-foreground/15'
                : 'hover:bg-foreground/5',
            className,
          )}
        >
          {boxClassName ? (
            <span
              data-on-deck-box
              className={cn(
                'flex items-center justify-center gap-1 rounded-md transition-colors',
                active
                  ? 'bg-foreground/10 group-hover/deck:bg-foreground/15'
                  : 'group-hover/deck:bg-foreground/5',
                boxClassName,
              )}
            >
              <DeckFace active={active} iconClassName={iconClassName} />
            </span>
          ) : (
            <DeckFace active={active} iconClassName={iconClassName} />
          )}
        </button>
      </DeckMenu>
    </span>
  )
}

/**
 * On deck's icon: lucide `Layers2`, icon only, everywhere (Trent, 2026-10-20;
 * the tooltip and the accessible name say "On deck"). PROVISIONAL — Trent:
 * not thrilled, candidate for a custom icon. On deck (A10) it is NOT filled —
 * two filled layers read as one muddy block — the button wears the neutral
 * active chip instead (grey fill, full-strength icon; see the button).
 */
function DeckFace({ iconClassName }: { active: boolean; iconClassName?: string }) {
  return <Layers2 className={iconClassName} strokeWidth={1.75} />
}

const PICK_DATE = 'deck-pick-date'
const REMOVE = 'deck-remove'

/**
 * The On deck HOLD MENU (spec rule 7): the days from `deckMenuDays`, "Pick a
 * date…" (a date-only calendar — a deck has no time), and Remove while the
 * task is on deck. In the shared hold-menu shell (`OptionMenu`), titled "On
 * deck". A deadline task's days from its automatic target's day on are
 * greyed with a caption ("deadline reminds from Tue", A1, `deckLimit`), and
 * so are they in the calendar.
 */
export function DeckMenu({
  task,
  timezone,
  limit,
  open,
  onOpenChange,
  onPick,
  children,
}: {
  task: Pick<Task, 'on_deck_day' | 'deadline_at' | 'due_at' | 'target_auto'>
  timezone: string
  /** Omitted: `deckLimit(task)`. */
  limit?: DeckLimit | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** A yyyy-MM-dd day, or null for Remove. */
  onPick: (day: string | null) => void
  children: React.ReactNode
}) {
  const { checkInDay } = useCheckInDay()
  // The picker is mounted afresh on every open (`pickerKey`), so it never
  // keeps an old selection — whichever way it was opened.
  const [pickerKey, setPickerKey] = useState(0)
  const [pickerOpen, setPickerOpen] = useState(false)
  const now = new Date()
  const bound = limit === undefined ? deckLimit(task, timezone, now) : limit
  const days = deckMenuDays(timezone, now, checkInDay, bound)
  const options: OptionMenuItem[] = [
    ...days.map((d) => ({
      label: d.label,
      option: d.day,
      disabled: d.disabled,
      caption: d.caption,
      icon: <Layers2 />,
    })),
    { label: 'Pick a date…', option: PICK_DATE, icon: <CalendarDays /> },
    ...(task.on_deck_day ? [{ label: 'Remove', option: REMOVE, icon: <XCircle /> }] : []),
  ]
  const select = (option: string) => {
    onOpenChange(false)
    if (option === PICK_DATE) {
      setPickerKey((k) => k + 1)
      setPickerOpen(true)
    } else onPick(option === REMOVE ? null : option)
  }
  return (
    <OptionMenu
      open={open}
      onOpenChange={onOpenChange}
      title="On deck"
      options={options}
      onSelect={select}
      // A Radix popover on desktop, so the menu also works in the Quick
      // panel's dialog (`OptionMenu`'s `anchored`).
      anchored
      after={
        <DeckDatePicker
          key={pickerKey}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          timezone={timezone}
          current={task.on_deck_day}
          latest={bound?.latestDay ?? null}
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
 * The first day the picker should open on: the current deck day when it is
 * still allowed, else tomorrow, else today — whichever is first allowed. Null
 * when no day is (a deadline already reminding).
 */
export function deckPickerDefault(
  today: string,
  current: string | null,
  latest: string | null,
): string | null {
  const allowed = (day: string) => day >= today && (latest === null || day <= latest)
  const tomorrow = DateTime.fromISO(today).plus({ days: 1 }).toFormat(DECK_DAY_FORMAT)
  return [current, tomorrow, today].find((d): d is string => !!d && allowed(d)) ?? null
}

/**
 * "Pick a date…": a calendar and nothing else — a deck is a day. Today (the
 * calendar day) is the earliest; a deadline task's later days are greyed
 * (A1). Opens on a day that can be chosen (`deckPickerDefault`); "Put on
 * deck" is off while the selection is a day that can't.
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
  const [selected, setSelected] = useState<string | null>(() =>
    deckPickerDefault(today, current, latest),
  )
  const valid = selected !== null && selected >= today && (latest === null || selected <= latest)
  const disabled = [{ before: toLocal(today) }, ...(latest ? [{ after: toLocal(latest) }] : [])]
  const month = toLocal(selected ?? today)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>On deck for…</DialogTitle>
          <DialogDescription className="sr-only">Choose the day</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center">
          <Calendar
            mode="single"
            selected={selected ? toLocal(selected) : undefined}
            onSelect={(date) => {
              if (date) setSelected(fromLocal(date))
            }}
            defaultMonth={month}
            disabled={disabled}
          />
        </div>
        <Button
          data-deck-date-submit
          disabled={!valid}
          onClick={() => {
            if (valid) onPick(selected)
          }}
          className="w-full"
        >
          <Layers2 className="mr-1.5 size-4" />
          Put on deck
        </Button>
      </DialogContent>
    </Dialog>
  )
}
