import type { CreatedBucket } from '@/lib/created-bucket'

/**
 * Scan's AGE STEPS as classes on a row's swipe foreground (`SwipeableRow`'s
 * `tone`). Plain classes with literal values in globals.css (`.age-step-*`),
 * like the row tints, so Trent can tune them live in dev tools (2026-10-29);
 * a test checks they are `AGE_STEP_GREYS`. Unlayered, so they win over the
 * foreground's `bg-background`. Today is the page itself. A row's state tint
 * (red, blue) is drawn above the foreground, so it wins; the rows' hairlines
 * sit on the step, and two steps meet with no seam.
 */
export const AGE_STEP_CLASS: Readonly<Record<CreatedBucket, string>> = {
  today: 'bg-background',
  yesterday: 'age-step-yesterday',
  week: 'age-step-week',
  month: 'age-step-month',
  year: 'age-step-year',
  earlier: 'age-step-earlier',
}
