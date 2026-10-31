/**
 * "Just now" shows two, then five more a tap (Trent, 2026-10-30, `JustAddedCard`):
 * the two newest entries, "Show 5 more" adding five each tap, its last step
 * "Show N more", and Clear still there.
 *
 * Nine tasks created here are the newest entries whatever else the shared
 * user holds, so the first two listed are this test's last two. Unique
 * titles; every task trashed in `finally`.
 */
import { test, expect, uniqueTitle, withPreferences } from './fixtures'

test('two newest, then "Show 5 more" until the end, the last step "Show N more"', async ({
  authenticatedPage: page,
}) => {
  const ids: number[] = []
  try {
    for (let i = 0; i < 9; i++) {
      const res = await page.request.post('/api/tasks', { data: { title: uniqueTitle(`JN ${i}`) } })
      ids.push((await res.json()).data.id as number)
    }
    await withPreferences(page, { default_grouping: 'new' }, async () => {
      await page.goto('/')
      const card = page.locator('[data-just-added-card]')
      const entries = card.locator('[data-just-added-entry]')
      const more = card.locator('[data-just-added-more]')
      await expect(entries).toHaveCount(2)
      await expect(entries.nth(0)).toHaveAttribute('data-just-added-entry', String(ids[8]))
      await expect(entries.nth(1)).toHaveAttribute('data-just-added-entry', String(ids[7]))
      await expect(card.getByRole('button', { name: 'Clear' })).toBeVisible()
      // Five at a time; the last step names what is left.
      let shown = 2
      while (await more.count()) {
        const label = (await more.textContent())!.trim()
        const step = Number(/^Show (\d+) more$/.exec(label)?.[1])
        expect(step).toBeGreaterThan(0)
        expect(step).toBeLessThanOrEqual(5)
        await more.click()
        shown += step
        await expect(entries).toHaveCount(shown)
        if (step < 5) await expect(more).toHaveCount(0)
      }
      expect(shown).toBeGreaterThanOrEqual(9)
    })
  } finally {
    await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
  }
})
