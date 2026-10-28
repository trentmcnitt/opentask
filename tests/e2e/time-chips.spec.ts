/**
 * THE TIME CHIPS (Trent, 2026-10-28, `TimeChip`): every target and deadline
 * time on a task row is a box of one shape in its kind's colour — a blue
 * target ("Tomorrow 10:00 AM", no "Target" word), a plum one once over
 * target, a teal deadline with a flag, solid teal on the deadline's own day,
 * red with a flag once passed. Each readable (≥ 4.5:1 on its own tint) in
 * light and dark.
 *
 * Its own project, so `/?project=` lists every row; unique titles; trashed
 * in `finally`.
 */
import { DateTime } from 'luxon'
import { test, expect, uniqueTitle, chipContrast, openTaskDay } from './fixtures'
import type { Page } from '@playwright/test'

const TZ = process.env.E2E_TZ || 'America/Chicago'

async function create(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), await res.text()).toBeTruthy()
  return (await res.json()).data.id as number
}

test('time chips: one shape, a colour per kind, a flag on deadlines, readable', async ({
  authenticatedPage: page,
}) => {
  const project = (
    await (await page.request.post('/api/projects', { data: { name: uniqueTitle('TC') } })).json()
  ).data.id as number
  const ids: number[] = []
  try {
    const local = (iso: string, h: number) =>
      DateTime.fromISO(iso, { zone: TZ }).set({ hour: h }).toUTC().toISO()!
    const mk = (title: string, data: Record<string, unknown>) =>
      create(page, { title: uniqueTitle(title), project_id: project, ...data })
    const target = await mk('TC target', { target_at: local(await openTaskDay(page, 1), 10) })
    const over = await mk('TC over', { target_at: local(await openTaskDay(page, -1), 10) })
    const ahead = await mk('TC ahead', { deadline_at: local(await openTaskDay(page, 4), 17) })
    // Later today (the test user has the task queue off: calendar days).
    const due = await mk('TC due today', {
      deadline_at: DateTime.now().setZone(TZ).endOf('day').minus({ minutes: 1 }).toUTC().toISO(),
    })
    const passed = await mk('TC passed', { deadline_at: local(await openTaskDay(page, -2), 17) })
    ids.push(target, over, ahead, due, passed)

    await page.goto(`/?project=${project}`)
    const chip = (id: number) => page.locator(`#task-row-${id} [data-time-chip]`).first()

    await expect(page.locator(`#task-row-${target} [data-target-time]`)).toHaveText(/^Tomorrow /)
    await expect(chip(target)).toHaveAttribute('data-time-chip', 'target')
    await expect(chip(over)).toHaveAttribute('data-time-chip', 'over')
    await expect(chip(ahead)).toHaveAttribute('data-time-chip', 'deadline')
    await expect(chip(due)).toHaveAttribute('data-time-chip', 'today')
    await expect(chip(passed)).toHaveAttribute('data-time-chip', 'passed')
    // The flag is a deadline's, never a target's.
    for (const id of [ahead, due, passed]) await expect(chip(id).locator('svg')).toHaveCount(1)
    await expect(page.locator(`#task-row-${target} [data-target-time] svg`)).toHaveCount(0)

    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      for (const id of [target, over, ahead, due, passed]) {
        const tone = await chip(id).getAttribute('data-time-chip')
        // Polled: the row's background eases into the new scheme (`transition-colors`).
        await expect
          .poll(() => chipContrast(chip(id)), { message: `${scheme} ${tone}` })
          .toBeGreaterThanOrEqual(4.5)
      }
    }
    await page.emulateMedia({ colorScheme: null })
  } finally {
    if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
    await page.request.delete(`/api/projects/${project}`)
  }
})
