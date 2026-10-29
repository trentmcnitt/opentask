/**
 * THE SECTIONS, as data. Each is one `SectionDef` — reorder, add or drop one
 * in the mode's array in `registry.ts`; tune one here. Every rule reads
 * `predicates.ts`, which reads the app's existing date rules.
 */
import { UNSET_HORIZON, type HorizonValue } from '@/lib/task-segments'
import { HORIZON_LABELS } from '@/lib/task-model-words'
import type { Task } from '@/types'
import type { ModeContext, SectionDef } from './types'
import {
  byPriorityThenNewest,
  comingUpAt,
  dateMoment,
  daysAgo,
  isHorizonGoverned,
  isOnDeckToday,
  isToday,
  byNewestCreated,
  newestFirst,
  soonestFirst,
  todayTime,
  wasPulled,
} from './predicates'

/** Rows a capped section shows before "Show 5 more". */
export const SECTION_CAP = 5
/** Horizon: Days shows more (Trent, 10-28). */
export const HORIZON_DAYS_CAP = 10

// ── Today ──────────────────────────────────────────────────────────────────

/**
 * TODAY (title temporary): over target, targeted later today and the deadline
 * safety net, in one list by time — the target, else the deadline — so past
 * times sit first and a row never jumps sections when its time comes. Its
 * identity is its order: the sort pill leaves it alone.
 */
export const TODAY: SectionDef = {
  id: 'today',
  title: 'Today',
  match: isToday,
  order: (a, b) => soonestFirst(todayTime(a), todayTime(b)),
  sortable: false,
  cap: null,
  allowOverlap: false,
  rows: 'full',
}

/** Today's decks, in the compact row. */
export const ON_DECK: SectionDef = {
  id: 'on-deck',
  title: 'On deck',
  match: isOnDeckToday,
  order: byPriorityThenNewest,
  sortable: true,
  cap: null,
  allowOverlap: false,
  rows: 'compact',
}

// ── The middle mode (Scan) ─────────────────────────────────────────────────

/**
 * How far back "Pulled" looks: pulled by a rollover in the last 14 OpenTask
 * days, today included (the prototype's window, 2026-10-28).
 */
export const PULLED_DAYS = 14
/** How far ahead "Coming up" looks (OpenTask days, today included). */
export const COMING_UP_DAYS = 3

/** The target or deck day a pulled task missed, as an instant to sort by. */
function missedAt(task: Task, ctx: ModeContext): string | null {
  if (task.queued_from_due_at) return task.queued_from_due_at
  return task.queued_from_deck_day ? dateMoment(task.queued_from_deck_day, ctx) : null
}

/** Pulled off a target or a deck: the latest pull first, then the latest day missed. */
export const PULLED: SectionDef = {
  id: 'pulled',
  title: 'Pulled',
  match: (task, ctx) => wasPulled(task) && daysAgo(task.queued_at!, ctx) <= PULLED_DAYS,
  order: (a, b, ctx) =>
    newestFirst(a.queued_at, b.queued_at) || newestFirst(missedAt(a, ctx), missedAt(b, ctx)),
  dateBreaks: true,
  sortable: true,
  cap: SECTION_CAP,
  allowOverlap: false,
  rows: 'full',
}

/** Every task, newest first: a complete list (Trent, 10-28: no cutoff). */
export const NEWEST: SectionDef = {
  id: 'newest',
  title: 'Newest',
  match: () => true,
  order: byNewestCreated,
  dateBreaks: true,
  sortable: false,
  cap: SECTION_CAP,
  allowOverlap: true,
  rows: 'full',
}

/** A deadline or picked target in the next 3 OpenTask days, soonest first. */
export const COMING_UP: SectionDef = {
  id: 'coming-up',
  title: 'Coming up',
  match: (task, ctx) => {
    const at = comingUpAt(task, ctx)
    return at !== null && -daysAgo(at, ctx) < COMING_UP_DAYS
  },
  order: (a, b, ctx) => soonestFirst(comingUpAt(a, ctx), comingUpAt(b, ctx)),
  sortable: false,
  cap: SECTION_CAP,
  allowOverlap: false,
  rows: 'full',
}

/**
 * A horizon's section: the one-offs that horizon governs, newest added
 * first. Unset is its own section, titled after what it counts as
 * (`UNSET_HORIZON`) and placed right after it. Complete lists: they overlap
 * the sections above.
 */
function horizonSection(horizon: HorizonValue | null, cap: number = SECTION_CAP): SectionDef {
  const title =
    horizon === null
      ? `Horizon: ${HORIZON_LABELS[UNSET_HORIZON]} (Unset)`
      : `Horizon: ${HORIZON_LABELS[horizon]}`
  return {
    id: `horizon-${horizon ?? 'unset'}`,
    title,
    match: (task) => isHorizonGoverned(task) && (task.horizon ?? null) === horizon,
    dateBreaks: true,
    order: byNewestCreated,
    sortable: true,
    cap,
    allowOverlap: true,
    rows: 'full',
  }
}

export const HORIZON_DAYS = horizonSection('days', HORIZON_DAYS_CAP)
export const HORIZON_WEEKS = horizonSection('weeks')
export const HORIZON_UNSET = horizonSection(null)
export const HORIZON_MONTHS = horizonSection('months')
export const HORIZON_EVENTUALLY = horizonSection('eventually')

/** The horizon sections in order, Unset right after the horizon it counts as. */
export const HORIZON_SECTIONS: readonly SectionDef[] = (() => {
  const named = [HORIZON_DAYS, HORIZON_WEEKS, HORIZON_MONTHS, HORIZON_EVENTUALLY]
  const at = named.findIndex((s) => s.id === `horizon-${UNSET_HORIZON}`)
  return [...named.slice(0, at + 1), HORIZON_UNSET, ...named.slice(at + 1)]
})()
