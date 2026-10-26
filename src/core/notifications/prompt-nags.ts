/**
 * NAMED QUOTA-PROMPT PUSHES (Push PR 4, 2026-10-26, Trent; plan "named
 * pushes and marks"; docs/NOTIFICATIONS.md § Named quota-prompt pushes).
 *
 * WHAT. The named reminder pushes (reminder-nags.ts) for quota prompts: a
 * waiting prompt whose QUOTA is Medium or above gets a push of its own — the
 * quota's short title as the banner's title, "Morning · 1/3 this week" as the
 * body (the count first, no priority word) — instead of being one of its
 * period's count. None and Low prompts stay in the period push and the
 * period nag; the ones pushed by name are left out of both (`waitingBySlot`,
 * `promptGetsNamedPush` in reminder-nag-rule.ts), so a period with only
 * Medium+ items waiting sends no period push and no period nag.
 *
 * WHEN A PROMPT GETS ONE — all of:
 *  - it is waiting in today's prompts (`getQuotaPromptsBySlot`, the
 *    Reminders screen's own: neither considered nor done — `promptWaiting`);
 *  - its quota's priority is Medium (2) or above (`promptGetsNamedPush`).
 *    Priority is the only dial: there is no Nag option, as for reminders;
 *  - it is in a real period, not Anytime (the un-slotted group never opens);
 *  - its period has opened today (`openedPeriods`, the OpenTask day).
 * One per `prompt_key`, so a daily quota with prompts in two periods gets one
 * in each.
 *
 * WHEN IT FIRES.
 *  - FIRST at the period's open, exact (the first tick at or after it).
 *  - REPEATS at the slot nag's rung for its quota's priority
 *    (`nagIntervalMinutes('slot_nag', priority)`: Medium 120, High 30, Urgent
 *    10 with the shipped tiers), on clock marks (`nextNagAt`).
 *  - STOPS when considered or did-it'd, when its count is met (a daily row
 *    #k once today's count reaches k; any other quota once anything is
 *    logged today: both make it `done`), and at the end of the OpenTask day
 *    (the next day's keys are new, and its periods have not opened).
 *
 * PACING: `nag_sends`, key `prompt-<prompt_key>`. DEVIATION from the
 * reminder rows (`reminder-<taskId>`, no date): a prompt key already carries
 * its OpenTask date (`q:<taskId>:<k>:<date>`), so each day's prompt is a
 * fresh row — never sent is the first push, and no `since` floor is needed.
 * The claim is the same compare-and-swap, under the tick's per-minute claim
 * (`tick-prompt-nags`). The weekly purge drops rows two days old or more:
 * their day is over (`purgeOldPromptNags`).
 *
 * THE CHEAP GATE (`mayBeDue`, like the reminders'): before a user's prompts
 * are computed, one query lists their Medium+ live quotas with today's
 * `prompt-…` stamps, and the placement rule alone (`promptPlacements`, the
 * one `getQuotaPromptsBySlot` uses) says which rows sit in which period. The
 * prompts are computed only when some row is in an opened period, not
 * considered today, and its stamp is due. A superset of the real test (it
 * does not read the count), so it never skips a due push.
 *
 * HOW (one alert per tick, tick.ts). Kinds `prompt_urgent`, `prompt_high`,
 * `prompt_medium`, each ranked WITH the reminder of the same priority
 * (`SAME_RANK`): Urgent reminder or prompt › High reminder or prompt › … ›
 * Medium reminder or prompt. High and Urgent SOUND; Medium is SILENT by its
 * own rule, so it never leads a minute in which something sounds. Every
 * banner is `interruption-level: active`. Payloads: `buildPromptNagNotification`
 * (apns.ts) and `sendPromptWebPush` below, with "Considered" and "Did it"
 * buttons on the web (public/sw.js → POST /api/quota-prompts/consider and
 * /did with the push's `prompt_key`).
 *
 * STALE BANNERS: `promptPushEndCheck` — a mutation that can end a prompt's
 * named push (consider, did it, a count logged, an edit of the quota's
 * priority, kind, period or target; and the user-level changes: the prompt
 * switch, the default period, a period deleted or retimed, the day start)
 * asks it before and after, and dismisses the ended PROMPTS
 * (`dismissPromptNotifications`, dismiss.ts): the `dismiss` push carries
 * their `promptKeys`, and a banner with a `prompt_key` closes only when its
 * key is listed — so considering Morning's prompt of a daily quota leaves
 * Evening's banner up (review of #377).
 *
 * WHY THIS IS NOT A §6 VIOLATION: the same exception Trent ruled for Medium+
 * reminders on 2026-10-26. A prompt still carries no debt: never overdue,
 * never in the badge, nothing rolls past the day.
 */

