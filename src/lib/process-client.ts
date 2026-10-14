/**
 * Process — the client side of `GET /api/process` and of every write the
 * Process modal makes (2026-10-10 task model, spec §5).
 *
 * Every write goes through an endpoint that already exists and already logs
 * undo (PATCH, bulk edit, target today, DELETE), so Process adds no mutation
 * path of its own. Each call here is one undo entry, except `bulkEditChunks`,
 * which counts the ones it made into a `WriteTally`, so the toast's Undo can
 * take back exactly that many (`undoEntries`).
 *
 * The two AI reads (`/api/process/recommend-projects`, `/api/process/duplicates`)
 * are optional: a 404 (AI off, or not deployed), an error or an empty answer
 * all read as "nothing to suggest", and Process carries on without them.
 */

import { apiFetch, jsonInit } from '@/lib/api-client'
import { postUndoRedo } from '@/lib/undo-client'
import { URGENT_PRIORITY } from '@/lib/priority'
import type { HorizonValue } from '@/lib/task-segments'

/** The task fields the modal shows. */
export interface ProcessTask {
  id: number
  title: string
  notes: string | null
  priority: number
  project_id: number
  horizon: HorizonValue | null
  deadline_at: string | null
  target_at: string | null
  created_at: string
}

export interface GrowthItem {
  task: ProcessTask
  from: HorizonValue | null
  to: HorizonValue
  days_on_horizon: number
  can_act: boolean
}

export interface StaleTargetItem {
  task: ProcessTask
  /** Local days over target (spec §7); listed from ATTEMPTS_OFFER_REMOVE (3). */
  attempts: number
}

export interface ProcessData {
  inbox_project_id: number | null
  inbox: ProcessTask[]
  growth: GrowthItem[]
  stale_targets: StaleTargetItem[]
  stale_targets_with_deadline: StaleTargetItem[]
}

export interface Recommendation {
  project_id: number | null
  reason: string
}

export interface DuplicateGroup {
  task_ids: number[]
  reason: string
}

/**
 * The last answer, kept for the session so reopening paints at once while the
 * fresh read runs (the app's stale-while-revalidate pattern, as in
 * `useReminders`). The menu's count hint fills it, so the modal opened from
 * that menu usually starts with data.
 */
let cached: ProcessData | null = null

export function cachedProcessData(): ProcessData | null {
  return cached
}

/** Keep the cache in step with what the modal shows after a local, optimistic change. */
export function rememberProcessData(data: ProcessData): void {
  cached = data
}

export async function fetchProcess(): Promise<ProcessData> {
  cached = await apiFetch<ProcessData>('/api/process')
  return cached
}

const RECOMMEND_MAX = 100

/** The AI's project picks for these Inbox tasks, keyed by task id; empty when AI can't help. */
export async function fetchRecommendations(ids: number[]): Promise<Map<number, Recommendation>> {
  const map = new Map<number, Recommendation>()
  if (ids.length === 0) return map
  try {
    // The endpoint takes up to RECOMMEND_MAX ids per (AI) call. The Inbox is
    // walked oldest first, so the first ones are the ones shown first; a
    // longer Inbox gets picks for the rest on the next opening.
    const res = await fetch(
      '/api/process/recommend-projects',
      jsonInit('POST', { ids: ids.slice(0, RECOMMEND_MAX) }),
    )
    if (!res.ok) return map
    const body = (await res.json()) as {
      data?: { recommendations?: ({ task_id: number } & Recommendation)[] }
    }
    for (const r of body.data?.recommendations ?? []) {
      if (r.project_id !== null) map.set(r.task_id, { project_id: r.project_id, reason: r.reason })
    }
  } catch {
    // AI unavailable: no highlight.
  }
  return map
}

/** Possible duplicates; empty when AI can't help. */
export async function fetchDuplicates(): Promise<DuplicateGroup[]> {
  try {
    const res = await fetch('/api/process/duplicates')
    if (!res.ok) return []
    const body = (await res.json()) as { data?: { groups?: DuplicateGroup[] } }
    return (body.data?.groups ?? []).filter((g) => g.task_ids.length > 1)
  } catch {
    return []
  }
}

