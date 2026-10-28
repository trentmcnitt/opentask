import { Flag } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * THE TIME CHIPS (Trent, 2026-10-28, mockup "C-blue"): every target and
 * deadline time on a task row is a small box of one shape, in its KIND's
 * colour — "a target should be a certain color and a deadline should be a
 * certain color".
 *
 *   target    blue box, the time alone ("Tomorrow 7:00 AM", "Fri 9:00 AM")
 *   over      plum box: the target has passed (the row's plum stripe agrees)
 *   deadline  teal box with a flag ("⚑ Deadline Mon")
 *   today     solid teal: the deadline is today
 *   passed    red box with a flag: the deadline has passed
 *
 * One rule for which tone a deadline wears (`deadlineChip`'s), one for a
 * target (over target or not). Every row draws through this: the dashboard
 * row (`TargetTimeText`, `DeadlineChip`) and the task-segment rows.
 *
 * Contrast (text on its own tint, light / dark): blue-600 4.5 / blue-400 6.3;
 * plum #8e389b 5.6 / the token 5.7; teal-700 / teal-400 and the solid teal
 * are checked by `deadlines-page.spec.ts`; red-700 / red-400 5.4 / 6.6.
 */
export type TimeChipTone = 'target' | 'over' | 'deadline' | 'today' | 'passed'

const TONE: Record<TimeChipTone, string> = {
  target: 'bg-blue-600/10 text-blue-600 dark:bg-blue-400/15 dark:text-blue-400',
  // The plum token on its own tint is 4.3:1 in light; the text goes a step
  // darker there (oklch 0.50 0.17 322).
  over: 'bg-over-target/12 text-[#8e389b] dark:bg-over-target/15 dark:text-over-target',
  deadline: 'bg-teal-700/10 text-teal-700 dark:bg-teal-400/12 dark:text-teal-400',
  today: 'bg-teal-700 text-white dark:bg-teal-400 dark:text-teal-950',
  passed: 'bg-destructive/10 text-red-700 dark:text-red-400',
}

/** The flag marks a deadline's chip, whatever its tone. */
const FLAGGED: ReadonlySet<TimeChipTone> = new Set(['deadline', 'today', 'passed'])

export function timeChipClasses(tone: TimeChipTone, className?: string): string {
  return cn(
    'inline-flex shrink-0 items-center gap-[3px] rounded px-1 font-semibold whitespace-nowrap',
    TONE[tone],
    className,
  )
}

export function TimeChip({
  tone,
  children,
  className,
  title,
  ...data
}: {
  tone: TimeChipTone
  children: React.ReactNode
  className?: string
  title?: string
} & { [key: `data-${string}`]: string | undefined }) {
  return (
    <span
      data-time-chip={tone}
      className={timeChipClasses(tone, className)}
      title={title}
      {...data}
    >
      {FLAGGED.has(tone) && <Flag aria-hidden className="size-3 shrink-0" strokeWidth={2.5} />}
      {children}
    </span>
  )
}
