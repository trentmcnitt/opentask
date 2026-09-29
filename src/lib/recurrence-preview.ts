/**
 * Client-side recurrence preview ("Next: Wed, Jan 21, 11:00 PM" in the quick panel).
 *
 * The preview must show exactly what the server will store when the task is
 * saved, so it calls the server's own computeFirstOccurrence() rather than a
 * copy of it. (A hand-maintained copy used to drift: it anchored its pattern in
 * the browser's timezone instead of UTC, which put late-evening weekly rules a
 * weekday off for anyone whose device was west of UTC.) The recurrence engine
 * is pure — rrule.js and luxon, no database — so it is safe in the browser.
 */

import { DateTime } from 'luxon'
import { computeFirstOccurrence } from '@/core/recurrence/compute-next'

/**
 * Compute the next occurrence for a recurrence preview.
 *
 * @param rruleStr The RRULE string (e.g., "FREQ=DAILY;BYHOUR=9;BYMINUTE=0")
 * @param timezone The user's IANA timezone (e.g., "America/Chicago")
 * @returns ISO string of the next occurrence in `timezone`, or null for an RRULE the engine rejects
 */
export function computeRecurrencePreview(rruleStr: string, timezone: string): string | null {
  try {
    const next = computeFirstOccurrence(rruleStr, null, timezone)
    return DateTime.fromJSDate(next).setZone(timezone).toISO()
  } catch {
    // Invalid rrule - don't show preview
    return null
  }
}
