/**
 * THE DEADLINES PAGE'S OWN TEAL (2026-10-26, an experiment for Trent: "change
 * the color on that one and see what that's like"). The deadlines segment's
 * title, its bar in the Tasks card's strip and the /reminders day bar, its
 * hairline and its finished "N of N ✓" / "Nothing today ✓" all wear its teal
 * (globals.css) — where every other segment turns GREEN when done, this one
 * stays its teal (`segmentDoneColor` / `segmentDoneTextColor` in
 * TaskSegmentRow.tsx). Two tokens in light mode: TEXT (the title, the count's
 * numbers) is `--deadlines` #008464; FILL (bars, hairline, every ✓ glyph) is
 * `--deadlines-fill` #0d9488. Dark mode uses #2dd4bf for both.
 *
 * Read from computed styles, against the token and the done green resolved
 * in the page itself (Tailwind 4's green is oklch, so never a hard-coded
 * rgb). The other segments keep green: an empty Weekly, done from the start
 * of the day, is the control beside the empty deadlines page. While a bar
 * FILLS it is the reminders' purple on every segment (2026-10-26), the
 * deadlines page's included: a part-filled Daily is the check.
 *
 * Its own user (`queue@opentask.local`, as deadlines-page): with the switch
 * on, the minute cron's rollover would strip the shared user's past-target
 * one-offs. Unique titles; every task trashed in `finally`; the switch off
 * again after the file.
 */
import { test, expect, uniqueTitle } from './fixtures'
import type { Locator, Page } from '@playwright/test'

const TZ = process.env.E2E_TZ || 'America/Chicago'
test.use({ timezoneId: TZ })
const DAY = 24 * 60 * 60 * 1000
const fromNow = (ms: number) => new Date(Date.now() + ms).toISOString()

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('queue@opentask.local')
  await page.getByLabel('Password').fill('testpass123')
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL('/', { timeout: 10_000 })
}

async function create(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), `create ${JSON.stringify(data)}`).toBeTruthy()
  return (await res.json()).data.id as number
}

/** Considers `id` on its task segment, so the segment is part-way filled. */
async function consider(page: Page, id: number) {
  const res = await page.request.post('/api/task-segments/consider', { data: { ids: [id] } })
  expect(res.ok(), `consider ${id}`).toBeTruthy()
}

async function trash(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

/**
 * A CSS colour as the page computes it: a scratch element given `css` for
 * `prop` (a `var(--token)`), or the class `cls` (a Tailwind utility the app
 * already ships), read back through getComputedStyle.
 */
async function resolved(
  page: Page,
  spec: { prop: 'color' | 'backgroundColor'; css?: string; cls?: string },
): Promise<string> {
  return page.evaluate(({ prop, css, cls }) => {
    const el = document.createElement('div')
    if (cls) el.className = cls
    if (css) el.style[prop] = css
    document.body.appendChild(el)
    const value = getComputedStyle(el)[prop]
    el.remove()
    return value
  }, spec)
}

const colorOf = (el: Locator) => el.evaluate((e) => getComputedStyle(e).color)
const fillOf = (el: Locator) => el.evaluate((e) => getComputedStyle(e).backgroundColor)

async function palette(page: Page) {
  return {
    teal: await resolved(page, { prop: 'color', css: 'var(--deadlines)' }),
    tealFill: await resolved(page, { prop: 'backgroundColor', css: 'var(--deadlines-fill)' }),
    tealGlyph: await resolved(page, { prop: 'color', css: 'var(--deadlines-fill)' }),
    greenText: await resolved(page, { prop: 'color', cls: 'text-green-700 dark:text-green-400' }),
    greenFill: await resolved(page, { prop: 'backgroundColor', cls: 'bg-green-600' }),
    // Every bar fills in the reminders' purple while it fills (2026-10-26).
    purpleFill: await resolved(page, { prop: 'backgroundColor', css: 'var(--badge-reminders)' }),
  }
}

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  await signIn(page)
  const res = await page.request.post('/api/test/task-queue', { data: { enabled: true } })
  expect(res.ok()).toBeTruthy()
})
test.afterAll(async ({ request }) => {
  await request.post('/api/test/task-queue', { data: { enabled: false } })
})

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]

