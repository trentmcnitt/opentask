/**
 * The dashboard's view switch is Today · All · New (Trent, 2026-09-29).
 *
 * - New is every open task in one flat list, newest-added first, whatever the
 *   saved sort says (`effectiveSort`), and the flat list shows project names
 *   (`isFlatGrouping`).
 * - The Projects view is retired: a stored or submitted 'project' becomes 'time'
 *   (All) — in `coerceGrouping`, in `toAuthUser`, and in the column itself via the
 *   idempotent startup step `retireProjectGrouping`.
 */
import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import { buildTaskGroups, effectiveSort, isFlatGrouping, sortTasks } from '@/lib/task-grouping'
import { coerceGrouping, GROUPINGS } from '@/lib/grouping'
import { toAuthUser } from '@/core/auth/helpers'
import { getDb, retireProjectGrouping } from '@/core/db'
import type { Task } from '@/types'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const task = (id: number, project_id: number, created: string, due: string | null) =>
  ({
    id,
    project_id,
    title: `t${id}`,
    created_at: created,
    updated_at: created,
    due_at: due,
    done: false,
    priority: 0,
    labels: [],
  }) as unknown as Task

describe('DV-NEW: the New view', () => {
  const tasks = [
    task(1, 1, '2026-01-10T10:00:00Z', '2026-01-15T15:00:00Z'),
    task(2, 2, '2026-01-14T10:00:00Z', null),
    task(3, 1, '2026-01-12T10:00:00Z', '2026-01-20T15:00:00Z'),
  ]

  test('is one flat group holding every task', () => {
    const groups = buildTaskGroups(tasks, 'new', TEST_TIMEZONE, [])
    expect(groups).toHaveLength(1)
    expect(groups[0].tasks.map((t) => t.id).sort()).toEqual([1, 2, 3])
    expect(isFlatGrouping('new')).toBe(true)
    expect(isFlatGrouping('unified')).toBe(true)
    expect(isFlatGrouping('time')).toBe(false)
    expect(isFlatGrouping('slot')).toBe(false)
  })

  test('sorts newest-added first whatever the saved sort is', () => {
    for (const [saved, reversed] of [
      ['due_date', false],
      ['priority', true],
      ['age', true],
      ['title', false],
    ] as const) {
      const eff = effectiveSort('new', saved, reversed)
      expect(eff).toEqual({ sortOption: 'age', reversed: false })
      expect(sortTasks(tasks, eff.sortOption, eff.reversed).map((t) => t.id)).toEqual([2, 3, 1])
    }
  })

  test('leaves the saved sort alone in every other view', () => {
    for (const g of ['slot', 'time', 'unified'] as const) {
      expect(effectiveSort(g, 'priority', true)).toEqual({ sortOption: 'priority', reversed: true })
    }
  })
})

describe('DV-PROJ: the retired Projects view lands on All', () => {
  test('coerceGrouping: project → time, live values kept, other unknowns → slot', () => {
    expect(coerceGrouping('project')).toBe('time')
    for (const g of GROUPINGS) expect(coerceGrouping(g)).toBe(g)
    expect(coerceGrouping('reminders')).toBe('slot')
    expect(coerceGrouping('recent')).toBe('slot')
    expect(coerceGrouping(undefined)).toBe('slot')
  })

  test('toAuthUser echoes project as time', () => {
    const user = toAuthUser({
      id: 1,
      email: 'a@example.com',
      name: 'a',
      timezone: TEST_TIMEZONE,
      default_grouping: 'project',
      is_demo: 0,
    })
    expect(user.default_grouping).toBe('time')
  })

  describe('retireProjectGrouping (startup data step)', () => {
    beforeEach(() => setupTestDb())
    afterAll(() => teardownTestDb())

    const stored = () =>
      (
        getDb().prepare('SELECT default_grouping FROM users WHERE id = ?').get(TEST_USER_ID) as {
          default_grouping: string
        }
      ).default_grouping

    test('rewrites a stored project to time, idempotently', () => {
      getDb()
        .prepare("UPDATE users SET default_grouping = 'project' WHERE id = ?")
        .run(TEST_USER_ID)
      retireProjectGrouping(getDb())
      expect(stored()).toBe('time')
      retireProjectGrouping(getDb())
      expect(stored()).toBe('time')
    })

    test('leaves every other value alone', () => {
      for (const g of ['slot', 'new', 'unified', 'time']) {
        getDb().prepare('UPDATE users SET default_grouping = ? WHERE id = ?').run(g, TEST_USER_ID)
        retireProjectGrouping(getDb())
        expect(stored()).toBe(g)
      }
    })
  })
})
