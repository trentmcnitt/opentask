import { describe, test, expect, beforeEach } from 'vitest'
import { apiFetch, apiFetchB, resetTestData } from './helpers'

/**
 * Undo/Redo integration tests
 *
 * Tests the undo/redo system end-to-end via HTTP against a real server.
 * Each test resets the DB to ensure a clean undo stack.
 *
 * Seeded tasks (User A):
 *   1: "Buy groceries" — one-off, project Inbox, priority 2
 *   2: "Morning routine" — recurring daily, project Routine
 *   4: "Review PRs" — one-off, project Work, priority 3, labels ["work","dev"]
 *   5: "Prepare slides" — one-off, project Inbox, priority 2
 *   7: "Clean desk" — one-off, project Inbox, priority 0
 *   8: "Call dentist" — one-off, project Inbox, priority 1
 *
 * Seeded tasks (User B):
 *   3: "User B task" — one-off
 */

// Helper: get a single task
async function getTask(id: number) {
  const res = await apiFetch(`/api/tasks/${id}`)
  expect(res.status).toBe(200)
  return (await res.json()).data
}

// Helper: edit a task via PATCH
async function editTask(id: number, body: Record<string, unknown>) {
  const res = await apiFetch(`/api/tasks/${id}`, { method: 'PATCH', body })
  expect(res.status).toBe(200)
  return (await res.json()).data
}

// Helper: mark done
async function markDone(id: number) {
  const res = await apiFetch(`/api/tasks/${id}/done`, { method: 'POST' })
  expect(res.status).toBe(200)
  return (await res.json()).data
}

// Helper: delete (trash)
async function trashTask(id: number) {
  const res = await apiFetch(`/api/tasks/${id}`, { method: 'DELETE' })
  expect(res.status).toBe(200)
  return (await res.json()).data
}

// Helper: snooze
async function snoozeTask(id: number, until: string) {
  const res = await apiFetch(`/api/tasks/${id}/snooze`, {
    method: 'POST',
    body: { until },
  })
  expect(res.status).toBe(200)
  return (await res.json()).data
}

// Helper: undo — returns response (caller checks status)
async function undo() {
  return apiFetch('/api/undo', { method: 'POST' })
}

// Helper: redo — returns response (caller checks status)
async function redo() {
  return apiFetch('/api/redo', { method: 'POST' })
}