for (const viewport of VIEWPORTS) {
  test.describe(`at ${viewport.width}`, () => {
    test.use({ viewport })

    test('the Tasks card: the deadlines bar, title and ✓ are its teal; Weekly stays green', async ({
      page,
    }) => {
      const ids: number[] = []
      try {
        // Two Daily rows, one considered: the card is a pager (not the
        // one-line done card) and Daily's bar is part-way filled; the
        // deadlines page and Weekly are empty — done from the start.
        ids.push(await create(page, { title: uniqueTitle('DT daily'), horizon: 'days' }))
        ids.push(await create(page, { title: uniqueTitle('DT daily 2'), horizon: 'days' }))
        await consider(page, ids[1])
        await page.goto('/?tasks=deadlines')
        const card = page.locator('[data-tasks-panel]')
        await expect(card).toHaveAttribute('data-tasks-page', 'tasks:deadlines')
        const p = await palette(page)
        expect(p.teal).not.toBe(p.greenText)
        // The light tokens, as globals.css sets them: text #008464, fill #0d9488.
        expect(p.teal).toBe('rgb(0, 132, 100)')
        expect(p.tealFill).toBe('rgb(13, 148, 136)')

        // The strip: the deadlines bar's finished fill is the teal; Weekly's green.
        const fill = (key: string) => card.locator(`[data-slot-segment="${key}"] > span > span`)
        await expect(card.locator('[data-slot-segment="tasks:deadlines"]')).toHaveAttribute(
          'data-slot-state',
          'done',
        )
        expect(await fillOf(fill('tasks:deadlines'))).toBe(p.tealFill)
        expect(await fillOf(fill('tasks:weeks'))).toBe(p.greenFill)
        // Daily, filling: the reminders' purple, not a teal of its own.
        expect(p.purpleFill).not.toBe(p.tealFill)
        expect(await fillOf(fill('tasks:days'))).toBe(p.purpleFill)

        // The header: the title in the text teal; the ✓ glyphs (the header's
        // and "Nothing today ✓") in the fill teal.
        const title = card.locator('[data-slot-header-toggle] span.uppercase')
        await expect(title).toHaveText(/Task queue · Deadlines/i)
        expect(await colorOf(title)).toBe(p.teal)
        expect(await colorOf(card.locator('[data-done-check]').first())).toBe(p.tealGlyph)
        expect(await colorOf(card.locator('[data-segment-empty] [data-done-check]'))).toBe(
          p.tealGlyph,
        )

        // Weekly's page: its own title colour, and the done check is green.
        await page.goto('/?tasks=weeks')
        await expect(card).toHaveAttribute('data-tasks-page', 'tasks:weeks')
        expect(await colorOf(title)).not.toBe(p.teal)
        expect(await colorOf(card.locator('[data-done-check]').first())).toBe(p.greenText)
        expect(await colorOf(card.locator('[data-segment-empty] [data-done-check]'))).toBe(
          p.greenText,
        )
      } finally {
        await trash(page, ids)
      }
    })

    test('/reminders: the deadlines section and day-bar segment are its teal, filling and done', async ({
      page,
    }) => {
      const ids: number[] = []
      try {
        ids.push(await create(page, { title: uniqueTitle('DT daily'), horizon: 'days' }))
        ids.push(await create(page, { title: uniqueTitle('DT daily 2'), horizon: 'days' }))
        await consider(page, ids[1])
        // A reminder in the first period: without one the page is its empty
        // state, with no headline and so no day bar.
        const slots = (await (await page.request.get('/api/time-slots')).json()).data
          .time_slots as { start_time: string }[]
        const [h, m] = slots[0].start_time.split(':').map(Number)
        ids.push(
          await create(page, {
            title: uniqueTitle('DT reminder'),
            is_reminder: true,
            rrule: `FREQ=DAILY;BYHOUR=${h};BYMINUTE=${m}`,
          }),
        )
        await page.goto('/reminders')
        const p = await palette(page)
        await expect(
          page.locator('[data-reminders-headline] [data-day-segment="tasks:deadlines"]'),
        ).toBeVisible()
        const section = (kind: string) =>
          page.locator(`[data-task-segments] [data-task-segment="${kind}"]`)
        const title = (kind: string) => section(kind).locator('button span.uppercase').first()
        const hairline = (kind: string) =>
          section(kind).locator('[role="progressbar"] > div').first()
        const dayFill = (key: string) =>
          page.locator(`[data-reminders-headline] [data-day-segment="${key}"] > span > span`)

        // Empty, so done: title and "0 of 0" in the text teal; its ✓, the
        // "Nothing today ✓", the hairline and the day bar in the fill teal.
        await expect(section('deadlines').locator('[data-segment-empty]')).toBeVisible()
        expect(await colorOf(title('deadlines'))).toBe(p.teal)
        expect(await colorOf(section('deadlines').locator('[data-done-count]'))).toBe(p.teal)
        expect(
          await colorOf(section('deadlines').locator('[data-done-count] [data-done-check]')),
        ).toBe(p.tealGlyph)
        expect(
          await colorOf(section('deadlines').locator('[data-segment-empty] [data-done-check]')),
        ).toBe(p.tealGlyph)
        expect(await fillOf(hairline('deadlines'))).toBe(p.tealFill)
        expect(await fillOf(dayFill('tasks:deadlines'))).toBe(p.tealFill)
        // Weekly, empty too: green as before, and a title of its own colour.
        expect(await colorOf(section('weeks').locator('[data-done-count]'))).toBe(p.greenText)
        expect(await colorOf(section('weeks').locator('[data-done-count] [data-done-check]'))).toBe(
          p.greenText,
        )
        expect(await fillOf(hairline('weeks'))).toBe(p.greenFill)
        expect(await fillOf(dayFill('tasks:weeks'))).toBe(p.greenFill)
        expect(await colorOf(title('weeks'))).not.toBe(p.teal)
        expect(await colorOf(title('days'))).not.toBe(p.teal)
        // Daily, one of two considered: its hairline and day bar fill purple.
        expect(await fillOf(hairline('days'))).toBe(p.purpleFill)
        expect(await fillOf(dayFill('tasks:days'))).toBe(p.purpleFill)

        // With a row on the page (filling): the title is still the teal.
        const deadline = await create(page, {
          title: uniqueTitle('DT deadline'),
          deadline_at: fromNow(5 * DAY),
          lead_days: 30,
        })
        ids.push(deadline)
        await page.reload()
        await expect(
          section('deadlines').locator(`[data-segment-task="${deadline}"]`),
        ).toBeVisible()
        expect(await colorOf(title('deadlines'))).toBe(p.teal)
        await expect(section('deadlines').locator('[data-done-count]')).toHaveCount(0)
      } finally {
        await trash(page, ids)
      }
    })
  })
}

test.describe('dark', () => {
  test.use({ colorScheme: 'dark', viewport: { width: 1280, height: 800 } })

  test('the dark token is its own value, and the deadlines page wears it', async ({ page }) => {
    const ids: number[] = []
    try {
      ids.push(await create(page, { title: uniqueTitle('DT daily'), horizon: 'days' }))
      await page.goto('/reminders')
      await expect(page.locator('html')).toHaveClass(/dark/)
      const p = await palette(page)
      // #2dd4bf in globals.css's `.dark` block, text and fill alike.
      expect(p.teal).toBe('rgb(45, 212, 191)')
      expect(p.tealFill).toBe('rgb(45, 212, 191)')
      const section = page.locator('[data-task-segments] [data-task-segment="deadlines"]')
      expect(await colorOf(section.locator('button span.uppercase').first())).toBe(p.teal)
      expect(await colorOf(section.locator('[data-done-count]'))).toBe(p.teal)
      const weeks = page.locator('[data-task-segments] [data-task-segment="weeks"]')
      expect(await colorOf(weeks.locator('[data-done-count]'))).toBe(p.greenText)
    } finally {
      await trash(page, ids)
    }
  })
})
