/**
 * Interval quotas on the web (2026-10-16): "every 2 weeks".
 *
 * The editor keeps its period chips and gains an "every N" stepper under the
 * pressed one; the rule it writes is canonical (`FREQ=WEEKLY;INTERVAL=2`).
 * The Track panel gives the quota a section of its own ("every 2 weeks", no
 * shared clock), and its chip says when its period ends — the server's
 * `period_label`, "by Oct 24".
 */
import { test, expect, uniqueTitle } from './fixtures'

const made: number[] = []

test.afterEach(async ({ authenticatedPage: page }) => {
  // Cleanup asserts nothing — it only leaves the database as it found it.
  for (const id of made.splice(0)) await page.request.delete(`/api/tasks/${id}`)
})

test.describe('Interval quotas', () => {
  test('creates an every-2-weeks quota in the editor; its chip says "by …" in its own section', async ({
    authenticatedPage: page,
  }) => {
    const title = uniqueTitle('Deep-clean the oven')
    await page.goto('/quotas')
    await page.getByRole('button', { name: 'New quota' }).click()
    const form = page.getByRole('dialog')
    await expect(form).toBeVisible()
    await form.getByRole('textbox').first().fill(title)
    await form.getByRole('textbox', { name: 'Times per period' }).fill('1')

    // "Every week" is pressed by default, with the stepper under it at 1.
    await expect(form.getByRole('button', { name: 'Every week' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    const stepper = form.locator('[data-interval-stepper="WEEKLY"]')
    await expect(stepper).toContainText('every')
    await expect(stepper.locator('[data-interval-value]')).toHaveText('1')
    await stepper.getByRole('button', { name: 'More weeks per period' }).click()
    await expect(stepper.locator('[data-interval-value]')).toHaveText('2')
    await expect(stepper).toContainText('weeks')

    const created = page.waitForResponse(
      (r) => r.url().endsWith('/api/tasks') && r.request().method() === 'POST',
    )
    await form.getByRole('button', { name: 'Create' }).click()
    const response = await created
    expect(response.request().postDataJSON().rrule).toBe('FREQ=WEEKLY;INTERVAL=2')
    const body = await response.json()
    const id = body.data.id as number
    made.push(id)
    const label = body.data.period_label as string
    expect(label).toMatch(/^by [A-Z][a-z]{2} \d{1,2}$/)

    // Its own section, with no clock, and the chip carries its end.
    const section = page.locator('[data-quota-period="WEEKLY/2"]')
    await expect(section).toBeVisible()
    await expect(section).toContainText(/every 2 weeks/i)
    await expect(section.locator('[data-track-period-notch]')).toHaveCount(0)
    const chip = section.locator(`[data-track-chip="${id}"]`)
    await expect(chip).toContainText(label)
    await expect(chip).toHaveAttribute('aria-label', new RegExp(`0 of 1 ${label}$`))

    // The chip's bubble: "0 of 1 by Oct 24 · Every 2 weeks", never "this week",
    // and the record (closed periods, whatever their length) reads as for any quota.
    // On /quotas a hold selects the chip; its bubble is the bar's Details.
    await chip.click({ delay: 500 })
    await page
      .locator('[data-quota-selection-bar]')
      .getByRole('button', { name: 'Details', exact: true })
      .click()
    const pop = page.locator('[data-track-popover]')
    await expect(pop).toBeVisible()
    await expect(pop).toContainText(`0 of 1 ${label} · Every 2 weeks`)
    await expect(pop).not.toContainText('this week')
    const record = pop.locator('[data-quota-record]')
    await expect(record).toHaveAttribute('data-quota-record', 'ready')
    await expect(record.locator('[data-quota-met]')).toHaveText('Never yet')
    await expect(record).toContainText('Tracking since')
    await page.keyboard.press('Escape')

    // The editor reads it back: the chip pressed by FREQ, the interval in the stepper.
    await page.goto(`/tasks/${id}`)
    const editor = page.locator(`[data-quota-detail="${id}"]`)
    await expect(editor.getByRole('button', { name: 'Every week' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await expect(
      editor.locator('[data-interval-stepper="WEEKLY"] [data-interval-value]'),
    ).toHaveText('2')
  })

  test('the stepper changes only the interval, and a yearly quota has none', async ({
    authenticatedPage: page,
  }) => {
    const res = await page.request.post('/api/tasks', {
      data: { title: uniqueTitle('Swap the air filters'), is_tracked: true, rrule: 'FREQ=MONTHLY' },
    })
    const id = (await res.json()).data.id as number
    made.push(id)

    await page.goto(`/tasks/${id}`)
    const editor = page.locator(`[data-quota-detail="${id}"]`)
    const stepper = editor.locator('[data-interval-stepper="MONTHLY"]')
    await expect(stepper.locator('[data-interval-value]')).toHaveText('1')
    // At 1 the fewer button can't go lower.
    await expect(stepper.getByRole('button', { name: 'Fewer months per period' })).toBeDisabled()
    await stepper.getByRole('button', { name: 'More months per period' }).click()
    await stepper.getByRole('button', { name: 'More months per period' }).click()

    const saved = page.waitForResponse(
      (r) => r.url().includes(`/api/tasks/${id}`) && r.request().method() === 'PATCH',
    )
    await editor.getByRole('button', { name: 'Save' }).click()
    expect((await saved).request().postDataJSON().rrule).toBe('FREQ=MONTHLY;INTERVAL=3')

    // Yearly: no stepper at all.
    await editor.getByRole('button', { name: 'Every year' }).click()
    await expect(editor.locator('[data-interval-stepper]')).toHaveCount(0)
  })
})
