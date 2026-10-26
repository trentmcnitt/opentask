/**
 * The Settings layout after the 2026-10-24 cleanup (Trent: "Why is this all
 * listed under defer?" and "Roll over now… seems dangerous"):
 *
 * - Your day, Reminder periods, Number pad and Defer, in that order, each
 *   holding only its own rows (Defer: Default defer and the Defer all button);
 * - Advanced, the last section, a fold that is closed on every visit and
 *   holds Roll over now; hidden entirely with the task queue off.
 * - Your day's "Day starts at" row, likewise only with the task queue on
 *   (with it off the day turns at midnight).
 *
 * Checked at desktop (1280) and phone (375) widths. The task queue is a
 * server-wide switch, so the queue's own user (`queue@opentask.local`, as
 * tq-run-now.spec.ts) is signed in and the switch is turned off after each
 * test. Nothing here runs a rollover — the fold is opened, never confirmed.
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('queue@opentask.local')
  await page.getByLabel('Password').fill('testpass123')
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL('/', { timeout: 10_000 })
}

async function setQueue(page: Page, enabled: boolean) {
  const res = await page.request.post('/api/test/task-queue', { data: { enabled } })
  expect(res.ok()).toBeTruthy()
}

function section(page: Page, title: string) {
  return page
    .locator('main section')
    .filter({ has: page.getByRole('heading', { level: 2, name: title, exact: true }) })
}

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone', width: 375, height: 812 },
]

test.describe.configure({ mode: 'serial' })

test.afterEach(async ({ page }) => {
  await setQueue(page, false)
})

for (const vp of VIEWPORTS) {
  test(`Settings sections and the Advanced fold at ${vp.width} (${vp.name})`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height })
    await signIn(page)
    await setQueue(page, true)
    await page.goto('/settings')

    const headings = page.locator('main').getByRole('heading', { level: 2 })
    await expect(headings).toHaveText([
      'Account',
      'Theme',
      'Help',
      'Priority Display',
      'Notifications',
      'Your day',
      'Reminder periods',
      'Number pad',
      'Defer',
      'Labels',
      'Projects',
      'API Tokens',
      'More',
      'About',
      'Advanced',
    ])

    // Your day: its four time rows in order, then the week's two selects.
    const day = section(page, 'Your day')
    await expect(day.locator('[data-anchor-row]')).toHaveCount(4)
    const rows = await day
      .locator('[data-anchor-row]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-anchor-row')))
    expect(rows).toEqual(['day_start', 'wake', 'morning', 'sleep'])
    await expect(day.getByLabel('Day starts at: follows')).toBeVisible()
    await expect(day.getByText('Default task time', { exact: true })).toBeVisible()
    await expect(day.getByLabel('Week starts on')).toBeVisible()
    await expect(day.getByLabel('Check-in day')).toBeVisible()

    // Reminder periods keeps the default reminder period and quota reminders.
    const periods = section(page, 'Reminder periods')
    await expect(periods.getByLabel('Default reminder period')).toBeVisible()
    await expect(periods.getByLabel('Quota reminders')).toBeVisible()

    // Number pad: the four buttons, nothing else with a time.
    await expect(section(page, 'Number pad').locator('[data-anchor-row]')).toHaveCount(4)

    // Defer: Default defer and the Defer all button, and no more.
    const defer = section(page, 'Defer')
    await expect(defer.locator('select')).toHaveCount(2)
    await expect(defer.getByLabel('Default defer')).toBeVisible()
    await expect(defer.getByLabel('Defer all button')).toBeVisible()
    await expect(defer.locator('[data-anchor-row], [data-rollover-now]')).toHaveCount(0)

    // Advanced: closed, Roll over now nowhere on the page until it opens.
    const toggle = page.getByRole('button', { name: 'Advanced' })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('[data-rollover-now]')).toHaveCount(0)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const rollover = section(page, 'Advanced').locator('[data-rollover-now]')
    await expect(rollover).toBeVisible()
    const box = (await rollover.boundingBox())!
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)

    // It folds again, and the next visit opens it closed.
    await toggle.click()
    await expect(page.locator('[data-rollover-now]')).toHaveCount(0)
    await toggle.click()
    await page.reload()
    await expect(page.getByRole('button', { name: 'Advanced' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    await expect(page.locator('[data-rollover-now]')).toHaveCount(0)
  })
}

test('with the task queue off there is no Advanced section and no Day starts at', async ({
  page,
}) => {
  await signIn(page)
  await setQueue(page, false)
  await page.goto('/settings')
  await expect(page.getByRole('heading', { level: 2, name: 'About' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: 'Advanced' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Advanced' })).toHaveCount(0)

  // Your day: the three other time rows draw (so the preferences are in), and
  // Day starts at is not among them.
  const day = section(page, 'Your day')
  await expect(day.locator('[data-anchor-row]')).toHaveCount(3)
  const rows = await day
    .locator('[data-anchor-row]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-anchor-row')))
  expect(rows).toEqual(['wake', 'morning', 'sleep'])
  await expect(page.locator('[data-anchor-row="day_start"]')).toHaveCount(0)
  await expect(page.getByText('Day starts at')).toHaveCount(0)
})
