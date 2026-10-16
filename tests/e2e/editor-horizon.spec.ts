/**
 * The task editor's horizon (2026-10-15). Trent, on a High one-off with no
 * target: "why can't i set the horizon here?" — the editor showed "Target: No
 * target" AND "Target set: quiet until Oct 15" (the picker's working date, read
 * as a target), and offered no horizon control at all.
 *
 * Now the horizon is a chip beside project and priority (`HorizonPicker`),
 * always offered on a one-off; the "not in effect" note shows only when the
 * task really has a target.
 */
import { test, expect, uniqueTitle, withPreferences } from './fixtures'
import type { Locator, Page } from '@playwright/test'

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  timezoneId: process.env.E2E_TZ || 'America/Chicago',
})

async function createTask(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok()).toBeTruthy()
  return (await res.json()).data.id as number
}

async function stateOf(page: Page, id: number): Promise<Record<string, unknown>> {
  return (await (await page.request.get(`/api/tasks/${id}`)).json()).data
}

/** Tap the row's own padding (not the title link, not the Done circle) to open the sheet. */
async function openEditor(page: Page, id: number): Promise<Locator> {
  await page.goto('/')
  const row = page.locator(`#task-row-${id}`)
  await row.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  const box = await row.boundingBox()
  if (!box) throw new Error('row not on screen')
  await row.tap({ position: { x: 56, y: box.height - 6 } })
  const sheet = page.locator('[data-slot="sheet-content"]')
  await expect(sheet.getByRole('button', { name: 'Save' })).toBeVisible()
  return sheet
}

test.describe('Task editor: the horizon', () => {
  test('a one-off with no target: the horizon chip sets it, and nothing says "quiet until"', async ({
    authenticatedPage: page,
  }) => {
    const id = await createTask(page, {
      title: uniqueTitle('Pick a sport'),
      priority: 3,
      horizon: 'weeks',
    })
    try {
      await withPreferences(page, { default_grouping: 'unified' }, async () => {
        const sheet = await openEditor(page, id)
        await expect(sheet.locator('[data-quick-panel-horizon-quiet]')).toHaveCount(0)
        await expect(sheet).not.toContainText('quiet until')
        const chip = sheet.locator('[data-quick-panel-horizon]')
        await expect(chip).toHaveText(/Weeks/)
        await chip.tap()
        await page.locator('[data-horizon-option="months"]').tap()
        await expect(chip).toHaveText(/Months/)
        await sheet.getByRole('button', { name: 'Save' }).tap()
        await expect.poll(async () => (await stateOf(page, id)).horizon).toBe('months')
      })
    } finally {
      await page.request.delete(`/api/tasks/${id}`)
    }
  })

  test('a one-off with a target: the chip is still offered, and the note says the horizon is not in effect', async ({
    authenticatedPage: page,
  }) => {
    const id = await createTask(page, {
      title: uniqueTitle('Targeted one-off'),
      due_at: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
      horizon: 'days',
    })
    try {
      await withPreferences(page, { default_grouping: 'unified' }, async () => {
        const sheet = await openEditor(page, id)
        await expect(sheet.locator('[data-quick-panel-horizon-quiet]')).toContainText(
          'not in effect',
        )
        const chip = sheet.locator('[data-quick-panel-horizon]')
        await chip.tap()
        await page.locator('[data-horizon-option="eventually"]').tap()
        await sheet.getByRole('button', { name: 'Save' }).tap()
        await expect.poll(async () => (await stateOf(page, id)).horizon).toBe('eventually')
        // The target is untouched.
        expect((await stateOf(page, id)).target_at).not.toBeNull()
      })
    } finally {
      await page.request.delete(`/api/tasks/${id}`)
    }
  })

  test('a recurring task has no horizon chip', async ({ authenticatedPage: page }) => {
    const id = await createTask(page, {
      title: uniqueTitle('Weekly thing'),
      rrule: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0',
    })
    try {
      await withPreferences(page, { default_grouping: 'unified' }, async () => {
        const sheet = await openEditor(page, id)
        await expect(sheet.locator('[data-quick-panel-horizon]')).toHaveCount(0)
      })
    } finally {
      await page.request.delete(`/api/tasks/${id}`)
    }
  })
})
