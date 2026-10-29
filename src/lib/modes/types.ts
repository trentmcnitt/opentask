/**
 * THE DASHBOARD MODES (Trent, 2026-10-28): Today | Scan | All, as DATA. A
 * mode is a list of sections; a section is a declarative definition the
 * selector (`select.ts`) runs over the open tasks. Nothing here renders:
 * `src/components/modes/` draws the `SectionView`s. See README.md here.
 */
import type { Task } from '@/types'

/** What every predicate and comparator may read besides the task. */
export interface ModeContext {
  now: Date
  timezone: string
  /** The user's day boundary (HH:MM): every "today" is the OpenTask day. */
  dayStart: string
}

/**
 * The modes' STABLE ids — stored per device and used in `?mode=`. Never the
 * display word: the middle mode's name may change (`MODE_LABELS`), its id
 * does not.
 */
export type ModeId = 'today' | 'pick-mode' | 'all'

/** How a section draws its rows: the full lean row, or the one-line compact row. */
export type RowForm = 'full' | 'compact'

/**
 * One section of a mode: which tasks (a pure predicate), in what order, how
 * many before "Show 5 more", and whether a task an EARLIER section took may
 * appear here too.
 */
export interface SectionDef {
  id: string
  title: string
  match: (task: Task, ctx: ModeContext) => boolean
  order: (a: Task, b: Task, ctx: ModeContext) => number
  /**
   * May the mode's sort (the sort pill) re-order this section? false for a
   * section whose identity IS its order (Newest, Coming up, Today): re-sorting
   * it would undo what it is — unless "Sort every section" is on.
   */
  sortable: boolean
  /** Rows shown before "Show 5 more"; null shows every row. */
  cap: number | null
  /**
   * A complete list: it lists every match, even tasks an earlier section
   * took, and claims none from the sections after it. false: it skips tasks
   * an earlier section took and claims its own — and its heading counts them.
   */
  allowOverlap: boolean
  rows: RowForm
  /**
   * Scan's DATE BREAKS (2026-10-29): mark where the created-date bucket
   * changes between rows (`created-bucket.ts`) — drawn only while the rows
   * run newest-created first (`SectionView.dateBreaks`).
   */
  dateBreaks?: boolean
}

/** A mode: its sections, or `null` for the dashboard's own list (All). */
export interface ModeDef {
  id: ModeId
  sections: readonly SectionDef[] | null
}

/** A section as selected: what the renderer draws. */
export interface SectionView {
  id: string
  title: string
  /** Every row of the section, in order. */
  tasks: Task[]
  /** The rows shown (its cap, plus what "Show 5 more" revealed). */
  visible: Task[]
  /** How many more "Show 5 more" can reveal. */
  hidden: number
  /** The section's cap (null = uncapped). */
  cap: number | null
  /** A complete list (`allowOverlap`): no count on its heading. */
  complete: boolean
  /** The mode's sort applies here (else the section's own order). */
  sortedByMode: boolean
  rows: RowForm
  /**
   * Draw date breaks: the section asks for them (`SectionDef.dateBreaks`)
   * and the order in effect is newest-created (`byNewestCreated`, the
   * section's own or the sort pill's "Newest") — under any other sort the
   * buckets would interleave, so none are drawn.
   */
  dateBreaks: boolean
}
