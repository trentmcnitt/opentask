'use client'

import { useCallback, useEffect, useMemo } from 'react'
import { slotGroupKey } from '@/lib/reminder-slots'
import { promptWaiting, type QuotaPrompt } from '@/lib/quota-prompts'
import type { ReminderGroup } from '@/hooks/useReminders'
import type { useSelectionMode } from '@/hooks/useSelectionMode'
import { SLOT_PREVIEW_COUNT, slotShowsEverything } from '@/components/reminders/ReminderSlotGroup'
import type { Task } from '@/types'

/**
 * The rows actually rendered, in DOM order — the universe for range
 * selection — and which of them are selected. Per slot that is the reminders
 * on screen, then the slot's waiting quota prompts (`SlotPromptList`, which
 * draws every one: prompts are never capped), so a Shift-click range runs
 * across the seam exactly as the eye reads it.
 */
export function useRenderedSelection({
  searching,
  searchGroups,
  visibleGroups,
  started,
  isOpen,
  expandedKeys,
  selectedIds,
}: {
  searching: boolean
  searchGroups: ReminderGroup[]
  visibleGroups: ReminderGroup[]
  started: ReminderGroup[]
  isOpen: (key: string) => boolean
  expandedKeys: Set<string>
  selectedIds: Set<number | string>
}) {
  const rendered = useMemo(() => {
    // While searching every match is on screen, so range selection spans all
    // of them rather than the usual open-and-expanded subset (and a search
    // group's prompts are already only the waiting ones).
    if (searching) {
      return searchGroups.map((group) => ({ reminders: group.reminders, prompts: group.prompts }))
    }
    return visibleGroups
      .filter((group) => isOpen(slotGroupKey(group)))
      .map((group) => ({
        // Must mirror ReminderSlotGroup's own slice, or a shift-click range
        // would span rows that are not on screen.
        reminders: slotShowsEverything(
          started.includes(group),
          expandedKeys.has(slotGroupKey(group)),
        )
          ? group.reminders
          : group.reminders.slice(0, SLOT_PREVIEW_COUNT),
        prompts: group.prompts.filter(promptWaiting),
      }))
  }, [searching, searchGroups, visibleGroups, isOpen, expandedKeys, started])
  const orderedIds = useMemo(
    () =>
      rendered.flatMap((g) => [
        ...g.reminders.map((r) => r.id),
        ...g.prompts.map((p) => p.prompt_key),
      ]),
    [rendered],
  )
  const selectedTasks = useMemo(
    () => rendered.flatMap((g) => g.reminders).filter((r) => selectedIds.has(r.id)),
    [rendered, selectedIds],
  )
  const selectedPrompts = useMemo(
    () => rendered.flatMap((g) => g.prompts).filter((p) => selectedIds.has(p.prompt_key)),
    [rendered, selectedIds],
  )
  return { orderedIds, selectedTasks, selectedPrompts }
}

/**
 * The surface's verbs, wired to the selection so a row that leaves the screen
 * leaves the selection too, whichever path took it. Escape clears a selection,
 * as it does on the dashboard.
 */