import { getDb } from '@/core/db'
import { log } from '@/lib/logger'
import { HIGH_PRIORITY_THRESHOLD, URGENT_PRIORITY } from '@/lib/priority'
import {
  dayStateFor,
  promptCountText,
  promptDate,
  promptEnabled,
  promptKey,
  promptPlacements,
  promptWaiting,
  type QuotaPrompt,
} from '@/lib/quota-prompts'
import { isTracked } from '@/lib/track'
import { listTimeSlots } from '@/core/time-slots'
import { getQuotaPromptsBySlot, quotaPromptsEnabledGlobally } from '@/core/tasks/quota-prompts'
import { parseJsonColumn } from '@/core/tasks/read'
import { dayBoundaryForUser } from '@/core/tasks/rollover-time'
import { APP_URL } from '@/core/notifications/format'
import { dismissPromptNotifications } from '@/core/notifications/dismiss'
import { isApnsConfigured, promptCollapseId, sendApnsPromptNag } from '@/core/notifications/apns'
import { isWebPushConfigured, sendPushNotification } from '@/core/notifications/web-push'
import { mergeSettled, type DeliveryResult } from '@/core/notifications/delivery-result'
import { notifiableUsers } from '@/core/notifications/notifiable-users'
import { nagIntervalMinutes, userNagTiers, type NagTiers } from '@/core/notifications/nag-ladder'
import { claimNagSend, dueAfter } from '@/core/notifications/nag-sends'
import {
  NAMED_REMINDER_MIN_PRIORITY,
  promptGetsNamedPush,
} from '@/core/notifications/reminder-nag-rule'
import { CONSIDERED_ACTION, openedPeriods } from '@/core/notifications/reminder-nags'
import {
  runTick,
  type Channels,
  type Delivery,
  type PushKind,
  type SourcePlan,
  type TickSource,
} from '@/core/notifications/tick'
import type { QuotaDayState, QuotaPromptConfig } from '@/types'

/** The `nag_sends` key prefix: `prompt-<prompt_key>`. */
export const PROMPT_NAG_KEY_PREFIX = 'prompt-'

export function promptNagKey(key: string): string {
  return `${PROMPT_NAG_KEY_PREFIX}${key}`
}

/** The Web Push "Did it" button (public/sw.js handles `did`). */
export const DID_ACTION = { action: 'did', title: 'Did it' } as const

/** How long a `prompt-…` row is kept: its day is over well before this. */
const PROMPT_NAG_RETENTION_DAYS = 2

export interface PendingPromptNag {
  userId: number
  /** The quota's task id. */
  taskId: number
  promptKey: string
  /** The quota's short title (`short_title ?? title`). */
  title: string
  /** The quota's priority. */
  priority: number
  slotLabel: string
  /** "1/3 this week" (`promptCountText`, the prompt row's own words). */
  countText: string
  /** The slot nag's rung for its quota's priority (minutes). */
  intervalMinutes: number
  /** The user's zone, whose clock marks the repeats land on. */
  timezone: string
}

/** The tick's kind for a named prompt push (ranked with the reminder of its priority). */
export function promptKind(priority: number): PushKind {
  if (priority >= URGENT_PRIORITY) return 'prompt_urgent'
  if (priority >= HIGH_PRIORITY_THRESHOLD) return 'prompt_high'
  return 'prompt_medium'
}

/** High and Urgent sound; Medium is silent (and so never leads a sounding minute). */
export function promptSounds(priority: number): boolean {
  return priority >= HIGH_PRIORITY_THRESHOLD
}

/** "Morning · 1/3 this week": the period, then the count — no priority word. */
export function promptNagBody(slotLabel: string, countText: string): string {
  return `${slotLabel} · ${countText}`
}

/** One Medium+ quota, as its row reads (the gate's input). */
interface NamedPromptCandidate {
  id: number
  title: string
  short_title: string | null
  priority: number
  rrule: string | null
  progress_target: number
  is_tracked: number
  quota_prompt_config: string | null
  quota_day_state: string | null
}

/**
 * The user's quotas whose prompts `promptGetsNamedPush` could pick — one
 * statement. `getQuotaPromptsBySlot` reads the same open, undeleted,
 * unarchived own quotas, so every prompt it could push by name is one of
 * these.
 */
