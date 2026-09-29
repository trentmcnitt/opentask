import type { ReactNode, Ref } from 'react'
import { cn } from '@/lib/utils'

/**
 * The bordered card every editor sits in, with the blue stripe down its left
 * edge while it holds unsaved edits — the one cue, on every surface (task
 * page, dashboard popover, create panel, selection sheet, the Reminders and
 * Quotas modals), that there is something to save. An inset box-shadow rather
 * than a border so the stripe doesn't shift the content when it appears.
 */
export function DirtyCard({
  dirty,
  className,
  ref,
  children,
}: {
  dirty: boolean
  className?: string
  ref?: Ref<HTMLDivElement>
  children: ReactNode
}) {
  return (
    <div
      ref={ref}
      className={cn(
        'rounded-lg border p-3',
        className,
        dirty && '[box-shadow:inset_4px_0_0_rgb(59_130_246)]',
      )}
    >
      {children}
    </div>
  )
}
