/**
 * Optional short name for the quota widget chip (§5, Trent 2026-09-23).
 *
 * Quota titles are often long sentences ("Posture practice (tall spine,
 * soft jaw, shoulders down and back, seated)"); the widget
 * shows every quota as a small tappable chip and needs something that fits.
 * `short_title` is validated the same way `notes` is (trim, cap, '' -> null),
 * and is an ordinary field for undo purposes — no special-casing anywhere in
 * the mutation/undo pipeline.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTask, getTaskById, updateTask } from '@/core/tasks'
import { executeUndo, executeRedo } from '@/core/undo'
import { validateTaskCreate, validateTaskUpdate } from '@/core/validation'
import { ZodError } from 'zod'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const NOW = new Date('2026-01-15T16:00:00Z')

describe('Quota short name (short_title)', () => {
  beforeEach(() => {
    vi.setSystemTime(NOW)
    setupTestDb()
  })
  afterEach(() => {
    vi.useRealTimers()
    teardownTestDb()
  })

  describe('validation', () => {
    test('trims surrounding whitespace', () => {
      expect(validateTaskUpdate({ short_title: '  Posture  ' }).short_title).toBe('Posture')
      expect(validateTaskCreate({ title: 'Eat beef', short_title: '  Beef  ' }).short_title).toBe(
        'Beef',
      )
    })

    test('empty string (or whitespace-only) becomes null, not ""', () => {
      expect(validateTaskUpdate({ short_title: '' }).short_title).toBeNull()
      expect(validateTaskUpdate({ short_title: '   ' }).short_title).toBeNull()
      expect(validateTaskCreate({ title: 'Eat beef', short_title: '' }).short_title).toBeNull()
    })

    test('rejects more than 24 characters', () => {
      const tooLong = 'A'.repeat(25)
      expect(() => validateTaskUpdate({ short_title: tooLong })).toThrow(ZodError)
      expect(() => validateTaskCreate({ title: 'x', short_title: tooLong })).toThrow(ZodError)
    })

    test('24 characters exactly is allowed', () => {
      const exact = 'A'.repeat(24)
      expect(validateTaskUpdate({ short_title: exact }).short_title).toBe(exact)
    })

    test('trim happens before the length check — 24 non-space chars padded with spaces still passes', () => {
      const exact = 'A'.repeat(24)
      expect(validateTaskUpdate({ short_title: `  ${exact}  ` }).short_title).toBe(exact)
    })

    test('omitted entirely means "no change" (undefined) — explicit null clears it', () => {
      const omitted = validateTaskUpdate({ title: 'New title' })
      expect(omitted.short_title).toBeUndefined()
      expect('short_title' in omitted).toBe(false)

      expect(validateTaskUpdate({ short_title: null }).short_title).toBeNull()
    })
  })

  describe('update + undo', () => {
    test('setting a short_title is an ordinary field change with undo/redo', () => {
      const quota = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Blow up balloons', rrule: 'FREQ=WEEKLY', progress_target: 4 },
      })
      expect(getTaskById(quota.id)!.short_title).toBeNull()

      const result = updateTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: quota.id,
        input: { short_title: 'Posture' },
      })
      expect(result.fieldsChanged).toEqual(['short_title'])
      expect(result.description).toBe('Changed short name — "Blow up balloons"')
      expect(getTaskById(quota.id)!.short_title).toBe('Posture')

      expect(() => executeUndo(TEST_USER_ID)).not.toThrow()
      expect(getTaskById(quota.id)!.short_title).toBeNull()

      expect(() => executeRedo(TEST_USER_ID)).not.toThrow()
      expect(getTaskById(quota.id)!.short_title).toBe('Posture')
    })

    test('clearing a short_title back to null, and undoing that, restores the prior name', () => {
      const quota = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: {
          title: 'Eat beef',
          rrule: 'FREQ=WEEKLY',
          progress_target: 4,
          short_title: 'Beef',
        },
      })
      expect(getTaskById(quota.id)!.short_title).toBe('Beef')

      // Routed through the same validation the API does — '' becomes null
      // before it ever reaches the core mutation.
      updateTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: quota.id,
        input: validateTaskUpdate({ short_title: '' }),
      })
      expect(getTaskById(quota.id)!.short_title).toBeNull()

      expect(() => executeUndo(TEST_USER_ID)).not.toThrow()
      expect(getTaskById(quota.id)!.short_title).toBe('Beef')
    })

    test('not touching short_title on an unrelated edit leaves it alone', () => {
      const quota = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: {
          title: 'Eat beef',
          rrule: 'FREQ=WEEKLY',
          progress_target: 4,
          short_title: 'Beef',
        },
      })

      const result = updateTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: quota.id,
        input: { progress_target: 5 },
      })
      expect(result.fieldsChanged).not.toContain('short_title')
      expect(getTaskById(quota.id)!.short_title).toBe('Beef')
    })

    test('is accepted (and undoable) on an ordinary, non-quota task too', () => {
      const task = createTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        input: { title: 'Buy groceries', short_title: 'Groceries' },
      })
      expect(getTaskById(task.id)!.short_title).toBe('Groceries')

      updateTask({
        userId: TEST_USER_ID,
        userTimezone: TEST_TIMEZONE,
        taskId: task.id,
        input: { short_title: 'Shopping' },
      })
      expect(getTaskById(task.id)!.short_title).toBe('Shopping')

      expect(() => executeUndo(TEST_USER_ID)).not.toThrow()
      expect(getTaskById(task.id)!.short_title).toBe('Groceries')
    })
  })
})
