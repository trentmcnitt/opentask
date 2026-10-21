'use client'

import { OVER_TARGET_LOWER } from '@/lib/task-model-words'
import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  useSnoozePreferences,
  useSchedulePreferences,
  useWeekStart,
  useCheckInDay,
} from '@/components/PreferencesProvider'
import type { BulkSnoozeDefault } from '@/components/PreferencesProvider'
import type { WeekStart } from '@/lib/week-start'
import { coerceCheckInDay, type CheckInDay } from '@/lib/task-segments'
import { CHECK_IN_DAY_NAMES } from '@/lib/task-model-words'
import { savePreferenceField } from '@/lib/save-preference'
import { formatSnoozeOptionLabel, formatMorningTime, NEXT_PERIOD_OPTION } from '@/lib/snooze'
import { SettingsSection } from './SettingsSection'
import { SettingRow } from './SettingRow'
import { RolloverNowRow } from './RolloverNowRow'

const SELECT_CLASS =
  'rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900'

/** A time-of-day input that saves on change (an emptied field is ignored). */
function TimeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="time"
      value={value}
      onChange={(e) => {
        if (e.target.value) onChange(e.target.value)
      }}
      className={SELECT_CLASS}
    />
  )
}

/**
 * Settings → Snooze: the single-tap snooze duration, the snooze-all button's
 * target, and the day's anchor times (morning, wake, sleep) plus the week's
 * first day.
 */
export function SnoozeSection() {
  const { bulkSnoozeDefault, setBulkSnoozeDefault, morningTime, setMorningTime } =
    useSnoozePreferences()
  const { wakeTime, setWakeTime, sleepTime, setSleepTime } = useSchedulePreferences()
  const { weekStart, setWeekStart } = useWeekStart()
  const { checkInDay, setCheckInDay } = useCheckInDay()

  return (
    <SettingsSection
      title="Snooze"
      description="Configure the default snooze duration and morning start time."
    >
      <div className="space-y-4">
        <DefaultSnoozeRow />
        {/* Trent, 2026-09-22: the clock press defaults to the next
            period, with this to flip back while he decides. */}
        <SettingRow
          label="Snooze-all button"
          description={`Where a tap of the clock sends every ${OVER_TARGET_LOWER} task`}
        >
          <select
            aria-label="Snooze-all button"
            value={bulkSnoozeDefault}
            onChange={(e) =>
              void savePreferenceField(
                'bulk_snooze_default',
                e.target.value as BulkSnoozeDefault,
                bulkSnoozeDefault,
                setBulkSnoozeDefault,
              )
            }
            className={SELECT_CLASS}
          >
            <option value="next_period">Next period</option>
            <option value="default_option">Default snooze</option>
          </select>
        </SettingRow>
        <SettingRow
          label="Morning time"
          description="Default task time for snooze and AI enrichment, and a deadline's automatic target"
        >
          <TimeInput
            value={morningTime}
            onChange={(v) => savePreferenceField('morning_time', v, morningTime, setMorningTime)}
          />
        </SettingRow>
        <SettingRow
          label="Wake time"
          description="When your day starts (used by AI for time-of-day context)"
        >
          <TimeInput
            value={wakeTime}
            onChange={(v) => savePreferenceField('wake_time', v, wakeTime, setWakeTime)}
          />
        </SettingRow>
        <SettingRow
          label="Sleep time"
          description={
            <>When you go to bed (used by AI for &ldquo;tonight&rdquo; and &ldquo;bedtime&rdquo;)</>
          }
        >
          <TimeInput
            value={sleepTime}
            onChange={(v) => savePreferenceField('sleep_time', v, sleepTime, setSleepTime)}
          />
        </SettingRow>
        {/* Trent, 2026-09-27: Sunday, so Saturday is the last day to do a
            week's quotas. Moves every weekly quota's boundary. The server
            closes any weekly quota period the new boundary ends before it
            answers (see the preferences route), so a refresh after this shows
            the new week; open dashboards pick it up from the sync event it
            emits. */}
        <SettingRow label="Week starts on" description="When weekly quotas reset">
          <select
            aria-label="Week starts on"
            data-week-start-select
            value={weekStart}
            onChange={(e) =>
              void savePreferenceField(
                'week_start',
                e.target.value as WeekStart,
                weekStart,
                setWeekStart,
              )
            }
            className={SELECT_CLASS}
          >
            <option value="sunday">Sunday</option>
            <option value="monday">Monday</option>
          </select>
        </SettingRow>
        {/* The check-in day (2026-10-12, spec §3): the weekday the Weeks,
            Months and Eventually task segments come round on. Its own
            setting, independent of the quota week above; Upcoming ignores it. */}
        <SettingRow
          label="Check-in day"
          description="When Weeks tasks come round; Months and Eventually on the first one"
        >
          <select
            aria-label="Check-in day"
            data-check-in-day-select
            value={checkInDay}
            onChange={(e) =>
              void savePreferenceField(
                'check_in_day',
                coerceCheckInDay(Number(e.target.value)),
                checkInDay,
                setCheckInDay,
              )
            }
            className={SELECT_CLASS}
          >
            {CHECK_IN_DAY_ORDER.map((d) => (
              <option key={d} value={d}>
                {CHECK_IN_DAY_NAMES[d]}
              </option>
            ))}
          </select>
        </SettingRow>
        <RolloverNowRow />
      </div>
    </SettingsSection>
  )
}

