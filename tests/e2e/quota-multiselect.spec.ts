/**
 * Selecting several quotas on the Quotas page (2026-10-16, Trent: "Of course
 * we need a way to have multiple selections on the quotas screen.").
 *
 * The chips select the way the dashboard's rows do — Cmd/Ctrl-click, a press
 * and hold, shift-click for a range over the chips on screen, Escape to clear
 * — while a plain tap stays +1 whenever nothing is selected. The floating bar
 * edits the selection together (the quota editor's multi-edit) or trashes it,
 * each with one Undo. The full gesture table is `useQuotaChipSelection`'s.
 */
import { test, expect, expectClearOnFirstRow } from './fixtures'
import type { Locator, Page } from '@playwright/test'

const made: number[] = []

test.afterEach(async ({ authenticatedPage: page }) => {
  // Already-trashed rows answer 400; cleanup only has to leave nothing behind.
  for (const id of made.splice(0)) await page.request.delete(`/api/tasks/${id}`)
})

async function createQuota(page: Page, body: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data: body })
  expect(res.ok()).toBeTruthy()
  const id = (await res.json()).data.id as number
  made.push(id)
  return id
}

/**
 * Three weekly quotas alone in a run-unique label cluster, titled so they sort
 * a, b, c. `b` has "Remind me daily" switched off.
 */
async function seedThree(page: Page) {
  const tag = `msel${Date.now()}`
  const ids: number[] = []
  for (const k of ['a', 'b', 'c']) {
    ids.push(
      await createQuota(page, {
        title: `${tag} ${k}`,
        progress_target: 2,
        rrule: 'FREQ=WEEKLY',
        labels: [tag],
        create_label: true,
        ...(k === 'b' ? { quota_prompt_config: { enabled: false } } : {}),
      }),
    )
  }
  await page.goto('/quotas')
  const panel = page.getByRole('region', { name: 'Quotas' })
  const chips = ids.map((id) => panel.locator(`[data-track-chip="${id}"]`))
  for (const chip of chips) await expect(chip).toBeVisible()
  return { tag, ids, panel, chips }
}

const selectedIn = (panel: Locator) => panel.locator('[data-track-chip-selected]')
const countOf = (chip: Locator) => chip.locator('[data-track-count]')

