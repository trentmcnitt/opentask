/**
 * Anchor field derivation from RRULE
 *
 * Anchor fields are derived automatically from the RRULE and from `due_at`.
 *
 * `anchor_dow` and `anchor_dom` are a display/sort cache — the RRULE remains the
 * source of truth for which *days* an occurrence lands on.
 *
 * `anchor_time` is NOT merely a cache. `compute-next.ts` prefers it over BYHOUR
 * when setting an occurrence's time-of-day (see `computeFromDue` and
 * `computeFromCompletion`), because rrule.js evaluates BYHOUR in UTC, which
 * breaks local-time recurrence across DST. Many stored rrules carry no BYHOUR at
 * all, and for those `anchor_time` is the *only* carrier of time-of-day —
 * derived here from the initial `due_at`. Clearing or mis-deriving it silently
 * moves when a recurring task fires.
 *
 * (An earlier version of this comment claimed anchor fields are "NOT used for
 * recurrence computation." That was false for `anchor_time`, and the read-time
 * occurrence derivation in docs/REDESIGN-V03.md §4.6 depends on it being right.)
 */

import { parseRRule } from './rrule-builder'
import { formatAnchorTime, utcToLocal } from './timezone'

export interface AnchorFields {
  anchor_time: string | null // HH:MM in local time
  anchor_dow: number | null // 0=Mon..6=Sun
  anchor_dom: number | null // 1-31
}

/**
 * Derive anchor fields from an RRULE and optional due_at
 *
 * Rules (from spec):
 * - If RRULE has BYHOUR/BYMINUTE: anchor_time from RRULE
 * - If RRULE lacks BYHOUR: anchor_time from initial due_at time
 * - If RRULE has BYDAY (weekly): anchor_dow from RRULE
 * - If RRULE has BYMONTHDAY: anchor_dom from RRULE
 * - If no RRULE (one-off): all anchors NULL
 */
export function deriveAnchorFields(
  rrule: string | null,
  dueAt: string | null,
  timezone: string,
): AnchorFields {
  // One-off tasks have no anchors
  if (!rrule) {
    return {
      anchor_time: null,
      anchor_dow: null,
      anchor_dom: null,
    }
  }

  const components = parseRRule(rrule)
  let anchorTime: string | null = null
  let anchorDow: number | null = null
  let anchorDom: number | null = null

  // Derive anchor_time
  if (components.byhour !== undefined) {
    // Time is explicitly in the RRULE
    anchorTime = formatAnchorTime(components.byhour, components.byminute ?? 0)
  } else if (dueAt) {
    // Derive from due_at time (converted to local)
    const localDt = utcToLocal(dueAt, timezone)
    anchorTime = formatAnchorTime(localDt.hour, localDt.minute)
  }

  // Derive anchor_dow for weekly patterns
  if (components.freq === 'WEEKLY' && components.byday && components.byday.length > 0) {
    // For multi-day patterns, use the first day as the primary anchor
    // This is mainly for display/sorting purposes
    anchorDow = components.byday[0]
  }

  // Derive anchor_dom for monthly patterns
  if (components.freq === 'MONTHLY' && components.bymonthday !== undefined) {
    const monthday = Array.isArray(components.bymonthday)
      ? components.bymonthday[0]
      : components.bymonthday
    anchorDom = monthday
  }

  return {
    anchor_time: anchorTime,
    anchor_dow: anchorDow,
    anchor_dom: anchorDom,
  }
}

/**
 * Extract the time-of-day from an RRULE or due_at
 * Returns { hour, minute } in local timezone
 */
export function extractTimeOfDay(
  rrule: string | null,
  dueAt: string | null,
  timezone: string,
): { hour: number; minute: number } | null {
  if (rrule) {
    const components = parseRRule(rrule)
    if (components.byhour !== undefined) {
      return {
        hour: components.byhour,
        minute: components.byminute ?? 0,
      }
    }
  }

  if (dueAt) {
    const localDt = utcToLocal(dueAt, timezone)
    return {
      hour: localDt.hour,
      minute: localDt.minute,
    }
  }

  return null
}

/**
 * Update RRULE with explicit BYHOUR/BYMINUTE if missing
 * This ensures the RRULE has the time embedded for anti-drift
 */
export function ensureTimeInRRule(rrule: string, hour: number, minute: number): string {
  const components = parseRRule(rrule)

  // Already has time
  if (components.byhour !== undefined) {
    return rrule
  }

  // Add time components
  const parts = rrule.split(';')
  parts.push(`BYHOUR=${hour}`)
  parts.push(`BYMINUTE=${minute}`)

  return parts.join(';')
}
