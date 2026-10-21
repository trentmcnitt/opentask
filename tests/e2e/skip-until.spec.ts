/**
 * Skip until on the web (task queue PR 4; spec rule 10): the Quick panel's
 * More menu for one repeating task, and the selection sheet's button for
 * several — "Skip this occurrence" by default, or a day from the calendar.
 * Every test reads the task back over the API, and Undo in the toast puts it
 * back.
 *
 * Isolation: unique titles, every task trashed in `finally`, the Unified view
 * (`withPreferences`) so a row due tomorrow is on the page. Time-agnostic:
 * every task repeats daily at 9:00 starting tomorrow, so its occurrences are
 * all ahead at any hour; the browser runs in the user's zone, since the
 * calendar's days are the browser's dates.
 */

import { DateTime } from 'luxon'
import {
  test,
  expect,
  uniqueTitle,
  waitForPrefsLoaded,
  withPreferences,
  cmdClickRow,
} from './fixtures'
import type { Page } from '@playwright/test'

const TEST_TZ = process.env.E2E_TZ || 'America/Chicago'
const unified = { default_grouping: 'unified' }

/** Local 9:00 `days` from today, as the UTC ISO the API returns. */
function nineAm(days: number): string {
  return DateTime.now()
    .setZone(TEST_TZ)
    .plus({ days })
    .set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()!
}

async function createTask(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), `create ${JSON.stringify(data)}`).toBeTruthy()
  return (await res.json()).data.id as number
}

async function daily(page: Page, base: string): Promise<number> {
  return createTask(page, {
    title: uniqueTitle(base),
    rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    due_at: nineAm(1),
    priority: 1,
  })
}

async function stateOf(page: Page, id: number) {
  return (await (await page.request.get(`/api/tasks/${id}`)).json()).data as {
    target_at: string | null
    occurrence_at: string | null
    skip_count: number | null
  }
}

