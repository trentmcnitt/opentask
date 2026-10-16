/**
 * A quota's record at the top of its editor, and the "Last: …" line
 * (2026-10-16): the bubble and the editor both say when the last tap that
 * still stands was logged, and say nothing when there is none.
 */
import { test, expect } from './fixtures'

const made: number[] = []

test.afterEach(async ({ authenticatedPage: page }) => {
  for (const id of made.splice(0)) await page.request.delete(`/api/tasks/${id}`)
})

test('the bubble and the editor show the record and the last tap', async ({
  authenticatedPage: page,
}) => {
  const res = await page.request.post('/api/tasks', {
    data: { title: `Last tap probe ${Date.now()}`, progress_target: 3, rrule: 'FREQ=WEEKLY' },
  })
  const id = (await res.json()).data.id as number
  made.push(id)

  await page.goto('/')
  const chip = page.getByRole('region', { name: 'Quotas' }).locator(`[data-track-chip="${id}"]`)
  await expect(chip).toBeVisible()

  // Never logged: the record, and no "Last" line at all.
  await chip.click({ delay: 500 })
  const pop = page.locator('[data-track-popover]')
  await expect(pop.locator('[data-quota-record]')).toHaveAttribute('data-quota-record', 'ready')
  await expect(pop.locator('[data-quota-last]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(pop).toHaveCount(0)

  // A tap from the web: it is the last one, today.
  const logged = page.waitForResponse(
    (r) => r.url().endsWith(`/api/tasks/${id}/progress`) && r.request().method() === 'POST',
  )
  await chip.click()
  const sent = await logged
  expect(sent.request().postDataJSON()).toMatchObject({ delta: 1, source: 'web' })
  await chip.click({ delay: 500 })
  await expect(pop.locator('[data-quota-last]')).toHaveText(/^Last: today \d{1,2}:\d{2}\s?[AP]M$/)

  // The editor opens on the same record, at the top.
  await pop.getByRole('button', { name: 'Open' }).click()
  const editor = page.getByRole('dialog')
  const record = editor.locator('[data-quota-detail] [data-quota-record]')
  await expect(record).toBeVisible()
  await expect(record).toContainText('Periods met')
  await expect(record.locator('[data-quota-last]')).toHaveText(/^Last: today /)
  const recordBox = (await record.boundingBox())!
  const titleBox = (await editor.getByRole('textbox').first().boundingBox())!
  expect(recordBox.y).toBeLessThan(titleBox.y)

  await page.keyboard.press('Escape')
})
