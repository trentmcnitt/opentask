'use client'

import { useState } from 'react'
import { Clock, CalendarDays } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Calendar } from '@/components/ui/calendar'
import { Button } from '@/components/ui/button'
import { OptionMenu, type OptionMenuItem } from '@/components/OptionMenu'
import { useSlotsWhenOpen } from '@/hooks/useSlotsWhenOpen'
import {
  useDayStart,
  useDayStartKnown,
  useSnoozePreferences,
} from '@/components/PreferencesProvider'
import { useTimezone } from '@/hooks/useTimezone'
import { computeSnoozeTime } from '@/lib/snooze'
import { to12Hour, to24Hour } from '@/lib/time-utils'
import { DateTime } from 'luxon'
import { nextSlotStart, type TimeSlot } from '@/lib/time-slot-assign'
import { SLOT_OPTION_PREFIX, targetMenu } from '@/lib/target-menu'
import { deadlineDayPick } from '@/lib/editor-target-labels'
import { customPickerStart } from '@/lib/custom-picker-start'
import { PickerTimeFields } from '@/components/PickerTimeFields'

/** The picker's "Morning of the deadline" (ruling Q8, 2026-10-12). */
const DEADLINE_DAY_OPTION = 'deadline-day'

/** Each option's icon: custom → calendar, else a clock. */
function OptionIcon({ option, className }: { option: string; className: string }) {
  if (option === 'custom') return <CalendarDays className={className} />
  return <Clock className={className} />
}

interface SnoozeMenuProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with UTC ISO string when user picks a snooze option */
  onSnooze: (until: string) => void
  /** Trigger element — rendered as-is; parent controls click/long-press behavior */
  children?: React.ReactNode
  /**
   * The task's deadline: while it is ahead the menu offers "Morning of the deadline"
   * (ruling Q8 — the morning of its day, or the deadline itself if earlier),
   * and every option stops at it anyway (the server caps, §8.2).
   */
  deadlineAt?: string | null
  /** The sheet's title and the menu's accessible name: "Snooze" by default; Today's menu says "Target". */
  title?: string
  /**
   * Custom... opens the caller's own picker instead of the snooze dialog. The
   * segment rows' Today menu uses it for its "Set target" picker, which knows
   * the deadline (ruling Q8).
   */
  onCustom?: () => void
  /** `OptionMenu`'s trigger wrapper class (a selection bar's verb). */
  triggerClassName?: string
  /**
   * What the built-in Custom… picker says: "Set target" when the menu picks a
   * target (Trent, 2026-10-30: "I press the target button, but it says
   * 'defer'"), else "Defer until…". Omitted: from the title ("Target…").
   */
  customPurpose?: 'defer' | 'target'
  /** The targets the Custom… picker should not open before (`customPickerStart`). */
  customFrom?: readonly (string | null | undefined)[]
}

/**
 * Snooze option menu opened via long-press, in the shared hold-menu shell
 * (`OptionMenu`): desktop, a portal-rendered dropdown positioned via
 * getBoundingClientRect to escape stacking contexts; mobile, a bottom Sheet. Children (trigger button) are never wrapped in a Radix trigger
 * to avoid event interception — the parent component controls open state directly.
 */
