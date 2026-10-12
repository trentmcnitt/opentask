/**
 * Process (2026-10-10 task model, spec §5) — the happy path through the modal
 * opened from the top bar's menu: sort an Inbox task into a project, grow a
 * long-unchanged horizon, and remove an old target, then Undo it.
 *
 * The E2E database is shared by every spec, so this one acts as little as it
 * can on tasks it did not create: it skips other Inbox tasks, and unchecks
 * other rows before a batch write (an unchecked growth row is a "keep", which
 * only restarts that task's horizon clock; an unchecked target is untouched). With no AI in E2E, the duplicates step is absent and no
 * project is highlighted — Process must work with AI off.
 */
import path from 'path'
import Database from 'better-sqlite3'
import { DateTime } from 'luxon'
import type { Page } from '@playwright/test'
import { test, expect, uniqueTitle } from './fixtures'

const DAY = 24 * 60 * 60 * 1000
const TEST_TZ = process.env.E2E_TZ || 'America/Chicago'

async function createTask(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.status()).toBe(201)
  return (await res.json()).data.id
}

async function getTask(page: Page, id: number) {
  const res = await page.request.get(`/api/tasks/${id}`)
  return (await res.json()).data
}

/**
 * The growth clock can't be set over the API — nor when a target was set
 * (attempts never count before it, spec §7).
 */
function backdate(id: number, days: number) {
  const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
  try {
    const when = new Date(Date.now() - days * DAY).toISOString()
    db.prepare(
      'UPDATE tasks SET created_at = ?, target_set_at = ?, horizon_set_at = NULL WHERE id = ?',
    ).run(when, when, id)
  } finally {
    db.close()
  }
}

async function openProcess(page: Page) {
  await page.getByRole('button', { name: 'Menu' }).first().click()
  await page.locator('[data-process-menu-item]').click()
  await expect(page.locator('[data-process-modal]')).toBeVisible()
}

test.describe('Process', () => {
  test.use({ timezoneId: TEST_TZ })
  test('sorts the Inbox, grows a horizon, removes an old target with Undo', async ({
    authenticatedPage: page,
  }) => {
    const inboxTitle = uniqueTitle('Process inbox')
    const growTitle = uniqueTitle('Process grow')
    const targetTitle = uniqueTitle('Process target')
    const inboxId = await createTask(page, { title: inboxTitle, project_id: 1 })
    const growId = await createTask(page, { title: growTitle, project_id: 3 })
    backdate(growId, 61)
    // Noon, ten local days ago in the user's zone: 11 local days over target
    // (spec §7 attempts) at any hour.
    const staleTarget = DateTime.now()
      .setZone(TEST_TZ)
      .minus({ days: 10 })
      .set({ hour: 12, minute: 0, second: 0, millisecond: 0 })
      .toUTC()
      .toISO()!
    const targetId = await createTask(page, {
      title: targetTitle,
      project_id: 3,
      target_at: staleTarget,
    })
    // Written down (and targeted) a month ago: attempts never count from
    // before either. A target of its own: never a growth ask.
    backdate(targetId, 30)

    try {
      await openProcess(page)
      const modal = page.locator('[data-process-modal]')

      // 1. Inbox: skip other specs' tasks until ours is shown, then move it.
      const title = modal.locator('[data-process-inbox-title]')
      await expect(title).toBeVisible()
      for (let i = 0; i < 50 && (await title.textContent()) !== inboxTitle; i++) {
        const before = await title.textContent()
        await modal.getByRole('button', { name: 'Skip' }).click()
        await expect(title).not.toHaveText(before ?? '')
      }
      await expect(title).toHaveText(inboxTitle)
      // Fixed order, Settings order, Inbox not offered; no AI → no highlight.
      // (Other specs add projects of their own after these two.)
      const buttons = modal.locator('[data-process-project]')
      await expect(buttons.first()).toHaveText('Routine')
      await expect(buttons.nth(1)).toHaveText('Work')
      await expect(modal.locator('[data-process-project="Inbox"]')).toHaveCount(0)
      await expect(modal.locator('[data-suggested]')).toHaveCount(0)
      await modal.locator('[data-process-project="Work"]').click()
      await expect(page.getByText('Moved to Work')).toBeVisible()
      await expect.poll(async () => (await getTask(page, inboxId)).project_id).toBe(3)

      // 3. Horizons: our task, checked by default; grow it.
      await modal.getByRole('tab', { name: /Horizons/ }).click()
      const growRow = modal.locator(`[data-process-growth-row="${growId}"]`)
      await expect(growRow).toContainText('Weeks (unset)')
      await expect(growRow).toContainText('Months')
      await expect(growRow.getByRole('checkbox')).toBeChecked()
      for (const row of await modal.locator('[data-process-growth-row]').all()) {
        if ((await row.getAttribute('data-process-growth-row')) !== String(growId)) {
          await row.getByRole('checkbox').click()
        }
      }
      await modal.locator('[data-process-growth-apply]').click()
      await expect(growRow).toHaveCount(0)
      await expect.poll(async () => (await getTask(page, growId)).horizon).toBe('months')

      // 4. Old targets: only ours checked; remove, then Undo from the toast.
      await modal.getByRole('tab', { name: /Old targets/ }).click()
      const targetRow = modal.locator(`[data-process-target-row="${targetId}"]`)
      await expect(targetRow).toContainText('11×')
      for (const row of await modal.locator('[data-process-target-row]').all()) {
        const checkbox = row.getByRole('checkbox')
        const mine = (await row.getAttribute('data-process-target-row')) === String(targetId)
        if (mine !== (await checkbox.isChecked())) await checkbox.click()
      }
      await expect(modal.locator('[data-process-remove-targets]')).toHaveText('Remove 1 target')
      await modal.locator('[data-process-remove-targets]').click()
      await expect(page.getByText('Removed 1 target')).toBeVisible()
      await expect.poll(async () => (await getTask(page, targetId)).target_at).toBeNull()

      // The toast's Undo works with the modal still open (it used to sit under
      // the modal's overlay), and tapping it does not close Process.
      await page
        .locator('[data-sonner-toast]', { hasText: 'Removed 1 target' })
        .getByRole('button', { name: 'Undo' })
        .click()
      await expect.poll(async () => (await getTask(page, targetId)).target_at).toBe(staleTarget)
      await expect(targetRow).toBeVisible()
      await expect(modal).toBeVisible()
    } finally {
      // Trashed, so no later spec finds them — the backdated one would sit in
      // a task segment on every reminders surface.
      await page.request.post('/api/tasks/bulk/delete', {
        data: { ids: [inboxId, growId, targetId] },
      })
    }
  })
})
