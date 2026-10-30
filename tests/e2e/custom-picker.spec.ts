/**
 * THE CUSTOM PICKER FROM TARGET (Trent, 2026-10-30, on his phone): the
 * selection bar's Target → Custom… says "Set target" (title and button), not
 * "Defer until…"; it opens on the selection's target when every task shares
 * it, else at the Default task time (`customPickerStart`); and under the time
 * it offers the periods in one sideways-scrolling row, the Default task time
 * marked (bold), a tap setting the time and leaving the date (`PeriodChipRow`).
 *
 * The seeded user (`authenticatedPage`), at 375 (no touch: Cmd-click selects).
 * Unique titles; every task trashed in `finally`.
 */
import { DateTime } from 'luxon'
import { test, expect, cmdClickRow, showAllNow, uniqueTitle } from './fixtures'
import type { Page } from '@playwright/test'

const TZ = process.env.E2E_TZ || 'America/Chicago'

async function create(page: Page, target: DateTime): Promise<number> {
  const res = await page.request.post('/api/tasks', {
    data: { title: uniqueTitle('CP task'), due_at: target.toUTC().toISO() },
  })
  expect(res.ok()).toBeTruthy()
  return (await res.json()).data.id as number
}

async function trash(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

/** Select the rows, then the bar's Target → Custom…; the picker dialog. */
async function openCustomFromTarget(page: Page, ids: number[]) {
  await page.goto('/')
  await showAllNow(page)
  for (const id of ids) await cmdClickRow(page.locator(`#task-row-${id}`))
  const bar = page.locator('[data-selection-sheet]')
  await expect(bar).toContainText(`${ids.length} selected`)
  await bar.locator('[data-bar-target]').click()
  await page.getByRole('button', { name: 'Custom...' }).click()
  const dialog = page.getByRole('dialog', { name: 'Set target' })
  await expect(dialog).toBeVisible()
  return dialog
}

test.use({ viewport: { width: 375, height: 812 } })

test('every task shares a target: "Set target", on that target, with the periods', async ({
  authenticatedPage: page,
}) => {
  const at = DateTime.now().setZone(TZ).plus({ days: 2 }).set({ hour: 10, minute: 15 })
  const ids = [await create(page, at), await create(page, at)]
  try {
    const dialog = await openCustomFromTarget(page, ids)
    await expect(dialog.getByRole('button', { name: 'Set target' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Defer', exact: true })).toHaveCount(0)
    await expect(dialog.getByLabel('Hour')).toHaveValue('10')
    await expect(dialog.getByLabel('Minute')).toHaveValue('15')
    await expect(dialog.getByRole('button', { name: /^Toggle AM\/PM, currently AM/ })).toBeVisible()
    // The day: the shared target's.
    await expect(dialog.locator('[aria-selected="true"]').first()).toHaveText(String(at.day))
    // The periods, one row, the Default task time marked.
    const periods = dialog.locator('[data-picker-periods]')
    await expect(periods).toBeVisible()
    await expect(periods.locator('[data-picker-default]')).toHaveCount(1)
    await page.screenshot({
      path: '.tmp/screens/custom-picker-same-375.png',
      animations: 'disabled',
    })
  } finally {
    await trash(page, ids)
  }
})

test('targets differ: the Default task time, the default period pressed; a period sets the time only', async ({
  authenticatedPage: page,
}) => {
  const day = DateTime.now().setZone(TZ).plus({ days: 3 })
  const ids = [
    await create(page, day.set({ hour: 10, minute: 0 })),
    await create(page, day.set({ hour: 14, minute: 0 })),
  ]
  try {
    const prefs = (await (await page.request.get('/api/user/preferences')).json()).data
    const [h, m] = (prefs.morning_time as string).split(':').map(Number)
    const dialog = await openCustomFromTarget(page, ids)
    await expect(dialog.getByLabel('Hour')).toHaveValue(String(((h + 11) % 12) + 1))
    await expect(dialog.getByLabel('Minute')).toHaveValue(String(m).padStart(2, '0'))
    // On the earliest target's day (after tomorrow).
    await expect(dialog.locator('[aria-selected="true"]').first()).toHaveText(String(day.day))
    const periods = dialog.locator('[data-picker-periods]')
    // The default is what the fields say: marked and pressed at once.
    const def = periods.locator('[data-picker-default]')
    await expect(def).toHaveAttribute('aria-pressed', 'true')
    await page.screenshot({
      path: '.tmp/screens/custom-picker-mixed-375.png',
      animations: 'disabled',
    })
    // Another period: the time follows, the day stays.
    const other = periods.locator('[data-picker-period]:not([data-picker-default])').last()
    const start = (await other.getAttribute('data-picker-period'))!
    await other.click()
    const [oh, om] = start.split(':').map(Number)
    await expect(dialog.getByLabel('Hour')).toHaveValue(String(((oh + 11) % 12) + 1))
    await expect(dialog.getByLabel('Minute')).toHaveValue(String(om).padStart(2, '0'))
    await expect(other).toHaveAttribute('aria-pressed', 'true')
    await expect(def).toHaveAttribute('aria-pressed', 'false')
    await expect(dialog.locator('[aria-selected="true"]').first()).toHaveText(String(day.day))
  } finally {
    await trash(page, ids)
  }
})
