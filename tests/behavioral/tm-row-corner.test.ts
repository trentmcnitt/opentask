/**
 * TM-RC: the dashboard row's corner and target-time menu (2026-10-14,
 * `src/lib/row-corner.ts`) — the priority tab, the horizon dot's rules and
 * tooltip, which rows offer Today, what tapping the target time offers — and
 * the bulk "Remove target" the action bar's More sheet sends: one bulk/edit
 * `{ due_at: null }` scoped to the removable ids, one undo entry, High and
 * Urgent picks included, a deadline task back to its automatic target.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { createTask, bulkEdit } from '@/core/tasks'
import { getTaskById } from '@/core/tasks/read'
import { executeUndo } from '@/core/undo'
import { planQuickPanelSave } from '@/lib/save-quick-panel-changes'
import {
  HORIZON_DOT,
  comesBack,
  cornerWidth,
  horizonDotTitle,
  offersTargetToday,
  priorityTab,
  removableTargetIds,
  showsHorizonDot,
  targetTimeMenu,
} from '@/lib/row-corner'
import { HORIZON_ORDER } from '@/lib/task-segments'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
const NOW = new Date('2026-10-14T17:00:00Z') // Wed Oct 14, noon in Chicago

/** A row-shaped task with only what the rules read. */
function row(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    due_at: null as string | null,
    deadline_at: null as string | null,
    target_auto: false,
    rrule: null as string | null,
    is_reminder: false,
    done: false,
    horizon: null as string | null,
    progress_target: 1,
    is_tracked: false,
    ...over,
  }
}

describe('TM-RC: priority tab', () => {
  test('TM-RC-001: High and Urgent get a solid tab; Medium, Low and None nothing (10-15)', () => {
    expect(priorityTab(0)).toBeNull()
    expect(priorityTab(1)).toBeNull()
    expect(priorityTab(2)).toBeNull()
    expect(priorityTab(2, 'icons')).toBeNull()
    expect(priorityTab(3)).toMatchObject({ text: 'High', name: 'High priority' })
    expect(priorityTab(4)).toMatchObject({ text: 'Urgent', name: 'Urgent priority' })
  })

  test("TM-RC-002: the app's priority hues, filled", () => {
    expect(priorityTab(3)!.className).toBe('bg-orange-500 text-white')
    expect(priorityTab(4)!.className).toBe('bg-red-500 text-white')
  })

  test('TM-RC-003: the Icons display style puts the symbol in the tab, same name', () => {
    expect(priorityTab(4, 'icons')).toMatchObject({ text: '!!', name: 'Urgent priority' })
    expect(priorityTab(3, 'icons')!.text).toBe('!')
    expect(priorityTab(1, 'icons')).toBeNull()
  })
})

