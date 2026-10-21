/**
 * The settings pieces of the 2026-10-10 task-model redesign:
 *
 * 1. Settings → Default snooze offers "Next period", it reads back after a
 *    reload, and a row's snooze tap on an overdue task then goes to the start
 *    of the next period (not +1 hour).
 * 2. Settings → Projects: a project's description, added with a live
 *    character count, saved, shown under the name after a reload, and cleared.
 *
 * The AI-context staleness nudge's left-bar test moved to
 * process-nav-and-ai-context.spec.ts (2026-10-14): the link is gone, and the
 * nudge now lives in Settings › AI.
 *
 * The E2E database is shared by every spec, so each test puts back what it
 * changed.
 */
import { DateTime } from 'luxon'
import { test, expect, uniqueTitle, waitForPreferenceSave, waitForPrefsLoaded } from './fixtures'

test.use({ viewport: { width: 1280, height: 900 } })

/**
 * Where "Next period" sends a tap, as `computeSnoozeTime('next_period', …)`
 * (src/lib/snooze.ts) decides: the next period if it starts later TODAY, else
 * the top of the next hour (spec amendment 17) — never tomorrow's first.
 */
function nextPeriodStart(starts: string[], timezone: string): string {
  const local = DateTime.now().setZone(timezone)
  const later = starts
    .map((hhmm) => {
      const [hour, minute] = hhmm.split(':').map(Number)
      return local.set({ hour, minute, second: 0, millisecond: 0 })
    })
    .filter((t) => t > local)
    .sort((a, b) => a.toMillis() - b.toMillis())[0]
  return (later ?? local.startOf('hour').plus({ hours: 1 })).toUTC().toISO()!
}

test('Default snooze "Next period": saved, read back, and used by a row tap', async ({
  authenticatedPage: page,
}) => {
  const prefs = (await (await page.request.get('/api/user/preferences')).json()).data
  const slots = (await (await page.request.get('/api/time-slots')).json()).data.time_slots as {
    start_time: string
  }[]
  expect(slots.length).toBeGreaterThan(0)
  // The seeded user's zone (tests/e2e/globalSetup.ts).
  const timezone = process.env.E2E_TZ || 'America/Chicago'

  const title = uniqueTitle('Next period tap')
  const created = await page.request.post('/api/tasks', {
    data: { title, priority: 1, due_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
  })
  expect(created.ok()).toBe(true)
  const id = (await created.json()).data.id as number

  try {
    await page.goto('/settings')
    const select = page.getByRole('combobox', { name: 'Default defer' })
    await expect(select).toHaveValue(prefs.default_snooze_option)
    await expect(select.locator('option', { hasText: 'Next period' })).toHaveCount(1)

    const saved = waitForPreferenceSave(page, 'default_snooze_option')
    await select.selectOption('next_period')
    expect((await saved).ok()).toBe(true)
    await page.reload()
    await expect(select).toHaveValue('next_period')

    // The row's snooze tap on an overdue task: one tap, no menu, to the next period.
    const row = page.locator(`#task-row-${id}`)
    await waitForPrefsLoaded(page, () => page.goto('/'), row)
    await row.hover()
    const before = nextPeriodStart(
      slots.map((s) => s.start_time),
      timezone,
    )
    const sent = page.waitForRequest(
      (r) => r.method() === 'POST' && r.url().endsWith(`/api/tasks/${id}/snooze`),
    )
    await row.getByRole('button', { name: `Defer "${title}"` }).click()
    const until = (JSON.parse((await sent).postData() ?? '{}') as { until: string }).until
    const after = nextPeriodStart(
      slots.map((s) => s.start_time),
      timezone,
    )
    // Computed either side of the tap, so a period starting mid-test can't flake it.
    expect([before, after]).toContain(new Date(until).toISOString())
  } finally {
    await page.request.patch('/api/user/preferences', {
      data: { default_snooze_option: prefs.default_snooze_option },
    })
    await page.request.delete(`/api/tasks/${id}`)
  }
})

test('Project description: add with a live count, read back, clear', async ({
  authenticatedPage: page,
}) => {
  const name = uniqueTitle('Described')
  const created = await page.request.post('/api/projects', { data: { name } })
  expect(created.ok()).toBe(true)
  const id = (await created.json()).data.id as number

  try {
    await page.goto('/settings')
    const row = page.locator(`[data-project-row="${id}"]`)
    await expect(row).toBeVisible()
    await row.hover()
    await row.getByRole('button', { name: 'Add description' }).click()

    const field = row.getByRole('textbox', { name: `Description of ${name}` })
    await expect(field).toBeFocused()
    await expect(field).toHaveAttribute('maxlength', '280')
    const count = row.locator('[data-project-description-count]')
    await expect(count).toHaveText('0/280')
    const text = 'Client work for Acme: calls, invoices, deliverables'
    await field.fill(text)
    await expect(count).toHaveText(`${text.length}/280`)

    const patched = page.waitForResponse(
      (r) => r.request().method() === 'PATCH' && r.url().endsWith(`/api/projects/${id}`),
    )
    await row.getByRole('button', { name: 'Save' }).click()
    expect((await patched).ok()).toBe(true)

    await page.reload()
    const shown = row.getByRole('button', { name: `Edit description: ${text}` })
    await expect(shown).toBeVisible()
    expect((await (await page.request.get(`/api/projects/${id}`)).json()).data.description).toBe(
      text,
    )

    // Emptying the field clears it.
    await shown.click()
    await field.fill('')
    const cleared = page.waitForResponse(
      (r) => r.request().method() === 'PATCH' && r.url().endsWith(`/api/projects/${id}`),
    )
    await row.getByRole('button', { name: 'Save' }).click()
    expect((await cleared).ok()).toBe(true)
    await expect(shown).toHaveCount(0)
    expect(
      (await (await page.request.get(`/api/projects/${id}`)).json()).data.description,
    ).toBeNull()
  } finally {
    await page.request.delete(`/api/projects/${id}`)
  }
})
