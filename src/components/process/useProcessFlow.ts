'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useProjects } from '@/components/ProjectsProvider'
import { useProcess } from '@/hooks/useProcess'
import { showSaveError } from '@/lib/toast'
import { getPriorityOption } from '@/lib/priority'
import {
  bulkEditChunks,
  fetchDuplicates,
  fetchRecommendations,
  fetchTask,
  moveToProject,
  raisePriority,
  targetToday,
  trashTask,
  type GrowthItem,
  type ProcessData,
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

/** Drop tasks by id from every list Process shows. */
function without(d: ProcessData, ids: Set<number>): ProcessData {
  return {
    ...d,
    inbox: d.inbox.filter((t) => !ids.has(t.id)),
    growth: d.growth.filter((g) => !ids.has(g.task.id)),
    stale_targets: d.stale_targets.filter((s) => !ids.has(s.task.id)),
    stale_targets_with_deadline: d.stale_targets_with_deadline.filter((s) => !ids.has(s.task.id)),
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
  const { data, update, error, reload, toastWithUndo } = useProcess(open)
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
      update((d) => without(d, new Set([task.id])))
      moveToProject(task.id, project.id)
        .then(() => toastWithUndo(`Moved to ${project.name}`))
        .catch(fail)
    },
    [update, toastWithUndo, fail],
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
      update((d) => without(d, new Set([task.id])))
      trashTask(task.id)
        .then(() => toastWithUndo('Moved to Trash', 1, () => setDuplicates(before)))
        .catch(fail)
    },
    [duplicates, update, toastWithUndo, fail],
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
    update,
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
  const { update, toastWithUndo, fail, setBusy } = flow

  const applyGrowth = useCallback(
    async (grow: GrowthItem[], keep: GrowthItem[]) => {
      setBusy(true)
      try {
        let entries = 0
        const byTarget = new Map<string, number[]>()
        for (const g of grow) byTarget.set(g.to, [...(byTarget.get(g.to) ?? []), g.task.id])
        for (const [to, ids] of byTarget) entries += await bulkEditChunks(ids, { horizon: to })
        if (keep.length) {
          entries += await bulkEditChunks(
            keep.map((k) => k.task.id),
            { affirm_horizon: true },
          )
        }
        update((d) => without(d, new Set([...grow, ...keep].map((g) => g.task.id))))
        const parts = [grow.length && `Grew ${grow.length}`, keep.length && `kept ${keep.length}`]
        toastWithUndo(parts.filter(Boolean).join(', '), entries)
      } catch (err) {
        fail(err)
      } finally {
        setBusy(false)
      }
    },
    [update, toastWithUndo, fail, setBusy],
  )

  const doIt = useCallback(
    (item: GrowthItem) => {
      update((d) => without(d, new Set([item.task.id])))
      targetToday([item.task.id])
        .then(() => toastWithUndo('Targeted today'))
        .catch(fail)
    },
    [update, toastWithUndo, fail],
  )

  const raise = useCallback(
    (item: GrowthItem) => {
      update((d) => without(d, new Set([item.task.id])))
      raisePriority(item.task)
        .then(() =>
          toastWithUndo(
            `Raised to ${getPriorityOption(Math.min(item.task.priority + 1, 4)).label}`,
          ),
        )
        .catch(fail)
    },
    [update, toastWithUndo, fail],
  )

  const removeTargets = useCallback(
    async (ids: number[]) => {
      setBusy(true)
      try {
        const entries = await bulkEditChunks(ids, { target_at: null, deadline_nag_off: true })
        update((d) => without(d, new Set(ids)))
        toastWithUndo(`Removed ${ids.length} target${ids.length === 1 ? '' : 's'}`, entries)
      } catch (err) {
        fail(err)
      } finally {
        setBusy(false)
      }
    },
    [update, toastWithUndo, fail, setBusy],
  )

  return { applyGrowth, doIt, raise, removeTargets }
}
