'use client'

import { OVERDUE_LOWER } from '@/lib/task-model-words'
import { useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  useAnchorTimes,
  useSnoozePreferences,
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
import { AnchorTimeRow } from './AnchorTimeRow'
import { DayStartRow } from './DayStartRow'
import { PAD_PRESET_COUNT, padButtonName, resolveTime } from '@/lib/anchor-times'
import type { TimeSlot } from '@/lib/time-slot-assign'

const SELECT_CLASS =
  'rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900'

/**
 * Settings → Snooze: the single-tap snooze duration, the snooze-all button's
 * target, the number pad's four buttons, and the day's anchor times (morning,
 * wake, sleep) plus the week's first day.
 *
 * `timeSlots` is the page's one period list (src/app/settings/page.tsx),
 * shared with Reminder periods, so a period added, renamed or moved there
 * shows in these pickers at once. The anchor rows wait for a SUCCESSFUL read
 * of it (`slotsLoaded`) AND for their own fresh read of the anchor times on
 * opening (`anchorsFresh`): before that the provider may hold its defaults or
 * a value another tab has since changed, and a row drawn then showed
 * "Morning · 9:00 AM, Custom time" for a linked Morning (seen on dev,
 * 2026-10-21) — and a pick made in that moment would have saved from it.
 */
export function SnoozeSection({
  timeSlots,
  slotsLoaded,
}: {
  timeSlots: TimeSlot[]
  slotsLoaded: boolean
}) {
  const { bulkSnoozeDefault, setBulkSnoozeDefault } = useSnoozePreferences()
  const anchors = useAnchorTimes()
  const { reloadPreferences } = anchors
  const [anchorsFresh, setAnchorsFresh] = useState(false)
  // Read on opening, and again whenever the window comes back into focus — a
  // period or setting changed in another tab or on another device shows here
  // before the user edits from a stale copy.
  useEffect(() => {
    let cancelled = false
    const reload = () =>
      void reloadPreferences().then((ok) => {
        if (!cancelled && ok) setAnchorsFresh(true)
      })
    reload()
    window.addEventListener('focus', reload)
    return () => {
      cancelled = true
      window.removeEventListener('focus', reload)
    }
  }, [reloadPreferences])
  const rowsReady = slotsLoaded && anchorsFresh
  // Wake = Sleep reads as awake all day (no quiet hours, nags all day) —
  // allowed, as it always was with custom times, but said.
  const sameWakeSleep =
    resolveTime(anchors.wake, timeSlots).time === resolveTime(anchors.sleep, timeSlots).time
  const { weekStart, setWeekStart } = useWeekStart()
  const { checkInDay, setCheckInDay } = useCheckInDay()

  return (
    <SettingsSection
      title="Defer"
      description="Configure the default defer duration, the morning start time and when the day starts."
    >
      <div className="space-y-4">
        <DefaultSnoozeRow />
        {rowsReady && <NumberPadRows timeSlots={timeSlots} />}
        {/* Trent, 2026-09-22: the clock press defaults to the next
            period, with this to flip back while he decides. */}
        <SettingRow
          label="Defer all button"
          description={`Where a tap of the clock sends every ${OVERDUE_LOWER} task`}
        >
          <select
            aria-label="Defer all button"
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
            <option value="default_option">Default defer</option>
          </select>
        </SettingRow>
        {rowsReady && (
          <>
            <AnchorTimeRow
              label="Morning time"
              description="Default task time for defer and AI enrichment, and a deadline's automatic target. Targets already set keep their time."
              target="morning"
              timeSlots={timeSlots}
            />
            <AnchorTimeRow
              label="Wake time"
              description="When you wake (used by AI for time-of-day context)"
              target="wake"
              timeSlots={timeSlots}
            />
            <AnchorTimeRow
              label="Sleep time"
              description="When you go to bed (used by AI for “tonight” and “bedtime”)"
              target="sleep"
              timeSlots={timeSlots}
            />
            {sameWakeSleep && (
              <p className="text-xs text-amber-700 dark:text-amber-400" data-wake-sleep-warning>
                Wake and Sleep are the same time, so you&rsquo;re never asleep: hourly reminders and
                widget updates run all day.
              </p>
            )}
            {/* Trent, 2026-10-23: one day boundary everywhere, his at 3:00 AM.
                "Day starts at" PR 2 (10-24): everything uses it — Today, Upcoming,
                quota weeks and months, decks, History. The copy covers both
                directions (the naming convention, opentask-day.ts): before noon
                the late night keeps the day before; after noon the next day
                starts early. Midnight is the calendar day. */}
            <DayStartRow
              description="When a new day begins — for Today, reminders, quotas, decks and the task rollover. Before noon, a late night counts as the day before; after noon, the next day starts early (at 11 PM, Sunday 11:30 PM is Monday)."
              timeSlots={timeSlots}
            />
          </>
        )}
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

/**
 * The number pad's four preset buttons (the quick panel's first row), each a
 * custom time or a reminder period it follows. Kept in their positions, never
 * sorted: a period moving past another shouldn't reshuffle the pad.
 */
function NumberPadRows({ timeSlots }: { timeSlots: TimeSlot[] }) {
  return (
    <div className="space-y-3" data-number-pad-settings>
      <div>
        <div className="text-sm">Number pad</div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          The quick panel&rsquo;s four preset times
        </div>
      </div>
      {Array.from({ length: PAD_PRESET_COUNT }, (_, i) => (
        <AnchorTimeRow key={i} label={padButtonName(i)} target={i} timeSlots={timeSlots} />
      ))}
    </div>
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
      label="Default defer"
      description={`Where a single tap or swipe defers an ${OVERDUE_LOWER} task`}
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
          aria-label="Default defer"
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
