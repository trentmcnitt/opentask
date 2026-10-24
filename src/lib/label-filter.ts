/**
 * The label filter's rules — one place, shared by the dashboard's filter bar
 * (`useFilterState`, `LabelFilterBar`) and the Quotas page's label chips
 * (`useLabelFilter`, 2026-10-24). Pure, so both surfaces and the tests read
 * the same arithmetic.
 *
 * WHAT A SELECTION MEANS:
 * - **Include is OR.** With "kids" and "health" selected, an item carrying
 *   EITHER label is shown (`some`, not `every`).
 * - **Exclude removes.** An item carrying ANY excluded label is dropped.
 * - **Includes apply first**, then excludes remove from that result.
 * - Labels are matched exactly as stored (case-sensitive), as the chips are
 *   counted.
 *
 * HOW THE CHIP GESTURES CHANGE A SELECTION (`useChipInteraction` decides
 * which gesture is which):
 * - tap → toggle the label in or out of the includes;
 * - double-click → toggle it in or out of the excludes, dropping it from the
 *   includes;
 * - Cmd/Ctrl-click or a long press → make it the ONLY include (or clear the
 *   includes if it already is) and clear every exclude.
 */
import type { Task } from '@/types'

export interface LabelFilterCriteria {
  selectedLabels: string[]
  excludedLabels: string[]
}

export const EMPTY_LABEL_FILTER: LabelFilterCriteria = { selectedLabels: [], excludedLabels: [] }

/** Narrow `tasks` to the selection — see the module comment for the rules. */
export function filterByLabels<T extends Pick<Task, 'labels'>>(
  tasks: T[],
  c: LabelFilterCriteria,
): T[] {
  let filtered = tasks
  if (c.selectedLabels.length > 0) {
    filtered = filtered.filter((t) => t.labels.some((l) => c.selectedLabels.includes(l)))
  }
  if (c.excludedLabels.length > 0) {
    filtered = filtered.filter((t) => !t.labels.some((l) => c.excludedLabels.includes(l)))
  }
  return filtered
}

/** How many labels are selected or excluded — 0 means the filter is off. */
export function labelFilterCount(c: LabelFilterCriteria): number {
  return c.selectedLabels.length + c.excludedLabels.length
}

/**
 * Every chip and its count, most-used first, then by name. A label counts once
 * per item that carries it, so an item with two labels counts toward both
 * chips. A label that is selected or excluded is listed even at 0 — a filter
 * that is on must always have a chip that can turn it off.
 */
export function labelChipCounts(
  tasks: Pick<Task, 'labels'>[],
  c: LabelFilterCriteria,
): [string, number][] {
  const counts = new Map<string, number>()
  for (const task of tasks) {
    for (const label of task.labels) {
      counts.set(label, (counts.get(label) || 0) + 1)
    }
  }
  for (const l of [...c.selectedLabels, ...c.excludedLabels]) {
    if (!counts.has(l)) counts.set(l, 0)
  }
  return [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]
    return a[0].localeCompare(b[0])
  })
}

/** Tap: toggle `label` in or out of the includes. */
export function toggleLabelIn(c: LabelFilterCriteria, label: string): LabelFilterCriteria {
  const selectedLabels = c.selectedLabels.includes(label)
    ? c.selectedLabels.filter((l) => l !== label)
    : [...c.selectedLabels, label]
  return { ...c, selectedLabels }
}

/** Double-click: toggle `label` in or out of the excludes, and out of the includes. */
export function excludeLabelIn(c: LabelFilterCriteria, label: string): LabelFilterCriteria {
  return {
    selectedLabels: c.selectedLabels.filter((l) => l !== label),
    excludedLabels: c.excludedLabels.includes(label)
      ? c.excludedLabels.filter((l) => l !== label)
      : [...c.excludedLabels, label],
  }
}

/** Cmd/Ctrl-click or long press: only this label — or nothing, if it already was. */
export function exclusiveLabelIn(c: LabelFilterCriteria, label: string): LabelFilterCriteria {
  const only = c.selectedLabels.length === 1 && c.selectedLabels[0] === label
  return { selectedLabels: only ? [] : [label], excludedLabels: [] }
}

/** The kept selection, or none. Anything malformed reads as none. */
export function parseStoredLabelFilter(raw: string | null): LabelFilterCriteria {
  if (!raw) return EMPTY_LABEL_FILTER
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof LabelFilterCriteria, unknown>>
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    return {
      selectedLabels: strings(value?.selectedLabels),
      excludedLabels: strings(value?.excludedLabels),
    }
  } catch {
    return EMPTY_LABEL_FILTER
  }
}
