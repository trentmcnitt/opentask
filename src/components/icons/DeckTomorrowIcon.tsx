import { DeckLayersIcon, type DeckIconProps } from './deck-layers'

/**
 * "On deck tomorrow"'s icon: On deck's layers, lowered, with an arrow arcing
 * over them on to the next day — the pair of `OnDeckIcon` (a "+" there).
 *
 * Trent's pick — option B, "layers under an arc" (2026-10-21; option A,
 * layers + a straight arrow, was the interim). Every use goes through this
 * one component, so a swap is this file alone.
 *
 * Lucide's API shape and SVG attributes (`SunSolid`'s), so it sits beside
 * `SunSolid` like one of them. The layers, their fit and the halo that
 * knocks them out under the arc are the shared `DeckLayersIcon`.
 */
const HALO_WIDTH = 4.5
const ARC = 'M6.5 8a6 6 0 0 1 11 0'
const ARROWHEAD = 'm17.9 4.8-.4 3.2-3.1-.6'

export function DeckTomorrowIcon({ filled, ...props }: DeckIconProps & { filled?: boolean }) {
  return (
    <DeckLayersIcon
      {...props}
      // Filled: on deck for tomorrow (its button lit, 2026-10-27), the top
      // card solid like `OnDeckIcon`'s; the arc sits above it, haloed as ever.
      filled={filled}
      idPrefix="deck-tomorrow"
      mark={[ARC, ARROWHEAD]}
      haloWidth={HALO_WIDTH}
      dataAttr="data-deck-tomorrow-icon"
    />
  )
}
