import { LABEL_COLORS } from '@/lib/label-colors'
import type { LabelColor } from '@/types'

/** A round color swatch button — the color pickers in Labels and Projects. */
export function ColorDot({
  color,
  selected,
  onClick,
  ariaLabel,
}: {
  color: LabelColor
  selected: boolean
  onClick: () => void
  ariaLabel: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`size-5 rounded-full ${LABEL_COLORS[color].dot} transition-transform ${
        selected
          ? 'ring-2 ring-zinc-400 ring-offset-1 ring-offset-white dark:ring-offset-zinc-950'
          : 'hover:scale-110'
      }`}
      aria-label={ariaLabel}
    />
  )
}
