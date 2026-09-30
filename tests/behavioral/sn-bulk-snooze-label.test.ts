/**
 * The snooze-all clock's corner badge (SL-001 through SL-003): it says where a
 * plain press sends the overdue tasks.
 *
 * The bug: the badge read only the default snooze option ("+1h"), while a
 * press followed the bulk-snooze setting, whose default is the next period —
 * so the button promised one hour and delivered the next period.
 *
 * Pure-function tests: no DB, no HTTP, no browser.
 */

import { describe, test, expect } from 'vitest'
import { bulkSnoozeCompactLabel } from '@/lib/snooze'

describe('bulkSnoozeCompactLabel', () => {
  test('SL-001: next period, with periods to go to, reads "Next"', () => {
    expect(bulkSnoozeCompactLabel('next_period', '60', true)).toBe('Next')
    expect(bulkSnoozeCompactLabel('next_period', 'tomorrow', true)).toBe('Next')
  })

  test('SL-002: next period with no periods falls back to the default option, as a press does', () => {
    expect(bulkSnoozeCompactLabel('next_period', '60', false)).toBe('+1h')
  })

  test('SL-003: the default-option setting shows the option', () => {
    expect(bulkSnoozeCompactLabel('default_option', '30', true)).toBe('+30m')
    expect(bulkSnoozeCompactLabel('default_option', '120', true)).toBe('+2h')
    expect(bulkSnoozeCompactLabel('default_option', 'tomorrow', true)).toBe('AM')
  })
})
