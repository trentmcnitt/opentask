/**
 * The quota count as segments (2026-10-13, `QuotaSegments`).
 *
 * A quota's count is N small boxes — indigo per completion, all green once
 * met — then a short period word ("today", "week"), falling back to plain
 * "0/7 week" text past six boxes. The fit rule itself is unit-tested
 * (tests/behavioral/quota-segments.test.ts); this spec covers what a browser
 * shows on each surface: empty, partway, met, the >6 fallback, the Track
 * chip's wordless form, and the group's accessible name.
 *
 * Time-agnostic: prompts render in every slot whether it has started or not,
 * and every quota made here is trashed afterwards.
 */

import { test, expect } from './fixtures'
import type { Locator, Page } from '@playwright/test'

const created: number[] = []

async function makeQuota(page: Page, title: string, rrule: string, target: number, logged = 0) {
  const res = await page.request.post('/api/tasks', {
    data: { title, rrule, progress_target: target, is_tracked: true },
  })
  expect(res.ok()).toBeTruthy()
  const id = (await res.json()).data.id as number
  created.push(id)
  if (logged > 0) {
    const p = await page.request.post(`/api/tasks/${id}/progress`, { data: { delta: logged } })
    expect(p.ok()).toBeTruthy()
  }
  return id
}

/** The count group inside a row — never the hidden measuring twins beside it. */
function countIn(row: Locator) {
  return row.locator('[data-quota-segments]')
}

async function expectSegments(group: Locator, fills: string[]) {
  await expect(group).toHaveAttribute('data-count-form', 'segments')
  const segs = group.locator('[data-seg]')
  await expect(segs).toHaveCount(fills.length)
  for (let i = 0; i < fills.length; i++) {
    await expect(segs.nth(i)).toHaveAttribute('data-seg', fills[i])
  }
}

test.describe('Quota segments', () => {
  test.afterEach(async ({ authenticatedPage: page }) => {
    if (created.length > 0) {
      await page.request.post('/api/tasks/bulk/delete', { data: { ids: [...created] } })
      created.length = 0
    }
  })

  test('a waiting prompt row shows empty segments with the period word', async ({
    authenticatedPage: page,
  }) => {
    await makeQuota(page, 'E2E seg weekly empty', 'FREQ=WEEKLY', 3)
    await makeQuota(page, 'E2E seg daily one', 'FREQ=DAILY', 1)
    await page.goto('/reminders')

    const empty = countIn(page.locator('li[data-prompt-key]', { hasText: 'E2E seg weekly empty' }))
    await expectSegments(empty, ['empty', 'empty', 'empty'])
    await expect(empty).toHaveAttribute('aria-label', '0 of 3 this week')
    await expect(empty).toHaveAttribute('role', 'img')
    // The word is "week", not "this week"; the boxes carry no text.
    await expect(empty).toHaveText('week')

    // A 1x quota is one segment; a daily one says "today".
    const daily = countIn(page.locator('li[data-prompt-key]', { hasText: 'E2E seg daily one' }))
    await expectSegments(daily, ['empty'])
    await expect(daily).toHaveAttribute('aria-label', '0 of 1 today')
    await expect(daily).toHaveText('today')
  })

  test('a handled prompt row shows partway in indigo and met in green', async ({
    authenticatedPage: page,
  }) => {
    const partTitle = `E2E seg partway ${Date.now()}`
    const metTitle = `E2E seg met ${Date.now()}`
    await makeQuota(page, partTitle, 'FREQ=WEEKLY', 3)
    await makeQuota(page, metTitle, 'FREQ=WEEKLY', 1)
    await page.goto('/reminders')

    // "Did it" on each: one of three logged, and one of one — met. Each
    // handled prompt joins its period's considered list.
    for (const title of [partTitle, metTitle]) {
      const row = page.locator('li[data-prompt-key]', { hasText: title })
      const card = page.locator('[data-slot-group]', { has: row })
      const slot = await card.getAttribute('data-slot-group')
      const did = page.waitForResponse((r) => r.url().includes('/api/quota-prompts/did'))
      await row.locator('[data-prompt-did]').click()
      expect((await did).ok()).toBeTruthy()
      await expect(page.locator('li[data-prompt-key]', { hasText: title })).toHaveCount(0)
      const slotCard = page.locator(`[data-slot-group="${slot}"]`)
      const show = slotCard.getByRole('button', { name: /^Show \d+ considered$/ })
      if (await show.isVisible()) await show.click()
    }

    const partway = countIn(page.locator('li[data-considered-prompt]', { hasText: partTitle }))
    await expectSegments(partway, ['filled', 'empty', 'empty'])
    await expect(partway).toHaveAttribute('aria-label', '1 of 3 this week')

    const met = countIn(page.locator('li[data-considered-prompt]', { hasText: metTitle }))
    await expectSegments(met, ['met'])
    await expect(met).toHaveAttribute('aria-label', '1 of 1 this week')
    // The word turns green with the boxes.
    await expect(met.getByText('week')).toHaveClass(/text-green-700/)
  })

  test('more than six falls back to "0/7 week" text', async ({ authenticatedPage: page }) => {
    await makeQuota(page, 'E2E seg seven', 'FREQ=WEEKLY', 7)
    await page.goto('/reminders')
    const group = countIn(page.locator('li[data-prompt-key]', { hasText: 'E2E seg seven' }))
    await expect(group).toHaveAttribute('data-count-form', 'text')
    await expect(group).toHaveText('0/7 week')
    await expect(group.locator('[data-seg]')).toHaveCount(0)
    await expect(group).toHaveAttribute('aria-label', '0 of 7 this week')
  })

  test('a Track chip shows segments without a word, and no progress fill', async ({
    authenticatedPage: page,
  }) => {
    const id = await makeQuota(page, 'E2E seg chip', 'FREQ=WEEKLY', 3, 1)
    await page.goto('/')
    const panel = page.getByRole('region', { name: 'Quotas' })
    await expect(panel).toBeVisible()
    // On a phone the period starts folded to its bar — open it first.
    const toggle = panel.locator(
      `[data-quota-period]:has([data-track-chip="${id}"]) [data-track-period-toggle]`,
    )
    if (await toggle.isVisible()) await toggle.click()
    const chip = panel.locator(`[data-track-chip="${id}"]`)
    await expect(chip).toBeVisible()

    const group = chip.locator('[data-track-count]')
    await expectSegments(group, ['filled', 'empty', 'empty'])
    await expect(group).toHaveText('')
    // The fill behind the chip is gone: nothing in it is sized by the count.
    await expect(chip.locator('[style*="width"]')).toHaveCount(0)

    // A tap logs one, and the boxes follow.
    await chip.click()
    await expectSegments(group, ['filled', 'filled', 'empty'])
    await expect(group).toHaveAttribute('data-count', '2/3')
  })
})