export function SnoozeMenu({
  open,
  onOpenChange,
  onSnooze,
  children,
  deadlineAt = null,
  title = 'Defer',
  onCustom,
  triggerClassName,
  customPurpose,
  customFrom = [],
}: SnoozeMenuProps) {
  const timezone = useTimezone()
  const { morningTime } = useSnoozePreferences()
  // "Tomorrow" is the next OpenTask day ("Day starts at" PR 2); until the
  // browser knows the day start, Tomorrow is shown but not choosable.
  const dayStart = useDayStart()
  const dayKnown = useDayStartKnown()
  const [customPickerOpen, setCustomPickerOpen] = useState(false)
  // The Custom… picker opens afresh each time (`key`), on `customPickerStart`.
  const [picker, setPicker] = useState<{ key: number; startAt: string }>({ key: 0, startAt: '' })

  const slots = useSlotsWhenOpen(open)

  // T1 (Trent, 2026-10-30; `src/lib/target-menu.ts`): Next period, 1 hour, 2
  // hours, Tomorrow, This (or Next) weekend, Next week — then the deadline's
  // morning when the task has one, then every other period as ONE wrapping
  // row of buttons (the menu stays the same height at 8 or 10 periods), then
  // Custom… and Remove target. A period goes to its next start — today if
  // still ahead, else tomorrow — as before.
  const now = new Date()
  const menu = targetMenu({ now, timezone, dayStart, morningTime, slots })
  const pick = new Map(menu.rows.map((r) => [r.option, r.at]))
  const deadlineDay = deadlineDayPick(deadlineAt, { timezone, morningTime }, now, dayStart)
  const options: Omit<OptionMenuItem, 'icon'>[] = [
    ...menu.rows.map((r) => ({
      label: r.label,
      option: r.option,
      caption: r.detail,
      disabled: r.needsDay && !dayKnown,
    })),
    ...(deadlineDay ? [{ label: deadlineDay.label, option: DEADLINE_DAY_OPTION }] : []),
    ...menu.periods.map((p) => ({
      label: p.label,
      option: p.option,
      caption: p.time,
      chipGroup: 'Periods',
    })),
    // No Remove target here since 2026-10-30: the target chip's X does it.
    { label: 'Custom...', option: 'custom' },
  ]

  const handleSelect = (option: string) => {
    if (option === DEADLINE_DAY_OPTION && deadlineDay) {
      onSnooze(deadlineDay.at)
      onOpenChange(false)
      return
    }
    if (option === 'custom') {
      onOpenChange(false)
      if (onCustom) onCustom()
      else {
        setPicker((p) => ({
          key: p.key + 1,
          startAt: customPickerStart({ from: customFrom, timezone, morningTime, dayStart }),
        }))
        setCustomPickerOpen(true)
      }
      return
    }
    // A period: its next start, and an offset: from now (the menu may have
    // sat open). A named day: as the menu worked it out.
    const at = option.startsWith(SLOT_OPTION_PREFIX)
      ? nextSlotStart(option.slice(SLOT_OPTION_PREFIX.length), timezone)
      : /^\d+$/.test(option)
        ? computeSnoozeTime(option, timezone, morningTime, dayStart)
        : pick.get(option)
    if (!at) return
    onSnooze(at)
    onOpenChange(false)
  }

  const handleCustomSnooze = (until: string) => {
    onSnooze(until)
    setCustomPickerOpen(false)
  }

  return (
    <OptionMenu
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      options={options.map((o) => ({
        ...o,
        icon: <OptionIcon option={o.option} className="size-4" />,
      }))}
      onSelect={handleSelect}
      triggerClassName={triggerClassName}
      after={
        <CustomSnoozePicker
          key={picker.key}
          open={customPickerOpen}
          onOpenChange={setCustomPickerOpen}
          timezone={timezone}
          startAt={picker.startAt}
          slots={slots}
          purpose={customPurpose ?? (title.startsWith('Target') ? 'target' : 'defer')}
          onSnooze={handleCustomSnooze}
        />
      }
    >
      {children}
    </OptionMenu>
  )
}

/**
 * The menu's Custom… dialog: a calendar and 12-hour time inputs, then the
 * user's periods (`PeriodChipRow`). It opens on `startAt` — the Default task
 * time, on tomorrow or a later target's day (`customPickerStart`, Trent
 * 2026-10-30); mounted afresh on each open (the menu's `key`), so it never
 * keeps the last pick. It used to set that only from the dialog's own
 * `onOpenChange`, which a menu opening it never calls — so it opened on
 * whatever was last left there (Nov 16, 1:00 AM on Trent's phone). Its words
 * follow its purpose: "Set target" from a Target menu, "Defer until…"
 * otherwise.
 */
function CustomSnoozePicker({
  open,
  onOpenChange,
  timezone,
  startAt,
  slots,
  purpose,
  onSnooze,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  timezone: string
  startAt: string
  slots: readonly TimeSlot[]
  purpose: 'defer' | 'target'
  onSnooze: (until: string) => void
}) {
  const { morningTime } = useSnoozePreferences()
  const start = startAt ? DateTime.fromISO(startAt, { zone: 'utc' }).setZone(timezone) : null
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(() =>
    start
      ? DateTime.fromObject({ year: start.year, month: start.month, day: start.day }).toJSDate()
      : undefined,
  )
  const [hour12, setHour12] = useState(() => (start ? to12Hour(start.hour) : 9))
  const [minute, setMinute] = useState(() => start?.minute ?? 0)
  const [period, setPeriod] = useState<'AM' | 'PM'>(() => (start && start.hour >= 12 ? 'PM' : 'AM'))
  const target = purpose === 'target'
  const title = target ? 'Set target' : 'Defer until...'
  const action = target ? 'Set target' : 'Defer'

  const handleSnooze = () => {
    if (!selectedDate) return
    const hour24 = to24Hour(hour12, period)
    const localDt = DateTime.fromJSDate(selectedDate)
      .setZone(timezone, { keepLocalTime: true })
      .set({ hour: hour24, minute, second: 0, millisecond: 0 })
    const utcIso = localDt.toUTC().toISO()
    if (utcIso) onSnooze(utcIso)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">
            {target
              ? 'Choose a date and time for the target'
              : 'Choose a custom date and time to defer'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center">
          <Calendar
            mode="single"
            selected={selectedDate}
            onSelect={(date) => {
              if (date) setSelectedDate(date)
            }}
            defaultMonth={selectedDate}
          />
          <div className="w-full border-t px-3 pt-3 pb-1">
            <PickerTimeFields
              hour12={hour12}
              minute={minute}
              period={period}
              slots={slots}
              defaultTime={morningTime}
              onSet={(h, m, p) => {
                setHour12(h)
                setMinute(m)
                setPeriod(p)
              }}
            />
          </div>
        </div>
        <Button onClick={handleSnooze} disabled={!selectedDate} className="w-full">
          <Clock className="mr-1.5 size-4" />
          {action}
        </Button>
      </DialogContent>
    </Dialog>
  )
}
