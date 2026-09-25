/**
 * Quota reminders on the Reminders surface (2026-09-24)
 *
 * An unmet quota also shows up as a prompt in a reminder period. The
 * behavioral suite (qp-prompts.test.ts) pins which prompts a day has; these
 * tests cover what only a browser shows: the row, its two actions (the circle
 * considers, the square checkbox logs one), the Undo, the quota editor's
 * "Remind me daily" switch, and the Settings switch.
 *
 * Time-agnostic: prompts render in every slot, started or not (a slot ahead
 * in the day still lists its prompts), so nothing here depends on the clock.
 * Every quota made here is trashed again afterwards, and the Settings switch
 * is put back, so other specs' counts are untouched.
 */

import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

const created: number[] = []

async function makeQuota(page: Page, title: string, rrule = 'FREQ=WEEKLY', target = 3) {
  const res = await page.request.post('/api/tasks', {
    data: { title, rrule, progress_target: target, is_tracked: true },
  })
  expect(res.ok()).toBeTruthy()
  const id = (await res.json()).data.id as number
  created.push(id)
  return id
}

async function progressOf(page: Page, id: number): Promise<number> {
  const res = await page.request.get(`/api/tasks/${id}`)
  return (await res.json()).data.progress_current as number
}

function promptRow(page: Page, title: string) {
  return page.locator('li[data-prompt-key]', { hasText: title })
}

test.describe('Quota prompts', () => {
  test.afterEach(async ({ authenticatedPage: page }) => {
    if (created.length > 0) {
      await page.request.post('/api/tasks/bulk/delete', { data: { ids: [...created] } })
      created.length = 0
    }
    await page.request.patch('/api/user/preferences', { data: { quota_prompts_enabled: true } })
  })

  test('the circle considers a prompt without logging, and the header Undo brings it back', async ({
    authenticatedPage: page,
  }) => {
    const id = await makeQuota(page, 'E2E prompt consider')
    await page.goto('/reminders')
    const row = promptRow(page, 'E2E prompt consider')
    await expect(row).toBeVisible()
    await expect(row).toContainText('0/3')

    await row.locator('[data-prompt-consider]').click()
    await expect(row).toHaveCount(0)
    expect(await progressOf(page, id)).toBe(0)

    const undone = page.waitForResponse((r) => r.url().includes('/api/undo'))
    await page.getByRole('banner').getByRole('button', { name: /^Undo/ }).click()
    await undone
    await expect(promptRow(page, 'E2E prompt consider')).toBeVisible()
  })

  test('the square checkbox logs one, and the toast Undo takes it back', async ({
    authenticatedPage: page,
  }) => {
    const id = await makeQuota(page, 'E2E prompt did')
    await page.goto('/reminders')
    const row = promptRow(page, 'E2E prompt did')
    await expect(row).toBeVisible()

    const did = page.waitForResponse((r) => r.url().includes('/api/quota-prompts/did'))
    await row.locator('[data-prompt-did]').click()
    expect((await did).ok()).toBeTruthy()
    await expect(row).toHaveCount(0)
    expect(await progressOf(page, id)).toBe(1)

    const undone = page.waitForResponse((r) => r.url().includes('/api/undo'))
    await page.locator('[data-sonner-toast]').getByRole('button', { name: 'Undo' }).click()
    await undone
    await expect(promptRow(page, 'E2E prompt did')).toBeVisible()
    await expect(promptRow(page, 'E2E prompt did')).toContainText('0/3')
    expect(await progressOf(page, id)).toBe(0)
  })

  test('a prompt is not selectable; its hold opens the quota, whose switch turns it off', async ({
    authenticatedPage: page,
  }) => {
    await makeQuota(page, 'E2E prompt editor')
    await page.goto('/reminders')
    const row = promptRow(page, 'E2E prompt editor')
    await expect(row).toBeVisible()

    // Press and hold: the quota's bubble, never a selection bar.
    const box = (await row.boundingBox())!
    await page.mouse.move(box.x + 120, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForSelector('[data-track-popover]')
    await page.mouse.up()
    await expect(page.getByRole('button', { name: /move .* to trash/i })).toHaveCount(1)
    await page.locator('[data-track-popover]').getByRole('button', { name: 'Open' }).click()

    const field = page.locator('[data-quota-prompt-field]')
    await expect(field).toBeVisible()
    await field.locator('[data-quota-prompt-enabled]').click()
    const saved = page.waitForResponse(
      (r) => r.request().method() === 'PATCH' && /\/api\/tasks\/\d+$/.test(r.url()),
    )
    await page.getByRole('button', { name: 'Save' }).click()
    const body = await (await saved).json()
    expect(body.data.quota_prompt_config).toEqual({ enabled: false })
    await expect(promptRow(page, 'E2E prompt editor')).toHaveCount(0)
  })

  test('Settings: the quota reminders switch hides every prompt', async ({
    authenticatedPage: page,
  }) => {
    await makeQuota(page, 'E2E prompt settings')
    await page.goto('/settings')
    const toggle = page.locator('[data-quota-prompts-switch]')
    await expect(toggle).toBeVisible()
    await expect(page.locator('[data-quota-prompt-slot]')).toBeVisible()
    const saved = page.waitForResponse((r) => r.url().includes('/api/user/preferences'))
    await toggle.click()
    await saved
    await expect(page.locator('[data-quota-prompt-slot]')).toHaveCount(0)

    await page.goto('/reminders')
    await expect(
      page.locator('[data-reminders-headline], section[aria-label="Reminders"]').first(),
    ).toBeVisible()
    await expect(promptRow(page, 'E2E prompt settings')).toHaveCount(0)
  })
})
