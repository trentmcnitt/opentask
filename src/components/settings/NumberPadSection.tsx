'use client'

import { PAD_PRESET_COUNT, padButtonName } from '@/lib/anchor-times'
import type { TimeSlot } from '@/lib/time-slot-assign'
import { SettingsSection } from './SettingsSection'
import { AnchorTimeRow } from './AnchorTimeRow'

/**
 * Settings → Number pad: the quick panel's four preset buttons (its first
 * row), each a custom time or a reminder period it follows. Kept in their
 * positions, never sorted: a period moving past another shouldn't reshuffle
 * the pad. Its own section since 2026-10-24 (it sat under Defer).
 *
 * The rows wait for `rowsReady`, like Your day's (src/app/settings/page.tsx).
 */
export function NumberPadSection({
  timeSlots,
  rowsReady,
}: {
  timeSlots: TimeSlot[]
  rowsReady: boolean
}) {
  return (
    <SettingsSection
      title="Number pad"
      description="The quick panel’s four preset times. Each is its own time or follows a reminder period."
    >
      {rowsReady && (
        <div className="space-y-3" data-number-pad-settings>
          {Array.from({ length: PAD_PRESET_COUNT }, (_, i) => (
            <AnchorTimeRow key={i} label={padButtonName(i)} target={i} timeSlots={timeSlots} />
          ))}
        </div>
      )}
    </SettingsSection>
  )
}
