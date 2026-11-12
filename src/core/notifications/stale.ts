/**
 * THE BANNER RECONCILE (2026-11-10): which of a device's delivered banners no
 * longer stand. `POST /api/notifications/stale` answers it for the native
 * apps (iPhone, Mac, Watch), which send what each delivered banner carries
 * and remove the identifiers this returns.
 *
 * Why: the `dismiss` silent push names only the tasks its own mutation
 * touched, and iOS budgets silent pushes to a few an hour, keeping only the
 * newest pending one. Twenty considers in ten seconds sent twenty dismisses;
 * at most one arrived, so most banners stayed on the lock screen (Trent,
 * 11-10). Now whichever push arrives makes the device ask this, and one
 * arrival cleans every stale banner — however it was handled, wherever.
 *
 * The rules — each the push's own "does it still stand" test, never a new one:
 *  - `prompt_key` (a named quota-prompt push): stale unless today's standing
 *    keys hold it (`standingPromptKeys`); another day's key never does.
 *  - icon `reminder` (a named reminder push): stale unless
 *    `namedPushStands` — waiting today, in an opened period, Medium+.
 *  - icon `period` (a period push): stale when its period has not opened
 *    today (yesterday's banner) or has nothing it counts waiting
 *    (`waitingBySlot`: reminders and prompts without a named push of their
 *    own). A count that only dropped leaves the banner: the next nag
 *    replaces it with the right number.
 *  - kind `deadlines` (the deadlines-page nag): stale when no row keeps the
 *    nag going (`deadlineRowsWaiting`) — the page is built only when such a
 *    banner is asked about.
 *  - icon `task` (an overdue task's push): stale unless still currently due
 *    (`getCurrentlyDueTaskIds`: done, deleted, deferred or retargeted all
 *    end it).
 *  - a `taskId` with no icon (AI finished, enrichment failed, and banners
 *    from before the icons): stale only when the task is done, deleted,
 *    archived or not this user's — those tasks were never overdue.
 *  - anything else (the overdue summary, the sweep result, the deadline cap):
 *    never stale here. They go as they always have.
 */
import { getDb } from '@/core/db'
import { getCurrentlyDueTaskIds } from '@/core/tasks/currently-due'
import { DEADLINES_NAG_KIND } from './apns'
import { deadlineRowsWaiting } from './deadline-nags'
import { standingPromptKeys } from './prompt-nags'
import { namedPushStands, openedPeriods } from './reminder-nags'
import { waitingBySlot } from './slot-reminders'

/** What a device knows about one delivered banner: its payload's fields. */
export interface DeliveredBannerInfo {
  /** The request identifier — what the device removes. */
  id: string
  task_id?: number | null
  prompt_key?: string | null
  icon?: string | null
  kind?: string | null
  slot_id?: number | null
}

/** Lazily computed facts, each read at most once per request. */
function factsFor(userId: number, timezone: string, now: Date) {
  const once = <T>(read: () => T) => {
    let value: { v: T } | null = null
    return () => (value ??= { v: read() }).v
  }
  return {
    prompts: once(() => standingPromptKeys(userId, timezone, now)),
    opened: once(() => openedPeriods(userId, timezone, now).opened),
    slots: once(() => waitingBySlot(userId, timezone, now)),
    deadlines: once(() => deadlineRowsWaiting(userId, timezone, now)),
    due: once(() => new Set(getCurrentlyDueTaskIds(userId, now))),
  }
}

/** This user's open tasks among `ids` (not done, deleted or archived). */
function openTaskIds(userId: number, ids: number[]): Set<number> {
  if (ids.length === 0) return new Set()
  const rows = getDb()
    .prepare(
      `SELECT id FROM tasks
       WHERE user_id = ? AND done = 0 AND deleted_at IS NULL AND archived_at IS NULL
         AND id IN (${ids.map(() => '?').join(',')})`,
    )
    .all(userId, ...ids) as { id: number }[]
  return new Set(rows.map((r) => r.id))
}

/**
 * RULE BANNER-STALE: A delivered banner is stale by its kind: a prompt key no
 *   longer standing; the deadlines nag with no row waiting; a period banner
 *   whose period has not opened today or has nothing waiting; a named
 *   reminder no longer standing; an overdue task no longer due; any other
 *   task banner once the task is done or gone. A banner the rules do not know
 *   is never stale. A count that only dropped leaves a period banner.
 * Why: The device asks about everything it shows, so one request clears whatever no longer
 *   stands.
 * Ruling: The design session's call, 2026-11-10; Trent's words are not recorded here.
 */
/** The identifiers of the banners in `banners` that no longer stand. */
export function staleBannerIds(
  userId: number,
  banners: readonly DeliveredBannerInfo[],
  now: Date = new Date(),
): string[] {
  const user = getDb().prepare('SELECT timezone FROM users WHERE id = ?').get(userId) as
    | { timezone: string }
    | undefined
  if (!user) return []
  const facts = factsFor(userId, user.timezone, now)
  const taskIds = banners
    .map((b) => b.task_id)
    .filter((id): id is number => Number.isSafeInteger(id))
  const open = openTaskIds(userId, [...new Set(taskIds)])
  return banners.filter((b) => isStale(b, userId, facts, open, now)).map((b) => b.id)
}

function isStale(
  b: DeliveredBannerInfo,
  userId: number,
  facts: ReturnType<typeof factsFor>,
  open: Set<number>,
  now: Date,
): boolean {
  if (b.prompt_key) return !facts.prompts().has(b.prompt_key)
  if (b.kind === DEADLINES_NAG_KIND) return facts.deadlines() === 0
  if (b.icon === 'period') return periodStale(b.slot_id, facts)
  const taskId = b.task_id
  if (taskId === null || taskId === undefined) return false
  if (!open.has(taskId)) return true
  if (b.icon === 'reminder') return !namedPushStands(userId, taskId, now)
  if (b.icon === 'task') return !facts.due().has(taskId)
  return false
}

function periodStale(
  slotId: number | null | undefined,
  facts: ReturnType<typeof factsFor>,
): boolean {
  if (slotId === null || slotId === undefined) return false
  if (!facts.opened().has(slotId)) return true
  const waiting = facts.slots().get(slotId)
  return !waiting || waiting.reminders + waiting.prompts === 0
}
