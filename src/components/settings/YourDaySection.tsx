'use client'

import {
  useAnchorTimes,
  useWeekStart,
  useCheckInDay,
  useTaskQueue,
} from '@/components/PreferencesProvider'
import type { WeekStart } from '@/lib/week-start'
import { coerceCheckInDay, type CheckInDay } from '@/lib/task-segments'
import { CHECK_IN_DAY_NAMES } from '@/lib/task-model-words'
import { savePreferenceField } from '@/lib/save-preference'
import { resolveTime } from '@/lib/anchor-times'
import type { TimeSlot } from '@/lib/time-slot-assign'
import { SettingsSection } from './SettingsSection'
import { SettingRow } from './SettingRow'
import { AnchorTimeRow } from './AnchorTimeRow'
import { DayStartRow } from './DayStartRow'

const SELECT_CLASS =
  'rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900'

/** The check-in day's choices, Sunday first like the week-start select. */
const CHECK_IN_DAY_ORDER: CheckInDay[] = [7, 1, 2, 3, 4, 5, 6]

/**
 * Settings → Your day (Trent, 2026-10-24: "Why is this all listed under
 * defer?"): when the day and the week begin, and the times of day the app
 * fills in — Day starts at, Wake time, Default task time (`morning_time`,
 * "Morning time" until 10-24), Sleep time, Week starts on, Check-in day.
 *
 * `timeSlots` is the page's one period list (src/app/settings/page.tsx),
 * shared with Reminder periods, so a period added, renamed or moved there
 * shows in these pickers at once. The time rows wait for `rowsReady`
 * (the page's `useFreshAnchorTimes` plus a loaded period list); the two
 * selects below them don't depend on either.
 *
 * Day starts at shows only with the server's task-queue switch on: with it
 * off the day turns at midnight whatever the setting says (`useDayStart`), so
 * the row would change nothing. Like the Advanced fold
 * (src/components/settings/AdvancedSection.tsx) it waits for `useTaskQueue`'s
 * `loaded`, so it never draws on the provider's fallback (off). The other
 * three time rows wait for it too: `rowsReady` comes from a separate read
 * (`useFreshAnchorTimes`) that can land first, and Day starts at must not pop
 * in above rows already drawn.
 */
export function YourDaySection({
  timeSlots,
  rowsReady,
}: {
  timeSlots: TimeSlot[]
  rowsReady: boolean
}) {
  const anchors = useAnchorTimes()
  // Wake = Sleep reads as awake all day (no quiet hours, nags all day) —
  // allowed, as it always was with custom times, but said.
  const sameWakeSleep =
    resolveTime(anchors.wake, timeSlots).time === resolveTime(anchors.sleep, timeSlots).time
  const { weekStart, setWeekStart } = useWeekStart()
  const { checkInDay, setCheckInDay } = useCheckInDay()
  const queue = useTaskQueue()
  const timeRowsReady = rowsReady && queue.loaded

  return (
    <SettingsSection
      title="Your day"
      description="When your day and week begin, and the times of day OpenTask uses for you."
    >
      <div className="space-y-4">
        {timeRowsReady && (
          <>
            {/* Trent, 2026-10-23: one day boundary everywhere, his at 3:00 AM.
                Task queue only: with the switch off the day turns at midnight. */}
            {queue.enabled && (
              <DayStartRow
                description="When a new day begins — for Today, reminders, quotas, decks and the task rollover. Before noon, a late night counts as the day before; after noon, the next day starts early (at 11 PM, Sunday 11:30 PM is Monday)."
                timeSlots={timeSlots}
              />
            )}
            <AnchorTimeRow
              label="Wake time"
              description="When you wake (AI uses it for time-of-day context)."
              target="wake"
              timeSlots={timeSlots}
            />
            <AnchorTimeRow
              label="Default task time"
              description="The time tasks use when you don’t give one: defer to tomorrow morning, AI enrichment, and relative targets."
              target="morning"
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
      </div>
    </SettingsSection>
  )
}
