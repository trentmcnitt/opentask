/**
 * THE MODE SORT (the sort pill): one order for a whole mode, as data — a
 * comparator per sort. Rows carry no words for it (Trent, 10-28: a row
 * looks the same in every section); the pill says the order.
 *
 * It applies to the sections that are categories (`sortable`: Pulled, the
 * horizon sections, On deck). A section that IS an order — Newest, Coming
 * up, Today — keeps its own, unless "Sort every section" is on
 * (`ModeSort.everywhere`).
 */
import { HORIZON_ORDER, UNSET_HORIZON } from '@/lib/task-segments'
import type { Task } from '@/types'
import { hasPickedTarget, newestFirst, soonestFirst } from './predicates'
import type { ModeContext } from './types'

export type SortId =
  | 'newest'
  | 'oldest'
  | 'priority'
  | 'horizon'
  | 'deadline'
  | 'target'
  | 'touched'

export interface SortDef {
  id: SortId
  label: string
  order: (a: Task, b: Task, ctx: ModeContext) => number
}

/** The mode's sort as chosen on the pill. */
export interface ModeSort {
  id: SortId
  /** Sort the order-defined sections too (Today, Newest, Coming up). */
  everywhere: boolean
}

export const DEFAULT_MODE_SORT: ModeSort = { id: 'newest', everywhere: false }

/** Unset counts as `UNSET_HORIZON`, so it sorts right after it. */
function horizonRank(task: Task): number {
  if (task.horizon === null || task.horizon === undefined)
    return HORIZON_ORDER.indexOf(UNSET_HORIZON) + 0.5
  return HORIZON_ORDER.indexOf(task.horizon)
}
const pickedTarget = (task: Task) => (hasPickedTarget(task) ? task.due_at : null)

export const SORTS: Readonly<Record<SortId, SortDef>> = {
  newest: {
    id: 'newest',
    label: 'Newest',
    order: (a, b) => newestFirst(a.created_at, b.created_at),
  },
  oldest: {
    id: 'oldest',
    label: 'Oldest',
    order: (a, b) => soonestFirst(a.created_at, b.created_at),
  },
  priority: {
    id: 'priority',
    label: 'Priority',
    order: (a, b) => b.priority - a.priority || newestFirst(a.created_at, b.created_at),
  },
  horizon: {
    id: 'horizon',
    label: 'Horizon',
    order: (a, b) => horizonRank(a) - horizonRank(b) || newestFirst(a.created_at, b.created_at),
  },
  deadline: {
    id: 'deadline',
    label: 'Deadline',
    order: (a, b) =>
      soonestFirst(a.deadline_at, b.deadline_at) || newestFirst(a.created_at, b.created_at),
  },
  target: {
    id: 'target',
    label: 'Target',
    order: (a, b) =>
      soonestFirst(pickedTarget(a), pickedTarget(b)) || newestFirst(a.created_at, b.created_at),
  },
  touched: {
    id: 'touched',
    label: 'Last touched',
    order: (a, b) => newestFirst(a.updated_at, b.updated_at),
  },
}

/** The pill's order. */
export const SORT_ORDER: readonly SortId[] = [
  'newest',
  'oldest',
  'priority',
  'horizon',
  'deadline',
  'target',
  'touched',
]

export function isSortId(value: unknown): value is SortId {
  return typeof value === 'string' && (SORT_ORDER as readonly string[]).includes(value)
}
