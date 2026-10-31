/**
 * THE TASKS HEADING (T1, Trent 2026-10-31; `.tmp/tasks-boundary/` t1-mid /
 * t1-land): a hairline and a big "Tasks" where the task list starts — under
 * Quotas on a phone, at the top of the left column on a desktop — the same
 * word in Today, Scan and All. It is where the tasks anchor lands: a fresh
 * load and a re-tap at the top put its hairline right under the top bar.
 *
 * Its own user (`queue@opentask.local`, the switch on), lean rows, dark (the
 * mockups'). A reminder, a quota and a few decked tasks give the page its
 * upper area. Unique titles; every item trashed in `finally`.
 */
import { test, expect, openTaskDay, pickMode, uniqueTitle } from './fixtures'
import type { Page } from '@playwright/test'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('queue@opentask.local')
  await page.getByLabel('Password').fill('testpass123')
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL('/', { timeout: 10_000 })
}

async function create(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), JSON.stringify(data)).toBeTruthy()
  return (await res.json()).data.id as number
}

/** The upper area (a reminder, a quota) and an On deck list. */
async function seed(page: Page): Promise<number[]> {
  const ids = [
    await create(page, {
      title: uniqueTitle('TH thought'),
      is_reminder: true,
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    }),
    await create(page, {
      title: uniqueTitle('TH quota'),
      is_tracked: true,
      progress_target: 3,
      rrule: 'FREQ=WEEKLY',
    }),
  ]
  const decks: number[] = []
  for (let i = 0; i < 6; i++) decks.push(await create(page, { title: uniqueTitle(`TH deck ${i}`) }))
  const today = await openTaskDay(page, 0)
  expect(
    (await page.request.post('/api/tasks/deck', { data: { ids: decks, day: today } })).ok(),
  ).toBe(true)
  return [...ids, ...decks]
}

const heading = (page: Page) => page.locator('[data-tasks-heading]')

/** The heading's hairline (its top edge) sits on the landing line, under the top bar. */
async function onTheLine(page: Page) {
  await expect
    .poll(() =>
      heading(page).evaluate((el) => {
        const list = el.parentElement!
        const line = parseFloat(getComputedStyle(list).scrollMarginTop) || 0
        return Math.abs(el.getBoundingClientRect().top - line) <= 1
      }),
    )
    .toBe(true)
}

test.describe.configure({ mode: 'serial' })
test.use({ colorScheme: 'dark' })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('opentask_task_rows', 'lean')
    window.localStorage.setItem('opentask_dashboard_mode', 'today')
    // Room below, so the heading can rise to its line on a short list.
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style')
      style.textContent = 'body { padding-bottom: 1200px; }'
      document.head.append(style)
    })
  })
  await signIn(page)
  const res = await page.request.post('/api/test/task-queue', { data: { enabled: true } })
  expect(res.ok()).toBeTruthy()
})
test.afterAll(async ({ request }) => {
  await request.post('/api/test/task-queue', { data: { enabled: false } })
})

test.describe('402, one column', () => {
  test.use({ viewport: { width: 402, height: 874 } })

  test('the heading opens the list in every mode; the landing and a re-tap put it under the top bar', async ({
    page,
  }) => {
    const ids = await seed(page)
    try {
      await page.goto('/')
      await expect(heading(page)).toHaveText('Tasks')
      // A fresh load lands on it.
      await onTheLine(page)
      await page.screenshot({
        path: '.tmp/screens/tasks-heading-land-402.png',
        animations: 'disabled',
      })
      // Mid-screen: the boundary under Quotas.
      await heading(page).evaluate((el) =>
        window.scrollTo({
          top: el.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.45,
          behavior: 'instant',
        }),
      )
      await page.screenshot({
        path: '.tmp/screens/tasks-heading-mid-402.png',
        animations: 'disabled',
      })
      // Under Quotas, above the list.
      const quotas = page.locator('[data-track-panel], section[aria-label="Quotas"]').first()
      if (await quotas.count()) {
        expect((await heading(page).boundingBox())!.y).toBeGreaterThan(
          (await quotas.boundingBox())!.y,
        )
      }
      // The re-tap from the top: the heading again.
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
      await page.locator('nav').getByRole('link', { name: 'Dashboard', exact: true }).click()
      await onTheLine(page)
      // The same word in Scan and All.
      for (const mode of ['pick-mode', 'all'] as const) {
        await pickMode(page, mode)
        await expect(heading(page)).toHaveText('Tasks')
      }
    } finally {
      await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
    }
  })
})

test.describe('1600, two columns', () => {
  test.use({ viewport: { width: 1600, height: 900 } })

  test('the heading tops the left column', async ({ page }) => {
    const ids = await seed(page)
    try {
      await page.goto('/')
      await expect(heading(page)).toHaveText('Tasks')
      const h = (await heading(page).boundingBox())!
      const reminders = (await page.locator('[data-reminders-panel]').boundingBox())!
      // Left of the right column's cards.
      expect(h.x + h.width).toBeLessThanOrEqual(reminders.x)
      await page.screenshot({ path: '.tmp/screens/tasks-heading-1600.png', animations: 'disabled' })
    } finally {
      await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
    }
  })
})
