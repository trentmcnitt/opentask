'use client'

/**
 * Settings → "Day starts at" (2026-10-23): when the OpenTask day turns — the
 * task queue's rollover, today's reminders and quota prompts, a daily quota's
 * count. `AnchorTimeRow`'s control (`src/lib/anchor-times.ts`), with one more
 * choice at the top: "Default (3:00 AM)", the unset state every user starts
 * in (`DEFAULT_DAY_START`, Trent 2026-10-24), kept selectable to go back to.
 *
 * A custom time can be any time of day: 3:00 AM keeps a late night with the
 * day before; 11:00 PM starts the next day an hour before midnight
 * (`dayStartMoment` in src/lib/opentask-day.ts names the day either way).
 *
 * Optimistic like `AnchorTimeRow`: the row shows the new value at once
 * (resolved by the server's own rule), then takes the server's answer, or
 * puts the old value back on a failure.
 */

import { useAnchorTimes } from '@/components/PreferencesProvider'
import { anchorPrefsOf, parseServerPrefs, type AnchorPrefs } from '@/lib/preferences-state'
import { savePreference } from '@/lib/save-preference'
import {
  DEFAULT_DAY_START,
  dayStartLabel,
  resolveDayStart,
  type ResolvedDayStart,
  type TimeSetting,
} from '@/lib/anchor-times'
import { sortSlotsByStart, type TimeSlot } from '@/lib/time-slot-assign'
import { formatClockTime } from '@/lib/time-utils'

const SELECT_CLASS =
  'rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900'

/** The wire form: null back to the default, a link its period, a custom time its time. */
function toWire(next: TimeSetting | null): Record<string, string | number | null> {
  if (next === null) return { day_start_time: null }
  return next.slot_id !== null ? { day_start_slot_id: next.slot_id } : { day_start_time: next.time }
}

export function DayStartRow({
  description,
  timeSlots,
}: {
  description?: string
  timeSlots: TimeSlot[]
}) {
  const anchors = useAnchorTimes()
  const resolve = (setting: TimeSetting | null): ResolvedDayStart =>
    resolveDayStart(
      { day_start_time: setting?.time ?? null, day_start_slot_id: setting?.slot_id ?? null },
      timeSlots,
    )
  const current = anchors.dayStart
  const resolved = resolve(current)
  const slots = sortSlotsByStart(timeSlots)

  const prefsFor = (setting: TimeSetting | null): Partial<AnchorPrefs> => {
    const r = resolve(setting)
    return {
      dayStart: r.default ? null : { time: r.time, slot_id: r.slot_id },
      rolloverTime: r.time,
    }
  }

  const save = (next: TimeSetting | null) => {
    void savePreference(toWire(next), {
      apply: () => anchors.setAnchorPrefs(prefsFor(next)),
      revert: () => anchors.setAnchorPrefs(prefsFor(current)),
    }).then((data) => {
      if (data) anchors.setAnchorPrefs(anchorPrefsOf(parseServerPrefs(data)))
    })
  }

  const value = resolved.default ? 'default' : (resolved.slot_id ?? 'custom')
  return (
    <div className="flex flex-wrap items-center justify-between gap-2" data-anchor-row="day_start">
      <div className="min-w-0">
        <div className="text-sm">Day starts at</div>
        {description && (
          <div className="text-xs text-zinc-500 dark:text-zinc-400">{description}</div>
        )}
        <div className="text-xs text-zinc-600 dark:text-zinc-300" data-anchor-summary>
          {dayStartLabel(resolved)}
        </div>
      </div>
      <div className="flex max-w-full min-w-0 flex-wrap items-center justify-end gap-2">
        <select
          aria-label="Day starts at: follows"
          value={value}
          onChange={(e) => {
            const picked = e.target.value
            if (picked === 'default') save(null)
            else if (picked === 'custom') save({ time: resolved.time, slot_id: null })
            else save({ time: resolved.time, slot_id: Number(picked) })
          }}
          className={`${SELECT_CLASS} max-w-full min-w-0`}
        >
          <option value="default">Default ({formatClockTime(DEFAULT_DAY_START)})</option>
          <option value="custom">Custom time</option>
          {slots.map((slot) => (
            <option key={slot.id} value={slot.id}>
              {slot.label} ({formatClockTime(slot.start_time)})
            </option>
          ))}
        </select>
        {value === 'custom' && (
          <input
            type="time"
            aria-label="Day starts at"
            value={resolved.time}
            onChange={(e) => {
              if (e.target.value) save({ time: e.target.value, slot_id: null })
            }}
            className={SELECT_CLASS}
          />
        )}
      </div>
    </div>
  )
}
