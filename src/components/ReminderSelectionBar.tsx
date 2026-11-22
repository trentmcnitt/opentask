'use client'

import { useMemo, useState } from 'react'
import { CheckCheck, ClockArrowDown, FileText, Trash2 } from 'lucide-react'
import { BarAction, SELECTION_BAR_HINT_ID, SelectionBarShell } from '@/components/SelectionBarShell'
import { OptionMenu } from '@/components/OptionMenu'
import { useDayStart } from '@/components/PreferencesProvider'
import { laterPeriodsForAll, laterPeriodsToday } from '@/lib/reminder-move'
import { formatClockTime } from '@/lib/time-utils'
import type { TimeSlot } from '@/lib/time-slot-assign'

/**
 * The floating action bar for a selection on the Reminders surface.
 *
 * Deliberately the same object as the dashboard's bar (`SelectionActionSheet`):
 * same position, same black pill, same button shapes — the user asked for the
 * reminders screen to behave like the dashboard, not like a second app. What
 * differs is the verb set. A reminder has no due date to move and no priority
 * ladder worth editing in bulk, and the server refuses to snooze one (RM-006),
 * so the task bar's Snooze / More would be dead or misleading here. What
 * remains: consider the selection, open its details (one reminder's editor,
 * or several reminders' schedule edited together — Trent, 2026-09-05: "we
 * need that"), move the selection to Trash ("why doesn't it have a trash
 * can?"), clear.
 *
 * QUOTA PROMPTS in the selection (2026-09-25). A prompt is a quota's row, not
 * a reminder, so the verbs narrow to what is safe for it:
 * - Considered covers everything selected, prompts as "considered" (never +1).
 * - Details opens ONE kind of editor: the reminders' when only reminders are
 *   selected, the quota editor (deduped to the quotas behind the prompts) when
 *   only prompts are. A mix has no single editor, so Details is disabled and
 *   the bar says why, in one line.
 * - Delete is ALWAYS offered (Trent, 2026-11-12: with a prompt selected
 *   there was no Delete — "It's confusing"). Reminders alone delete at once.
 *   With any prompt in the selection Delete would delete the QUOTA itself,
 *   so the surface asks first, once (`DeleteQuotasDialog`): all of it, the
 *   reminders only, or cancel. This replaced the 2026-09-25 rule that Trash
 *   was not offered while a prompt was selected.
 * - Later today (2026-11-21, the one-day move) covers both: reminders and
 *   prompts move together, to a period every one of them can go to.
 */
interface ReminderSelectionBarProps {
  selectedCount: number
  /** How many of the selection are reminders, and how many quota prompts. */
  reminderCount: number
  promptCount: number
  /** Mark everything selected as considered — one bulk call, one Undo. */
  onConsidered: () => void
  /** Open the selection's details — reminders' editor, or the prompts' quotas. */
  onDetails: () => void
  /** Delete the selection — reminders at once; with a prompt in it, after the one confirmation. */
  onDelete: () => void
  /** The period each selected row is in today (null = Anytime), for Later today. */
  currents: (TimeSlot | null)[]
  timeSlots: TimeSlot[]
  timezone: string
  /** Later today's pick: move the whole selection to `to` for today. */
  onMoveForToday: (to: TimeSlot) => void
  onClear: () => void
}

/** Why Details is off for a mixed selection — the bar's hint line. */
export const MIXED_DETAILS_HINT = 'Details: pick only reminders or only quotas'

/**
 * Why Later today is off when some of the selection could move, but no one
 * period comes after all of it (one in Evening, or in Anytime). Not shown
 * when none of it could move (all in the day's last period): there the
 * disabled verb says enough, and a line under every evening selection would
 * be noise.
 */
export const LATER_NONE_HINT = 'Later today: no period comes after all of them'

