import type { ReactNode, Ref } from 'react'
import { cn } from '@/lib/utils'

/**
 * The surface an editor sits in.
 *
 * ON A PAGE (`/tasks/[id]`) it is the editor's one surface: a bordered card,
 * with a blue stripe down its left edge while it holds unsaved edits.
 *
 * IN A DIALOG OR A SHEET (`flat`) the dialog or sheet already IS the surface,
 * so the card draws nothing — no border, no radius, no padding — and there
 * is no stripe (2026-10-24, Trent: "a rectangle inside a rectangle"). The
 * stripe is not needed there: the Save button is disabled until there is
 * something to save and turns solid the moment there is, each changed value
 * is drawn blue, and closing with unsaved edits asks first. On a page the
 * card is the surface, so its edge keeps the stripe.
 *
 * The stripe is an inset box-shadow rather than a border so it doesn't shift
 * the content when it appears. `data-editor-surface` lets the E2E specs check
 * that a hosted editor draws no frame of its own.
 */
export function DirtyCard({
  dirty,
  flat = false,
  className,
  ref,
  children,
}: {
  dirty: boolean
  /** Hosted in a dialog or sheet: draw no frame of its own (see above). */
  flat?: boolean
  className?: string
  ref?: Ref<HTMLDivElement>
  children: ReactNode
}) {
  return (
    <div
      ref={ref}
      data-editor-surface={flat ? 'flat' : 'card'}
      className={cn(
        !flat && 'rounded-lg border p-3',
        className,
        !flat && dirty && '[box-shadow:inset_4px_0_0_rgb(59_130_246)]',
      )}
    >
      {children}
    </div>
  )
}
