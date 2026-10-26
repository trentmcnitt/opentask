/**
 * DEFER ONLY EVER MOVES A TARGET LATER (Trent, 2026-10-26) — the rule for the
 * Defer button with a selection (`useSnoozeOverdue`'s `snoozeSelected`).
 *
 * Without a selection the button only ever sees overdue tasks, whose targets
 * are all before any defer time, so the rule holds by construction. A
 * selection can hold anything: a task due tomorrow, one with no target at
 * all. Sending those with the rest would pull tomorrow's task back to this
 * evening, or give an undated task its first date — neither is "not now". So
 * the selection is split here, on the one absolute time the press resolved:
 *
 * - `movers`: a target strictly before the defer time (overdue, or due
 *   earlier today). Only these are sent.
 * - `later`: a target at or after the defer time. Left alone and counted.
 *   Equal counts as later: the server would treat it as a no-op anyway.
 * - `undated`: no target. Left alone and counted.
 *
 * The comparison is against the defer time the request carries, not against
 * where the server finally puts each task. With the task queue on, a defer
 * landing at or after the next rollover parks a below-High, deadline-free
 * task AT the rollover (`planLanding` in `src/core/tasks/bulk.ts`), which can
 * be before the defer time: at 10 PM, "next period" may be tomorrow 8:00 and
 * the rollover 3:00. A selected task targeted between the two then goes into
 * the queue at 3:00 — the queue taking it, not a pick moving it earlier — so
 * it is not mirrored here.
 */

import type { Task } from '@/types'

export interface SelectionDeferSplit {
  movers: Task[]
  later: number
  undated: number
}

export function splitSelectionDefer(tasks: Task[], deferUntil: string): SelectionDeferSplit {
  const cutoff = Date.parse(deferUntil)
  const movers: Task[] = []
  let later = 0
  let undated = 0
  for (const task of tasks) {
    if (!task.due_at) undated++
    else if (Date.parse(task.due_at) < cutoff) movers.push(task)
    else later++
  }
  return { movers, later, undated }
}

/** "1 already later", "2 have no target" — the parts the toast adds. */
function heldBackParts({ later, undated }: Pick<SelectionDeferSplit, 'later' | 'undated'>) {
  const parts: string[] = []
  if (later > 0) parts.push(`${later} already later`)
  if (undated > 0) parts.push(`${undated} ${undated === 1 ? 'has' : 'have'} no target`)
  return parts
}

/**
 * What the toast appends to the server's summary line for the tasks the
 * client held back: "Deferred 2 tasks · 1 already later · 1 has no target".
 * Empty when nothing was held back.
 */
export function selectionHeldBackSuffix(split: Pick<SelectionDeferSplit, 'later' | 'undated'>) {
  return heldBackParts(split)
    .map((p) => ` · ${p}`)
    .join('')
}

/** The toast when no selected task qualifies (no request is sent). */
export function nothingToDeferMessage(split: Pick<SelectionDeferSplit, 'later' | 'undated'>) {
  const parts = heldBackParts(split)
  return parts.length > 0 ? `Nothing to defer: ${parts.join(', ')}` : 'Nothing to defer'
}
