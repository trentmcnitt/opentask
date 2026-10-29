/**
 * The lean row clock's tap (`src/lib/lean-clock.ts`): Today on an untargeted
 * row; on a targeted one, defer when due, the menu when not.
 */
import { describe, expect, test } from 'vitest'
import { clockTap } from '@/lib/lean-clock'
import type { Task } from '@/types'

const task = (overrides: Partial<Task> = {}) =>
  ({
    title: 'task',
    rrule: null,
    is_reminder: false,
    is_tracked: false,
    progress_target: 1,
    due_at: null,
    target_auto: false,
    deadline_at: null,
    horizon: null,
    ...overrides,
  }) as Task

describe('clockTap', () => {
  test('untargeted: target today (a deadline, or an automatic target, is not a picked one)', () => {
    expect(clockTap(task(), false)).toBe('target-today')
    expect(clockTap(task({ deadline_at: '2026-11-02T23:00:00Z' }), false)).toBe('target-today')
    expect(clockTap(task({ due_at: '2026-11-01T14:00:00Z', target_auto: true }), false)).toBe(
      'target-today',
    )
  })

  test('a picked target: defer when due, the menu when not', () => {
    const targeted = task({ due_at: '2026-11-01T14:00:00Z' })
    expect(clockTap(targeted, true)).toBe('defer')
    expect(clockTap(targeted, false)).toBe('menu')
  })

  test('a repeating task is always targeted: defer or menu, never Today', () => {
    const weekly = task({ rrule: 'FREQ=WEEKLY', due_at: '2026-11-01T14:00:00Z' })
    expect(clockTap(weekly, true)).toBe('defer')
    expect(clockTap(weekly, false)).toBe('menu')
  })
})
