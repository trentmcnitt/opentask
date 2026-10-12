/**
 * A deadline always has a visible target (spec §8, 2026-10-12;
 * docs/TASK-MODEL.md § Deadline):
 *
 * - the row's snooze menu offers "Deadline day" (ruling Q8) and, on a picked
 *   target with a deadline, "Back to auto" — never "Remove target";
 * - every move stops AT the deadline, and the toast says so;
 * - the editor labels a stored automatic target "auto", and its … menu puts a
 *   picked one back to auto.
 *
 * Isolation: every task is created here under a unique title and deleted in
 * `finally`; the dashboard grouping is put back by `withPreferences`.
 */
import { DateTime } from 'luxon'
import { test, expect, holdUntil, uniqueTitle, withPreferences } from './fixtures'
import type { Locator, Page } from '@playwright/test'

const TZ = process.env.E2E_TZ || 'America/Chicago'
const MIN = 60_000
const DAY = 24 * 60 * MIN

async function create(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), `create ${JSON.stringify(data)}`).toBeTruthy()
  return (await res.json()).data.id as number
}

async function stateOf(page: Page, id: number): Promise<Record<string, unknown>> {
  return (await (await page.request.get(`/api/tasks/${id}`)).json()).data as Record<string, unknown>
}

async function remove(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

const localDay = (iso: unknown) => DateTime.fromISO(String(iso)).setZone(TZ).toISODate()

/** The row's snooze button, hovered into view. */
async function snoozeButton(page: Page, id: number, title: string): Promise<Locator> {
  const row = page.locator(`#task-row-${id}`)
  await expect(row).toBeVisible({ timeout: 10_000 })
  await row.hover()
  const btn = row.getByRole('button', { name: new RegExp(`snooze "${title}"`, 'i') })
  await expect(btn).toBeVisible()
  return btn
}

test.describe('Deadline: the snooze menu', () => {
  test('"Deadline day" moves the target to the deadline\'s morning; a picked target offers Back to auto, not Remove target', async ({
    authenticatedPage: page,
  }) => {
    const title = uniqueTitle('TM8 deadline day')
    const deadline = DateTime.now().setZone(TZ).plus({ days: 3 }).set({ hour: 17, minute: 0 })
    const id = await create(page, {
      title,
      target_at: DateTime.now().setZone(TZ).plus({ days: 1 }).set({ hour: 10 }).toUTC().toISO(),
      deadline_at: deadline.toUTC().toISO(),
    })
    try {
      await withPreferences(page, { default_grouping: 'unified' }, async () => {
        await page.goto('/')
        // Not over target, so a tap opens the menu.
        await (await snoozeButton(page, id, title)).click()
        const menu = page.getByRole('menu', { name: 'Snooze options' })
        await expect(menu).toBeVisible()
        await expect(menu.getByRole('menuitem', { name: 'Back to auto' })).toBeVisible()
        await expect(menu.getByRole('menuitem', { name: 'Remove target' })).toHaveCount(0)
        await menu.getByRole('menuitem', { name: /^Deadline day · / }).click()
        await expect
          .poll(async () => localDay((await stateOf(page, id)).target_at))
          .toBe(deadline.toISODate())
        const after = await stateOf(page, id)
        expect(Date.parse(String(after.target_at))).toBeLessThanOrEqual(
          Date.parse(String(after.deadline_at)),
        )
        expect(after.target_auto).toBe(false)
      })
    } finally {
      await remove(page, [id])
    }
  })

  test('a snooze past the deadline stops AT it, and the toast says so', async ({
    authenticatedPage: page,
  }) => {
    const title = uniqueTitle('TM8 capped')
    const deadline = new Date(Date.now() + 30 * MIN).toISOString()
    const id = await create(page, {
      title,
      target_at: new Date(Date.now() - 60 * MIN).toISOString(),
      deadline_at: deadline,
    })
    try {
      await withPreferences(page, { default_grouping: 'unified' }, async () => {
        await page.goto('/')
        // Over target: a tap would snooze at once, so hold for the menu.
        const btn = await snoozeButton(page, id, title)
        const menu = page.getByRole('menu', { name: 'Snooze options' })
        await holdUntil(btn, () => expect(menu).toBeVisible())
        await menu.getByRole('menuitem', { name: '1 hour', exact: true }).click()
        await expect(page.locator('[data-sonner-toast]').first()).toContainText(
          'Snoozed to deadline',
        )
        await expect
          .poll(async () => Date.parse(String((await stateOf(page, id)).target_at)))
          .toBe(Date.parse(deadline))
      })
    } finally {
      await remove(page, [id])
    }
  })
})

test.describe('Deadline: the editor', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

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

  test('an automatic target is labelled "auto" and offers no reset; Back to auto puts a picked one back', async ({
    authenticatedPage: page,
  }) => {
    const deadline = new Date(Date.now() + 20 * DAY).toISOString()
    const auto = await create(page, { title: uniqueTitle('TM8 auto'), deadline_at: deadline })
    const picked = await create(page, {
      title: uniqueTitle('TM8 picked'),
      target_at: DateTime.now().setZone(TZ).plus({ days: 2 }).set({ hour: 10 }).toUTC().toISO(),
      deadline_at: deadline,
    })
    try {
      expect((await stateOf(page, auto)).target_auto).toBe(true)
      await withPreferences(page, { default_grouping: 'unified' }, async () => {
        // The automatic target: "auto", the lead, and nothing to reset.
        let sheet = await openEditor(page, auto)
        const autoLine = sheet.locator('[data-quick-panel-date]')
        await expect(autoLine.locator('[data-quick-panel-auto-target]')).toHaveText('auto')
        await expect(autoLine).toContainText('(4 days before deadline)')
        await sheet.getByRole('button', { name: 'More options' }).tap()
        await expect(page.locator('[data-target-reset]')).toHaveCount(0)
        await page.keyboard.press('Escape')
        await page.keyboard.press('Escape')

        // A picked target: … → Back to auto → the line previews "auto" → Save.
        sheet = await openEditor(page, picked)
        const line = sheet.locator('[data-quick-panel-date]')
        await expect(line.locator('[data-quick-panel-auto-target]')).toHaveCount(0)
        await sheet.getByRole('button', { name: 'More options' }).tap()
        const reset = page.locator('[data-target-reset="auto"]')
        await expect(reset).toHaveText('Back to auto')
        await reset.tap()
        await expect(line.locator('[data-quick-panel-auto-target]')).toHaveText('auto')
        await sheet.getByRole('button', { name: 'Save' }).tap()
        await expect.poll(async () => (await stateOf(page, picked)).target_auto).toBe(true)
        const after = await stateOf(page, picked)
        expect(Date.parse(String(after.target_at))).toBeLessThan(Date.parse(deadline))
      })
    } finally {
      await remove(page, [auto, picked])
    }
  })
})
