/**
 * EVERY REPEATING TASK OR REMINDER HAS A TIME OF DAY (Trent, 2026-10-12:
 * "That's supposed to be the default for the day if nothing's set. Nothing
 * should have no time.")
 *
 * A recurrence rule that reaches the server without BYHOUR — from the API, the
 * CLI, an old client, a bulk edit or AI enrichment — is given one before it is
 * stored. Without it the rule has no time of its own: the first occurrence was
 * local midnight (always passed, so a new rule started one period late) and
 * the task's time-of-day rode on `anchor_time` alone.
 *
 * WHERE THE TIME COMES FROM, first match wins (`ruleTimeFor`):
 *   1. a date sent in the SAME request as the rule — its local time. This is
 *      the anchor the request carries (`anchor_time` is not a request field;
 *      create and PATCH derive it from the date: "repeat weekly, starting
 *      this Friday at 3 PM" keeps 3 PM);
 *   2. the row's stored `anchor_time` — a rule change keeps the task's time
 *      (a rule with no BYHOUR on a task anchored at 10:00 → BYHOUR=10);
 *   3. the row's stored `due_at` — its local time. A dated one-off given a
 *      rule keeps its time, as `deriveAnchorFields` always derived it;
 *   4. the user's Morning time (`users.morning_time`, "Default task time" in
 *      Settings) — read from the setting, never a constant.
 *
 * QUOTAS ARE EXEMPT. A quota's rule is a bare period rule ("FREQ=WEEKLY"): it
 * names the period the count runs over, not a moment, and a time on it would
 * mean nothing. Callers judge that on the row the write LEAVES (`isTracked`
 * of the resulting is_tracked / progress_target) and skip the fill.
 *
 * The three writers that call this: `createTask`, `collectFieldChanges`
 * (PATCH, bulk edit, a period move) and enrichment's `collectEnrichmentChanges`
 * (raw SQL). `anchor_time` stays consistent for free: `deriveAnchorFields`
 * reads it from the BYHOUR this adds.
 */

import { parseRRule } from './rrule-builder'
import { formatAnchorTime, utcToLocal } from './timezone'

/**
 * The rule with BYHOUR/BYMINUTE set to `time` ("HH:MM") when it has no
 * BYHOUR; otherwise the rule exactly as given. A stray BYMINUTE without a
 * BYHOUR is replaced. Pure.
 */
export function ensureRuleTime(rrule: string, time: string): string {
  if (parseRRule(rrule).byhour !== undefined) return rrule
  const [hour, minute] = time.split(':').map((n) => parseInt(n, 10))
  const parts = rrule.split(';').filter((p) => p !== '' && !/^BYMINUTE=/i.test(p))
  parts.push(`BYHOUR=${hour}`, `BYMINUTE=${minute}`)
  return parts.join(';')
}

/**
 * The rule with its time of day SET to `time` ("HH:MM"): any BYHOUR /
 * BYMINUTE replaced. For a rule whose instant changes meaning — the
 * deadline-anchor migration (`migrate-repeat-anchor.ts`) rebinds a rule that
 * walked a target to its deadline's time. Pure.
 */
export function setRuleTime(rrule: string, time: string): string {
  const bare = rrule
    .split(';')
    .filter((p) => p !== '' && !/^BYHOUR=/i.test(p) && !/^BYMINUTE=/i.test(p))
    .join(';')
  return ensureRuleTime(bare, time)
}

/** What a write knows that could give a rule its time (see the module doc). */
export interface RuleTimeSources {
  /** A date (UTC ISO) arriving in the same request as the rule. */
  requestDueAt?: string | null
  /** The row's stored `anchor_time` ("HH:MM", local). */
  anchorTime?: string | null
  /** The row's stored `due_at` (UTC ISO). */
  existingDueAt?: string | null
  /** The user's Morning time setting ("HH:MM"). */
  morningTime: string
  timezone: string
}

/** The time ("HH:MM", local) a timeless rule takes, first match wins. */
export function ruleTimeFor(sources: RuleTimeSources): string {
  const fromDate = (iso: string) => {
    const local = utcToLocal(iso, sources.timezone)
    return formatAnchorTime(local.hour, local.minute)
  }
  if (sources.requestDueAt) return fromDate(sources.requestDueAt)
  if (sources.anchorTime) return sources.anchorTime
  if (sources.existingDueAt) return fromDate(sources.existingDueAt)
  return sources.morningTime
}

/**
 * The rule a write stores: `rrule` with its time filled in (`ensureRuleTime`
 * from `ruleTimeFor`) — unless it is null, already timed, or the row is a
 * quota (`tracked`), which keeps its bare period rule.
 */
export function fillRuleTime<R extends string | null | undefined>(
  rrule: R,
  tracked: boolean,
  sources: RuleTimeSources,
): R {
  if (!rrule || tracked) return rrule
  if (parseRRule(rrule).byhour !== undefined) return rrule
  return ensureRuleTime(rrule, ruleTimeFor(sources)) as R
}
