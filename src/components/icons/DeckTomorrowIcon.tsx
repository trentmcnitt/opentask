import { useId } from 'react'

/**
 * "On deck tomorrow"'s icon: On deck's `Layers2`, lowered, with an arrow
 * arcing over it on to the next day.
 *
 * Trent's pick — option B, "layers under an arc" (2026-10-21; option A,
 * layers + a straight arrow, was the interim). Every use goes through this
 * one component, so a swap is this file alone.
 *
 * Lucide's API shape and SVG attributes (`SunSolid`'s), so it sits beside
 * `Layers2` and `SunSolid` like one of them.
 *
 * THE LAYERS' FIT: the spec was `Layers2` translated down 3, but that puts
 * the bottom layer's lowest point at y ≈ 25 (≈ 26 with its stroke), past the
 * 24 viewBox, so it clipped. Instead the layers are scaled to
 * `LAYERS_SCALE` about their bottom centre (12, 22): the bottom stays where
 * Lucide draws it (inside the box like every Lucide icon), and the top card
 * lands at y ≈ 5 — where the 3-down translate put it — so the arc cuts
 * across it as designed. An SVG `scale()` scales its stroke too, so the
 * group's stroke is `strokeWidth / LAYERS_SCALE`, keeping the layers' lines
 * the arc's weight on screen.
 *
 * THE HALO: the arc must cut cleanly across the top card in either theme, so
 * nothing is painted behind it — the layers are MASKED: a white rect with
 * the arc and arrowhead stroked black and wider (`HALO_WIDTH`) knocks the
 * layers out under the arc, and the row's own background shows through. The
 * mask sits on an untransformed wrapper group, so its paths are in the icon's
 * own coordinates. Its id is per instance (`useId`, sanitised for `url(#…)`):
 * the icon renders many times on a page.
 */
const LAYERS_SCALE = 0.85
const HALO_WIDTH = 4.5
const ARC = 'M6.5 8a6 6 0 0 1 11 0'
const ARROWHEAD = 'm17.9 4.8-.4 3.2-3.1-.6'

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
  const maskId = `deck-tomorrow-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
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
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
          <rect x="0" y="0" width="24" height="24" fill="white" stroke="none" />
          <path d={ARC} stroke="black" strokeWidth={HALO_WIDTH} />
          <path d={ARROWHEAD} stroke="black" strokeWidth={HALO_WIDTH} />
        </mask>
      </defs>
      <g mask={`url(#${maskId})`}>
        <g
          transform={`translate(12 22) scale(${LAYERS_SCALE}) translate(-12 -22)`}
          strokeWidth={strokeWidth / LAYERS_SCALE}
        >
          <path d="M13 13.74a2 2 0 0 1-2 0L2.5 8.87a1 1 0 0 1 0-1.74L11 2.26a2 2 0 0 1 2 0l8.5 4.87a1 1 0 0 1 0 1.74z" />
          <path d="m20 14.285 1.5.845a1 1 0 0 1 0 1.74L13 21.74a2 2 0 0 1-2 0l-8.5-4.87a1 1 0 0 1 0-1.74l1.5-.845" />
        </g>
      </g>
      <path d={ARC} />
      <path d={ARROWHEAD} />
    </svg>
  )
}
