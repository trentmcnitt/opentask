'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useProjects } from '@/components/ProjectsProvider'
import { useProcess } from '@/hooks/useProcess'
import { showSaveError } from '@/lib/toast'
import { getPriorityOption, URGENT_PRIORITY } from '@/lib/priority'
import {
  bulkEditChunks,
  fetchDuplicates,
  fetchRecommendations,
  fetchTask,
  moveToProject,
  newTally,
  raisePriority,
  targetToday,
  trashTask,
  type GrowthItem,
  type ProcessTask,
  type Recommendation,
} from '@/lib/process-client'
import type { Project } from '@/types'
import type { ShownDuplicateGroup } from './ProcessDuplicatesStep'

/**
 * Dismissed duplicate groups, per browser. "Not duplicates" is a judgment
 * about THAT set of tasks, so it is keyed by the sorted ids; a group the AI
 * finds again with a new member is a new question. Browser storage, wrapped,
 * because nothing breaks without it — the group just comes back.
 */
const DISMISSED_KEY = 'opentask:process:dismissed-duplicates'
const MAX_DUPLICATE_GROUPS = 20

function readDismissed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

function writeDismissed(keys: Set<string>): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...keys].slice(-200)))
  } catch {
    // Storage unavailable: the group returns next time, which is harmless.
  }
}

async function loadDuplicateGroups(): Promise<ShownDuplicateGroup[]> {
  const dismissed = readDismissed()
  const groups = (await fetchDuplicates())
    .map((g) => ({ ...g, key: [...g.task_ids].sort((a, b) => a - b).join(',') }))
    .filter((g) => !dismissed.has(g.key))
    .slice(0, MAX_DUPLICATE_GROUPS)
  const ids = [...new Set(groups.flatMap((g) => g.task_ids))]
  const tasks = new Map<number, ProcessTask>()
  await Promise.all(
    ids.map((id) =>
      fetchTask(id)
        .then((t) => tasks.set(id, t))
        .catch(() => {}),
    ),
  )
  return groups
    .map((g) => ({
      key: g.key,
      reason: g.reason,
      tasks: g.task_ids.map((id) => tasks.get(id)).filter((t): t is ProcessTask => !!t),
    }))
    .filter((g) => g.tasks.length > 1)
}

/**
 * Everything the Process modal does, so the modal itself is layout. Each
 * action removes what it acted on at once (optimistic), writes through an
 * existing endpoint, then offers Undo; a failed write re-reads instead.
 */
export function useProcessFlow(open: boolean) {
  const { data, remove, error, reload, toastWithUndo } = useProcess(open)
  const { projects } = useProjects()
  const [skipped, setSkipped] = useState<Set<number>>(() => new Set())
  const [recommendations, setRecommendations] = useState<Map<number, Recommendation>>(
    () => new Map(),
  )
  const [duplicates, setDuplicates] = useState<ShownDuplicateGroup[]>([])
  const [busy, setBusy] = useState(false)

  const inboxIds = useMemo(() => data?.inbox.map((t) => t.id) ?? [], [data])
  const inboxKey = inboxIds.join(',')
  const hasData = data !== null

  // AI reads: once per opening, in the background, never blocking the steps.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    loadDuplicateGroups().then((g) => !cancelled && setDuplicates(g))
    return () => {
      cancelled = true
    }
  }, [open])
  // The project picks: asked once per opening, for the Inbox as it stood when
  // the list first arrived — the picks for the rest still stand after a sort.
  const recsAskedRef = useRef(false)
  useEffect(() => {
    if (!open) {
      recsAskedRef.current = false
      return
    }
    if (!hasData || recsAskedRef.current) return
    recsAskedRef.current = true
    const ids = inboxKey ? inboxKey.split(',').map(Number) : []
    void fetchRecommendations(ids).then(setRecommendations)
  }, [open, hasData, inboxKey])

  const inboxProjects: Project[] = useMemo(
    () => projects.filter((p) => p.id !== data?.inbox_project_id),
    [projects, data?.inbox_project_id],
  )
  const inboxQueue = data?.inbox.filter((t) => !skipped.has(t.id)) ?? []

  const fail = useCallback(
    (err: unknown) => {
      showSaveError(err)
      void reload()
    },
    [reload],
  )

  const move = useCallback(
    (task: ProcessTask, project: Project) => {
      // Off the Inbox only: its growth or old-target question still stands.
      remove([task.id], ['inbox'])
      moveToProject(task.id, project.id)
        .then(() => toastWithUndo(`Moved to ${project.name}`))
        .catch(fail)
    },
    [remove, toastWithUndo, fail],
  )

  const skip = useCallback((task: ProcessTask) => {
    setSkipped((s) => new Set(s).add(task.id))
  }, [])

  const trash = useCallback(
    (task: ProcessTask) => {
      const before = duplicates
      setDuplicates((gs) =>
        gs
          .map((g) => ({ ...g, tasks: g.tasks.filter((t) => t.id !== task.id) }))
          .filter((g) => g.tasks.length > 1),
      )
      remove([task.id], ['inbox', 'growth', 'targets'])
      trashTask(task.id)
        .then(() => toastWithUndo('Moved to Trash', 1, () => setDuplicates(before)))
        .catch(fail)
    },
    [duplicates, remove, toastWithUndo, fail],
  )

  const dismiss = useCallback((group: ShownDuplicateGroup) => {
    setDuplicates((gs) => gs.filter((g) => g.key !== group.key))
    const keys = readDismissed()
    keys.add(group.key)
    writeDismissed(keys)
  }, [])

  return {
    data,
    error,
    busy,
    setBusy,
    remove,
    toastWithUndo,
    fail,
    inboxQueue,
    inboxProjects,
    recommendations,
    duplicates,
    projects,
    move,
    skip,
    trash,
    dismiss,
  }
}

