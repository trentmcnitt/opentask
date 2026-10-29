'use client'

/**
 * The lean row's LEFT CONTROL, in one place so a restyle is one file: the
 * done square — or, in selection mode, the selection checkbox in its spot
 * (the card row's rule, `TaskRow`). No consider circle: the lean row has no
 * consider.
 *
 * THE HORIZON SQUARE (`src/lib/horizon-square.ts`): on a row the horizon
 * governs, the square's border draws the horizon — Days solid (the plain
 * checkbox itself, 0.25 grey), Weeks long dashes, Months a dash mid-side,
 * Eventually dots (0.42 grey); unset looks like whatever unset means
 * (`UNSET_HORIZON`). Every other row keeps the plain checkbox. The pattern
 * is SVG on whole pixels: a 1px stroke at 1x and a 1.5px stroke at 2x, each
 * drawn only at its density, so every dash lands on the pixel grid.
 *
 * The square's hit area reaches past its 22px box (the segment rows' done
 * square, `TaskSegmentRow`): a thumb on a phone lands on it, not on the row.
 */
import { Check } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import {
  horizonGoverns,
  horizonSquareLook,
  isPlainLook,
  squarePaths,
  SQUARE_SIZE,
  type SquareLook,
} from '@/lib/horizon-square'
import { UNSET_HORIZON } from '@/lib/task-segments'
import { cn } from '@/lib/utils'
import type { Task } from '@/types'

const HIT = "after:absolute after:-inset-x-[4px] after:-inset-y-[11px] after:content-['']"

export function DoneControl({
  task,
  onDone,
  isSelectionMode,
  isSelected,
  onSelect,
}: {
  task: Task
  onDone: () => void
  isSelectionMode: boolean
  isSelected: boolean
  onSelect?: () => void
}) {
  if (isSelectionMode) {
    return (
      <Checkbox
        checked={isSelected}
        onCheckedChange={() => onSelect?.()}
        onClick={(e) => e.stopPropagation()}
        aria-label={`Select "${task.title}"`}
        className="mt-px size-[22px] shrink-0"
      />
    )
  }
  const governed = horizonGoverns(task)
  const look = governed ? horizonSquareLook(task.horizon) : null
  const patterned = look !== null && !isPlainLook(look)
  return (
    <button
      type="button"
      data-no-row-press
      data-lean-done
      data-horizon-square={governed ? (task.horizon ?? UNSET_HORIZON) : undefined}
      aria-label={`Done: "${task.title}"`}
      title="Done"
      onClick={(e) => {
        e.stopPropagation()
        onDone()
      }}
      className={cn(
        'group/done hover:bg-foreground/5 relative mt-px flex size-[22px] shrink-0 cursor-pointer items-center justify-center rounded-[5px] transition-colors',
        HIT,
        patterned
          ? 'text-foreground/[0.42] hover:text-foreground/60'
          : 'border-foreground/25 hover:border-foreground/60 border-[1.5px]',
      )}
    >
      {patterned && <SquareBorder look={look} />}
      <Check
        className="text-foreground relative size-3.5 opacity-0 transition-opacity group-hover/done:opacity-60"
        strokeWidth={3}
        aria-hidden
      />
    </button>
  )
}

/** The patterned border: one group per screen density, each on its own pixel grid. */
function SquareBorder({ look }: { look: SquareLook }) {
  return (
    <svg
      aria-hidden
      data-horizon-border
      width={SQUARE_SIZE}
      height={SQUARE_SIZE}
      viewBox={`0 0 ${SQUARE_SIZE} ${SQUARE_SIZE}`}
      fill="none"
      stroke="currentColor"
      strokeLinecap="butt"
      className="pointer-events-none absolute inset-0"
    >
      <SquareStroke look={look} width={1} className="[@media(min-resolution:1.5dppx)]:hidden" />
      <SquareStroke
        look={look}
        width={1.5}
        className="hidden [@media(min-resolution:1.5dppx)]:inline"
      />
    </svg>
  )
}

function SquareStroke({
  look,
  width,
  className,
}: {
  look: SquareLook
  width: number
  className: string
}) {
  const { arcs, sides, dots } = squarePaths(look, width)
  const dash = look.side ? look.side.join(' ') : undefined
  return (
    <g strokeWidth={width} className={className}>
      {arcs.map((d) => (
        <path key={d} d={d} />
      ))}
      {dots.map((p) => (
        <rect
          key={`${p.x},${p.y}`}
          x={p.x}
          y={p.y}
          width={p.size}
          height={p.size}
          fill="currentColor"
          stroke="none"
        />
      ))}
      {sides.map((d) => (
        <path key={d} d={d} strokeDasharray={dash} />
      ))}
    </g>
  )
}
