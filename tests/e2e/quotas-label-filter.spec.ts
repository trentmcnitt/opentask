/**
 * The Quotas page's label filter (2026-10-24): the dashboard's label chips,
 * one row under the page's header row. Selected labels are OR'd; the filter
 * narrows the period sections (a period with nothing left is gone), their
 * "N of M", and the met-of-total header; a "Showing N of M quotas · Clear
 * filter" line says the view is filtered; the selection is kept across a
 * reload (localStorage). See `QuotasSummary` and `TrackPanel`'s "THE LABEL
 * FILTER".
 *
 * Every quota here wears run-unique labels, so the rest of the E2E database
 * (other specs' quotas) is filtered away by the very filter under test.
 */
import { test, expect } from './fixtures'
import type { Locator, Page } from '@playwright/test'

const STORAGE_KEY = 'opentask.quotasLabelFilter'
const made: number[] = []

test.afterEach(async ({ authenticatedPage: page }) => {
  for (const id of made.splice(0)) await page.request.delete(`/api/tasks/${id}`)
  // The kept filter must not leak into the next test's /quotas.
  await page.evaluate((key) => window.localStorage.removeItem(key), STORAGE_KEY)
})

/** A label chip's number (its label text holds digits too: the run tag). */
const countOf = (chip: Locator) => chip.locator('span').nth(1)

async function createQuota(page: Page, body: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', {
    data: { is_tracked: true, create_label: true, ...body },
  })
  expect(res.ok(), await res.text()).toBeTruthy()
  const id = (await res.json()).data.id as number
  made.push(id)
  return id
}

/**
 * Two weekly quotas on label `a` (one already met, so it is put away) and one
 * monthly quota on label `b`.
 */
async function seed(page: Page) {
  const tag = `lf${Date.now()}`
  const a = `${tag}-a`
  const b = `${tag}-b`
  const walk = await createQuota(page, {
    title: `${tag} walk`,
    progress_target: 2,
    rrule: 'FREQ=WEEKLY',
    labels: [a],
  })
  const water = await createQuota(page, {
    title: `${tag} water`,
    progress_target: 1,
    rrule: 'FREQ=WEEKLY',
    labels: [a],
  })
  expect(
    (await page.request.post(`/api/tasks/${water}/progress`, { data: { delta: 1 } })).ok(),
  ).toBeTruthy()
  const music = await createQuota(page, {
    title: `${tag} music`,
    progress_target: 3,
    rrule: 'FREQ=MONTHLY',
    labels: [b],
  })

  await page.goto('/quotas')
  // Start unfiltered whatever an earlier run left behind.
  await page.evaluate((key) => window.localStorage.removeItem(key), STORAGE_KEY)
  await page.reload()

  const panel = page.getByRole('region', { name: 'Quotas' })
  const chips = page.locator('[data-quota-label-filter]')
  await expect(panel.locator(`[data-track-chip="${walk}"]`)).toBeVisible()
  const total = Number((await page.locator('h1').innerText()).match(/\d+/)![0])
  return { tag, a, b, walk, water, music, panel, chips, total }
}

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  test.describe(`Quotas page — label filter at ${viewport.width}`, () => {
    test.beforeEach(async ({ authenticatedPage: page }) => {
      await page.setViewportSize(viewport)
    })

    test('a label narrows the periods and their counts, says so, and survives a reload', async ({
      authenticatedPage: page,
    }) => {
      const { a, b, walk, music, panel, chips, total } = await seed(page)
      const chipA = chips.locator(`[data-label-chip="${a}"]`)
      const chipB = chips.locator(`[data-label-chip="${b}"]`)
      const filterLine = page.locator('[data-quota-filter-count]')

      // Unfiltered: the chips count quotas per label; no "Showing" line.
      await expect(countOf(chipA)).toHaveText('2')
      await expect(countOf(chipB)).toHaveText('1')
      await expect(filterLine).toHaveCount(0)

      // Select `a`: only the week is left, counted over a's two quotas.
      await chipA.click()
      await expect(chipA).toHaveAttribute('data-chip-state', 'included')
      await expect(panel.locator('[data-quota-period]')).toHaveCount(1)
      const week = panel.locator('[data-quota-period="WEEKLY"]')
      await expect(week.locator('[data-track-period-count]')).toHaveText('1 of 2')
      await expect(panel.locator('[data-track-overall]')).toHaveAttribute(
        'data-track-overall',
        '1 of 2',
      )
      await expect(panel.locator(`[data-track-chip="${walk}"]`)).toBeVisible()
      await expect(panel.locator(`[data-track-chip="${music}"]`)).toHaveCount(0)
      await expect(filterLine).toHaveAttribute('data-quota-filter-count', '2')
      await expect(filterLine).toContainText(`Showing 2 of ${total} quotas`)
      // The other chips keep counting the whole page, not a's slice.
      await expect(countOf(chipB)).toHaveText('1')

      // Add `b`: OR — both periods, every quota of either label.
      await chipB.click()
      await expect(chipB).toHaveAttribute('data-chip-state', 'included')
      await expect(panel.locator('[data-quota-period]')).toHaveCount(2)
      await expect(panel.locator(`[data-track-chip="${music}"]`)).toBeVisible()
      await expect(filterLine).toHaveAttribute('data-quota-filter-count', '3')
      await expect(panel.locator('[data-track-overall]')).toHaveAttribute(
        'data-track-overall',
        '1 of 3',
      )

      // Kept across a reload.
      await page.reload()
      await expect(chipA).toHaveAttribute('data-chip-state', 'included')
      await expect(chipB).toHaveAttribute('data-chip-state', 'included')
      await expect(filterLine).toHaveAttribute('data-quota-filter-count', '3')
      await expect(panel.locator('[data-quota-period]')).toHaveCount(2)

      // Clear filter: the whole page again, and nothing kept.
      await filterLine.getByRole('button', { name: 'Clear filter' }).click()
      await expect(filterLine).toHaveCount(0)
      await expect(chipA).toHaveAttribute('data-chip-state', 'unselected')
      await expect(panel.locator(`[data-track-chip="${walk}"]`)).toBeVisible()
      await expect
        .poll(() => page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY))
        .toBeNull()
    })
  })
}

