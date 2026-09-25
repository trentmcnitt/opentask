/**
 * Quota reminders — the pure, client-safe half (2026-09-24).
 *
 * An unmet quota also shows up as a reminder-like PROMPT in a reminder period
 * each day, so it gets the same attention a reminder does. The server computes
 * prompts (`src/core/tasks/quota-prompts.ts`); this file holds what both sides
 * need to agree on: a prompt's identity, and how a day's record reads.
 */
import { DateTime } from 'luxon'
import type { QuotaDayState } from '@/types'

/**
 * The owner's local calendar date, YYYY-MM-DD. A quota's day record and every
 * prompt key are scoped to it, so "today" means the same thing to the prompt
 * list, the actions and the undo that restores them.
 */
export function localDate(timezone: string, now: Date = new Date()): string {
  return DateTime.fromJSDate(now).setZone(timezone).toFormat('yyyy-LL-dd')
}

/**
 * A prompt's identity: `q:<taskId>:<k>:<date>`.
 *
 * `k` is the prompt's number for a daily quota — the HIGHEST number assigned
 * to its period, since a period shows at most one row per quota — and 0 for
 * every other quota, which prompts once a day. Numbered prompts share a task
 * id, so clients key rows by this and act on `task_id`. The date makes a key
 * from yesterday's payload refer to yesterday, which the server refuses.
 */
export function promptKey(taskId: number, number: number, date: string): string {
  return `q:${taskId}:${number}:${date}`
}

export interface ParsedPromptKey {
  taskId: number
  number: number
  date: string
}

export function parsePromptKey(key: string): ParsedPromptKey | null {
  const match = /^q:(\d+):(\d+):(\d{4}-\d{2}-\d{2})$/.exec(key)
  if (!match) return null
  const taskId = Number.parseInt(match[1], 10)
  const number = Number.parseInt(match[2], 10)
  if (!Number.isSafeInteger(taskId) || taskId <= 0 || !Number.isSafeInteger(number)) return null
  return { taskId, number, date: match[3] }
}

/**
 * A quota's record for `date`. A record from another day is an empty one —
 * nothing clears it at midnight, it simply stops applying.
 */
export function dayStateFor(state: QuotaDayState | null | undefined, date: string): QuotaDayState {
  if (state && state.date === date) {
    return {
      date,
      logged: Math.max(0, state.logged ?? 0),
      did: Array.isArray(state.did) ? state.did : [],
      considered: Array.isArray(state.considered) ? state.considered : [],
    }
  }
  return { date, logged: 0, did: [], considered: [] }
}

/**
 * Today's record after `applied` progress was logged from anywhere — the
 * widget, the watch, the web chips, a prompt's "did it". Net, and never below
 * zero: a +1 corrected by a −1 is "nothing logged today", so the prompt it hid
 * comes back.
 */
export function withLogged(
  state: QuotaDayState | null | undefined,
  date: string,
  applied: number,
): QuotaDayState {
  const today = dayStateFor(state, date)
  return { ...today, logged: Math.max(0, today.logged + applied) }
}
