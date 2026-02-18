/**
 * Behavioral tests for client-side recurrence preview computation
 *
 * Verifies that the client-side preview matches the server-side computation
 * by using the same "naive local" approach for timezone handling.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { computeRecurrencePreview } from '@/lib/recurrence-preview'
import { computeFirstOccurrence } from '@/core/recurrence'

const TIMEZONE_CHICAGO = 'America/Chicago'
const TIMEZONE_LONDON = 'Europe/London'

describe('Recurrence preview timezone handling', () => {
  beforeEach(() => {
    // Freeze time to Jan 15, 2026 at 10am Chicago (16:00 UTC)
    vi.setSystemTime(new Date('2026-01-15T16:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('daily at 9 AM shows 9 AM local time, not UTC', () => {
    const rrule = 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0'

    // Client preview
    const preview = computeRecurrencePreview(rrule, TIMEZONE_CHICAGO)
    expect(preview).not.toBeNull()

    // Parse and verify the local time
    const previewDt = DateTime.fromISO(preview!).setZone(TIMEZONE_CHICAGO)
    expect(previewDt.hour).toBe(9)
    expect(previewDt.minute).toBe(0)
  })

  test('client preview matches server-side computation', () => {
    const rrule = 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0'

    // Client preview
    const clientPreview = computeRecurrencePreview(rrule, TIMEZONE_CHICAGO)

    // Server-side computation
    const serverResult = computeFirstOccurrence(rrule, '09:00', TIMEZONE_CHICAGO)

    // Both should return the same time
    expect(clientPreview).not.toBeNull()
    const clientDt = DateTime.fromISO(clientPreview!)
    const serverDt = DateTime.fromJSDate(serverResult)

    // Compare local times
    const clientLocal = clientDt.setZone(TIMEZONE_CHICAGO)
    const serverLocal = serverDt.setZone(TIMEZONE_CHICAGO)

    expect(clientLocal.hour).toBe(serverLocal.hour)
    expect(clientLocal.minute).toBe(serverLocal.minute)
    expect(clientLocal.day).toBe(serverLocal.day)
  })

  test('weekly recurrence shows correct day and time', () => {
    // Weekly on Wednesday at 3 PM
    const rrule = 'FREQ=WEEKLY;BYDAY=WE;BYHOUR=15;BYMINUTE=30'

    const preview = computeRecurrencePreview(rrule, TIMEZONE_CHICAGO)
    expect(preview).not.toBeNull()

    const previewDt = DateTime.fromISO(preview!).setZone(TIMEZONE_CHICAGO)
    expect(previewDt.hour).toBe(15)
    expect(previewDt.minute).toBe(30)
    expect(previewDt.weekday).toBe(3) // Wednesday = 3 in Luxon
  })

  test('monthly recurrence shows correct day and time', () => {
    // Monthly on the 15th at 10 AM
    const rrule = 'FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=10;BYMINUTE=0'

    const preview = computeRecurrencePreview(rrule, TIMEZONE_CHICAGO)
    expect(preview).not.toBeNull()

    const previewDt = DateTime.fromISO(preview!).setZone(TIMEZONE_CHICAGO)
    expect(previewDt.hour).toBe(10)
    expect(previewDt.minute).toBe(0)
    expect(previewDt.day).toBe(15)
  })

  test('preview works correctly in different timezones', () => {
    const rrule = 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0'

    // Chicago preview
    const chicagoPreview = computeRecurrencePreview(rrule, TIMEZONE_CHICAGO)
    const chicagoDt = DateTime.fromISO(chicagoPreview!).setZone(TIMEZONE_CHICAGO)
    expect(chicagoDt.hour).toBe(9)

    // London preview (same RRULE, different timezone)
    const londonPreview = computeRecurrencePreview(rrule, TIMEZONE_LONDON)
    const londonDt = DateTime.fromISO(londonPreview!).setZone(TIMEZONE_LONDON)
    expect(londonDt.hour).toBe(9)

    // The UTC times should be different because 9 AM Chicago != 9 AM London
    expect(chicagoPreview).not.toBe(londonPreview)
  })

  test('malformed rrule that causes error returns null', () => {
    // An RRULE with an invalid frequency should cause an error in rrule.js
    const preview = computeRecurrencePreview('FREQ=INVALID_FREQUENCY', TIMEZONE_CHICAGO)
    expect(preview).toBeNull()
  })

  test('rrule without BYHOUR defaults to midnight', () => {
    const rrule = 'FREQ=DAILY'

    const preview = computeRecurrencePreview(rrule, TIMEZONE_CHICAGO)
    expect(preview).not.toBeNull()

    const previewDt = DateTime.fromISO(preview!).setZone(TIMEZONE_CHICAGO)
    expect(previewDt.hour).toBe(0)
    expect(previewDt.minute).toBe(0)
  })
})
