/**
 * Label Registry Behavioral Tests (LR-001 through LR-014)
 *
 * Covers REDESIGN-V03 §7.2. The load-bearing behaviors are:
 *
 * - creating a label is a discrete act, so a typo fails loudly
 * - only NEWLY added labels are checked, so a legacy tag can't make a task
 *   permanently uneditable
 * - the reserved `ai-` namespace can't be minted implicitly, because those
 *   labels carry behavior
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { getDb } from '@/core/db'
import { createTask, getTaskById, updateTask } from '@/core/tasks'
import {
  listLabels,
  createLabel,
  deleteLabel,
  getLabelByName,
  validateLabelsExist,
  filterAutoCreatableLabels,
  confirmProvenance,
  PROVENANCE_LABELS,
} from '@/core/labels'
import { ValidationError } from '@/core/errors'
import { setupTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

describe('Label Registry', () => {
  beforeEach(() => {
    setupTestDb()
  })

  afterEach(() => {
    getDb().prepare("DELETE FROM labels WHERE name LIKE 'lr-%'").run()
  })

  /**
   * LR-001: The system vocabulary is seeded for every user by the backfill, so
   * the chip bar can render it without anyone having used it yet.
   */
  test('LR-001: system labels are registered on startup', () => {
    const names = listLabels(TEST_USER_ID).map((l) => l.name)
    expect(names).toContain('ai-to-process')
    expect(names).toContain(PROVENANCE_LABELS.added)
    expect(names).toContain(PROVENANCE_LABELS.proposed)
    expect(names).toContain(PROVENANCE_LABELS.monitored)
  })

  /**
   * LR-002: System labels are filed under the operational facet, which is what
   * keeps AND-across-facets chip semantics coherent.
   */
  test('LR-002: system labels carry the operational facet', () => {
    expect(getLabelByName(TEST_USER_ID, 'ai-to-process')?.facet).toBe('operational')
  })

  /**
   * LR-003: Registration is idempotent so callers can be naive about ordering.
   */
  test('LR-003: creating an existing label returns the existing row', () => {
    const first = createLabel(TEST_USER_ID, 'lr-kitchen')
    const second = createLabel(TEST_USER_ID, 'lr-kitchen')
    expect(second.id).toBe(first.id)
    expect(listLabels(TEST_USER_ID).filter((l) => l.name === 'lr-kitchen')).toHaveLength(1)
  })

  /**
   * LR-004: The headline rule — an unknown label on a task write is rejected.
   * This is what turns a typo from a silent taxonomy fork into a visible error.
   */
  test('LR-004: creating a task with an unregistered label is rejected', () => {
    expect(() =>
      createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Typo task', labels: ['lr-groseries'] },
      }),
    ).toThrow(ValidationError)
  })

  /**
   * LR-005: ...and the explicit escape hatch works.
   */
  test('LR-005: create_label registers the label as part of the write', () => {
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Deliberate', labels: ['lr-groceries'], create_label: true },
    })
    expect(task.labels).toContain('lr-groceries')
    expect(getLabelByName(TEST_USER_ID, 'lr-groceries')).not.toBeNull()
  })

  /**
   * LR-006: A registered label needs no flag.
   */
  test('LR-006: a registered label is accepted without create_label', () => {
    createLabel(TEST_USER_ID, 'lr-house')
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Fix door', labels: ['lr-house'] },
    })
    expect(task.labels).toContain('lr-house')
  })

  /**
   * LR-007: THE important one. A task carrying a label that is not in the
   * registry (legacy data, or a label deregistered later) must still be
   * editable. Checking the whole array instead of just additions would make
   * such a task permanently unsavable — far worse than a stray tag.
   */
  test('LR-007: an unrelated edit succeeds on a task with an unregistered label', () => {
    createLabel(TEST_USER_ID, 'lr-orphan')
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Legacy', labels: ['lr-orphan'] },
    })
    deleteLabel(TEST_USER_ID, 'lr-orphan')

    const { task: updated } = updateTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      taskId: task.id,
      input: { title: 'Legacy renamed', labels: ['lr-orphan'] },
    })
    expect(updated.title).toBe('Legacy renamed')
    expect(updated.labels).toContain('lr-orphan')
  })

  /**
   * LR-008: Adding a NEW unknown label to that same task is still rejected —
   * LR-007's leniency applies to round-tripping, not to fresh typos.
   */
  test('LR-008: adding a new unknown label to an existing task is still rejected', () => {
    createLabel(TEST_USER_ID, 'lr-known')
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Guarded', labels: ['lr-known'] },
    })

    expect(() =>
      updateTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: task.id,
        input: { labels: ['lr-known', 'lr-typoo'] },
      }),
    ).toThrow(ValidationError)
  })

  /**
   * LR-009: System labels never need registration, so validation can't depend
   * on backfill ordering.
   */
  test('LR-009: system labels validate even if absent from the registry', () => {
    deleteLabel(TEST_USER_ID, PROVENANCE_LABELS.added)
    expect(() =>
      validateLabelsExist(TEST_USER_ID, [PROVENANCE_LABELS.added], [], false),
    ).not.toThrow()
  })

  /**
   * LR-010: A typo INSIDE the reserved namespace is not a system label and must
   * fail. This is the specific hazard §7.2 names — a mistyped `ai-monitored`
   * yields a task nobody is watching that looks flagged.
   */
  test('LR-010: a typo in the reserved namespace is rejected', () => {
    expect(() => validateLabelsExist(TEST_USER_ID, ['ai-monitred'], [], false)).toThrow(
      ValidationError,
    )
  })

  /**
   * LR-011: Enrichment may register plain domain labels the user asked for...
   */
  test('LR-011: domain labels are auto-creatable by the enrichment path', () => {
    expect(filterAutoCreatableLabels(TEST_USER_ID, ['lr-nutrition'])).toEqual(['lr-nutrition'])
  })

  /**
   * LR-012: ...but must never mint an unregistered reserved label. Dropping is
   * correct here: the alternative is the AI silently inventing behavior.
   */
  test('LR-012: unregistered reserved labels are dropped, not created', () => {
    expect(filterAutoCreatableLabels(TEST_USER_ID, ['ai-invented', 'lr-real'])).toEqual(['lr-real'])
  })

  /**
   * LR-013: confirm swaps proposed for added and touches nothing else.
   */
  test('LR-013: confirmProvenance swaps proposed for added', () => {
    const result = confirmProvenance(['lr-keep', PROVENANCE_LABELS.proposed])
    expect(result).toContain('lr-keep')
    expect(result).toContain(PROVENANCE_LABELS.added)
    expect(result).not.toContain(PROVENANCE_LABELS.proposed)
  })

  /**
   * LR-014: Confirming twice is a no-op rather than producing a duplicate, so a
   * retried call is safe.
   */
  test('LR-014: confirming an already-confirmed set is idempotent', () => {
    const once = confirmProvenance([PROVENANCE_LABELS.proposed])
    const twice = confirmProvenance(once)
    expect(twice.filter((l) => l === PROVENANCE_LABELS.added)).toHaveLength(1)
  })

  /**
   * LR-015: Tasks created before the registry existed have their labels
   * backfilled, so nothing already known to the app looks like a typo.
   */
  test('LR-015: backfill registers labels already present on tasks', () => {
    const db = getDb()
    // Simulate legacy data: write labels straight to SQL, bypassing validation.
    const task = createTask({
      userId: TEST_USER_ID,
      userTimezone: TEST_TIMEZONE,
      input: { title: 'Legacy labelled' },
    })
    db.prepare('UPDATE tasks SET labels = ? WHERE id = ?').run('["lr-legacy"]', task.id)
    expect(getTaskById(task.id)!.labels).toContain('lr-legacy')
    expect(getLabelByName(TEST_USER_ID, 'lr-legacy')).toBeNull()
  })
})
