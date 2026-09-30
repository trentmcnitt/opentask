'use client'

import { TimeSlotSettings } from '@/components/TimeSlotSettings'
import { QuotaPromptSettings } from '@/components/QuotaPromptSettings'
import { SettingsSection } from './SettingsSection'

/**
 * Settings → Reminder periods: the user's time slots
 * (src/components/TimeSlotSettings.tsx), then the default period and the
 * quota-reminders switch (src/components/QuotaPromptSettings.tsx).
 */
export function ScheduleSection() {
  return (
    <SettingsSection
      title="Reminder periods"
      description="The parts of your day. Reminders are grouped into these and arrive together when each one starts. Moving or removing a period takes its reminders with it."
    >
      <TimeSlotSettings />
      <QuotaPromptSettings />
    </SettingsSection>
  )
}
