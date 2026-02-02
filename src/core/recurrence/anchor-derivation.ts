/**
 * Anchor field derivation from RRULE
 *
 * Anchor fields are derived automatically from the RRULE and serve as a display/sort cache.
 * They are NOT used for recurrence computation - the RRULE is the source of truth.
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
