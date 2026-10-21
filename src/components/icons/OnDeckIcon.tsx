import { DeckLayersIcon, type DeckIconProps } from './deck-layers'

/**
 * On deck's icon: the layers of `DeckTomorrowIcon` (Trent's pick B) with a
 * "+" at their top centre where B's arc sits — the pair reads "put on deck"
 * / "put on deck tomorrow" (Trent, 2026-10-21). The plus is knocked out of
 * the layers by the same halo mask (`DeckLayersIcon`), and is about the
 * size of B's arc and arrowhead.
 *
 * `filled` is the ACTIVE state (on deck; Trent: "fill the layers, keep the
 * plus visible"): the TOP CARD filled, the plus still drawn in its knocked-out
 * channel so it reads as a cut-out. The bottom layer stays a line — filling
 * both merges them into one block (see `DeckLayersIcon`).
 */
const HALO_WIDTH = 4.5
/**
 * Filled, the channel around the plus is all that separates it from the
 * card: at 4.5 it is under a pixel at 18 px and closes up, at 5.5 it reads
 * (compared at 18/22/48 px, light and dark, 2026-10-21).
 */
const HALO_WIDTH_FILLED = 5.5
const PLUS = ['M12 2.5v7', 'M8.5 6h7']

export function OnDeckIcon({ filled, ...props }: DeckIconProps & { filled?: boolean }) {
  return (
    <DeckLayersIcon
      {...props}
      idPrefix="on-deck"
      mark={PLUS}
      haloWidth={filled ? HALO_WIDTH_FILLED : HALO_WIDTH}
      filled={filled}
      dataAttr="data-on-deck-icon"
    />
  )
}