/** One task, for a duplicate group's rows (the duplicates read returns ids only). */
export function fetchTask(id: number): Promise<ProcessTask> {
  return apiFetch<ProcessTask>(`/api/tasks/${id}`)
}

export function moveToProject(taskId: number, projectId: number): Promise<unknown> {
  return apiFetch(`/api/tasks/${taskId}`, jsonInit('PATCH', { project_id: projectId }))
}

/** Soft delete (Trash), undoable like every delete. */
export function trashTask(taskId: number): Promise<unknown> {
  return apiFetch(`/api/tasks/${taskId}`, { method: 'DELETE' })
}

/** "Do it": target today — the same action as the task segment's button. */
export function targetToday(ids: number[]): Promise<unknown> {
  return apiFetch('/api/task-segments/target-today', jsonInit('POST', { ids }))
}

/** "Raise priority": one step up, and the horizon re-affirmed — the question is answered. */
export function raisePriority(task: ProcessTask): Promise<unknown> {
  return apiFetch(
    `/api/tasks/${task.id}`,
    jsonInit('PATCH', {
      priority: Math.min(task.priority + 1, URGENT_PRIORITY),
      affirm_horizon: true,
    }),
  )
}

const BULK_MAX = 500

/** What a run of writes has done so far — kept up to date as each request lands. */
export interface WriteTally {
  /** Undo entries made (a request that changed nothing makes none). */
  entries: number
  /** Tasks changed. */
  affected: number
}

export function newTally(): WriteTally {
  return { entries: 0, affected: 0 }
}

/**
 * A bulk edit over any number of ids, in chunks the endpoint accepts, counted
 * into `tally` as each chunk lands — so if a later chunk fails, the caller
 * still knows exactly what the earlier ones did and can offer their Undo. A
 * chunk that changed nothing logs no undo entry and is not counted.
 * `include_task_ids` is always the chunk itself: these are explicit picks, so
 * a target removal must not be filtered by the High/Urgent snooze sweep
 * (`planBulkEditDates`).
 */
export async function bulkEditChunks(
  ids: number[],
  changes: Record<string, unknown>,
  tally: WriteTally,
): Promise<void> {
  for (let i = 0; i < ids.length; i += BULK_MAX) {
    const chunk = ids.slice(i, i + BULK_MAX)
    const result = await apiFetch<{ tasks_affected: number }>(
      '/api/tasks/bulk/edit',
      jsonInit('POST', { ids: chunk, changes, include_task_ids: chunk }),
    )
    if (result.tasks_affected > 0) {
      tally.entries++
      tally.affected += result.tasks_affected
    }
  }
}

/**
 * Take back the last `count` undo entries — the ones the action just made.
 * Unscoped, like the iOS quick-action toast (`useNativeSnoozeToast`): the
 * Process modal sits over whichever page opened it, and that page refreshes on
 * the sync stream. Returns the server's description of the last one undone,
 * or null when there was nothing to undo.
 */
export async function undoEntries(count: number): Promise<string | null> {
  if (count <= 0) return null
  if (count === 1) {
    const data = await postUndoRedo('undo', null)
    return data?.description ?? null
  }
  // The batch route answers with counts only (and 400 when nothing is left).
  const res = await fetch('/api/undo/batch', jsonInit('POST', { count }))
  if (!res.ok) return null
  return `${count} changes`
}

/**
 * Opening Process from outside the top bar (2026-10-14). The modal lives in
 * `Header`, which only the dashboard, Reminders and Quotas render; its
 * listener for `OPEN_PROCESS_EVENT` cancels the event to say "opened". The
 * left bar shows Process on every page, so where nothing cancels it (History,
 * Settings, …) it navigates to `/?action=process`, and the dashboard's top bar
 * opens Process on arrival (`PROCESS_ACTION`) — the same in-place modal the ☰
 * menu opens, never a second copy.
 */
export const OPEN_PROCESS_EVENT = 'open-process'

/** `/?action=process`: open Process once the dashboard's top bar mounts. */
export const PROCESS_ACTION = 'process'

/** Ask the mounted top bar for Process; true when one opened it. */
export function requestOpenProcess(): boolean {
  return !window.dispatchEvent(new CustomEvent(OPEN_PROCESS_EVENT, { cancelable: true }))
}
