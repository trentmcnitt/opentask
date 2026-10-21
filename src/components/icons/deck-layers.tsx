import { useId } from 'react'

/**
 * The shared body of the two deck icons, `OnDeckIcon` (a "+" over the
 * layers) and `DeckTomorrowIcon` (an arc over them): Lucide's `Layers2`,
 * scaled down, with a MARK drawn across its top and knocked out of the
 * layers. One body, so the pair can't drift apart.
 *
 * THE LAYERS' FIT: they are scaled to `LAYERS_SCALE` about their bottom
 * centre (12, 22). The bottom stays where Lucide draws it (inside the box
 * like every Lucide icon) and the top card lands at y ≈ 5, leaving room for
 * the mark above and across it. (A plain 3-down translate pushed the bottom
 * layer past the 24 viewBox, so it clipped.) An SVG `scale()` scales its
 * stroke too, so the group's stroke is `strokeWidth / LAYERS_SCALE`, keeping
 * the layers' lines the mark's weight on screen.
 *
 * THE HALO: the mark must cut cleanly across the top card in either theme,
 * so nothing is painted behind it — the layers are MASKED: a white rect with
 * the mark stroked black and wider (`haloWidth`) knocks the layers out under
 * it, and the row's own background shows through. The mask sits on an
 * untransformed wrapper group, so its paths are in the icon's own
 * coordinates. Its id is per instance (`useId`, sanitised for `url(#…)`):
 * the icon renders many times on a page.
 *
 * FILLED (On deck's active state): the top card is filled, the bottom layer
 * stays a line. Lucide's bottom path is OPEN — filling it closes it with a
 * chord just under the top card's point, and the two layers merge into one
 * block (why a filled `Layers2` read as mud).
 */
const LAYERS_SCALE = 0.85
const TOP_CARD =
  'M13 13.74a2 2 0 0 1-2 0L2.5 8.87a1 1 0 0 1 0-1.74L11 2.26a2 2 0 0 1 2 0l8.5 4.87a1 1 0 0 1 0 1.74z'
const BOTTOM_LAYER =
  'm20 14.285 1.5.845a1 1 0 0 1 0 1.74L13 21.74a2 2 0 0 1-2 0l-8.5-4.87a1 1 0 0 1 0-1.74l1.5-.845'

export interface DeckIconProps {
  size?: number | string
  className?: string
  strokeWidth?: number
  'aria-hidden'?: boolean | 'true' | 'false'
}

export function DeckLayersIcon({
  size = 24,
  className,
  strokeWidth = 2,
  'aria-hidden': ariaHidden = true,
  idPrefix,
  mark,
  haloWidth,
  filled = false,
  dataAttr,
}: DeckIconProps & {
  /** The mask id's prefix (readable in the DOM). */
  idPrefix: string
  /** The mark's paths, drawn over the layers and knocked out of them. */
  mark: string[]
  haloWidth: number
  /** Fill the top card (On deck's active state). */
  filled?: boolean
  /** The `data-*` attribute that names the icon, e.g. `data-on-deck-icon`. */
  dataAttr: `data-${string}`
}) {
  const maskId = `${idPrefix}-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
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
      {...{ [dataAttr]: true }}
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
          <rect x="0" y="0" width="24" height="24" fill="white" stroke="none" />
          {mark.map((d) => (
            <path key={d} d={d} stroke="black" strokeWidth={haloWidth} />
          ))}
        </mask>
      </defs>
      <g mask={`url(#${maskId})`}>
        <g
          transform={`translate(12 22) scale(${LAYERS_SCALE}) translate(-12 -22)`}
          strokeWidth={strokeWidth / LAYERS_SCALE}
        >
          <path d={TOP_CARD} fill={filled ? 'currentColor' : undefined} />
          <path d={BOTTOM_LAYER} />
        </g>
      </g>
      {mark.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}