function namedPromptCandidates(userId: number): NamedPromptCandidate[] {
  return getDb()
    .prepare(
      `SELECT id, title, short_title, priority, rrule, progress_target, is_tracked,
              quota_prompt_config, quota_day_state
       FROM tasks
       WHERE user_id = ? AND done = 0 AND deleted_at IS NULL AND archived_at IS NULL
         AND (is_tracked = 1 OR progress_target > 1)
         AND priority >= ?`,
    )
    .all(userId, NAMED_REMINDER_MIN_PRIORITY) as NamedPromptCandidate[]
}

/** The quota's banner title: its short title when it has one. */
function bannerTitle(c: Pick<NamedPromptCandidate, 'title' | 'short_title'>): string {
  return c.short_title?.trim() || c.title
}

/** The user's prompt switch and default period (`readUserSettings`'s two fields the gate needs). */
function promptSettings(userId: number): { enabled: boolean; defaultSlotId: number | null } {
  const row = getDb()
    .prepare('SELECT quota_prompts_enabled, quota_prompt_slot_id FROM users WHERE id = ?')
    .get(userId) as
    | { quota_prompts_enabled: number; quota_prompt_slot_id: number | null }
    | undefined
  return {
    enabled: quotaPromptsEnabledGlobally() && (row?.quota_prompts_enabled ?? 1) !== 0,
    defaultSlotId: row?.quota_prompt_slot_id ?? null,
  }
}

/** Today's `prompt-…` stamps for a user, by prompt key. */
function stampsFor(userId: number, date: string): Map<string, string> {
  const rows = getDb()
    .prepare(
      `SELECT key, last_sent_at FROM nag_sends
       WHERE user_id = ? AND key LIKE '${PROMPT_NAG_KEY_PREFIX}q:%' AND key LIKE '%:' || ?`,
    )
    .all(userId, date) as { key: string; last_sent_at: string }[]
  return new Map(rows.map((r) => [r.key.slice(PROMPT_NAG_KEY_PREFIX.length), r.last_sent_at]))
}

/**
 * THE CHEAP GATE: could any of these quotas' prompts be due at `now`? From
 * the rows alone — the placement rule (`promptPlacements`), today's
 * considered keys, the stamps — never the count, so a superset of the real
 * test in `pendingPromptNags`.
 */
function mayBeDue(
  candidates: NamedPromptCandidate[],
  ctx: {
    userId: number
    timezone: string
    date: string
    opened: Map<number, Date>
    tiers: NagTiers
    now: Date
  },
): boolean {
  const settings = promptSettings(ctx.userId)
  if (!settings.enabled) return false
  const slots = listTimeSlots(ctx.userId)
  const stamps = stampsFor(ctx.userId, ctx.date)
  for (const c of candidates) {
    const task = {
      rrule: c.rrule,
      progress_target: c.progress_target,
      is_tracked: c.is_tracked === 1,
      quota_prompt_config: parseJsonColumn<QuotaPromptConfig>(c.quota_prompt_config),
    }
    if (!isTracked(task) || !promptEnabled(task)) continue
    const interval = nagIntervalMinutes('slot_nag', c.priority, ctx.tiers)
    if (interval <= 0) continue
    const considered = dayStateFor(
      parseJsonColumn<QuotaDayState>(c.quota_day_state),
      ctx.date,
    ).considered
    for (const row of promptPlacements(task, slots, settings.defaultSlotId)) {
      const slot = slots[row.slotIndex]
      if (!slot || !ctx.opened.has(slot.id)) continue
      const key = promptKey(c.id, row.number, ctx.date)
      if (considered.includes(key)) continue
      if (dueAfter(stamps.get(key) ?? null, interval, ctx.now, ctx.timezone)) return true
    }
  }
  return false
}

/** A user's waiting prompts that are pushed by name, in opened real periods. */
function standingNamedPrompts(
  userId: number,
  timezone: string,
  now: Date,
  opened: Map<number, Date>,
): QuotaPrompt[] {
  const out: QuotaPrompt[] = []
  for (const [slotId, prompts] of getQuotaPromptsBySlot(userId, timezone, now)) {
    // Anytime (no slot) never opens; a period still ahead has not opened.
    if (slotId === null || !opened.has(slotId)) continue
    for (const p of prompts) if (promptWaiting(p) && promptGetsNamedPush(p)) out.push(p)
  }
  return out
}

/**
 * Every named prompt push due this minute (read-only). The claim is
 * `planPromptNagSends`'s. `skipGate` (tests) computes every user's prompts,
 * to prove the gate never changes the answer.
 */
