'use client'

import { OVERDUE_LOWER } from '@/lib/task-model-words'
import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useSnoozePreferences } from '@/components/PreferencesProvider'
import type { BulkSnoozeDefault } from '@/components/PreferencesProvider'
import { savePreferenceField } from '@/lib/save-preference'
import { formatSnoozeOptionLabel, formatMorningTime, NEXT_PERIOD_OPTION } from '@/lib/snooze'
import { SettingsSection } from './SettingsSection'
import { SettingRow } from './SettingRow'

const SELECT_CLASS =
  'rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900'

/**
 * Settings → Defer: where a single tap or swipe defers an overdue task
 * (Default defer) and where the clock sends all of them (Defer all button).
 * Nothing else since 2026-10-24 (Trent: "Why is this all listed under
 * defer?") — the day's times are in Your day, the pad's buttons in Number
 * pad, and Roll over now in Advanced.
 */
export function DeferSection() {
  const { bulkSnoozeDefault, setBulkSnoozeDefault } = useSnoozePreferences()

  return (
    <SettingsSection
      title="Defer"
      description={`What a single tap and the clock do with ${OVERDUE_LOWER} tasks.`}
    >
      <div className="space-y-4">
        <DefaultSnoozeRow />
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
      </div>
    </SettingsSection>
  )
}

const DEFAULT_SNOOZE_PRESETS = ['30', '60', '120', NEXT_PERIOD_OPTION, 'tomorrow']

/**
 * The single-tap defer (`default_snooze_option`): a preset select whose
 * "Custom..." swaps in a minutes field (1-1440) with Set / Cancel. A saved
 * custom value shows as its own option.
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
