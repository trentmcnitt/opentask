/**
 * THE MODES, each declared in one place: its sections, in order. Reorder,
 * add or drop a section here (one line); define one in `sections.ts`.
 * `sections: null` is the dashboard's own list (All).
 */
import type { ModeDef, ModeId } from './types'
import { COMING_UP, HORIZON_SECTIONS, NEWEST, ON_DECK, PULLED, TODAY } from './sections'

/**
 * What the switch SAYS for each mode. The middle mode's name is Trent's
 * choice of the moment ("Scan", 2026-10-28; "Radar" was the other option):
 * renaming it is this one line — its id (`'pick-mode'`), stored per device
 * and used in `?mode=`, never changes.
 */
export const MODE_LABELS: Readonly<Record<ModeId, string>> = {
  today: 'Today',
  'pick-mode': 'Scan',
  all: 'All',
}

export const MODES: Readonly<Record<ModeId, ModeDef>> = {
  today: { id: 'today', sections: [TODAY, ON_DECK] },
  'pick-mode': {
    id: 'pick-mode',
    sections: [PULLED, NEWEST, COMING_UP, ...HORIZON_SECTIONS],
  },
  all: { id: 'all', sections: null },
}

/** The switch's order. */
export const MODE_ORDER: readonly ModeId[] = ['today', 'pick-mode', 'all']

/** The mode a device starts in. */
export const DEFAULT_MODE: ModeId = 'today'

export function isModeId(value: unknown): value is ModeId {
  return typeof value === 'string' && (MODE_ORDER as readonly string[]).includes(value)
}