export function ReminderSelectionBar({
  selectedCount,
  reminderCount,
  promptCount,
  onConsidered,
  onDetails,
  onDelete,
  currents,
  timeSlots,
  timezone,
  onMoveForToday,
  onClear,
}: ReminderSelectionBarProps) {
  const mixed = reminderCount > 0 && promptCount > 0
  const canDetails = !mixed && reminderCount + promptCount > 0
  const dayStart = useDayStart()
  // As of the selection's last change (`currents` is memoised on it and the
  // payload); Later today's menu works its list out again when it opens.
  const { later, laterBlocked } = useMemo(() => {
    const now = new Date()
    const common = laterPeriodsForAll(currents, timeSlots, now, timezone, dayStart)
    return {
      later: common,
      laterBlocked:
        common.length === 0 &&
        currents.length > 1 &&
        currents.some((c) => laterPeriodsToday(c, timeSlots, now, timezone, dayStart).length > 0),
    }
  }, [currents, timeSlots, timezone, dayStart])
  const hints = [mixed && MIXED_DETAILS_HINT, laterBlocked && LATER_NONE_HINT].filter(
    (h): h is string => !!h,
  )
  return (
    <SelectionBarShell
      count={selectedCount}
      onClear={onClear}
      onDoubleClickIntent={canDetails ? onDetails : undefined}
      hint={hints.length > 0 ? hints.join(' · ') : undefined}
    >
      <BarAction tone="done" icon={<CheckCheck />} label="Consider" onClick={onConsidered} />
      <BarAction
        icon={<FileText />}
        label="Details"
        onClick={onDetails}
        disabled={!canDetails}
        describedBy={mixed ? SELECTION_BAR_HINT_ID : undefined}
      />
      <LaterTodayVerb
        count={selectedCount}
        currents={currents}
        timeSlots={timeSlots}
        timezone={timezone}
        dayStart={dayStart}
        disabled={later.length === 0}
        describedBy={laterBlocked ? SELECTION_BAR_HINT_ID : undefined}
        onPick={onMoveForToday}
      />
      <BarAction
        tone="danger"
        icon={<Trash2 />}
        label="Delete"
        onClick={onDelete}
        ariaLabel={selectedCount === 1 ? 'Move to Trash' : `Move ${selectedCount} to Trash`}
      />
    </SelectionBarShell>
  )
}

/**
 * Later today: a menu of the periods the whole selection can move to for
 * today (`laterPeriodsForAll`), each with its start time — the app's hold
 * menu (`OptionMenu`: a sheet on a phone, a dropdown at the verb on a wider
 * screen), opened like the task bars' Target and Deck. The list is worked
 * out again when it opens, so it never offers a period that has started.
 */
function LaterTodayVerb({
  count,
  currents,
  timeSlots,
  timezone,
  dayStart,
  disabled,
  describedBy,
  onPick,
}: {
  count: number
  currents: (TimeSlot | null)[]
  timeSlots: TimeSlot[]
  timezone: string
  dayStart: string
  disabled: boolean
  describedBy?: string
  onPick: (to: TimeSlot) => void
}) {
  const [openedAt, setOpenedAt] = useState<Date | null>(null)
  const periods = openedAt
    ? laterPeriodsForAll(currents, timeSlots, openedAt, timezone, dayStart)
    : []
  return (
    <OptionMenu
      open={openedAt !== null}
      onOpenChange={(open) => setOpenedAt(open ? new Date() : null)}
      title={count === 1 ? 'Later today' : `Later today · ${count}`}
      options={periods.map((slot) => ({
        label: slot.label,
        option: String(slot.id),
        icon: null,
        caption: formatClockTime(slot.start_time),
      }))}
      onSelect={(option) => {
        setOpenedAt(null)
        const to = periods.find((slot) => String(slot.id) === option)
        if (to) onPick(to)
      }}
      triggerClassName="flex flex-auto"
    >
      <BarAction
        icon={<ClockArrowDown />}
        label="Later today"
        onClick={() => setOpenedAt(new Date())}
        disabled={disabled}
        describedBy={describedBy}
        data-bar-later
      />
    </OptionMenu>
  )
}
