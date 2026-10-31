import { useLayoutEffect } from 'react'
import { landOnTasksOnce } from '@/lib/dashboard-landing'

/**
 * The Dashboard's first visit since launch lands on the tasks
 * (src/lib/dashboard-landing.ts). A LAYOUT effect, on the dashboard's first
 * render with data: the scroll happens before that render is painted, so the
 * top never shows first.
 */
export function useLandOnTasks(): void {
  useLayoutEffect(() => landOnTasksOnce(), [])
}
