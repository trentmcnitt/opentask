/**
 * BG: the two badges (spec §7, rulings Q5–Q7, Q10; 2026-10-12) — attempts
 * (local days over target) and age (undated tasks past their horizon's
 * threshold). Rules in `src/lib/task-segments.ts` § the two badges; the read
 * in `rowToTask`, the checkpoint in `stampTargetSet`, the reset in done and
 * skip, the restore in put-back, the cron in `src/core/tasks/attempts.ts`.
 *
 * America/Chicago. Mon Oct 12 2026 is the anchor week; BG-009 crosses the
 * Nov 1 DST change.
 */
import { describe, test, expect, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { DateTime } from 'luxon'
import { getDb } from '@/core/db'
import { createTask, updateTask, markDone, bulkEdit } from '@/core/tasks'
import { markUndone } from '@/core/tasks/mark-done'
import { skipOccurrence } from '@/core/tasks/skip'
import { getTaskById } from '@/core/tasks/read'
import { persistAttempts } from '@/core/tasks/attempts'
import { executeUndo, executeRedo } from '@/core/undo'
import { formatTaskResponse } from '@/lib/format-task'
import { ageLabel, effectiveAttempts } from '@/lib/task-segments'
import { setupTestDb, teardownTestDb, TEST_TIMEZONE, TEST_USER_ID } from '../helpers/setup'

const tz = TEST_TIMEZONE
const u = { userId: TEST_USER_ID, userTimezone: tz }

/** Chicago wall-clock → UTC ISO. */
function at(local: string): string {
  return DateTime.fromISO(local, { zone: tz }).toUTC().toISO()!
}
function clock(local: string): void {
  vi.setSystemTime(new Date(at(local)))
}
function make(input: Record<string, unknown>) {
  return createTask({ ...u, input: { title: 'Synthetic task', ...input } })
}
const attemptsOf = (id: number) => getTaskById(id)!.attempts
const stored = (id: number) =>
  getDb().prepare('SELECT attempts, attempts_counted_through FROM tasks WHERE id = ?').get(id) as {
    attempts: number
    attempts_counted_through: string | null
  }

describe('BG: attempts', () => {
  afterAll(() => teardownTestDb())
  beforeEach(() => {
    clock('2026-10-12T09:00')
    setupTestDb()
  })
  afterEach(() => vi.useRealTimers())

  test('BG-001: the squeaky door — Tue target, moved to Sat: 1× Tue, frozen to Sat, 2× Sat, 3× Sun + offer', () => {
    const t = make({ due_at: at('2026-10-13T09:00') })
    expect(t.attempts).toBe(0)
    clock('2026-10-13T08:59')
    expect(attemptsOf(t.id)).toBe(0)
    // The moment it goes over target, the day counts (ruling Q5).
    clock('2026-10-13T09:00')
    expect(attemptsOf(t.id)).toBe(1)
    expect(formatTaskResponse(getTaskById(t.id)!, tz).attempts_label).toBe('1×')
    clock('2026-10-13T10:00')
    updateTask({ ...u, taskId: t.id, input: { due_at: at('2026-10-17T09:00') } })
    // The checkpoint was written by the move itself, before any cron.
    expect(stored(t.id)).toEqual({ attempts: 1, attempts_counted_through: '2026-10-13' })
    for (const day of ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17T08:59']) {
      clock(day.length === 10 ? `${day}T20:00` : day)
      expect(attemptsOf(t.id), day).toBe(1)
    }
    clock('2026-10-17T09:00')
    expect(attemptsOf(t.id)).toBe(2)
    clock('2026-10-18T07:00')
    const sun = formatTaskResponse(getTaskById(t.id)!, tz)
    expect(sun.attempts).toBe(3)
    expect(sun.attempts_label).toBe('3×')
    expect(sun.attempts_offer).toBe('remove')
  })

  test('BG-002: one per local day — moves the same day add nothing, even back into the past', () => {
    const t = make({ due_at: at('2026-10-12T08:00') })
    expect(attemptsOf(t.id)).toBe(1)
    clock('2026-10-12T10:00')
    updateTask({ ...u, taskId: t.id, input: { due_at: at('2026-10-12T11:00') } })
    clock('2026-10-12T11:30')
    expect(attemptsOf(t.id)).toBe(1)
    updateTask({ ...u, taskId: t.id, input: { due_at: at('2026-10-12T07:00') } })
    expect(attemptsOf(t.id)).toBe(1)
    // A target moved that hasn't arrived adds nothing either.
    updateTask({ ...u, taskId: t.id, input: { due_at: at('2026-10-20T09:00') } })
    clock('2026-10-19T23:59')
    expect(attemptsOf(t.id)).toBe(1)
  })

  test('BG-003: the moment counts even if the target moves before the minute cron', () => {
    const t = make({ due_at: at('2026-10-12T09:30') })
    clock('2026-10-12T09:30:20')
    // No read, no cron in between: the move's checkpoint reads the row as of now.
    updateTask({ ...u, taskId: t.id, input: { due_at: at('2026-10-13T09:30') } })
    expect(stored(t.id).attempts).toBe(1)
    expect(attemptsOf(t.id)).toBe(1)
  })

  test('BG-004: a one-off done resets; undo restores; put-back restores without counting the done days', () => {
    const t = make({ due_at: at('2026-10-10T09:00') })
    getDb()
      .prepare('UPDATE tasks SET created_at = ?, target_set_at = ? WHERE id = ?')
      .run(at('2026-10-01T09:00'), at('2026-10-01T09:00'), t.id)
    expect(attemptsOf(t.id)).toBe(3) // Sat, Sun, Mon
    markDone({ ...u, taskId: t.id })
    expect(stored(t.id)).toEqual({ attempts: 0, attempts_counted_through: null })
    const row = getDb()
      .prepare('SELECT attempts FROM completions WHERE task_id = ? ORDER BY id DESC')
      .get(t.id) as { attempts: number }
    expect(row.attempts).toBe(3)
    executeUndo(TEST_USER_ID)
    expect(attemptsOf(t.id)).toBe(3)
    executeRedo(TEST_USER_ID)
    expect(stored(t.id).attempts).toBe(0)
    // Put back two days later: the count comes back, Tue and Wed (done) are
    // not attempts, today is one.
    clock('2026-10-14T12:00')
    markUndone({ ...u, taskId: t.id })
    expect(attemptsOf(t.id)).toBe(4)
  })

  test('BG-005: a repeating task resets on each new occurrence (done and skip); the completion keeps the count', () => {
    clock('2026-10-08T10:00')
    const t = make({ rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0' })
    clock('2026-10-11T10:00') // Fri Oct 9 9:00 occurrence: Fri, Sat, Sun
    expect(attemptsOf(t.id)).toBe(3)
    markDone({ ...u, taskId: t.id })
    const after = getTaskById(t.id)!
    expect(after.due_at).toBe(at('2026-10-16T09:00'))
    expect(after.attempts).toBe(0)
    const completion = getDb()
      .prepare('SELECT attempts FROM completions WHERE task_id = ? ORDER BY id DESC')
      .get(t.id) as { attempts: number }
    expect(completion.attempts).toBe(3)
    clock('2026-10-17T10:00')
    expect(attemptsOf(t.id)).toBe(2)
    skipOccurrence({ ...u, taskId: t.id })
    expect(attemptsOf(t.id)).toBe(0)
    executeUndo(TEST_USER_ID)
    expect(attemptsOf(t.id)).toBe(2)
    // Put back the done (the skip is undone): the Fri Oct 9 occurrence and its
    // three days come back; the week it sat done adds only today.
    markUndone({ ...u, taskId: t.id })
    expect(getTaskById(t.id)!.due_at).toBe(at('2026-10-09T09:00'))
    expect(attemptsOf(t.id)).toBe(4)
  })

  test('BG-006: a removed target freezes; the badge hides; a retarget resumes', () => {
    const t = make({ due_at: at('2026-10-12T08:00') })
    clock('2026-10-13T09:00')
    updateTask({ ...u, taskId: t.id, input: { due_at: null } })
    let f = formatTaskResponse(getTaskById(t.id)!, tz)
    expect(f.attempts).toBe(2)
    expect(f.attempts_label).toBeNull()
    expect(f.attempts_offer).toBeNull()
    clock('2026-10-20T09:00')
    expect(attemptsOf(t.id)).toBe(2)
    updateTask({ ...u, taskId: t.id, input: { due_at: at('2026-10-21T09:00') } })
    clock('2026-10-21T09:00')
    f = formatTaskResponse(getTaskById(t.id)!, tz)
    expect(f.attempts).toBe(3)
    expect(f.attempts_offer).toBe('remove')
  })

  test('BG-007: what 3× offers — remove (a deadline task too since 2026-10-22), or nothing (auto target, repeating)', () => {
    clock('2026-10-01T09:00')
    const plain = make({ due_at: at('2026-10-02T09:00') })
    const picked = make({ due_at: at('2026-10-02T09:00'), deadline_at: at('2026-11-30T17:00') })
    const auto = make({ deadline_at: at('2026-10-04T17:00') })
    expect(auto.target_auto).toBe(true)
    const repeating = make({ rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' })
    clock('2026-10-12T12:00')
    const offer = (id: number) => formatTaskResponse(getTaskById(id)!, tz).attempts_offer
    expect(offer(plain.id)).toBe('remove')
    expect(offer(picked.id)).toBe('remove')
    expect(attemptsOf(auto.id)).toBeGreaterThanOrEqual(3)
    expect(offer(auto.id)).toBeNull()
    expect(attemptsOf(repeating.id)).toBeGreaterThanOrEqual(3)
    expect(offer(repeating.id)).toBeNull()
  })

  test('BG-008: reminders and quotas never count; done tasks never count', () => {
    clock('2026-10-01T09:00')
    const reminder = make({ is_reminder: true, rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' })
    const quota = make({ is_tracked: true, progress_target: 3, rrule: 'FREQ=WEEKLY' })
    clock('2026-10-12T12:00')
    expect(attemptsOf(reminder.id)).toBe(0)
    expect(attemptsOf(quota.id)).toBe(0)
  })

  test('BG-009: local days across DST — Sat Oct 31 21:00 → Sun Nov 1 → Mon Nov 2 is 3', () => {
    clock('2026-10-25T12:00')
    const t = make({ due_at: at('2026-10-31T21:00') })
    clock('2026-10-31T23:59')
    expect(attemptsOf(t.id)).toBe(1)
    clock('2026-11-01T00:30') // after midnight, before the 2 AM change
    expect(attemptsOf(t.id)).toBe(2)
    clock('2026-11-01T23:30') // after the change, same local day
    expect(attemptsOf(t.id)).toBe(2)
    clock('2026-11-02T00:01')
    expect(attemptsOf(t.id)).toBe(3)
  })

  test('BG-010: the minute cron persists the count; undo of a move leaves it', () => {
    const t = make({ due_at: at('2026-10-12T08:00') })
    expect(stored(t.id).attempts).toBe(0) // created after the fact: read-only so far
    expect(persistAttempts()).toBe(1)
    expect(stored(t.id)).toEqual({ attempts: 1, attempts_counted_through: '2026-10-12' })
    expect(persistAttempts()).toBe(0) // nothing new
    clock('2026-10-14T10:00')
    persistAttempts()
    expect(stored(t.id).attempts).toBe(3)
    updateTask({ ...u, taskId: t.id, input: { due_at: at('2026-10-20T08:00') } })
    executeUndo(TEST_USER_ID)
    expect(getTaskById(t.id)!.due_at).toBe(at('2026-10-12T08:00'))
    expect(attemptsOf(t.id)).toBe(3)
  })

  test('BG-011: a bulk move checkpoints every task', () => {
    const a = make({ due_at: at('2026-10-11T08:00') })
    const b = make({ due_at: at('2026-10-12T08:00') })
    getDb()
      .prepare('UPDATE tasks SET created_at = ?, target_set_at = ? WHERE id = ?')
      .run(at('2026-10-01T08:00'), at('2026-10-01T08:00'), a.id)
    bulkEdit({ ...u, taskIds: [a.id, b.id], changes: { due_at: at('2026-10-15T08:00') } })
    expect(stored(a.id).attempts).toBe(2)
    expect(stored(b.id).attempts).toBe(1)
  })

  test('BG-012: the pure rule — never before creation or before the target was set', () => {
    const base = {
      due_at: at('2026-10-01T09:00'),
      deadline_at: null,
      created_at: at('2026-10-05T09:00'),
      target_set_at: at('2026-10-08T09:00'),
    }
    const now = new Date(at('2026-10-10T12:00'))
    expect(effectiveAttempts(base, tz, now, null)).toEqual({
      attempts: 3,
      countedThrough: '2026-10-10',
    })
    expect(
      effectiveAttempts(
        { ...base, attempts_counted_through: '2026-10-09', attempts: 5 },
        tz,
        now,
        null,
      ),
    ).toEqual({ attempts: 6, countedThrough: '2026-10-10' })
  })
})

describe('BG: age', () => {
  afterAll(() => teardownTestDb())
  beforeEach(() => {
    clock('2026-10-12T09:00')
    setupTestDb()
  })
  afterEach(() => vi.useRealTimers())

  test.each([
    ['days', '2026-10-05T09:00', '2026-10-05T08:59', '>1 wk'],
    ['weeks', '2026-09-12T09:00', '2026-09-12T08:59', '>1 mo'],
    [null, '2026-09-12T09:00', '2026-09-12T08:59', '>1 mo'],
    ['months', '2026-07-12T09:00', '2026-07-12T08:59', '>3 mo'],
    ['eventually', '2026-04-12T09:00', '2026-04-12T08:59', '>6 mo'],
  ] as const)(
    'BG-020: %s — exactly at the threshold no; a minute past, %s',
    (horizon, edge, past, label) => {
      const task = { due_at: null, deadline_at: null, horizon, created_at: at(edge) }
      expect(ageLabel(task, new Date(), tz)).toBeNull()
      expect(ageLabel({ ...task, created_at: at(past) }, new Date(), tz)).toBe(label)
    },
  )

  test('BG-021: only undated one-offs — a target, a deadline, a repeat, a reminder, a quota: none', () => {
    const created = at('2026-01-01T09:00')
    const t = make({})
    getDb().prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(created, t.id)
    expect(formatTaskResponse(getTaskById(t.id)!, tz).age_label).toBe('>1 mo')
    const base = { created_at: created, due_at: null, deadline_at: null, horizon: null }
    expect(ageLabel({ ...base, due_at: at('2026-10-20T09:00') }, new Date())).toBeNull()
    expect(ageLabel({ ...base, deadline_at: at('2026-12-20T09:00') }, new Date())).toBeNull()
    expect(ageLabel({ ...base, rrule: 'FREQ=DAILY' }, new Date())).toBeNull()
    expect(ageLabel({ ...base, is_reminder: true }, new Date())).toBeNull()
    expect(ageLabel({ ...base, is_tracked: true }, new Date())).toBeNull()
  })

  test("BG-022: age_label is the user's calendar month, not UTC's — and the web row's answer", () => {
    // Made Fri Oct 30 at 10 PM in Chicago = Oct 31 03:00 UTC. A UTC month
    // ends Nov 30 03:00 UTC; the user's month ends Mon Nov 30 at 10 PM CST
    // (Dec 1 04:00 UTC). Month-end is where the two zones' months differ.
    const t = make({})
    getDb()
      .prepare('UPDATE tasks SET created_at = ? WHERE id = ?')
      .run(at('2026-10-30T22:00'), t.id)
    const label = () => formatTaskResponse(getTaskById(t.id)!, tz).age_label
    // Nov 30 at 6 AM Chicago (12:00 UTC): past the UTC month, not the local one.
    clock('2026-11-30T06:00')
    const task = getTaskById(t.id)!
    expect(ageLabel(task, new Date(), 'utc')).toBe('>1 mo') // what the server used to send
    expect(label()).toBeNull()
    expect(label()).toBe(ageLabel(task, new Date(), tz)) // the web row (TaskRow)
    // Exactly at the local threshold: not yet; a minute past: >1 mo.
    clock('2026-11-30T22:00')
    expect(label()).toBeNull()
    clock('2026-11-30T22:01')
    expect(label()).toBe('>1 mo')
  })
})