test.describe('Quotas page — label filter with search', () => {
  test('search and the label filter narrow together; the chips count the search results', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    const { tag, a, b, walk, water, music, panel, chips } = await seed(page)
    const chipA = chips.locator(`[data-label-chip="${a}"]`)
    const filterLine = page.locator('[data-quota-filter-count]')

    await chipA.click()
    await expect(filterLine).toHaveAttribute('data-quota-filter-count', '2')

    const field = page.getByRole('textbox', { name: 'Search quotas' })
    await field.fill(`${tag} wa`)
    // The search lets walk and water through; b's chip has nothing to count.
    await expect(page.locator('[data-search-count]')).toHaveAttribute('data-search-count', '2')
    await expect(chips.locator(`[data-label-chip="${b}"]`)).toHaveCount(0)
    await expect(countOf(chipA)).toHaveText('2')
    await expect(filterLine).toContainText('Showing 2 of 2 quotas')
    // A search shows met results, so water is on screen too.
    await expect(panel.locator(`[data-track-chip="${walk}"]`)).toBeVisible()
    await expect(panel.locator(`[data-track-chip="${water}"]`)).toBeVisible()

    // A search for b's quota under a's filter: the search found one, the
    // filter lets none of it through.
    await field.fill(`${tag} music`)
    await expect(page.locator('[data-search-count]')).toHaveAttribute('data-search-count', '1')
    await expect(filterLine).toContainText('Showing 0 of 1 quota')
    await expect(panel.locator(`[data-track-chip="${music}"]`)).toHaveCount(0)

    await page.getByRole('button', { name: 'Clear search' }).click()
    await expect(filterLine).toHaveAttribute('data-quota-filter-count', '2')
  })
})
