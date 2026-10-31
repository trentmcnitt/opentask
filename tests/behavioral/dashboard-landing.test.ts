/**
 * The Dashboard's re-tap in one column (2026-10-31, src/lib/dashboard-landing.ts,
 * Trent's revision): at the top — or overscrolled above it, the rubber band
 * and its rebound — the tasks; anywhere else, the top.
 */
import { describe, test, expect } from 'vitest'
import { AT_TOP_PX, dashboardRetapGoes } from '@/lib/dashboard-landing'

describe('dashboardRetapGoes', () => {
  test('at the top, or within a few pixels of it: the tasks', () => {
    expect(dashboardRetapGoes(0)).toBe('tasks')
    expect(dashboardRetapGoes(AT_TOP_PX)).toBe('tasks')
  })
  test('overscrolled above the top (the elastic zone) and bouncing back: the tasks', () => {
    expect(dashboardRetapGoes(-60)).toBe('tasks')
    expect(dashboardRetapGoes(-3)).toBe('tasks')
  })
  test('anywhere else: the top — above the tasks as much as below them', () => {
    expect(dashboardRetapGoes(AT_TOP_PX + 1)).toBe('top')
    expect(dashboardRetapGoes(400)).toBe('top')
    expect(dashboardRetapGoes(5000)).toBe('top')
  })
})