export function useReminderActions({
  selection,
  orderedIds,
  selectedTasks,
  selectedPrompts,
  startedGroups,
  complete,
  completeMany,
  completeGroup,
  considerPrompt,
  didPrompt,
  remove,
}: {
  selection: ReturnType<typeof useSelectionMode<number | string>>
  orderedIds: (number | string)[]
  selectedTasks: Task[]
  selectedPrompts: QuotaPrompt[]
  startedGroups: ReminderGroup[]
  complete: (task: Task) => Promise<void>
  completeMany: (tasks: Task[], prompts?: QuotaPrompt[]) => Promise<void>
  completeGroup: (group: ReminderGroup) => Promise<void>
  considerPrompt: (prompt: QuotaPrompt) => Promise<void>
  didPrompt: (prompt: QuotaPrompt) => Promise<void>
  remove: (tasks: Task[]) => Promise<void>
}) {
  const { isSelectionMode, toggle, rangeSelect, removeAll, clear } = selection

  useEffect(() => {
    if (!isSelectionMode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clear()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isSelectionMode, clear])

  /**
   * Add or remove one row. Deliberately `toggle`, where the dashboard's plain
   * desktop click is `selectOnly`: there, a click that replaced the selection
   * costs a click to undo, but here dropping out of selection mode means the
   * NEXT tap considers the thought. Replace-and-exit is a footgun this surface
   * has and the dashboard does not, so every tap in selection mode accumulates.
   */
  const selectRow = useCallback((task: Task) => toggle(task.id), [toggle])
  const rangeSelectRow = useCallback(
    (task: Task) => rangeSelect(task.id, orderedIds),
    [rangeSelect, orderedIds],
  )
  const completeOne = useCallback(
    (task: Task) => {
      removeAll([task.id])
      void complete(task)
    },
    [removeAll, complete],
  )
  // A prompt is selected by its `prompt_key`, never its task id: a daily
  // quota's numbers are separate rows sharing one task.
  const selectPrompt = useCallback((prompt: QuotaPrompt) => toggle(prompt.prompt_key), [toggle])
  const rangeSelectPrompt = useCallback(
    (prompt: QuotaPrompt) => rangeSelect(prompt.prompt_key, orderedIds),
    [rangeSelect, orderedIds],
  )
  // A prompt's own dashed circle and "did it" square act on that one row, and it
  // leaves the selection as it goes — `completeOne`'s rule for a reminder.
  const considerOnePrompt = useCallback(
    (prompt: QuotaPrompt) => {
      removeAll([prompt.prompt_key])
      void considerPrompt(prompt)
    },
    [removeAll, considerPrompt],
  )
  const didOnePrompt = useCallback(
    (prompt: QuotaPrompt) => {
      removeAll([prompt.prompt_key])
      void didPrompt(prompt)
    },
    [removeAll, didPrompt],
  )
  const completeSlot = useCallback(
    (group: ReminderGroup) => {
      removeAll([...group.reminders.map((r) => r.id), ...group.prompts.map((p) => p.prompt_key)])
      void completeGroup(group)
    },
    [removeAll, completeGroup],
  )
  // Reminders and prompts together: ONE request (bulk/complete when it is a
  // mix), one Undo. Prompts are considered, never +1 — the bar's green
  // button means what every sweep means.
  const considerSelection = useCallback(() => {
    const tasks = selectedTasks
    const prompts = selectedPrompts
    clear()
    void completeMany(tasks, prompts)
  }, [selectedTasks, selectedPrompts, clear, completeMany])
  const considerSoFar = useCallback(() => {
    const tasks = startedGroups.flatMap((g) => g.reminders)
    // Waiting quota prompts are part of "so far" — considered, never +1.
    const prompts = startedGroups.flatMap((g) => g.prompts.filter(promptWaiting))
    clear()
    void completeMany(tasks, prompts)
  }, [startedGroups, clear, completeMany])
  // Reminders only. The bar offers no Trash while a prompt is selected (a
  // prompt row must never delete its quota); refused here as well.
  const deleteSelection = useCallback(() => {
    if (selectedPrompts.length > 0) return
    const tasks = selectedTasks
    clear()
    void remove(tasks)
  }, [selectedTasks, selectedPrompts, clear, remove])
  // The details editor's verbs: the reminder(s) it holds, whether or not
  // they are the selection.
  const considerMany = useCallback(
    (tasks: Task[]) => {
      removeAll(tasks.map((t) => t.id))
      void completeMany(tasks)
    },
    [removeAll, completeMany],
  )
  const deleteMany = useCallback(
    (tasks: Task[]) => {
      removeAll(tasks.map((t) => t.id))
      void remove(tasks)
    },
    [removeAll, remove],
  )

  return {
    isSelectionMode,
    selectRow,
    rangeSelectRow,
    selectPrompt,
    rangeSelectPrompt,
    considerPrompt: considerOnePrompt,
    didPrompt: didOnePrompt,
    complete: completeOne,
    completeGroup: completeSlot,
    considerSelection,
    considerSoFar,
    deleteSelection,
    considerMany,
    deleteMany,
  }
}