async function trash(page: Page, ids: number[]): Promise<void> {
  if (ids.length > 0) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

const row = (page: Page, id: number) => page.locator(`#task-row-${id}`)
const skipDialog = (page: Page) => page.locator('[data-skip-until-dialog]')
const isSkip = (r: { url(): string; request(): { method(): string } }) =>
  r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/tasks/bulk/skip-until'
const toastUndo = (page: Page, text: string | RegExp) =>
  page.locator('[data-sonner-toast]', { hasText: text }).getByRole('button', { name: 'Undo' })

/** Double-click a row's own padding (not the title link, not the Done circle): the Quick panel. */
async function openQuickPanel(page: Page, id: number) {
  await waitForPrefsLoaded(page, () => page.goto('/'), row(page, id))
  await row(page, id).evaluate((el) => el.scrollIntoView({ block: 'center' }))
  const box = await row(page, id).boundingBox()
  if (!box) throw new Error('row not on screen')
  await row(page, id).dblclick({ position: { x: 56, y: box.height - 6 } })
  const panel = page.getByRole('dialog', { name: 'Quick Actions' })
  await expect(panel.getByRole('button', { name: 'Save' })).toBeVisible()
  return panel
}

/** Pick `days` from today in the skip picker's calendar (stepping a month on if needed). */
async function pickDay(page: Page, days: number) {
  const target = DateTime.now().setZone(TEST_TZ).plus({ days })
  const key = await page.evaluate(
    ([y, m, d]) => new Date(y, m - 1, d).toLocaleDateString(),
    [target.year, target.month, target.day],
  )
  const day = skipDialog(page).locator(`button[data-day="${key}"]`).first()
  if ((await day.count()) === 0) {
    await skipDialog(page)
      .getByRole('button', { name: /next month/i })
      .click()
  }
  await day.click()
  return target
}

test.describe('Skip until', () => {
  test.use({ timezoneId: TEST_TZ })

  test('details: "Skip this occurrence" skips one, and Undo puts it back', async ({
    authenticatedPage: page,
  }) => {
    const id = await daily(page, 'Skip one')
    try {
      await withPreferences(page, unified, async () => {
        const panel = await openQuickPanel(page, id)
        await panel.getByRole('button', { name: 'More options' }).click()
        await page.getByRole('menuitem', { name: 'Skip until…' }).click()
        await expect(skipDialog(page)).toBeVisible()

        // Cancel leaves the Quick panel usable (a layer opened from a menu
        // item must not leave the page unclickable), and nothing was sent.
        await skipDialog(page).getByRole('button', { name: 'Cancel' }).click()
        await expect(skipDialog(page)).toHaveCount(0)
        await panel.getByRole('button', { name: 'More options' }).click()
        await page.getByRole('menuitem', { name: 'Skip until…' }).click()
        await expect(skipDialog(page)).toBeVisible()
        expect((await stateOf(page, id)).skip_count ?? 0).toBe(0)

        const sent = page.waitForResponse(isSkip)
        await skipDialog(page).getByRole('button', { name: 'Skip this occurrence' }).click()
        const res = await sent
        expect(res.ok()).toBeTruthy()
        expect(res.request().postDataJSON()).toEqual({ ids: [id] })
        await expect(skipDialog(page)).toHaveCount(0)
        await expect(panel).toHaveCount(0)
        const after = await stateOf(page, id)
        expect(after.target_at).toBe(nineAm(2))
        expect(after.skip_count).toBe(1)

        const undone = page.waitForResponse('**/api/undo')
        await toastUndo(page, /Skipped/).click()
        expect((await undone).ok()).toBeTruthy()
        expect((await stateOf(page, id)).target_at).toBe(nineAm(1))
      })
    } finally {
      await trash(page, [id])
    }
  })

  test('details: a day skips every occurrence before it', async ({ authenticatedPage: page }) => {
    const id = await daily(page, 'Skip vacation')
    try {
      await withPreferences(page, unified, async () => {
        const panel = await openQuickPanel(page, id)
        await panel.getByRole('button', { name: 'More options' }).click()
        await page.getByRole('menuitem', { name: 'Skip until…' }).click()

        const target = await pickDay(page, 6)
        const submit = skipDialog(page).locator('[data-skip-until-submit]')
        await expect(submit).toHaveText(`Skip until ${target.toFormat('ccc, LLL d')}`)
        const sent = page.waitForResponse(isSkip)
        await submit.click()
        const res = await sent
        expect(res.request().postDataJSON()).toEqual({
          ids: [id],
          until: target.toFormat('yyyy-MM-dd'),
        })
        // Days 1 to 5 skipped; it lands on day 6.
        const after = await stateOf(page, id)
        expect(after.target_at).toBe(nineAm(6))
        expect(after.skip_count).toBe(5)
        await expect(
          page.locator('[data-sonner-toast]', { hasText: 'Skipped 5 occurrences' }),
        ).toBeVisible()
      })
    } finally {
      await trash(page, [id])
    }
  })

  test('multi-select: skips the repeating tasks, says how many were not, one Undo', async ({
    authenticatedPage: page,
  }) => {
    const a = await daily(page, 'Skip sel A')
    const b = await daily(page, 'Skip sel B')
    const oneOff = await createTask(page, {
      title: uniqueTitle('Skip sel one-off'),
      due_at: nineAm(1),
      priority: 1,
    })
    try {
      await withPreferences(page, unified, async () => {
        await waitForPrefsLoaded(page, () => page.goto('/'), row(page, a))
        for (const id of [a, b, oneOff]) {
          await cmdClickRow(row(page, id))
          await expect(row(page, id)).toHaveAttribute('aria-selected', 'true')
        }
        await page
          .locator('[data-selection-sheet]')
          .getByRole('button', { name: 'More', exact: true })
          .click()
        const sheet = page.getByRole('dialog', { name: '3 tasks selected' })
        // Two of the three repeat: the button says so.
        await sheet.locator('[data-bulk-skip-until]').click()
        await expect(skipDialog(page)).toContainText('2 repeating tasks · 1 other task left as is')

        const target = await pickDay(page, 4)
        const sent = page.waitForResponse(isSkip)
        await skipDialog(page).locator('[data-skip-until-submit]').click()
        const res = await sent
        const body = res.request().postDataJSON()
        // The whole selection goes; the server skips the repeating ones and counts the rest.
        expect([...body.ids].sort()).toEqual([a, b, oneOff].sort())
        expect(body.until).toBe(target.toFormat('yyyy-MM-dd'))
        await expect(sheet).toHaveCount(0)
        for (const id of [a, b]) expect((await stateOf(page, id)).target_at).toBe(nineAm(4))
        expect((await stateOf(page, oneOff)).target_at).toBe(nineAm(1))

        // The page still answers clicks: the sheet unmounted under an open
        // picker, and a Radix layer left behind would leave `pointer-events:
        // none` on the body. A row click selects it again.
        await expect(page.locator('[data-selection-sheet]')).toHaveCount(0)
        expect(await page.evaluate(() => getComputedStyle(document.body).pointerEvents)).not.toBe(
          'none',
        )
        await cmdClickRow(row(page, oneOff))
        await expect(row(page, oneOff)).toHaveAttribute('aria-selected', 'true')
        // One task selected: the bar offers Details.
        await expect(
          page.locator('[data-selection-sheet]').getByRole('button', { name: 'Details' }),
        ).toBeVisible()
        await page.locator('[data-selection-sheet]').getByRole('button', { name: /clear/i }).click()
        await expect(page.locator('[data-selection-sheet]')).toHaveCount(0)

        const undone = page.waitForResponse('**/api/undo')
        await expect(
          page.locator('[data-sonner-toast]', {
            hasText: /Skipped 2 tasks until .+ · 1 not repeating/,
          }),
        ).toBeVisible()
        await toastUndo(page, /Skipped 2 tasks until/).click()
        expect((await undone).ok()).toBeTruthy()
        for (const id of [a, b]) expect((await stateOf(page, id)).target_at).toBe(nineAm(1))
      })
    } finally {
      await trash(page, [a, b, oneOff])
    }
  })
})
