/**
 * T1, THE TARGET MENU AT TEN PERIODS (Trent, 2026-10-30: "make sure that we can
 * handle lots of periods … like 8 or 10"; `src/lib/target-menu.ts`). The
 * defer menu's six rows stay rows; every period but the next is a button in
 * ONE wrapping row under "Periods". On a phone the sheet stays on screen —
 * its title and first rows never pushed off the top (the old menu listed each
 * period as a row and ran off a 375×667 screen) — and a period button targets
 * that period's next start.
 *
 * The shared user gets five extra periods for this file (ten in all), removed
 * in `finally`; the task is created here and trashed.
 */
import { DateTime } from 'luxon'
import { test, expect, showAllNow, uniqueTitle } from './fixtures'
import type { Page } from '@playwright/test'

const TZ = process.env.E2E_TZ || 'America/Chicago'

const EXTRA = [
  ['T1 Dawn', '05:15'],
  ['T1 Brunch', '10:45'],
  ['T1 Tea', '15:20'],
  ['T1 Supper', '17:40'],
  ['T1 Late', '22:50'],
] as const

interface Slot {
  id: number
  label: string
  start_time: string
}

async function slots(page: Page): Promise<Slot[]> {
  return (await (await page.request.get('/api/time-slots')).json()).data.time_slots as Slot[]
}

test.use({ viewport: { width: 375, height: 667 } })

test('ten periods: the phone sheet stays on screen, periods are one wrapping row of buttons, a button targets its next start', async ({
  authenticatedPage: page,
}) => {
  const added: number[] = []
  let taskId: number | null = null
  try {
    for (const [label, start_time] of EXTRA) {
      const res = await page.request.post('/api/time-slots', { data: { label, start_time } })
      expect(res.ok()).toBeTruthy()
      added.push((await res.json()).data.id as number)
    }
    const all = await slots(page)
    expect(all.length).toBeGreaterThanOrEqual(10)

    const title = uniqueTitle('T1 menu')
    const due = DateTime.now().plus({ days: 2 }).set({ hour: 10, minute: 0 })
    const made = await page.request.post('/api/tasks', {
      data: { title, due_at: due.toUTC().toISO() },
    })
    taskId = (await made.json()).data.id as number

    await page.goto('/')
    await showAllNow(page)
    const row = page.locator(`#task-row-${taskId}`)
    await expect(row).toBeVisible()
    // On a phone a row's way to the menu is its target chip's Move… (the
    // clock button is a desktop hover control).
    await row.getByRole('button', { name: /^Target .*\. Options$/ }).click()
    await page.getByRole('menuitem', { name: 'Move…' }).click()
    const sheet = page.getByRole('dialog', { name: 'Target' })
    await expect(sheet).toBeVisible()

    // The periods group arrives with the slots fetch: every period but the next.
    const chips = sheet.locator('[data-option-chips="Periods"] [data-option-chip]')
    await expect(chips).toHaveCount(all.length - 1)
    // The six rows, the first ones on screen with the title.
    await expect(sheet.getByText('Target', { exact: true })).toBeInViewport()
    await expect(sheet.getByRole('button', { name: /^Next period · / })).toBeInViewport()
    await expect(sheet.getByRole('button', { name: '1 hour', exact: true })).toBeInViewport()
    await expect(sheet.getByRole('button', { name: /^Tomorrow \w{3} / })).toBeVisible()
    // Never taller than the screen: the sheet's top is on it.
    const box = (await sheet.boundingBox())!
    expect(box.y).toBeGreaterThanOrEqual(0)

    // A period button: that period's next start (the menu says no date — the
    // server's answer is checked against the period's own time).
    // The first added period that is a button (one of them may be the next
    // period, the top row, at this hour).
    let pick: (typeof EXTRA)[number] | null = null
    for (const extra of EXTRA) {
      if ((await chips.filter({ hasText: extra[0] }).count()) === 1) {
        pick = extra
        break
      }
    }
    expect(pick).not.toBeNull()
    const [label, start] = pick!
    const chip = chips.filter({ hasText: label })
    await chip.scrollIntoViewIfNeeded()
    await chip.click()
    await expect(sheet).toBeHidden()
    await expect
      .poll(async () => {
        const task = (await (await page.request.get(`/api/tasks/${taskId}`)).json()).data
        return DateTime.fromISO(task.due_at).setZone(TZ).toFormat('HH:mm')
      })
      .toBe(start)
  } finally {
    if (taskId !== null) {
      await page.request.post('/api/tasks/bulk/delete', { data: { ids: [taskId] } })
    }
    for (const id of added) await page.request.delete(`/api/time-slots/${id}`)
  }
})