export function pendingPromptNags(
  now: Date = new Date(),
  { skipGate = false }: { skipGate?: boolean } = {},
): PendingPromptNag[] {
  const pending: PendingPromptNag[] = []
  for (const user of notifiableUsers()) {
    const candidates = namedPromptCandidates(user.id)
    if (candidates.length === 0) continue

    const periods = openedPeriods(user.id, user.timezone, now)
    if (periods.opened.size === 0) continue
    const tiers = userNagTiers(user.id)
    const date = periods.day.date
    const ctx = {
      userId: user.id,
      timezone: user.timezone,
      date,
      opened: periods.opened,
      tiers,
      now,
    }
    if (!skipGate && !mayBeDue(candidates, ctx)) continue

    const byId = new Map(candidates.map((c) => [c.id, c]))
    const labels = new Map(periods.slots.map((s) => [s.id, s.label]))
    const stamps = stampsFor(user.id, date)
    for (const p of standingNamedPrompts(user.id, user.timezone, now, periods.opened)) {
      const candidate = byId.get(p.task_id)
      const priority = p.priority ?? 0
      const interval = nagIntervalMinutes('slot_nag', priority, tiers)
      if (interval <= 0 || p.slot_id === null) continue
      if (!dueAfter(stamps.get(p.prompt_key) ?? null, interval, now, user.timezone)) continue
      pending.push({
        userId: user.id,
        taskId: p.task_id,
        promptKey: p.prompt_key,
        title: candidate ? bannerTitle(candidate) : p.title,
        priority,
        slotLabel: labels.get(p.slot_id) ?? '',
        countText: promptCountText(p),
        intervalMinutes: interval,
        timezone: user.timezone,
      })
    }
  }
  return pending
}

/**
 * The Web Push banner: the APNs push's words and data, the "Considered" and
 * "Did it" buttons, tag `prompt-<prompt_key>`, a tap opening the row on
 * /reminders (`?prompt=`, `useRemindersDeepLinks`). High and Urgent renotify;
 * Medium, or a passive banner, is silent.
 */
async function sendPromptWebPush(
  nag: PendingPromptNag,
  body: string,
  delivery: Delivery,
): Promise<DeliveryResult> {
  const sounds = promptSounds(nag.priority) && !delivery.passive
  return sendPushNotification(nag.userId, {
    title: nag.title,
    body,
    data: {
      url: `${APP_URL}/reminders?prompt=${encodeURIComponent(nag.promptKey)}`,
      taskId: nag.taskId,
      prompt_key: nag.promptKey,
    },
    tag: promptCollapseId(nag.promptKey),
    actions: [{ ...CONSIDERED_ACTION }, { ...DID_ACTION }],
    ...(sounds ? { renotify: true } : { silent: true }),
  })
}

/** Deliver one named prompt push on the channels that are on. */
async function sendPromptNag(
  nag: PendingPromptNag,
  channels: Channels,
  delivery: Delivery,
): Promise<DeliveryResult> {
  const body = promptNagBody(nag.slotLabel, nag.countText) + (delivery.suffix ?? '')
  const sends: Promise<DeliveryResult>[] = []
  if (channels.webPush) sends.push(sendPromptWebPush(nag, body, delivery))
  if (channels.apns) {
    sends.push(
      sendApnsPromptNag(nag.userId, {
        taskId: nag.taskId,
        promptKey: nag.promptKey,
        title: nag.title,
        body,
        sound: promptSounds(nag.priority),
        passive: delivery.passive,
      }),
    )
  }
  const settled = await Promise.allSettled(sends)
  for (const r of settled) {
    if (r.status === 'rejected') log.error('notifications', 'Prompt push error:', r.reason)
  }
  return mergeSettled(settled)
}

/** This minute's named prompt pushes as tick sends (tick.ts); the claim is the `nag_sends` CAS. */
export function planPromptNagSends(now: Date, channels: Channels): SourcePlan {
  if (!channels.webPush && !channels.apns) return { sends: [] }
  return {
    sends: pendingPromptNags(now).map((nag) => ({
      userId: nag.userId,
      kind: promptKind(nag.priority),
      items: 1,
      // Medium makes no sound: it never leads a minute in which something sounds.
      silent: !promptSounds(nag.priority),
      claim: () => {
        const won = claimNagSend(
          nag.userId,
          promptNagKey(nag.promptKey),
          nag.intervalMinutes,
          now,
          nag.timezone,
        )
        if (won) {
          log.info(
            'notifications',
            `Prompt push for user ${nag.userId}: ${nag.promptKey}, every ${nag.intervalMinutes} min`,
          )
        }
        return won
      },
      deliver: (delivery) => sendPromptNag(nag, channels, delivery),
    })),
  }
}

