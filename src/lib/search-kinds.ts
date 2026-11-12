/**
 * SEARCH ACROSS KINDS (Trent, 2026-11-12, mockups S3 + R2). The dashboard's
 * search finds tasks, reminders and quotas alike: one list grouped Tasks /
 * Reminders / Quotas under kind chips (All N · Tasks n · Reminders n ·
 * Quotas n — only the kinds that matched). Task rows stay real task rows; a
 * reminder or quota is a pointer row saying where it lives, and a tap goes to
 * it. The Reminders and Quotas tabs keep their own in-place filter and add
 * one line for what else matches ("3 tasks also match “fern” · show them"),
 * which opens the dashboard's search.
 *
 * The pure part: classifying hits, the words, and where a tap goes.
 */
import { justAddedItemKind, justAddedWhere } from '@/lib/just-added'
import { isHorizonGoverned } from '@/lib/modes/predicates'
import type { PanelLift } from '@/lib/panel-lift'
import { HORIZON_LABELS } from '@/lib/task-model-words'
import { UNSET_HORIZON } from '@/lib/task-segments'
import type { TimeSlot } from '@/lib/time-slot-assign'
import type { Task } from '@/types'

export type SearchKind = 'task' | 'reminder' | 'quota'
/** The chip row's choice: every kind, or one. */
export type SearchKindFilter = 'all' | SearchKind

export const SEARCH_KIND_ORDER: readonly SearchKind[] = ['task', 'reminder', 'quota']
export const SEARCH_KIND_WORDS: Readonly<Record<SearchKind, { one: string; many: string }>> = {
  task: { one: 'task', many: 'tasks' },
  reminder: { one: 'reminder', many: 'reminders' },
  quota: { one: 'quota', many: 'quotas' },
}

export const searchKindOf = justAddedItemKind

export type SearchKindCounts = Readonly<Record<SearchKind, number>>

export function countSearchKinds(
  hits: Pick<Task, 'is_reminder' | 'progress_target' | 'is_tracked'>[],
) {
  const counts = { task: 0, reminder: 0, quota: 0 }
  for (const hit of hits) counts[searchKindOf(hit)] += 1
  return counts as SearchKindCounts
}

/** The kinds that matched, in chip order. */
export function matchedKinds(counts: SearchKindCounts): SearchKind[] {
  return SEARCH_KIND_ORDER.filter((kind) => counts[kind] > 0)
}

/**
 * The chip in effect: the chosen kind while it still has hits, else All — a
 * chip whose kind emptied (its last hit was done or deleted) must not leave
 * an empty list under a chip that is no longer drawn.
 */
export function effectiveKindFilter(
  chosen: SearchKindFilter,
  counts: SearchKindCounts,
): SearchKindFilter {
  return chosen !== 'all' && counts[chosen] > 0 ? chosen : 'all'
}

/**
 * A task row's extra words while searching: a task that sits in the task
 * queue (its horizon sets its pace: no picked target, no deadline) says so —
 * "Task queue · Weeks" — because in the results it is out of the section
 * that would. Null for a task with a date of its own (its chips say where).
 */
export function searchQueueWord(task: Task): string | null {
  if (!isHorizonGoverned(task)) return null
  return `Task queue · ${HORIZON_LABELS[task.horizon ?? UNSET_HORIZON]}`
}

/**
 * Where a reminder or quota lives, for its result row: "After School ·
 * Daily"; "2 a week · 1 done · After School" (the count so far this period
 * between the target and the period it reminds in).
 */
export function searchWhere(task: Task, slots: TimeSlot[], timezone: string): string {
  const where = justAddedWhere(task, slots, timezone) ?? ''
  if (searchKindOf(task) !== 'quota') return where
  const [count, ...rest] = where.split(' · ')
  return [count, `${task.progress_current ?? 0} done`, ...rest].join(' · ')
}

/** What the Reminders card's lift needs to know of a period (`useReminders`' groups). */
interface LiftGroup {
  reminders: { id: number }[]
  prompts: { prompt_key: string; task_id: number }[]
}

/**
 * Where a tap on a reminder or quota result goes: the dashboard's lift when
 * it waits TODAY (its row in the Reminders card, lifted to the top of its
 * period, `src/lib/panel-lift.ts`), else null — its details. `isWaiting` is
 * the card's own test for a prompt.
 */
export function searchResultLift<G extends LiftGroup>(
  task: Task,
  groups: readonly G[],
  isWaiting: (prompt: G['prompts'][number]) => boolean,
): PanelLift | null {
  if (searchKindOf(task) === 'reminder') {
    return groups.some((g) => g.reminders.some((r) => r.id === task.id))
      ? { kind: 'reminder', id: task.id }
      : null
  }
  for (const g of groups) {
    const prompt = g.prompts.find((p) => p.task_id === task.id && isWaiting(p))
    if (prompt) return { kind: 'prompt', key: prompt.prompt_key }
  }
  return null
}

/**
 * The Reminders and Quotas tabs' one line for what else matches: "3 tasks
 * also match", "1 task and 2 quotas also match". Null when nothing else does.
 */
export function alsoMatchWords(counts: Partial<Record<SearchKind, number>>): string | null {
  const parts = SEARCH_KIND_ORDER.flatMap((kind) => {
    const n = counts[kind] ?? 0
    if (n === 0) return []
    return [`${n} ${n === 1 ? SEARCH_KIND_WORDS[kind].one : SEARCH_KIND_WORDS[kind].many}`]
  })
  if (parts.length === 0) return null
  const total = SEARCH_KIND_ORDER.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0)
  const list =
    parts.length <= 2
      ? parts.join(' and ')
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `${list} also ${total === 1 ? 'matches' : 'match'}`
}

/** The dashboard's search as a link (`?search=`), for the tabs' "show them". */
export const SEARCH_PARAM = 'search'
export function dashboardSearchHref(query: string): string {
  return `/?${SEARCH_PARAM}=${encodeURIComponent(query)}`
}
