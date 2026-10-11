/**
 * The deadline caps a snooze (2026-10-10, docs/TASK-MODEL.md § Deadline): the
 * server refuses a single snooze past a deadline still ahead with 409
 * `PAST_DEADLINE`, never clamping it silently. The client's "confirm" is the
 * refusal toast's own button — "Snooze anyway" resends the same request with
 * `allow_past_deadline: true` — rather than a modal (Trent's rule: undo over
 * confirm). PROVISIONAL, like the cap itself.
 */
import { showToast } from '@/lib/toast'
import { DEADLINE_TODAY_HOLDS } from '@/lib/task-model-words'

export class PastDeadlineRefusal extends Error {
  readonly code = 'PAST_DEADLINE'
  constructor(
    message: string,
    /** Resend with the override. */
    readonly retry: () => Promise<unknown>,
  ) {
    super(message)
    this.name = 'PastDeadlineRefusal'
  }
}

export function isPastDeadlineBody(body: unknown): boolean {
  return (body as { code?: unknown } | null)?.code === 'PAST_DEADLINE'
}

async function undoLast(): Promise<void> {
  await fetch('/api/undo', { method: 'POST' }).catch(() => undefined)
}

/** The refusal toast, with the override on its button and Undo after it. */
export function offerSnoozeAnyway(refusal: PastDeadlineRefusal): void {
  showToast({
    message: 'That snooze goes past the deadline',
    type: 'error',
    action: {
      label: 'Snooze anyway',
      onClick: () => {
        refusal.retry().then(
          (result) =>
            showToast({
              // On the deadline's own day the nag stays on (ruling A4): the
              // server's description says so, and the toast passes it on.
              message:
                (result as { description?: string } | undefined)?.description ===
                DEADLINE_TODAY_HOLDS
                  ? DEADLINE_TODAY_HOLDS
                  : 'Snoozed past the deadline',
              type: 'success',
              action: { label: 'Undo', onClick: () => void undoLast() },
            }),
          (err: unknown) =>
            showToast({
              message: err instanceof Error && err.message ? err.message : 'Snooze failed',
              type: 'error',
            }),
        )
      },
    },
  })
}