/** The check-in day's choices, Sunday first like the week-start select. */
const CHECK_IN_DAY_ORDER: CheckInDay[] = [7, 1, 2, 3, 4, 5, 6]

const DEFAULT_SNOOZE_PRESETS = ['30', '60', '120', NEXT_PERIOD_OPTION, 'tomorrow']

/**
 * The single-tap snooze duration: a preset select whose "Custom..." swaps in
 * a minutes field (1-1440) with Set / Cancel. A saved custom value shows as
 * its own option.
 */
function DefaultSnoozeRow() {
  const { defaultSnoozeOption, setDefaultSnoozeOption, morningTime } = useSnoozePreferences()
  const [customMinutes, setCustomMinutes] = useState('')
  const [showCustom, setShowCustom] = useState(false)

  const save = (value: string) =>
    savePreferenceField('default_snooze_option', value, defaultSnoozeOption, setDefaultSnoozeOption)

  const applyCustom = () => {
    const val = parseInt(customMinutes, 10)
    if (val >= 1 && val <= 1440) {
      save(String(val))
      setShowCustom(false)
    }
  }

  const isPreset = DEFAULT_SNOOZE_PRESETS.includes(defaultSnoozeOption)

  return (
    <SettingRow
      label="Default snooze"
      description={`Where a single tap or swipe snoozes an ${OVER_TARGET_LOWER} task`}
    >
      {showCustom ? (
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            max={1440}
            value={customMinutes}
            onChange={(e) => setCustomMinutes(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyCustom()
              if (e.key === 'Escape') setShowCustom(false)
            }}
            className="h-8 w-20 text-sm"
            placeholder="min"
            autoFocus
          />
          <Button size="sm" variant="outline" className="h-8" onClick={applyCustom}>
            Set
          </Button>
          <Button size="sm" variant="ghost" className="h-8" onClick={() => setShowCustom(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <select
          aria-label="Default snooze"
          value={isPreset ? defaultSnoozeOption : 'custom'}
          onChange={(e) => {
            const val = e.target.value
            if (val === 'custom') {
              // Seed the minutes field only from a minute count.
              setCustomMinutes(/^\d+$/.test(defaultSnoozeOption) ? defaultSnoozeOption : '')
              setShowCustom(true)
            } else {
              save(val)
            }
          }}
          className={SELECT_CLASS}
        >
          <option value="30">30 min</option>
          <option value="60">1 hour</option>
          <option value="120">2 hours</option>
          {/* The start of the next reminder period (2026-10-10) — later today,
              or tomorrow's first once the day's last has begun; +1 hour with
              no periods. Same target as the snooze menu's "Next period". */}
          <option value={NEXT_PERIOD_OPTION}>Next period</option>
          <option value="tomorrow">Tomorrow at {formatMorningTime(morningTime)}</option>
          {!isPreset && (
            <option value={defaultSnoozeOption}>
              {formatSnoozeOptionLabel(defaultSnoozeOption, morningTime)}
            </option>
          )}
          <option value="custom">Custom...</option>
        </select>
      )}
    </SettingRow>
  )
}
