import type { Task } from '@/types'

/**
 * Normalise a raw search-box value into the form `matchesTaskSearch` expects:
 * trimmed and lower-cased. An empty result means "not searching".
 */
export function normalizeTaskSearch(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase()
}

/**
 * Whether a task matches a search, for the surfaces that filter what they
 * already hold rather than asking the server (Reminders, Quotas).
 *
 * Title and notes, case-insensitive substring — the same fields and the same
 * semantics as the Tasks page's search, which the server runs as
 * `title LIKE %q% OR notes LIKE %q%` (`getTasks` in `src/core/tasks/create.ts`),
 * so every surface agrees about what "matches" means. Labels are deliberately
 * not searched: the Tasks page does not search them either.
 *
 * `query` must already be normalised (`normalizeTaskSearch`), so a list of
 * hundreds is not lower-casing the query once per row.
 */
export function matchesTaskSearch(task: Pick<Task, 'title' | 'notes'>, query: string): boolean {
  return (
    task.title.toLowerCase().includes(query) || (task.notes ?? '').toLowerCase().includes(query)
  )
}
