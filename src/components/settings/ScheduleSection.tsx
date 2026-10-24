'use client'

import { TimeSlotSettings } from '@/components/TimeSlotSettings'
import { QuotaPromptSettings } from '@/components/QuotaPromptSettings'
import type { TimeSlot } from '@/lib/time-slot-assign'
import { SettingsSection } from './SettingsSection'

/**
 * Settings → Reminder periods: the user's time slots
 * (src/components/TimeSlotSettings.tsx), then the default period and the
 * quota-reminders switch (src/components/QuotaPromptSettings.tsx).
 *
 * The slot list is read once, by the Settings page, and handed to both (and
 * to Snooze, whose anchor times can follow a period). Each used to read its
 * own copy, so renaming or adding a period left the Default reminder period picker
 * showing the old list until the page was reloaded.
 */
export function ScheduleSection({
  timeSlots,
  loading,
  refresh,
}: {
  timeSlots: TimeSlot[]
  loading: boolean
  refresh: () => Promise<void>
}) {
  return (
    <SettingsSection
      title="Reminder periods"
      description="The parts of your day. Reminders are grouped into these and arrive together when each one starts. Moving or removing a period takes its reminders with it."
    >
      <TimeSlotSettings timeSlots={timeSlots} loading={loading} refresh={refresh} />
      <QuotaPromptSettings timeSlots={timeSlots} />
    </SettingsSection>
  )
}