describe('TM-RC: horizon dot', () => {
  test('TM-RC-010: near to far, every step smaller and lighter; Eventually still visible', () => {
    const sizes = HORIZON_ORDER.map((h) => HORIZON_DOT[h])
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i].r).toBeLessThan(sizes[i - 1].r)
      expect(sizes[i].opacity).toBeLessThan(sizes[i - 1].opacity)
    }
    // Days 8px, Weeks 6px, Months 5px (diameters).
    expect([HORIZON_DOT.days.r, HORIZON_DOT.weeks.r, HORIZON_DOT.months.r]).toEqual([4, 3, 2.5])
    // The mockup's 4px at 0.22 nearly vanished: Eventually is raised, not that.
    expect(HORIZON_DOT.eventually.opacity).toBeGreaterThanOrEqual(0.4)
    expect(HORIZON_DOT.eventually.r * 2).toBeGreaterThanOrEqual(4.5)
  })

  test('TM-RC-011: shown on untargeted one-offs and on an automatic target', () => {
    expect(showsHorizonDot(row())).toBe(true)
    expect(showsHorizonDot(row({ horizon: 'months' }))).toBe(true)
    expect(
      showsHorizonDot(
        row({
          due_at: '2026-10-20T14:00:00Z',
          deadline_at: '2026-10-23T05:00:00Z',
          target_auto: true,
        }),
      ),
    ).toBe(true)
  })

  test('TM-RC-012: hidden where the horizon decides nothing', () => {
    // A picked target: quiet until its date (spec §1).
    expect(showsHorizonDot(row({ due_at: '2026-10-20T14:00:00Z' }))).toBe(false)
    expect(
      showsHorizonDot(row({ due_at: '2026-10-20T14:00:00Z', deadline_at: '2026-10-23T05:00:00Z' })),
    ).toBe(false)
    // No horizon segment at all.
    expect(showsHorizonDot(row({ rrule: 'FREQ=DAILY', due_at: '2026-10-15T14:00:00Z' }))).toBe(
      false,
    )
    expect(showsHorizonDot(row({ is_reminder: true }))).toBe(false)
    expect(showsHorizonDot(row({ progress_target: 3 }))).toBe(false)
    expect(showsHorizonDot(row({ is_tracked: true }))).toBe(false)
    expect(showsHorizonDot(row({ done: true }))).toBe(false)
  })

  test('TM-RC-013: tooltip — "<Horizon> · comes back <when>", on the check-in day', () => {
    expect(horizonDotTitle(row({ horizon: 'weeks' }), 6, NOW)).toBe('Weeks · comes back Saturdays')
    expect(horizonDotTitle(row({ horizon: 'days' }), 6, NOW)).toBe('Days · comes back daily')
    expect(horizonDotTitle(row({ horizon: 'months' }), 2, NOW)).toBe(
      'Months · comes back 1st Tuesday',
    )
    expect(horizonDotTitle(row({ horizon: 'eventually' }), 6, NOW)).toBe(
      'Eventually · comes back quarterly',
    )
    expect(horizonDotTitle(row(), 6, NOW)).toBe('Unset (counts as Weeks) · comes back Saturdays')
  })

  test('TM-RC-014: a near deadline pulls it in, and the tooltip says when it really comes back', () => {
    const t = row({ horizon: 'months', deadline_at: '2026-10-16T05:00:00Z', target_auto: true })
    expect(horizonDotTitle(t, 6, NOW)).toBe('Months · deadline near, comes back daily')
  })

  test('TM-RC-015: comesBack keeps day names capitalised, the rest lower-case', () => {
    expect(comesBack('weeks', 1)).toBe('Mondays')
    expect(comesBack('days', 1)).toBe('daily')
  })
})

describe('TM-RC: Today and the target-time menu', () => {
  test('TM-RC-020: Today on the dot rows only (no target the user picked)', () => {
    expect(offersTargetToday(row())).toBe(true)
    expect(offersTargetToday(row({ due_at: '2026-10-20T14:00:00Z' }))).toBe(false)
    expect(offersTargetToday(row({ rrule: 'FREQ=DAILY', due_at: '2026-10-15T14:00:00Z' }))).toBe(
      false,
    )
  })

  test('TM-RC-021: Remove target (a deadline task too, 2026-10-22), or Move… only', () => {
    expect(targetTimeMenu(row({ due_at: '2026-10-20T14:00:00Z' })).reset).toBe('remove')
    expect(
      targetTimeMenu(row({ due_at: '2026-10-20T14:00:00Z', deadline_at: '2026-10-23T05:00:00Z' }))
        .reset,
    ).toBe('remove')
    // An automatic target, a repeating task, a reminder: Move… only.
    expect(
      targetTimeMenu(
        row({
          due_at: '2026-10-20T14:00:00Z',
          deadline_at: '2026-10-23T05:00:00Z',
          target_auto: true,
        }),
      ).reset,
    ).toBeNull()
    expect(targetTimeMenu(row({ due_at: '2026-10-15T14:00:00Z', rrule: 'FREQ=DAILY' })).reset).toBe(
      null,
    )
    expect(targetTimeMenu(row({ due_at: '2026-10-15T14:00:00Z', is_reminder: true })).reset).toBe(
      null,
    )
  })

  test('TM-RC-022: the bulk Remove target takes only the removable picks', () => {
    const ids = removableTargetIds([
      row({ id: 1, due_at: '2026-10-20T14:00:00Z' }),
      row({ id: 2, due_at: '2026-10-20T14:00:00Z', deadline_at: '2026-10-23T05:00:00Z' }),
      row({ id: 3 }),
      row({ id: 4, due_at: '2026-10-15T14:00:00Z', rrule: 'FREQ=DAILY' }),
      row({
        id: 5,
        due_at: '2026-10-20T14:00:00Z',
        deadline_at: '2026-10-23T05:00:00Z',
        target_auto: true,
      }),
      row({ id: 6, due_at: '2026-10-20T14:00:00Z', done: true }),
    ])
    expect(ids).toEqual([1, 2])
  })

  test('TM-RC-023: corner width adds up the tabs, nothing for an empty corner', () => {
    expect(cornerWidth({ dot: false, attempts: 0, priorityText: null })).toBe(0)
    expect(cornerWidth({ dot: true, attempts: 0, priorityText: null })).toBe(24)
    expect(cornerWidth({ dot: true, attempts: 2, priorityText: 'High' })).toBeGreaterThan(
      cornerWidth({ dot: true, attempts: 0, priorityText: 'High' }),
    )
  })
})

