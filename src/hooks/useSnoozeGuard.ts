'use client'

import { useCallback, useRef, useState } from 'react'
import { evaluateSnoozeGuard, nextScheduledOccurrence, type SnoozeGuard } from '@/lib/snooze-guard'
import type { Task } from '@/types'

interface PendingSnooze {
  task: Task
  until: string
}

/**
 * Wraps a single-task snooze callback with the §4.3 confirmation prompts.
 *
 * Usage: call `requestSnooze(task, until)` where the raw snooze used to be
 * called, and render `<SnoozeGuardDialog {...dialogProps} />`. When no guard
 * applies, the snooze runs immediately with no extra render — the common case
 * stays frictionless.
 *
 * SCOPE (§4.3, load-bearing): single-task interactive snooze only. Bulk sweeps
 * must never modal-block, so this hook is deliberately shaped around one task
 * and cannot express a batch. Anything that snoozes many tasks should call the
 * bulk endpoints directly and report counts.
 *
 * The pending snooze lives in a ref as well as state: the dialog's action
 * handlers read it synchronously when they fire, and React may not have
 * committed a state update by then (the same hazard documented on
 * SelectionActionSheet's pending fields).
 */
export function useSnoozeGuard(
  timezone: string,
  onSnooze: (taskId: number, until: string) => void | Promise<void>,
) {
  const [guard, setGuard] = useState<SnoozeGuard | null>(null)
  const pendingRef = useRef<PendingSnooze | null>(null)

  const requestSnooze = useCallback(
    (task: Task, until: string) => {
      const result = evaluateSnoozeGuard(task, until, timezone)
      if (!result) {
        void onSnooze(task.id, until)
        return
      }
      pendingRef.current = { task, until }
      setGuard(result)
    },
    [timezone, onSnooze],
  )

  const clear = useCallback(() => {
    pendingRef.current = null
    setGuard(null)
  }, [])

  /** Proceed with exactly what the user asked for. */
  const handleConfirm = useCallback(() => {
    const pending = pendingRef.current
    clear()
    if (pending) void onSnooze(pending.task.id, pending.until)
  }, [clear, onSnooze])

  /**
   * Snooze to the next scheduled occurrence instead. Recomputed here rather
   * than read off the guard so the value sent to the server comes from the
   * single rrule evaluator (§4.6) rather than from a string round-trip.
   */
  const handleSnoozeToNextOccurrence = useCallback(() => {
    const pending = pendingRef.current
    clear()
    if (!pending) return
    const next = nextScheduledOccurrence(pending.task, timezone)
    // Falling back to the original target is correct: the user already chose
    // it, and the alternative is a button that does nothing.
    void onSnooze(pending.task.id, next ? next.toISOString() : pending.until)
  }, [clear, onSnooze, timezone])

  return {
    requestSnooze,
    dialogProps: {
      guard,
      timezone,
      onConfirm: handleConfirm,
      onSnoozeToNextOccurrence: handleSnoozeToNextOccurrence,
      onCancel: clear,
    },
  }
}