/** The batch and per-row writes of the growth and target steps. */
export function useProcessBatchActions(flow: ReturnType<typeof useProcessFlow>) {
  const { remove, toastWithUndo, fail, setBusy } = flow

  /**
   * Grow the checked rows (one bulk edit per new horizon) and keep the rest
   * (one bulk edit re-affirming them). If a later request fails, the earlier
   * ones have landed: the error toast is followed by an Undo for exactly
   * those, so nothing is left changed without a way back.
   */
  const applyGrowth = useCallback(
    async (grow: GrowthItem[], keep: GrowthItem[]) => {
      setBusy(true)
      const tally = newTally()
      try {
        const byTarget = new Map<string, number[]>()
        for (const g of grow) byTarget.set(g.to, [...(byTarget.get(g.to) ?? []), g.task.id])
        for (const [to, ids] of byTarget) await bulkEditChunks(ids, { horizon: to }, tally)
        if (keep.length) {
          await bulkEditChunks(
            keep.map((k) => k.task.id),
            { affirm_horizon: true },
            tally,
          )
        }
        remove(
          [...grow, ...keep].map((g) => g.task.id),
          ['growth'],
        )
        const parts = [grow.length && `Grew ${grow.length}`, keep.length && `kept ${keep.length}`]
        toastWithUndo(parts.filter(Boolean).join(', '), tally.entries)
      } catch (err) {
        fail(err)
        if (tally.entries > 0) toastWithUndo('Some of it was saved', tally.entries)
      } finally {
        setBusy(false)
      }
    },
    [remove, toastWithUndo, fail, setBusy],
  )

  const doIt = useCallback(
    (item: GrowthItem) => {
      remove([item.task.id], ['growth'])
      targetToday([item.task.id])
        .then(() => toastWithUndo('Targeted for today, not done'))
        .catch(fail)
    },
    [remove, toastWithUndo, fail],
  )

  const raise = useCallback(
    (item: GrowthItem) => {
      remove([item.task.id], ['growth'])
      raisePriority(item.task)
        .then(() =>
          toastWithUndo(
            `Raised to ${getPriorityOption(Math.min(item.task.priority + 1, URGENT_PRIORITY)).label}`,
          ),
        )
        .catch(fail)
    },
    [remove, toastWithUndo, fail],
  )

  const removeTargets = useCallback(
    async (ids: number[]) => {
      setBusy(true)
      const tally = newTally()
      try {
        // On a deadline task, clearing the target puts the deadline's
        // automatic one back (§8.3) — the server decides, per task.
        await bulkEditChunks(ids, { target_at: null }, tally)
        remove(ids, ['targets'])
        const n = tally.affected
        toastWithUndo(`Removed ${n} target${n === 1 ? '' : 's'}`, tally.entries)
      } catch (err) {
        fail(err)
        if (tally.entries > 0) toastWithUndo('Some of it was saved', tally.entries)
      } finally {
        setBusy(false)
      }
    },
    [remove, toastWithUndo, fail, setBusy],
  )

  return { applyGrowth, doIt, raise, removeTargets }
}
