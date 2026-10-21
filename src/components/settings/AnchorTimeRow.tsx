'use client'

/**
 * Settings → one of the seven ANCHOR TIMES (2026-10-21): Morning, Wake,
 * Sleep, or a number-pad button — each a custom time or linked to a reminder
 * period, which it then follows (`src/lib/anchor-times.ts`).
 *
 * The control is a select of [Custom time, …periods]; a time field appears
 * only for a custom time. Under the row's description a summary line reads
 * what the setting resolves to now — "8:30 AM · Morning period".
 *
 * Choosing "Custom time" on a linked setting unlinks it AT THE TIME IT READS,
 * so nothing jumps; the field then edits it. The save is optimistic: the row
 * shows the new value at once (resolved against the page's period list by
 * the same rule the server uses), then takes the server's answer, or puts the
 * old value back on a failure.
 */

import { useAnchorTimes } from '@/components/PreferencesProvider'
import { anchorPrefsOf, parseServerPrefs, type AnchorPrefs } from '@/lib/preferences-state'
import { savePreference } from '@/lib/save-preference'
import { anchorLabel, resolveTime, type AnchorKey, type TimeSetting } from '@/lib/anchor-times'
import { sortSlotsByStart, type TimeSlot } from '@/lib/time-slot-assign'
import { formatClockTime } from '@/lib/time-utils'

const SELECT_CLASS =
  'rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900'

/** Which setting a row edits: an anchor by key, a pad button by its 0-based index. */
export type AnchorTarget = AnchorKey | number

/** The wire form of one setting: a link sends only its period, a custom time only its time. */
function toWire(s: TimeSetting): { slot_id: number } | { time: string } {
  return s.slot_id !== null ? { slot_id: s.slot_id } : { time: s.time }
}

/** The Prefs fields that hold `target`, set to `value`. */
function prefsFor(
  target: AnchorTarget,
  value: TimeSetting,
  pad: TimeSetting[],
): Partial<AnchorPrefs> {
  if (typeof target === 'number') {
    return { padPresets: pad.map((p, i) => (i === target ? value : p)) }
  }
  const values: Partial<AnchorPrefs> = {}
  values[`${target}Time`] = value.time
  values[`${target}SlotId`] = value.slot_id
  return values
}

export function AnchorTimeRow({
  label,
  description,
  target,
  timeSlots,
}: {
  label: string
  description?: string
  target: AnchorTarget
  timeSlots: TimeSlot[]
}) {
  const anchors = useAnchorTimes()
  const current: TimeSetting = typeof target === 'number' ? anchors.pad[target] : anchors[target]
  const resolved = resolveTime(current, timeSlots)
  const slots = sortSlotsByStart(timeSlots)

  const save = (next: TimeSetting) => {
    const body =
      typeof target === 'number'
        ? // One button per PATCH: the other three are left as the SERVER has
          // them, never echoed from this page's copy, which can be stale.
          { pad_preset: { index: target, ...toWire(next) } }
        : next.slot_id !== null
          ? { [`${target}_slot_id`]: next.slot_id }
          : { [`${target}_time`]: next.time }
    const optimistic = resolveTime(next, timeSlots)
    void savePreference(body, {
      apply: () =>
        anchors.setAnchorPrefs(
          prefsFor(target, { time: optimistic.time, slot_id: optimistic.slot_id }, anchors.pad),
        ),
      revert: () => anchors.setAnchorPrefs(prefsFor(target, current, anchors.pad)),
    }).then((data) => {
      if (data) anchors.setAnchorPrefs(anchorPrefsOf(parseServerPrefs(data)))
    })
  }

  const selectLabel = `${label}: follows`
  return (
    <div className="flex flex-wrap items-center justify-between gap-2" data-anchor-row={target}>
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {description && (
          <div className="text-xs text-zinc-500 dark:text-zinc-400">{description}</div>
        )}
        <div className="text-xs text-zinc-600 dark:text-zinc-300" data-anchor-summary>
          {anchorLabel(resolved)}
        </div>
      </div>
      <div className="flex max-w-full min-w-0 flex-wrap items-center justify-end gap-2">
        <select
          aria-label={selectLabel}
          value={resolved.slot_id ?? 'custom'}
          onChange={(e) => {
            const value = e.target.value
            if (value === 'custom') save({ time: resolved.time, slot_id: null })
            else save({ time: resolved.time, slot_id: Number(value) })
          }}
          className={`${SELECT_CLASS} max-w-full min-w-0`}
        >
          <option value="custom">Custom time</option>
          {slots.map((slot) => (
            <option key={slot.id} value={slot.id}>
              {slot.label} ({formatClockTime(slot.start_time)})
            </option>
          ))}
        </select>
        {resolved.slot_id === null && (
          <input
            type="time"
            aria-label={label}
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
