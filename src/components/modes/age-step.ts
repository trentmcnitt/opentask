import type { CreatedBucket } from '@/lib/created-bucket'

/**
 * Scan's AGE STEPS as classes on a row's swipe foreground (`SwipeableRow`'s
 * `tone`): the greys of `AGE_STEP_GREYS`, written out whole so Tailwind sees
 * every class (a test checks they match). Today is the page itself. A row's
 * state tint (red, blue) is drawn above the foreground, so it wins; the rows'
 * hairlines sit on the step, and two steps meet with no seam.
 */
export const AGE_STEP_CLASS: Readonly<Record<CreatedBucket, string>> = {
  today: 'bg-background',
  yesterday: 'bg-[rgb(249,249,249)] dark:bg-[rgb(16,16,16)]',
  week: 'bg-[rgb(244,244,244)] dark:bg-[rgb(21,21,21)]',
  month: 'bg-[rgb(241,241,241)] dark:bg-[rgb(24,24,24)]',
  year: 'bg-[rgb(239,239,239)] dark:bg-[rgb(26,26,26)]',
  earlier: 'bg-[rgb(238,238,238)] dark:bg-[rgb(27,27,27)]',
}
