/**
 * THE HORIZON DONE SQUARE (Trent, 2026-10-28; research round 4): on a row
 * the horizon governs, the lean row's done square draws the horizon as its
 * border — a pace you read at the place you act:
 *
 *   Days        solid      — identical to the plain checkbox
 *   Weeks       long dashes, one gap per side
 *   Months      "Months A": a 4px dash mid-side, 3px gaps, the corners' curve
 *   Eventually  dots
 *   Unset       whatever unset MEANS: the look of `UNSET_HORIZON`
 *
 * Pure: the looks and the geometry. `DoneControl` draws them.
 *
 * WHOLE PIXELS: a 22px square, 5px corner radius. Each straight side runs
 * from x=5 to x=17 (12px) and carries an integer on/off pattern summing to
 * 12, symmetric, so every dash starts and ends on a pixel. At 1x the stroke
 * is 1px on half-pixel lines; at 2x it is 1.5px (the app's border width), on
 * lines the 2x grid lands exactly. Dotted corners are one whole-pixel square
 * each instead of an arc.
 */
import { UNSET_HORIZON, type HorizonValue } from '@/lib/task-segments'
import { isPlainOneOff } from '@/lib/row-corner'
import { HORIZON_LABELS, HORIZON_UNSET_LABEL, HORIZON_WORD } from '@/lib/task-model-words'
import type { Task } from '@/types'

export interface SquareLook {
  /** The straight sides' dash pattern (sums to 12), or null for solid. */
  side: readonly number[] | null
  /** The corners: the arc ('solid') or one whole-pixel dot ('dots'). */
  corners: 'solid' | 'dots'
}

export const HORIZON_SQUARE_LOOKS: Readonly<Record<HorizonValue, SquareLook>> = {
  days: { side: null, corners: 'solid' },
  weeks: { side: [4, 4, 4], corners: 'solid' },
  months: { side: [1, 3, 4, 3, 1], corners: 'solid' },
  eventually: { side: [0, 1, 1, 2, 1, 2, 1, 2, 1, 1], corners: 'dots' },
}

/** The look for a task's horizon: unset reads as `UNSET_HORIZON` (never a literal). */
export function horizonSquareLook(horizon: HorizonValue | null | undefined): SquareLook {
  return HORIZON_SQUARE_LOOKS[horizon ?? UNSET_HORIZON]
}

/**
 * A governed square's hint (Trent, 2026-10-29): it names the horizon it
 * draws — "Horizon: Weeks. Hold to change." Unset names what it reads as,
 * `UNSET_HORIZON` (the look it wears), the horizon first (Trent, 2026-10-29):
 * "Horizon: Weeks (unset). Hold to change." The tooltip is "Done · " and this; a phone has no hover, so the
 * accessible name carries the same words after the task's title.
 */
export function horizonSquareHint(horizon: HorizonValue | null | undefined): string {
  const name = horizon
    ? HORIZON_LABELS[horizon]
    : `${HORIZON_LABELS[UNSET_HORIZON]} (${HORIZON_UNSET_LABEL.toLowerCase()})`
  return `${HORIZON_WORD}: ${name}. Hold to change.`
}

/** Whether a solid look is the plain checkbox (drawn as the checkbox itself). */
export function isPlainLook(look: SquareLook): boolean {
  return look.side === null && look.corners === 'solid'
}

/**
 * Rows whose square shows the horizon: EVERY ONE-OFF (not repeating, not a
 * reminder or quota, not done) — targeted or not, deadline or not, decked or
 * not (Trent, 2026-10-29: "the checkbox always reflects the horizon,
 * regardless of whether it has a target"). It shows the horizon the user SET
 * ("it should reflect the set horizon not the way it's acting… I want to
 * make sure the logic is simple"): never `effectiveHorizon`, so a near
 * deadline does not change the square. Unset looks like `UNSET_HORIZON`.
 * Only repeating tasks keep the plain checkbox. It replaced 10-28's rule
 * (no picked target and no deadline).
 */
export function horizonGoverns(
  task: Pick<
    Task,
    | 'rrule'
    | 'is_reminder'
    | 'is_tracked'
    | 'progress_target'
    | 'due_at'
    | 'target_auto'
    | 'deadline_at'
    | 'horizon'
    | 'title'
  >,
): boolean {
  return isPlainOneOff(task)
}

const SIZE = 22
const RADIUS = 5

export interface SquarePaths {
  /** The four corner arcs (solid corners), as SVG path data. */
  arcs: string[]
  /** The four straight sides, as SVG path data (`look.side` dashes them). */
  sides: string[]
  /** The four corner dots (dotted corners): top-left x/y and size. */
  dots: { x: number; y: number; size: number }[]
}

/** The square's geometry for a stroke width (1 at 1x, 1.5 at 2x). */
export function squarePaths(look: SquareLook, strokeWidth: number): SquarePaths {
  const inset = strokeWidth / 2
  const r = RADIUS - inset
  const arc = (x1: number, y1: number, x2: number, y2: number) =>
    `M${x1} ${y1}A${r} ${r} 0 0 1 ${x2} ${y2}`
  const far = SIZE - inset
  const arcs = [
    arc(inset, RADIUS, RADIUS, inset),
    arc(SIZE - RADIUS, inset, far, RADIUS),
    arc(far, SIZE - RADIUS, SIZE - RADIUS, far),
    arc(RADIUS, far, inset, SIZE - RADIUS),
  ]
  const sides = [
    `M${RADIUS} ${inset}H${SIZE - RADIUS}`,
    `M${far} ${RADIUS}V${SIZE - RADIUS}`,
    `M${SIZE - RADIUS} ${far}H${RADIUS}`,
    `M${inset} ${SIZE - RADIUS}V${RADIUS}`,
  ]
  const [lo, hi] = strokeWidth <= 1 ? [1, 20] : [1.5, 19]
  const size = Math.max(strokeWidth, 1)
  const dots =
    look.corners === 'dots'
      ? [
          [lo, lo],
          [hi, lo],
          [hi, hi],
          [lo, hi],
        ].map(([x, y]) => ({ x, y, size }))
      : []
  return { arcs: look.corners === 'solid' ? arcs : [], sides, dots }
}

export const SQUARE_SIZE = SIZE
