'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSelectionMode } from '@/hooks/useSelectionMode'
import { useReminderActions } from '@/hooks/useReminderSelection'
import { ReminderSelectionBar } from '@/components/ReminderSelectionBar'
import { DeleteQuotasDialog } from '@/components/DeleteQuotasDialog'
import { promptWaiting, type QuotaPrompt } from '@/lib/quota-prompts'
import type { ReminderGroup, UseRemindersReturn } from '@/hooks/useReminders'
import type { TimeSlot } from '@/lib/time-slot-assign'
import type { Task } from '@/types'

/**
 * SELECT ON THE DASHBOARD'S REMINDERS CARD (2026-11-27, Trent: "Is there a
 * reason we never enabled multi-select on reminder panel items?" — there was
 * none but a design note that the card was "made for a glance").
 *
 * A "Select" pill on the card's actions line, left of "Consider all" (the
 * header row on a wide card, the line under it on a narrow one, so the
 * header stays one line at a phone; the design session, 2026-11-27), turns
 * the rows of the card's page into checkboxes: a tap on a row or its box picks it, the circle no longer
 * considers and a hold no longer opens the bubble. The bar is /reminders'
 * own (`ReminderSelectionBar`: Consider · Details · Today · Delete), wired to
 * the same verbs (`useReminderActions`): Consider is one request and one
 * Undo, Delete asks once when a quota prompt is in the selection
 * (`DeleteQuotasDialog`), Today moves the selection for today, and Details
 * opens the reminders' editor or the prompts' quotas.
 *
 * The universe is the page on screen (one period): its reminders, then its
 * waiting quota prompts. Select turns off when the card changes period (the
 * pager doesn't move by itself while selecting: it is held), when nothing on
 * the page is left waiting (the actions line, and the pill, are gone), and
 * from the pill. An action clears the selection and leaves Select on, as
 * on the Task queue card (Trent, 2026-10-30: it "only stays in select mode
 * if you enter select mode with the select button").
 */

/** The card's selection, made before the pager (the prompt rows and the hold need it). */
export function useReminderCardSelectionState() {
  const selection = useSelectionMode<number | string>()
  const [selectOn, setSelectOn] = useState(false)
  const selecting = selectOn || selection.isSelectionMode
  const { clear, toggle } = selection
  const toggleMode = useCallback(() => {
    if (selecting) {
      setSelectOn(false)
      clear()
    } else {
      setSelectOn(true)
    }
  }, [selecting, clear])
  const off = useCallback(() => {
    setSelectOn(false)
    clear()
  }, [clear])
  return {
    selection,
    selecting,
    toggleMode,
    off,
    selectedIds: selection.selectedIds,
    /** A row's tap or box in select mode: add or remove it. */
    pick: toggle,
  }
}

type CardSelectionState = ReturnType<typeof useReminderCardSelectionState>

/** The verbs and the bar, once the page on screen is known (`group`). */
export function useReminderCardSelection({
  state,
  group,
  pageKey,
  reminders,
  timeSlots,
  timezone,
  openReminders,
  openQuotas,
}: {
  state: CardSelectionState
  /** The page on screen's period; null before there is one. */
  group: ReminderGroup | null
  pageKey: string | null
  reminders: Pick<
    UseRemindersReturn,
    | 'complete'
    | 'completeMany'
    | 'completeGroup'
    | 'considerPrompt'
    | 'didPrompt'
    | 'remove'
    | 'moveForToday'
  >
  timeSlots: TimeSlot[]
  timezone: string
  /** Details on reminders: their editor. */
  openReminders: (tasks: Task[]) => void
  /** Details on prompts: their quotas' editor. */
  openQuotas: (prompts: QuotaPrompt[]) => void
}) {
  const { selection, selectedIds, off } = state

  // Select off when the card changes period.
  useEffect(() => {
    off()
  }, [pageKey, off])
  // And when nothing is left waiting: the actions line, and the pill, are gone.
  const nothingWaiting =
    !!group && group.reminders.length === 0 && !(group.prompts ?? []).some(promptWaiting)
  useEffect(() => {
    if (nothingWaiting) off()
  }, [nothingWaiting, off])

  const { orderedIds, selectedTasks, selectedPrompts } = useMemo(() => {
    const tasks = group?.reminders ?? []
    const prompts = (group?.prompts ?? []).filter(promptWaiting)
    return {
      orderedIds: [...tasks.map((t) => t.id), ...prompts.map((p) => p.prompt_key)],
      selectedTasks: tasks.filter((t) => selectedIds.has(t.id)),
      selectedPrompts: prompts.filter((p) => selectedIds.has(p.prompt_key)),
    }
  }, [group, selectedIds])

  const actions = useReminderActions({
    selection,
    orderedIds,
    selectedTasks,
    selectedPrompts,
    startedGroups: group ? [group] : [],
    complete: reminders.complete,
    completeMany: reminders.completeMany,
    completeGroup: reminders.completeGroup,
    considerPrompt: reminders.considerPrompt,
    didPrompt: reminders.didPrompt,
    remove: reminders.remove,
  })

  const { clear } = selection
  const bar = (
    <>
      <ReminderSelectionBar
        selectedCount={selectedTasks.length + selectedPrompts.length}
        reminderCount={selectedTasks.length}
        promptCount={selectedPrompts.length}
        onConsidered={actions.considerSelection}
        onDelete={actions.deleteSelection}
        onDetails={() =>
          selectedPrompts.length > 0 ? openQuotas(selectedPrompts) : openReminders(selectedTasks)
        }
        // Every row of the page is in its period.
        currents={[...selectedTasks, ...selectedPrompts].map(() => group?.slot ?? null)}
        timeSlots={timeSlots}
        timezone={timezone}
        onMoveForToday={(to) => {
          clear()
          void reminders.moveForToday(selectedTasks, selectedPrompts, to)
        }}
        onClear={clear}
      />
      <DeleteQuotasDialog
        request={actions.deleteRequest}
        onConfirm={actions.confirmDelete}
        onCancel={actions.cancelDelete}
      />
    </>
  )
  return { bar }
}
