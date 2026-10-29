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
 * CHANGING THE HORIZON (Trent, 2026-10-28, option A): on a governed row a
 * press-and-hold on the square (right-click on desktop) opens the horizon
 * menu (`HorizonMenuContent`, the editor chip's own); a tap still completes.
 * An ungoverned row's square is only done: holding it does nothing. The menu
 * anchors on a non-interactive span inside the square, so Radix's own
 * open-on-press never competes with the tap.
 *
 * The square's hit area reaches past its 22px box (the segment rows' done
 * square, `TaskSegmentRow`): a thumb on a phone lands on it, not on the row.
 */
import { useState } from 'react'
import { Check } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { HorizonMenuContent } from '@/components/HorizonDot'
import { useSimpleLongPress } from '@/hooks/useLongPress'
import {
  horizonGoverns,
  horizonSquareLook,
  isPlainLook,
  squarePaths,
  SQUARE_SIZE,
  type SquareLook,
} from '@/lib/horizon-square'
import { UNSET_HORIZON, type HorizonValue } from '@/lib/task-segments'
import { cn } from '@/lib/utils'
import type { Task } from '@/types'

const HIT = "after:absolute after:-inset-x-[4px] after:-inset-y-[11px] after:content-['']"

export function DoneControl({
  task,
  onDone,
  isSelectionMode,
  isSelected,
  onSelect,
  onSetHorizon,
  plain = false,
}: {
  task: Task
  onDone: () => void
  isSelectionMode: boolean
  isSelected: boolean
  onSelect?: () => void
  /** Change the horizon (a governed square's hold / right-click menu). */
  onSetHorizon?: (horizon: HorizonValue | null) => void
  /** Always the plain square, whatever the horizon (the compact row). */
  plain?: boolean
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
  const governed = !plain && horizonGoverns(task)
  if (governed && onSetHorizon) {
    return <HorizonDoneSquare task={task} onDone={onDone} onSetHorizon={onSetHorizon} />
  }
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
      className={squareClasses(governed ? horizonSquareLook(task.horizon) : null)}
    >
      <SquareFace look={governed ? horizonSquareLook(task.horizon) : null} />
    </button>
  )
}

/** A governed square: a tap completes; a hold or a right-click opens the horizon menu. */
function HorizonDoneSquare({
  task,
  onDone,
  onSetHorizon,
}: {
  task: Task
  onDone: () => void
  onSetHorizon: (horizon: HorizonValue | null) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const look = horizonSquareLook(task.horizon)
  const press = useSimpleLongPress({
    onLongPress: () => setMenuOpen(true),
    onShortPress: onDone,
    tapOn: 'click',
  })
  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <button
        type="button"
        data-no-row-press
        data-lean-done
        data-horizon-square={task.horizon ?? UNSET_HORIZON}
        aria-label={`Done: "${task.title}" (hold to change the horizon)`}
        title="Done · hold to change the horizon"
        onClick={(e) => {
          e.stopPropagation()
          press.onClick()
        }}
        onPointerDown={press.onPointerDown}
        onPointerUp={press.onPointerUp}
        onPointerLeave={press.onPointerLeave}
        onPointerMove={press.onPointerMove}
        onPointerCancel={press.onPointerCancel}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setMenuOpen(true)
        }}
        className={cn(squareClasses(look), 'touch-manipulation [-webkit-touch-callout:none]')}
      >
        {/* The menu's anchor: inert, so only the hold or right-click opens it. */}
        <DropdownMenuTrigger asChild>
          <span aria-hidden tabIndex={-1} className="pointer-events-none absolute inset-0" />
        </DropdownMenuTrigger>
        <SquareFace look={look} />
      </button>
      <HorizonMenuContent value={task.horizon} onChange={onSetHorizon} align="start" />
    </DropdownMenu>
  )
}

/** The square's box: the plain checkbox border, or room for the patterned SVG. */
function squareClasses(look: SquareLook | null): string {
  const patterned = look !== null && !isPlainLook(look)
  return cn(
    'group/done hover:bg-foreground/5 relative mt-px flex size-[22px] shrink-0 cursor-pointer items-center justify-center rounded-[5px] transition-colors',
    HIT,
    patterned
      ? 'text-foreground/[0.42] hover:text-foreground/60'
      : 'border-foreground/25 hover:border-foreground/60 border-[1.5px]',
  )
}

/** Inside the square: the patterned border (if any) and the hover check. */
function SquareFace({ look }: { look: SquareLook | null }) {
  return (
    <>
      {look !== null && !isPlainLook(look) && <SquareBorder look={look} />}
      <Check
        className="text-foreground relative size-3.5 opacity-0 transition-opacity group-hover/done:opacity-60"
        strokeWidth={3}
        aria-hidden
      />
    </>
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
