import type { Task } from '@/types'

/**
 * Computes the intersection of labels across all tasks.
 * Returns only labels that ALL tasks have in common.
 * For a single task, returns that task's labels.
 * For an empty array, returns an empty array.
 */
export function computeCommonLabels(tasks: Task[]): string[] {
  if (tasks.length === 0) return []
  if (tasks.length === 1) return tasks[0].labels
  // Start with first task's labels, filter to only those ALL tasks have
  const first = tasks[0].labels
  return first.filter((label) => tasks.every((t) => t.labels.includes(label)))
}

/**
 * Returns true if any task has different labels from any other task.
 * Used to show a "—" mixed indicator alongside common labels.
 */
export function hasLabelVariations(tasks: Task[]): boolean {
  if (tasks.length <= 1) return false
  const first = JSON.stringify([...tasks[0].labels].sort())
  return tasks.some((t) => JSON.stringify([...t.labels].sort()) !== first)
}

/**
 * Computes the common priority across all tasks.
 * Returns the priority if ALL tasks share the same value, otherwise null.
 */
export function computeCommonPriority(tasks: Task[]): number | null {
  if (tasks.length === 0) return null
  const first = tasks[0].priority
  const allSame = tasks.every((t) => t.priority === first)
  return allSame ? first : null
}
