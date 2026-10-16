import { cn } from '@/lib/utils'

/**
 * The Reminders screen's day bar, as a track and a fill — the one bar look
 * the app's "how far along" readouts share.
 *
 * Lifted out of `RemindersHeadline`'s `DayBarButton` (2026-10-16) so the
 * Quotas surface could wear exactly the same bar. Trent, looking at the
 * quota period headings' thin 5px grey track: "What's up with that hideous
 * today bar? … we have nice-looking bars and progress elsewhere, like on the
 * reminders screen." So there is one definition now, not two that drift: an
 * 8px fully rounded `bg-muted` track, an indigo fill while it is filling and
 * green the moment it is done (the 2026-09-22 rule — blue says "filling",
 * green says "finished"), the same in both themes, easing over 500ms.
 *
 * `DayBarTrack` is a plain span; its caller adds anything else it needs
 * (a hover shade, a focus ring, a `role="progressbar"`) through `className`
 * and props.
 */
export function DayBarTrack({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...rest}
      className={cn('bg-muted relative block h-2 overflow-hidden rounded-full', className)}
    >
      {children}
    </span>
  )
}

/**
 * The fill inside a `DayBarTrack`: `fraction` of the width (clamped to 0–1),
 * indigo while filling, green when `done`. `color` replaces the indigo while
 * filling — a task segment's teal on the Reminders day bar — and never the
 * green.
 */
export function DayBarFill({
  fraction,
  done,
  color,
}: {
  fraction: number
  done: boolean
  color?: string
}) {
  const width = Math.max(0, Math.min(1, fraction)) * 100
  return (
    <span
      aria-hidden="true"
      className={cn(
        'block h-full rounded-full transition-[width,background-color] duration-500 ease-out',
        done ? 'bg-green-600' : 'bg-indigo-600',
      )}
      style={{ width: `${width}%`, ...(color && !done ? { backgroundColor: color } : {}) }}
    />
  )
}
