'use client'

import { usePriorityDisplay } from '@/components/PreferencesProvider'
import { priorityRowStyles, type PriorityRowStyles } from '@/lib/priority-display'

/**
 * What a row shows for `priority` under the user's Settings → Priority
 * Display — the rule in `src/lib/priority-display.ts`, read by the reminder
 * rows, the quota prompt rows and the quota chips (`TaskRow` calls it with
 * the display it already holds).
 */
export function usePriorityRowStyles(priority: number): PriorityRowStyles {
  const { priorityDisplay } = usePriorityDisplay()
  return priorityRowStyles(priority, priorityDisplay)
}
