/**
 * The bulk-sweep toast (SM-001 through SM-007).
 *
 * The bug this file exists for: with four overdue High tasks the toast read
 * "No snoozable tasks (4 urgent must be snoozed individually)". The count was
 * right and the word was not — none of the four was Urgent. The core's
 * `urgentSkipped` counts BOTH tiers (its name is frozen by the `skipped_urgent`
 * API field the iOS client reads) and that internal name had leaked into copy
 * the user reads.
 *
 * So the two things asserted throughout are: the wording names the tier it is
 * actually talking about, and "must be snoozed individually" is said ONLY of
 * Urgent — because since 2026-09-15 it is only true of Urgent. High is swept on
 * the next press once nothing lower is left.
 *
 * Pure-function tests: no DB, no HTTP, no browser. The message is what the
 * toast renders verbatim.
 */

import { describe, test, expect } from 'vitest'
import { bulkSnoozeMessage } from '@/lib/snooze'

describe('bulkSnoozeMessage', () => {
  test('SM-001: a clean sweep says only what it moved', () => {
    expect(bulkSnoozeMessage({ affected: 5, high: 0, urgent: 0 })).toBe('Snoozed 5 tasks')
    expect(bulkSnoozeMessage({ affected: 1, high: 0, urgent: 0 })).toBe('Snoozed 1 task')
  })

  test('SM-002: skipped High tasks are called high, not urgent', () => {
    const message = bulkSnoozeMessage({ affected: 3, high: 4, urgent: 0 })
    expect(message).toBe('Snoozed 3 tasks (4 high skipped)')
    expect(message).not.toContain('urgent')
  })

  test('SM-003: skipped Urgent tasks are called urgent', () => {
    expect(bulkSnoozeMessage({ affected: 3, high: 0, urgent: 2 })).toBe(
      'Snoozed 3 tasks (2 urgent skipped)',
    )
  })

  test('SM-004: both tiers are named separately when both were skipped', () => {
    expect(bulkSnoozeMessage({ affected: 3, high: 2, urgent: 1 })).toBe(
      'Snoozed 3 tasks (2 high, 1 urgent skipped)',
    )
  })

  /**
   * THE REPORTED BUG, inverted. Four High tasks and nothing else can no longer
   * produce this message at all — the sweep takes them now — but if a batch
   * ever does skip High and move nothing, the message must not call them
   * urgent and must not claim they need doing by hand.
   */
  test('SM-005: a stalled sweep never calls High tasks urgent', () => {
    const message = bulkSnoozeMessage({ affected: 0, high: 4, urgent: 0 })
    expect(message).toBe('No snoozable tasks (4 high skipped)')
    expect(message).not.toContain('urgent')
    expect(message).not.toContain('individually')
  })

  test('SM-006: "must be snoozed individually" is said of Urgent, and only of Urgent', () => {
    expect(bulkSnoozeMessage({ affected: 0, high: 0, urgent: 4 })).toBe(
      'No snoozable tasks (4 urgent tasks must be snoozed individually)',
    )
    expect(bulkSnoozeMessage({ affected: 0, high: 0, urgent: 1 })).toBe(
      'No snoozable tasks (1 urgent task must be snoozed individually)',
    )
    // Mixed: the claim would be false of the High half, so it is not made.
    expect(bulkSnoozeMessage({ affected: 0, high: 2, urgent: 1 })).toBe(
      'No snoozable tasks (2 high, 1 urgent skipped)',
    )
  })

  test('SM-007: nothing moved and nothing skipped says just that', () => {
    expect(bulkSnoozeMessage({ affected: 0, high: 0, urgent: 0 })).toBe('No snoozable tasks')
  })

  test('names High when every task it moved was High — the second press of a double snooze', () => {
    expect(bulkSnoozeMessage({ affected: 3, highAffected: 3, high: 0, urgent: 0 })).toBe(
      'Snoozed 3 high-priority tasks',
    )
    expect(bulkSnoozeMessage({ affected: 1, highAffected: 1, high: 0, urgent: 2 })).toBe(
      'Snoozed 1 high-priority task (2 urgent skipped)',
    )
  })

  test('a mixed batch, or no High count at all, says plain "tasks"', () => {
    expect(bulkSnoozeMessage({ affected: 3, highAffected: 1, high: 0, urgent: 0 })).toBe(
      'Snoozed 3 tasks',
    )
    expect(bulkSnoozeMessage({ affected: 2, high: 0, urgent: 0 })).toBe('Snoozed 2 tasks')
  })
})
