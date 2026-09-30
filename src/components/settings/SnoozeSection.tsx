'use client'

import { useState, type ReactNode } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  useSnoozePreferences,
  useSchedulePreferences,
  useWeekStart,
} from '@/components/PreferencesProvider'
import type { BulkSnoozeDefault } from '@/components/PreferencesProvider'
import type { WeekStart } from '@/lib/week-start'
import { savePreferenceField } from '@/lib/save-preference'
import { formatSnoozeOptionLabel, formatMorningTime } from '@/lib/snooze'
import { SettingsSection } from './SettingsSection'

const SELECT_CLASS =
  'rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900'

function SettingRow({
  label,
  description,
  children,
}: {
  label: string
  description: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <div className="text-sm">{label}</div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">{description}</div>
      </div>
      {children}
    </div>
  )
}

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
          description="Where a tap of the clock sends every overdue task"
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
          description="Default task time for snooze and AI enrichment"
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
      </div>
    </SettingsSection>
  )
}

const DEFAULT_SNOOZE_PRESETS = ['30', '60', '120', 'tomorrow']

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
    <SettingRow label="Default snooze" description="Duration used for single-tap snooze">
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
          value={isPreset ? defaultSnoozeOption : 'custom'}
          onChange={(e) => {
            const val = e.target.value
            if (val === 'custom') {
              setCustomMinutes(defaultSnoozeOption !== 'tomorrow' ? defaultSnoozeOption : '')
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
