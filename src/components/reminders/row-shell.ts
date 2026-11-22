/**
 * The pieces of a reminder-surface row's shell that `ReminderRow`
 * (`ReminderRow.tsx`) and `QuotaPromptRow` share: where focus goes when a
 * row leaves, and what an animation ending on the row means. The rows
 * themselves differ on purpose (sizes, gestures, what they stand for); these
 * two rules must not.
 */

/**
 * Move focus off a row that is about to be considered: the next row, else the
 * one before it, else the slot's own header. Keyboard work down a slot should
 * carry on where it was, and focus must never end up on <body>.
 */
export function focusAfterRow(row: HTMLElement): void {
  const next = row.nextElementSibling as HTMLElement | null
  const prev = row.previousElementSibling as HTMLElement | null
  const header = row
    .closest('[data-slot-group]')
    ?.querySelector<HTMLElement>('button[aria-expanded]')
  ;(next ?? prev ?? header)?.focus()
}

/**
 * What an animation ending on a row MEANS: the deep link's flash is spent once
 * it has played (`row-highlight` → `onHighlightDone`). The name is checked
 * rather than assumed — the row's other animations (the AI pulse) end here too.
 */
export function onSurfaceRowAnimationEnd(
  e: React.AnimationEvent,
  { onHighlightDone }: { onHighlightDone?: () => void },
): void {
  if (e.target !== e.currentTarget) return
  if (e.animationName === 'row-highlight') onHighlightDone?.()
}
