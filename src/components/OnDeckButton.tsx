'use client'

import { CalendarDays, XCircle } from 'lucide-react'
import { OnDeckIcon } from '@/components/icons/OnDeckIcon'
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
import {
  useCheckInDay,
  useDayStart,
  useDayStartKnown,
  useTaskQueue,
} from '@/components/PreferencesProvider'
import { useSimpleLongPress } from '@/hooks/useLongPress'
import { deckLimit, deckMenuDays, deckTapDay, gateDeckDays, type DeckLimit } from '@/lib/deck-menu'
import { DECK_DAY_FORMAT, deckIsToday, openTaskToday } from '@/lib/task-segments'
import { ReplaceConfirm } from '@/components/ReplaceConfirm'
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
 *
 * `replaces` (the deadlines page, 2026-10-22, plan §5): on a one-off with a
 * target the user picked (`deckReplaces`: "target Fri 6 PM") the button is
 * drawn FADED, and a tap — or a day from the hold menu — asks first
 * (`ReplaceConfirm`: "Replaces target Fri 6 PM", Deck / Cancel): the deck
 * drops that target.
 */
export function OnDeckButton({
  task,
  timezone,
  onDeck,
  limit,
  className,
  iconClassName,
  boxClassName,
  replaces = null,
  litFor = 'any',
}: {
  task: Task
  timezone: string
  onDeck: (task: Task, day: string | null | undefined) => void
  /** What a deck would replace ("target Fri 6 PM", `deckReplaces`): faded, and it asks. */
  replaces?: string | null
  /**
   * The A1 limit for the hold menu (`deckLimit`). Omitted: worked out from
   * the task. The Quick panel passes it from a STAGED deadline.
   */
  limit?: DeckLimit | null
  className?: string
  iconClassName?: string
  /** The inner HOVER BOX (segment rows), as on `TargetTodayButton`. */
  boxClassName?: string
  /**
   * Which decks light it (`DECK_LIT`). `'any'` (the dashboard row, the Quick
   * panel): any deck day — there it is the only deck button. `'today'`: a
   * segment row, where On deck tomorrow lights for tomorrow's deck and a
   * later deck lights neither (the meta names its day).
   */
  litFor?: 'any' | 'today'
}) {
  // "Today" for a deck is the OpenTask day ("Day starts at" PR 2).
  const dayStart = useDayStart()
  const [menuOpen, setMenuOpen] = useState(false)
  // The day a replacing deck waits on the confirm with (`replaces`).
  const [pending, setPending] = useState<{ day: string | null | undefined } | null>(null)
  // Nothing to replace any more (the row changed under an open confirm): drop it.
  if (!replaces && pending) setPending(null)
  const act = (day: string | null | undefined) => {
    if (replaces) setPending({ day })
    else onDeck(task, day)
  }
  const press = useSimpleLongPress({
    onLongPress: () => setMenuOpen(true),
    onShortPress: () => act(deckTapDay(task, timezone, new Date(), dayStart)),
    // The tap can take the row off its list (see `TargetTodayButton`).
    tapOn: 'click',
  })
  // What a tap toggles: on deck for TODAY. With `litFor` 'any' a later deck
  // wears the filled icon too (the row's only sign of it) but is not
  // "pressed" — a tap moves it to today.
  const forToday = deckIsToday(task, timezone, new Date(), dayStart)
  const active = litFor === 'today' ? forToday : !!task.on_deck_day
  const title = replaces
    ? `On deck — replaces ${replaces} · hold for a day`
    : forToday
      ? 'On deck — today · tap to take off · hold for a day'
      : 'On deck — today · hold for a day'
  const face = <DeckFace active={active} iconClassName={iconClassName} />
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
        onPick={act}
      >
        <MaybeReplace
          replaces={replaces}
          pending={pending}
          onCancel={() => setPending(null)}
          onConfirm={(day) => onDeck(task, day)}
        >
          <button
            type="button"
            data-on-deck
            data-on-deck-active={active ? '' : undefined}
            data-replaces={replaces ? '' : undefined}
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
              active ? DECK_LIT : 'text-muted-foreground hover:text-foreground',
              // Faded: it would replace a target (plan §5).
              replaces && 'opacity-45 hover:opacity-100',
              // On deck: a full-strength, FILLED icon (`DeckFace`) — no grey
              // chip. The hover tint is on the inner box where there is one.
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
                {face}
              </span>
            ) : (
              face
            )}
          </button>
        </MaybeReplace>
      </DeckMenu>
    </span>
  )
}

