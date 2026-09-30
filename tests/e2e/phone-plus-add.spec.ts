/**
 * The phone tab bar's `+` (2026-09-30): on the dashboard it scrolls to the top
 * and focuses the add field there (the same field desktop uses, with its mic
 * and AI chip), so the keyboard comes up on it. It used to open a separate
 * quick-add sheet. From another page it goes to the dashboard and focuses the
 * field on arrival.
 *
 * Headless Chromium can prove the field is focused and on screen below the
 * top bar; whether iOS raises the keyboard depends on the focus() running
 * inside the tap, which only a device shows.
 */
import { test, expect, uniqueTitle } from './fixtures'
import type { Page } from '@playwright/test'
import { DateTime } from 'luxon'

/** Must track `globalSetup.ts`'s `E2E_TZ` override — see dashboard.spec.ts. */
const TEST_TZ = process.env.E2E_TZ || 'America/Chicago'
const VIEWPORT = { width: 375, height: 812 }
const VIEWS = [
  { grouping: 'time', label: 'All' },
  { grouping: 'slot', label: 'Today' },
  { grouping: 'new', label: 'Newest' },
] as const

const addField = (page: Page) => page.getByRole('textbox', { name: 'Quick add task' })
// Exact match: "Open full add form" also contains "add".
const plusTab = (page: Page) => page.getByRole('button', { name: 'Add', exact: true })

async function post(page: Page, url: string, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post(url, { data })
  expect(res.ok(), `POST ${url}`).toBeTruthy()
  return (await res.json()).data.id as number
}

async function setGrouping(page: Page, grouping: string) {
  const res = await page.request.patch('/api/user/preferences', {
    data: { default_grouping: grouping },
  })
  expect(res.ok()).toBeTruthy()
}

/** The field is focused, in the viewport, and not under the sticky top bar. */
async function expectFieldFocusedBelowHeader(page: Page) {
  const field = addField(page)
  await expect(field).toBeFocused()
  await expect(field).toBeInViewport()
  const header = (await page.locator('header').first().boundingBox())!
  const box = (await field.boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(header.y + header.height)
}

test.describe('Phone + focuses the dashboard add field', () => {
  test.use({ viewport: VIEWPORT })
  const taskIds: number[] = []
  let grouping = 'time'

  // Enough rows (every one due today, so they show in Today too) that the
  // page scrolls in every view, and the `+` has something to scroll back from.
  test.beforeEach(async ({ authenticatedPage: page }) => {
    grouping = (await (await page.request.get('/api/user/preferences')).json()).data
      .default_grouping as string
    const startOfToday = DateTime.now().setZone(TEST_TZ).startOf('day')
    taskIds.length = 0
    for (let i = 0; i < 20; i++) {
      taskIds.push(
        await post(page, '/api/tasks', {
          title: uniqueTitle(`Plus row ${i}`),
          due_at: startOfToday.toUTC().toISO(),
        }),
      )
    }
  })

  test.afterEach(async ({ authenticatedPage: page }) => {
    if (taskIds.length > 0) {
      await page.request.post('/api/tasks/bulk/delete', { data: { ids: taskIds.splice(0) } })
    }
    await setGrouping(page, grouping)
  })

  for (const view of VIEWS) {
    test(`${view.label}: scrolled down, + scrolls to the top and focuses the field`, async ({
      authenticatedPage: page,
    }) => {
      await setGrouping(page, view.grouping)
      await page.reload()
      await expect(
        page
          .getByRole('group', { name: 'View mode' })
          .getByRole('button', { name: view.label, exact: true }),
      ).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('[data-task-group]').first()).toBeVisible()

      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)
      await expect(addField(page)).not.toBeInViewport()

      await plusTab(page).click()

      expect(await page.evaluate(() => window.scrollY)).toBe(0)
      await expectFieldFocusedBelowHeader(page)
      // No sheet of its own any more.
      await expect(page.getByRole('dialog')).toHaveCount(0)
    })
  }

  test('what is typed after + adds through the top field', async ({ authenticatedPage: page }) => {
    await page.reload()
    await expect(page.locator('[data-task-group]').first()).toBeVisible()
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await plusTab(page).click()
    await expect(addField(page)).toBeFocused()

    const title = uniqueTitle('E2E plus add')
    await page.keyboard.type(title)
    await page.keyboard.press('Enter')

    await expect(page.locator('[data-just-added-card]').getByText(title)).toBeVisible({
      timeout: 5000,
    })
    await expect(page.getByRole('link', { name: title })).toBeVisible({ timeout: 5000 })
    const res = await page.request.get(`/api/tasks?search=${encodeURIComponent(title)}`)
    const created = ((await res.json()).data.tasks as { id: number; title: string }[]).find(
      (t) => t.title === title,
    )
    if (created) taskIds.push(created.id)
  })

  test('from another page, + goes to the dashboard and focuses the field', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/history')
    await plusTab(page).click()
    await page.waitForURL('/')
    await expectFieldFocusedBelowHeader(page)
    // The one-shot `?action=quick-add` is gone from the address bar.
    expect(new URL(page.url()).search).toBe('')
  })
})