describe('Undo/Redo integration', () => {
  beforeEach(async () => {
    await resetTestData()
  })

  // ─── Undo per action type ───────────────────────────────────────

  test('undo edit restores previous field values', async () => {
    const before = await getTask(1)
    expect(before.title).toBe('Buy groceries')
    expect(before.priority).toBe(2)

    // Edit title and priority
    await editTask(1, { title: 'Buy organic groceries', priority: 3 })
    const edited = await getTask(1)
    expect(edited.title).toBe('Buy organic groceries')
    expect(edited.priority).toBe(3)

    // Undo
    const undoRes = await undo()
    expect(undoRes.status).toBe(200)
    const undoData = (await undoRes.json()).data
    expect(undoData.undone_action).toBe('edit')

    // Verify restored
    const after = await getTask(1)
    expect(after.title).toBe('Buy groceries')
    expect(after.priority).toBe(2)
  })

  test('undo delete restores task from trash', async () => {
    const before = await getTask(7)
    expect(before.title).toBe('Clean desk')

    // Delete (trash)
    await trashTask(7)

    // Task should be in trash
    const trashRes = await apiFetch('/api/trash')
    const trashData = (await trashRes.json()).data
    const inTrash = trashData.tasks.find((t: { id: number }) => t.id === 7)
    expect(inTrash).not.toBeUndefined()
    expect(inTrash.id).toBe(7)

    // Undo
    const undoRes = await undo()
    expect(undoRes.status).toBe(200)
    const undoData = (await undoRes.json()).data
    expect(undoData.undone_action).toBe('delete')

    // Task should be back in active list
    const after = await getTask(7)
    expect(after.title).toBe('Clean desk')
    expect(after.deleted_at).toBeNull()
  })

  test('undo snooze restores original due_at', async () => {
    const before = await getTask(1)
    const originalDueAt = before.due_at

    // Snooze to far future
    const snoozeUntil = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
    await snoozeTask(1, snoozeUntil)

    const snoozed = await getTask(1)
    expect(snoozed.snoozed_from).not.toBeNull()
    expect(snoozed.due_at).not.toBe(originalDueAt)

    // Undo
    const undoRes = await undo()
    expect(undoRes.status).toBe(200)
    const undoData = (await undoRes.json()).data
    expect(undoData.undone_action).toBe('snooze')

    // Verify restored
    const after = await getTask(1)
    expect(after.due_at).toBe(originalDueAt)
    expect(after.snoozed_from).toBeNull()
  })

  // ─── Basic redo ─────────────────────────────────────────────────

  test('redo re-applies edit after undo', async () => {
    await editTask(1, { title: 'Updated title', priority: 4 })

    // Undo
    await undo()
    const undone = await getTask(1)
    expect(undone.title).toBe('Buy groceries')
    expect(undone.priority).toBe(2)

    // Redo
    const redoRes = await redo()
    expect(redoRes.status).toBe(200)
    const redoData = (await redoRes.json()).data
    expect(redoData.redone_action).toBe('edit')

    // Verify re-applied
    const after = await getTask(1)
    expect(after.title).toBe('Updated title')
    expect(after.priority).toBe(4)
  })

  test('redo re-applies mark done after undo', async () => {
    const before = await getTask(2) // recurring daily
    const originalDueAt = before.due_at

    // Mark done (advances due_at)
    await markDone(2)
    const doneTask = await getTask(2)
    const advancedDueAt = doneTask.due_at
    expect(advancedDueAt).not.toBe(originalDueAt)

    // Undo
    await undo()
    const undone = await getTask(2)
    expect(undone.due_at).toBe(originalDueAt)

    // Redo
    const redoRes = await redo()
    expect(redoRes.status).toBe(200)

    // Verify advanced again
    const after = await getTask(2)
    expect(after.due_at).toBe(advancedDueAt)
  })

  // ─── Multi-level undo/redo ──────────────────────────────────────

  test('multi-level: 3 actions, undo all 3, redo all 3', async () => {
    // Capture original states
    const orig1 = await getTask(1)
    const orig5 = await getTask(5)
    const orig7 = await getTask(7)

    // Action 1: edit task 1
    await editTask(1, { title: 'Action One' })

    // Action 2: edit task 5
    await editTask(5, { title: 'Action Two' })

    // Action 3: edit task 7
    await editTask(7, { title: 'Action Three' })

    // Verify all edits applied
    expect((await getTask(1)).title).toBe('Action One')
    expect((await getTask(5)).title).toBe('Action Two')
    expect((await getTask(7)).title).toBe('Action Three')

    // Undo 3 — reverses Action 3 (task 7)
    const undo3 = await undo()
    expect(undo3.status).toBe(200)
    expect((await getTask(7)).title).toBe(orig7.title)
    expect((await getTask(5)).title).toBe('Action Two')  // still edited

    // Undo 2 — reverses Action 2 (task 5)
    const undo2 = await undo()
    expect(undo2.status).toBe(200)
    expect((await getTask(5)).title).toBe(orig5.title)
    expect((await getTask(1)).title).toBe('Action One')  // still edited

    // Undo 1 — reverses Action 1 (task 1)
    const undo1 = await undo()
    expect(undo1.status).toBe(200)
    expect((await getTask(1)).title).toBe(orig1.title)

    // All back to original
    expect((await getTask(1)).title).toBe(orig1.title)
    expect((await getTask(5)).title).toBe(orig5.title)
    expect((await getTask(7)).title).toBe(orig7.title)

    // Redo 1 — re-applies Action 1 (task 1)
    const redo1 = await redo()
    expect(redo1.status).toBe(200)
    expect((await getTask(1)).title).toBe('Action One')
    expect((await getTask(5)).title).toBe(orig5.title)  // still original

    // Redo 2 — re-applies Action 2 (task 5)
    const redo2 = await redo()
    expect(redo2.status).toBe(200)
    expect((await getTask(5)).title).toBe('Action Two')

    // Redo 3 — re-applies Action 3 (task 7)
    const redo3 = await redo()
    expect(redo3.status).toBe(200)
    expect((await getTask(7)).title).toBe('Action Three')
  })

  test('multi-level with mixed action types: done + edit + snooze', async () => {
    const orig2 = await getTask(2) // recurring
    const orig1 = await getTask(1)
    const orig5 = await getTask(5)

    // Action 1: mark recurring task done (advances due_at)
    await markDone(2)
    const doneTask = await getTask(2)
    expect(doneTask.due_at).not.toBe(orig2.due_at)

    // Action 2: edit task 1 title
    await editTask(1, { title: 'Edited title' })

    // Action 3: snooze task 5
    const snoozeUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    await snoozeTask(5, snoozeUntil)

    // Undo all 3 in reverse
    await undo() // undo snooze
    const afterUndoSnooze = await getTask(5)
    expect(afterUndoSnooze.due_at).toBe(orig5.due_at)
    expect(afterUndoSnooze.snoozed_from).toBeNull()

    await undo() // undo edit
    expect((await getTask(1)).title).toBe(orig1.title)

    await undo() // undo done
    expect((await getTask(2)).due_at).toBe(orig2.due_at)

    // Redo first two (done + edit), leave snooze undone
    await redo() // redo done
    expect((await getTask(2)).due_at).not.toBe(orig2.due_at)

    await redo() // redo edit
    expect((await getTask(1)).title).toBe('Edited title')

    // Snooze should still be undone
    const task5 = await getTask(5)
    expect(task5.due_at).toBe(orig5.due_at)
    expect(task5.snoozed_from).toBeNull()
  })

  // ─── Redo invalidation ─────────────────────────────────────────

  test('new action after undo clears redo stack', async () => {
    // Action 1: edit task 1
    await editTask(1, { title: 'First edit' })

    // Undo
    await undo()
    expect((await getTask(1)).title).toBe('Buy groceries')

    // New action instead of redo: edit task 5
    await editTask(5, { title: 'New action' })

    // Redo should fail — the redo stack was cleared by the new action
    const redoRes = await redo()
    expect(redoRes.status).toBe(400)
    const redoData = await redoRes.json()
    expect(redoData.error).toMatch(/nothing to redo/i)
  })

  // ─── Edge cases ─────────────────────────────────────────────────

  test('undo with empty stack returns 400', async () => {
    // Fresh reset, no actions taken
    const undoRes = await undo()
    expect(undoRes.status).toBe(400)
    const data = await undoRes.json()
    expect(data.error).toMatch(/nothing to undo/i)
  })

  test('redo with empty stack returns 400', async () => {
    const redoRes = await redo()
    expect(redoRes.status).toBe(400)
    const data = await redoRes.json()
    expect(data.error).toMatch(/nothing to redo/i)
  })

  test('undo past available history returns 400 on extra attempt', async () => {
    // One action
    await editTask(1, { title: 'Only action' })

    // First undo succeeds
    const undo1 = await undo()
    expect(undo1.status).toBe(200)

    // Second undo should fail
    const undo2 = await undo()
    expect(undo2.status).toBe(400)
  })

  test('surgical undo: mark done then edit title, undo done preserves title', async () => {
    const orig = await getTask(2) // recurring daily

    // Action 1: mark done (advances due_at)
    await markDone(2)
    const afterDone = await getTask(2)
    expect(afterDone.due_at).not.toBe(orig.due_at)

    // Action 2: edit title (separate action)
    await editTask(2, { title: 'New routine name' })
    expect((await getTask(2)).title).toBe('New routine name')

    // Undo action 2 (the edit)
    await undo()
    const afterUndoEdit = await getTask(2)
    expect(afterUndoEdit.title).toBe('Morning routine') // title restored
    expect(afterUndoEdit.due_at).toBe(afterDone.due_at) // due_at still advanced

    // Undo action 1 (the done) — surgical: only due_at/snoozed_from fields
    await undo()
    const afterUndoDone = await getTask(2)
    expect(afterUndoDone.due_at).toBe(orig.due_at) // due_at restored
    expect(afterUndoDone.title).toBe('Morning routine') // title untouched
  })

  test('bulk done undo then redo restores all tasks both ways', async () => {
    const orig7 = await getTask(7)
    const orig8 = await getTask(8)

    // Bulk mark done
    const bulkRes = await apiFetch('/api/tasks/bulk/done', {
      method: 'POST',
      body: { ids: [7, 8] },
    })
    expect(bulkRes.status).toBe(200)

    // Both should be done
    expect((await getTask(7)).done).toBe(true)
    expect((await getTask(8)).done).toBe(true)

    // Undo — both revert
    const undoRes = await undo()
    expect(undoRes.status).toBe(200)
    expect((await getTask(7)).done).toBe(false)
    expect((await getTask(8)).done).toBe(false)

    // Redo — both re-complete
    const redoRes = await redo()
    expect(redoRes.status).toBe(200)
    expect((await getTask(7)).done).toBe(true)
    expect((await getTask(8)).done).toBe(true)
  })

  test('undo is isolated between users', async () => {
    // User A edits task 1
    await editTask(1, { title: 'User A edit' })

    // User B edits task 3
    const bEditRes = await apiFetchB('/api/tasks/3', {
      method: 'PATCH',
      body: { title: 'User B edit' },
    })
    expect(bEditRes.status).toBe(200)

    // User B undoes — should only affect task 3
    const bUndoRes = await apiFetchB('/api/undo', { method: 'POST' })
    expect(bUndoRes.status).toBe(200)

    // User A's edit should be untouched
    expect((await getTask(1)).title).toBe('User A edit')

    // User B's task should be restored
    const bTaskRes = await apiFetchB('/api/tasks/3')
    const bTask = (await bTaskRes.json()).data
    expect(bTask.title).toBe('User B task')
  })
})