/**
 * A LIT deck button's colour: its own token, `--deck-lit` (light and dark in
 * globals.css). 2026-10-27 (Trent: a solid black icon "looks unfinished"):
 * the task queue's teal; 2026-10-28 (Trent's "T2", after mocks in context):
 * that teal drained toward slate, quieter on the dashboard. On deck, On deck
 * tomorrow (`TaskSegmentRow`), the dashboard row and the Quick panel all wear
 * it; the "Today's pulls" title keeps its teal.
 */
export const DECK_LIT = 'text-(--deck-lit)'

/**
 * The faded button's confirm (`ReplaceConfirm`), or the button alone when
 * nothing would be replaced — so an ordinary row's layout never changes.
 */
function MaybeReplace({
  replaces,
  pending,
  onCancel,
  onConfirm,
  children,
}: {
  replaces: string | null
  pending: { day: string | null | undefined } | null
  onCancel: () => void
  onConfirm: (day: string | null | undefined) => void
  children: React.ReactNode
}) {
  if (!replaces) return <>{children}</>
  return (
    <ReplaceConfirm
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
      message={`Replaces ${replaces}`}
      confirmLabel="Deck"
      onConfirm={() => {
        if (pending) onConfirm(pending.day)
      }}
    >
      {children}
    </ReplaceConfirm>
  )
}

/**
 * On deck's icon: `OnDeckIcon` — layers with a "+" — the pair of the deck
 * tomorrow button's `DeckTomorrowIcon` (Trent, 2026-10-21), icon only,
 * everywhere (the tooltip and the accessible name say "On deck"). On deck
 * (A10) the icon is FILLED — its top card solid, the plus cut out of it — and
 * the button wears no grey chip (the fill is the sign; the state stays in
 * `aria-pressed` and `data-on-deck-active`).
 */
function DeckFace({ active, iconClassName }: { active: boolean; iconClassName?: string }) {
  return <OnDeckIcon className={iconClassName} strokeWidth={1.75} filled={active} />
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
  task: Pick<Task, 'on_deck_day' | 'deadline_at' | 'due_at' | 'target_auto' | 'rrule'>
  timezone: string
  /** Omitted: `deckLimit(task)` (a repeating task's from its deadline's OpenTask day). */
  limit?: DeckLimit | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** A yyyy-MM-dd day, or null for Remove. */
  onPick: (day: string | null) => void
  children: React.ReactNode
}) {
  const { checkInDay } = useCheckInDay()
  const dayStart = useDayStart()
  // The days wait for the user's day start (`gateDeckDays`).
  const dayKnown = useDayStartKnown()
  // The rollover time (with the switch on, as decks need): a repeating
  // deadline before the rollover counts as the evening before (`deckLimit`).
  const { attemptsRolloverTime: rolloverTime } = useTaskQueue()
  // The picker is mounted afresh on every open (`pickerKey`), so it never
  // keeps an old selection — whichever way it was opened.
  const [pickerKey, setPickerKey] = useState(0)
  const [pickerOpen, setPickerOpen] = useState(false)
  const now = new Date()
  const bound = limit === undefined ? deckLimit(task, timezone, now, null, rolloverTime) : limit
  const days = gateDeckDays(deckMenuDays(timezone, now, dayStart, checkInDay, bound), dayKnown)
  const options: OptionMenuItem[] = [
    ...days.map((d) => ({
      label: d.label,
      option: d.day,
      disabled: d.disabled,
      caption: d.caption,
      icon: <OnDeckIcon />,
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
  // user's OpenTask date. Convert through the date's parts, never through an
  // instant.
  const dayStart = useDayStart()
  const toLocal = (day: string) => {
    const d = DateTime.fromISO(day)
    return new Date(d.year, d.month - 1, d.day)
  }
  const fromLocal = (d: Date) =>
    DateTime.local(d.getFullYear(), d.getMonth() + 1, d.getDate()).toFormat(DECK_DAY_FORMAT)
  const today = openTaskToday(timezone, new Date(), dayStart)
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
            // The "today" ring is the OpenTask day, not the browser's calendar
            // day: at 00:30 with a 3:00 AM start, still yesterday's date.
            today={toLocal(today)}
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
          <OnDeckIcon className="mr-1.5 size-4" />
          Put on deck
        </Button>
      </DialogContent>
    </Dialog>
  )
}
