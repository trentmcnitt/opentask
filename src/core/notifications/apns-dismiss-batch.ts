/**
 * ONE DISMISS PUSH PER USER PER WINDOW (2026-11-10). The APNs `dismiss` is a
 * silent push, and iOS budgets those to a few an hour, keeping only the
 * newest pending one: twenty considers in ten seconds sent twenty, and most
 * never arrived (Trent's stale banners, 11-10). So the dismisses a user's
 * mutations ask for in a FIXED window, counted from the first one (not a
 * sliding debounce, which a steady stream would never let flush), go out as
 * one push carrying the union of their task ids and prompt keys.
 *
 * Whichever push arrives makes a current native build reconcile every
 * delivered banner with the server (`POST /api/notifications/stale`), so the
 * union mostly serves older builds, which match the ids themselves. One
 * semantic loss, accepted: a quota's plain dismiss (done, deleted — "every
 * banner of this quota") merged with a prompt dismiss sends `promptKeys`, and
 * a build that matches by key then keeps that quota's other prompt banners;
 * the reconcile clears them on a current build.
 *
 * Web Push is not budgeted and stays immediate (dismiss.ts). `dismiss-all`
 * drops a pending batch: it clears everything anyway.
 */
import { log } from '@/lib/logger'
import { dismissApnsNotifications } from './apns'

/** How long a user's dismisses gather before their one push goes out. */
export const DISMISS_WINDOW_MS = 3000

interface Pending {
  taskIds: Set<number>
  promptKeys: Set<string>
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<number, Pending>()

/** Ask for an APNs dismiss of these tasks (and prompts); sent at the end of the user's window. */
export function queueApnsDismiss(userId: number, taskIds: number[], promptKeys?: string[]): void {
  if (taskIds.length === 0) return
  let batch = pending.get(userId)
  if (!batch) {
    const timer = setTimeout(() => void flushApnsDismiss(userId), DISMISS_WINDOW_MS)
    // Never hold a script or test process open for a pending dismiss.
    timer.unref?.()
    batch = { taskIds: new Set(), promptKeys: new Set(), timer }
    pending.set(userId, batch)
  }
  for (const id of taskIds) batch.taskIds.add(id)
  for (const key of promptKeys ?? []) batch.promptKeys.add(key)
}

/** Send a user's gathered dismiss now (the window's end; tests). */
export async function flushApnsDismiss(userId: number): Promise<void> {
  const batch = pending.get(userId)
  if (!batch) return
  clearTimeout(batch.timer)
  pending.delete(userId)
  const taskIds = [...batch.taskIds]
  const promptKeys = [...batch.promptKeys]
  try {
    await dismissApnsNotifications(userId, taskIds, promptKeys.length ? promptKeys : undefined)
    log.info('notifications', `APNs dismiss sent for tasks [${taskIds.join(',')}] (combined)`)
  } catch (err) {
    log.error('notifications', 'APNs dismiss error:', err)
  }
}

/** Drop a user's pending dismiss without sending it (a `dismiss-all` supersedes it). */
export function dropApnsDismiss(userId: number): void {
  const batch = pending.get(userId)
  if (!batch) return
  clearTimeout(batch.timer)
  pending.delete(userId)
}
