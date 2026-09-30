/**
 * The pieces of a reminder-surface row's shell that `ReminderRow`
 * (`ReminderRow.tsx`) and `QuotaPromptRow` share: where focus goes when a
 * row leaves, the height its leaving animation collapses from, and what an
 * animation ending on the row means. The rows themselves differ on purpose
 * (sizes, gestures, what they stand for); these three rules must not.
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
 * Hand the leaving animation the height it has to collapse from.
 *
 * A callback ref rather than an effect: React attaches refs during the commit,
 * before the browser paints, so the row is measured at full size and the first
 * painted frame of the animation already has the value. An effect would run
 * after paint and leave one frame at `height: auto`.
 */
export const measureLeavingRow = (el: HTMLElement | null) => {
  if (el) el.style.setProperty('--reminder-row-h', `${el.offsetHeight}px`)
}

/**
 * What an animation ending on a row MEANS. The list closes the gap only once
 * the row has visibly gone (`reminder-leaving` → `onLeft`), and the deep
 * link's flash is spent once it has played (`row-highlight` →
 * `onHighlightDone`); both arrive here, so the name is checked rather than
 * assumed. A row that leaves while still flashing spends the flash too.
 *
 * `id` is whatever the surface tracks the row by — a reminder's task id, a
 * quota prompt's `prompt_key`.
 */
export function onSurfaceRowAnimationEnd<Id>(
  e: React.AnimationEvent,
  {
    id,
    highlighted,
    onLeft,
    onHighlightDone,
  }: {
    id: Id
    highlighted: boolean
    onLeft?: (id: Id) => void
    onHighlightDone?: () => void
  },
): void {
  if (e.target !== e.currentTarget) return
  if (e.animationName === 'reminder-leaving') {
    if (highlighted) onHighlightDone?.()
    onLeft?.(id)
  } else if (e.animationName === 'row-highlight') {
    onHighlightDone?.()
  }
}