test.describe('Quotas page — selecting chips', () => {
  test('Cmd-click selects, shift-click takes the range, a tap toggles, Escape clears', async ({
    authenticatedPage: page,
  }) => {
    const { panel, chips } = await seedThree(page)
    const [a, b, c] = chips
    const bar = page.locator('[data-quota-selection-bar]')

    // Cmd/Ctrl-click selects and logs nothing.
    await a.click({ modifiers: ['ControlOrMeta'] })
    await expect(a).toHaveAttribute('data-track-chip-selected', '')
    await expect(countOf(a)).toHaveAttribute('data-count', '0/2')
    await expect(bar).toBeVisible()

    // Shift takes exactly the range from the anchor — these three, no more.
    await c.click({ modifiers: ['Shift'] })
    for (const chip of chips) await expect(chip).toHaveAttribute('data-track-chip-selected', '')
    await expect(selectedIn(panel)).toHaveCount(3)
    await expect(bar).toContainText('3 selected')

    // In selection mode a plain tap toggles, never +1.
    await b.click()
    await expect(b).not.toHaveAttribute('data-track-chip-selected', '')
    await expect(countOf(b)).toHaveAttribute('data-count', '0/2')
    await expect(bar).toContainText('2 selected')

    // Escape clears; then a tap is a +1 again.
    await page.keyboard.press('Escape')
    await expect(selectedIn(panel)).toHaveCount(0)
    await expect(bar).toHaveCount(0)
    await a.click()
    await expect(countOf(a)).toHaveAttribute('data-count', '1/2')
  })

  test('a press and hold selects, a further hold extends the range, and nothing is logged', async ({
    authenticatedPage: page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    const { panel, chips } = await seedThree(page)
    const [a, b, c] = chips

    await a.click({ delay: 500 })
    await expect(a).toHaveAttribute('data-track-chip-selected', '')
    // The hold opens no bubble on this page; the bar's Details does.
    await expect(page.locator('[data-track-popover]')).toHaveCount(0)
    await c.click({ delay: 500 })
    await expect(selectedIn(panel)).toHaveCount(3)
    for (const chip of chips) await expect(countOf(chip)).toHaveAttribute('data-count', '0/2')

    // Tap toggles one out; the bar's × ends selection mode.
    await b.click()
    await expect(selectedIn(panel)).toHaveCount(2)
    await page.getByRole('button', { name: 'Clear selection' }).click()
    await expect(selectedIn(panel)).toHaveCount(0)

    // One chip selected: Details is its bubble.
    await b.click({ delay: 500 })
    await page
      .locator('[data-quota-selection-bar]')
      .getByRole('button', { name: 'Details', exact: true })
      .click()
    await expect(page.locator('[data-track-popover]')).toContainText('Periods met')
    await expect(selectedIn(panel)).toHaveCount(0)
  })

  test('edits a label and a reminder period across several, one with "Remind me daily" off', async ({
    authenticatedPage: page,
  }) => {
    const { ids, chips } = await seedThree(page)
    const [a, b] = chips
    const fresh = `msel-l${Date.now()}`
    const slots = (
      (await (await page.request.get('/api/time-slots')).json()).data.time_slots as {
        id: number
        start_time: string
      }[]
    ).sort((x, y) => x.start_time.localeCompare(y.start_time))
    const slot = slots[slots.length - 1]

    await a.click({ modifiers: ['ControlOrMeta'] })
    await b.click({ modifiers: ['ControlOrMeta'] })
    await page
      .locator('[data-quota-selection-bar]')
      .getByRole('button', { name: 'Details', exact: true })
      .click()

    const editor = page.getByRole('dialog')
    await expect(editor).toContainText('Editing 2 quotas')
    await editor.getByRole('button', { name: '+ New' }).click()
    await editor.getByRole('textbox', { name: 'New label' }).fill(fresh)
    await editor.getByRole('textbox', { name: 'New label' }).press('Enter')
    // On for one, off for the other: the switch reads mixed and the periods
    // are offered; picking one changes only the period.
    await expect(editor.locator('[data-quota-prompt-mixed="enabled"]')).toBeVisible()
    await editor.locator(`[data-quota-prompt-slot="${slot.id}"]`).click()
    const edited = page.waitForResponse(
      (r) => r.url().includes('/api/tasks/bulk/edit') && r.request().method() === 'POST',
    )
    await editor.getByRole('button', { name: 'Save' }).click()
    expect((await edited).status()).toBe(200)
    await expect(editor).toHaveCount(0)
    // A save clears the selection.
    await expect(page.locator('[data-quota-selection-bar]')).toHaveCount(0)

    for (const id of [ids[0], ids[1]]) {
      const task = (await (await page.request.get(`/api/tasks/${id}`)).json()).data
      expect(task.labels).toEqual([fresh])
      expect(task.quota_prompt_config.slot_id).toBe(slot.id)
    }
    // "Remind me daily" stayed off where it was off.
    const off = (await (await page.request.get(`/api/tasks/${ids[1]}`)).json()).data
    expect(off.quota_prompt_config.enabled).toBe(false)
    // The unselected one is untouched.
    const c = (await (await page.request.get(`/api/tasks/${ids[2]}`)).json()).data
    expect(c.labels).not.toContain(fresh)

    // One Undo takes the whole edit back.
    await page.locator('[data-sonner-toast]').getByRole('button', { name: 'Undo' }).click()
    await expect
      .poll(async () => (await (await page.request.get(`/api/tasks/${ids[0]}`)).json()).data.labels)
      .not.toContain(fresh)
    const bBack = (await (await page.request.get(`/api/tasks/${ids[1]}`)).json()).data
    expect(bBack.labels).not.toContain(fresh)
  })

  test('trashes the selection together, and one Undo brings every one back', async ({
    authenticatedPage: page,
  }) => {
    const { chips, panel } = await seedThree(page)
    const [a, b, c] = chips

    await a.click({ modifiers: ['ControlOrMeta'] })
    await c.click({ modifiers: ['Shift'] })
    await expect(selectedIn(panel)).toHaveCount(3)
    const deleted = page.waitForResponse(
      (r) => r.url().includes('/api/tasks/bulk/delete') && r.request().method() === 'POST',
    )
    await page
      .locator('[data-quota-selection-bar]')
      .getByRole('button', { name: 'Move 3 quotas to Trash' })
      .click()
    expect((await deleted).status()).toBe(200)
    for (const chip of [a, b, c]) await expect(chip).toHaveCount(0)
    await expect(page.locator('[data-quota-selection-bar]')).toHaveCount(0)

    await page.locator('[data-sonner-toast]').getByRole('button', { name: 'Undo' }).click()
    for (const chip of [a, b, c]) await expect(chip).toBeVisible()
  })
})

/**
 * The bar on a phone at the iOS app's 119% text (a 19.04px root,
 * ios/OpenTask/WebView.swift): "3 selected · Details · trash" and Clear (the
 * X on the pill's corner) all on one row, as on the dashboard and Reminders
 * (the shared `SelectionBarShell`, 2026-10-26).
 */
test.describe('Quotas page — the selection bar on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 } })

  test('the verbs and Clear sit on one row at a large text size', async ({
    authenticatedPage: page,
  }) => {
    const { chips } = await seedThree(page)
    await page.evaluate(() => (document.documentElement.style.fontSize = '19.04px'))
    const [a, , c] = chips
    await a.click({ modifiers: ['ControlOrMeta'] })
    await c.click({ modifiers: ['Shift'] })
    await expect(page.locator('[data-quota-selection-bar]')).toContainText('3 selected')
    await expectClearOnFirstRow(page, 'three selected', { oneRow: true })
  })
})