describe('TM-RC: bulk Remove target (bulk/edit with due_at null)', () => {
  const at = (local: string) => DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
  const u = { userId: TEST_USER_ID, userTimezone: tz }
  const make = (input: Record<string, unknown>) =>
    createTask({ ...u, input: { title: 'Task', ...input } })

  beforeAll(() => setupTestDb())
  afterAll(() => teardownTestDb())
  beforeEach(() => {
    getDb().prepare('DELETE FROM tasks').run()
    getDb().prepare('DELETE FROM undo_log').run()
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  test('TM-RC-030: the sheet plans ONE bulk/edit, scoped to the removable ids, picks included', () => {
    const plan = planQuickPanelSave([1, 2, 3], { due_at: null }, [1, 2])
    expect(plan).toEqual({
      kind: 'bulk',
      url: '/api/tasks/bulk/edit',
      body: {
        ids: [1, 2, 3],
        changes: { due_at: null },
        include_task_ids: [1, 2],
        date_task_ids: [1, 2],
      },
    })
    // One task: its own PATCH, never a bulk endpoint.
    expect(planQuickPanelSave([1], { due_at: null }, [1])).toEqual({
      kind: 'patch',
      taskId: 1,
      body: { due_at: null },
    })
  })

  test('TM-RC-031: targets go, a deadline task goes back to auto, Urgent included; one Undo', () => {
    const plain = make({ due_at: at('2026-10-20T09:00'), priority: 4 })
    const withDeadline = make({
      due_at: at('2026-10-15T09:00'),
      deadline_at: at('2026-10-23T23:59'),
      priority: 3,
    })
    const untouched = make({ due_at: at('2026-10-21T09:00') })
    expect(getTaskById(withDeadline.id)!.target_auto).toBe(false)

    const ids = [plain.id, withDeadline.id]
    const r = bulkEdit({
      ...u,
      taskIds: [...ids, untouched.id],
      changes: { due_at: null },
      includeTaskIds: ids,
      dateTaskIds: ids,
    })
    expect(r.tasksAffected).toBe(2)
    expect(getTaskById(plain.id)!.due_at).toBeNull()
    const back = getTaskById(withDeadline.id)!
    expect(back.target_auto).toBe(true)
    // The automatic target: the morning 3 days before the deadline.
    expect(back.due_at).toBe(at('2026-10-20T09:00'))
    expect(getTaskById(untouched.id)!.due_at).toBe(at('2026-10-21T09:00'))

    // One entry, and Undo puts both picked targets back.
    const entries = getDb().prepare('SELECT action FROM undo_log').all() as { action: string }[]
    expect(entries.filter((e) => e.action === 'bulk_edit')).toHaveLength(1)
    executeUndo(TEST_USER_ID)
    expect(getTaskById(plain.id)!.due_at).toBe(at('2026-10-20T09:00'))
    expect(getTaskById(withDeadline.id)!.due_at).toBe(at('2026-10-15T09:00'))
    expect(getTaskById(withDeadline.id)!.target_auto).toBe(false)
  })
})
