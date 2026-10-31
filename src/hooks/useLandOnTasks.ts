import { useLayoutEffect } from 'react'
import { landOnce } from '@/lib/dashboard-landing'

/**
 * The Dashboard's first visit since launch lands on the tasks — or, from the
 * Reminders widget's general tap (`?focus=reminders`), on the Reminders card
 * (src/lib/dashboard-landing.ts). A LAYOUT effect, on the dashboard's first
 * render with data: the scroll happens before that render is painted, so the
 * top never shows first.
 */
export function useLandOnTasks(): void {
  useLayoutEffect(() => landOnce(), [])
}
