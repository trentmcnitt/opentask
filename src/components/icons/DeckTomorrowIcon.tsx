/**
 * "On deck tomorrow"'s icon (2026-10-20): On deck's `Layers2`, shrunk into the
 * top-left, with an arrow pointing on to the next day.
 *
 * INTERIM — option A, "layers + arrow". Trent may pick differently; every
 * use goes through this one component, so the swap is this file alone.
 *
 * Lucide's API shape and SVG attributes (`SunSolid`'s), so it sits beside
 * `Layers2` and `SunSolid` like one of them. The layers are drawn at 72% in a
 * scaled group, and an SVG `scale()` scales its stroke too — so the group's
 * stroke is `strokeWidth / 0.72`, which keeps the layers' lines the same
 * weight as the arrow's on screen.
 */
const LAYERS_SCALE = 0.72

export function DeckTomorrowIcon({
  size = 24,
  className,
  strokeWidth = 2,
  'aria-hidden': ariaHidden = true,
}: {
  size?: number | string
  className?: string
  strokeWidth?: number
  'aria-hidden'?: boolean | 'true' | 'false'
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={ariaHidden}
      data-deck-tomorrow-icon
    >
      <g transform={`scale(${LAYERS_SCALE})`} strokeWidth={strokeWidth / LAYERS_SCALE}>
        <path d="M13 13.74a2 2 0 0 1-2 0L2.5 8.87a1 1 0 0 1 0-1.74L11 2.26a2 2 0 0 1 2 0l8.5 4.87a1 1 0 0 1 0 1.74z" />
        <path d="m20 14.285 1.5.845a1 1 0 0 1 0 1.74L13 21.74a2 2 0 0 1-2 0l-8.5-4.87a1 1 0 0 1 0-1.74l1.5-.845" />
      </g>
      <path d="M13.5 19h8" />
      <path d="m18.5 16 3 3-3 3" />
    </svg>
  )
}
