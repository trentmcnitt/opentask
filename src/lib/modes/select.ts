/**
 * THE SELECTOR: a mode's sections over a task list — pure, so the rules are
 * tested without a browser.
 *
 * In section order: a section takes every listable task its predicate
 * matches — minus, unless it is a complete list (`allowOverlap`), the tasks
 * an earlier section already took — sorts them, and shows its cap plus what
 * "Show 5 more" revealed. A complete list claims nothing for the sections
 * after it. Empty sections are dropped (no chrome for nothing).
 *
 * The ORDER: the mode's sort (the sort pill, `sorts.ts`) on a `sortable`
 * section, or on every section with "Sort every section" on; else the
 * section's own.
 */
import type { Task } from '@/types'
import type { ModeContext, SectionDef, SectionView } from './types'
import { byNewestCreated, isListable } from './predicates'
import { SORTS, type ModeSort } from './sorts'

/** How many more rows one "Show 5 more" reveals. */
export const SHOW_MORE_STEP = 5

/**
 * @param extra Rows revealed past each section's cap, by section id ("Show
 *   5 more" adds `SHOW_MORE_STEP`; "Show less" puts it back to 0).
 */
export function selectSections(
  tasks: readonly Task[],
  sections: readonly SectionDef[],
  ctx: ModeContext,
  sort: ModeSort | null = null,
  extra: Readonly<Record<string, number>> = {},
): SectionView[] {
  const listable = tasks.filter(isListable)
  const taken = new Set<number>()
  const views: SectionView[] = []
  for (const def of sections) {
    const byMode = sort !== null && (def.sortable || sort.everywhere)
    const order = byMode ? SORTS[sort.id].order : def.order
    const rows = listable
      .filter((t) => (def.allowOverlap || !taken.has(t.id)) && def.match(t, ctx))
      .sort((a, b) => order(a, b, ctx) || a.id - b.id)
    if (!def.allowOverlap) for (const t of rows) taken.add(t.id)
    if (rows.length === 0) continue
    const shown = def.cap === null ? rows.length : def.cap + (extra[def.id] ?? 0)
    const visible = rows.slice(0, shown)
    views.push({
      id: def.id,
      title: def.title,
      tasks: rows,
      visible,
      hidden: rows.length - visible.length,
      cap: def.cap,
      complete: def.allowOverlap,
      sortedByMode: byMode,
      rows: def.rows,
      ageSteps: !!def.ageSteps && order === byNewestCreated,
    })
  }
  return views
}

/** What the next "Show N more" reveals: a step, or what is left. */
export function nextStepSize(hidden: number): number {
  return Math.min(SHOW_MORE_STEP, hidden)
}
