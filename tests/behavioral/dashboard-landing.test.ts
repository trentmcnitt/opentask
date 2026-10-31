/**
 * The Dashboard's re-tap in one column (2026-10-31, src/lib/dashboard-landing.ts):
 * two positions, decided by where the page is relative to the tasks.
 */
import { describe, test, expect } from 'vitest'
import { dashboardRetapGoes } from '@/lib/dashboard-landing'

describe('dashboardRetapGoes', () => {
  test('at the tasks or below them: the top', () => {
    expect(dashboardRetapGoes(900, 900)).toBe('top')
    expect(dashboardRetapGoes(899.5, 900)).toBe('top')
    expect(dashboardRetapGoes(1400, 900)).toBe('top')
  })
  test('above the tasks (the top included): the tasks', () => {
    expect(dashboardRetapGoes(0, 900)).toBe('tasks')
    expect(dashboardRetapGoes(500, 900)).toBe('tasks')
  })
  test('a page with nothing above the tasks: a tap at the top stays a tap to the top', () => {
    expect(dashboardRetapGoes(0, 0)).toBe('top')
  })
})