/** The named prompt pushes as one of the minute tick's sources. */
export const PROMPT_NAG_SOURCE: TickSource = {
  name: 'Prompt push checker',
  minuteKey: 'tick-prompt-nags',
  plan: planPromptNagSends,
}

/** The named prompt pushes on their own (tests): one tick with this source alone. */
export async function checkPromptNags(nowOverride?: Date): Promise<void> {
  if (!isWebPushConfigured() && !isApnsConfigured()) return
  await runTick([PROMPT_NAG_SOURCE], nowOverride ?? new Date())
}

/** Fields whose change can take a quota's prompt out of its named push. */
const PROMPT_PUSH_FIELDS = new Set([
  'priority',
  'is_tracked',
  'progress_target',
  'progress_current',
  'rrule',
  'quota_prompt_config',
  'quota_day_state',
  'done',
  'archived_at',
  'is_reminder',
])

/**
 * For a mutation ABOUT to be applied: a check to run after it, answering the
 * prompt keys whose named push it ended — a prompt pushed today (a `prompt-…`
 * stamp of today) that stood before (waiting, Medium+, in an opened period)
 * and no longer does — so their delivered banners are stale. `quotaIds`
 * limits it to those quotas; `'all'` is every quota of the user (a
 * user-level change: the prompt switch, the default period, a period
 * deleted or retimed, the day start). Reads nothing more than one stamp
 * query unless a prompt in scope was pushed today.
 */
export function promptPushEndCheck(
  userId: number,
  quotaIds: readonly number[] | 'all',
): () => string[] {
  const none = () => []
  if (quotaIds !== 'all' && quotaIds.length === 0) return none
  const user = getDb().prepare('SELECT timezone FROM users WHERE id = ?').get(userId) as
    | { timezone: string }
    | undefined
  if (!user) return none
  const now = new Date()
  const date = promptDate(user.timezone, dayBoundaryForUser(userId), now)
  const ids = quotaIds === 'all' ? null : new Set(quotaIds)
  const sent = [...stampsFor(userId, date).keys()].filter(
    (key) => ids === null || ids.has(promptTaskId(key)),
  )
  if (sent.length === 0) return none
  const standing = (at: Date) => {
    const { opened } = openedPeriods(userId, user.timezone, at)
    return new Set(standingNamedPrompts(userId, user.timezone, at, opened).map((p) => p.prompt_key))
  }
  const before = standing(now)
  const stood = sent.filter((key) => before.has(key))
  if (stood.length === 0) return none
  return () => {
    const after = standing(new Date())
    return stood.filter((key) => !after.has(key))
  }
}

/**
 * After the mutation commits: dismiss the prompts `ended` names (a
 * `promptPushEndCheck` result) — nothing at all when it names none, so a
 * mutation that ended no named prompt push sends no dismiss push.
 */
export function dismissEndedPromptPushes(userId: number, ended: () => string[]): void {
  const keys = ended()
  if (keys.length > 0) dismissPromptNotifications(userId, keys)
}

/** The quota id in a prompt key (`q:<taskId>:<k>:<date>`). */
export function promptTaskId(key: string): number {
  return Number(key.split(':')[1])
}

/**
 * `promptPushEndCheck` for an edit of one task (updateTask, bulkEdit): only a
 * quota, and only an edit that touches a field that can end a prompt's push.
 */
export function promptPushEndCheckForEdit(
  task: { id: number; user_id: number; is_tracked: boolean; progress_target: number },
  fieldsChanged: readonly string[],
): () => string[] {
  if (!isTracked(task) || !fieldsChanged.some((f) => PROMPT_PUSH_FIELDS.has(f))) return () => []
  return promptPushEndCheck(task.user_id, [task.id])
}

/**
 * The weekly purge: drop `prompt-…` rows two days old or more. A row's key
 * names one OpenTask day, which is over by then, so nothing reads it again.
 */
export function purgeOldPromptNags(now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - PROMPT_NAG_RETENTION_DAYS * 24 * 60 * 60_000)
  const result = getDb()
    .prepare(
      `DELETE FROM nag_sends WHERE key LIKE '${PROMPT_NAG_KEY_PREFIX}%'
         AND datetime(last_sent_at) < datetime(?)`,
    )
    .run(cutoff.toISOString())
  if (result.changes > 0) {
    log.info('cron', `Deleted ${result.changes} prompt push records of days that are over`)
  }
  return result.changes
}
