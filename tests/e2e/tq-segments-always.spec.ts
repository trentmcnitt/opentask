/**
 * EVERY SEGMENT, EVERY DAY (Trent, 2026-10-24: "always show every queue
 * segment, every day, in fixed positions"; docs/TASK-MODEL.md § Task
 * segments). With the task-queue switch on, the web (`?fill=1`) shows all
 * eight segments in `SEGMENT_ORDER` — the deadlines page first — on the
 * dashboard's Tasks card and on /reminders, whether or not they have rows. An
 * empty one is done from the start of the day: green in the strip and the
 * day bar, "0 of 0 ✓", "Nothing today ✓" on its page or section. The card
 * opens on the first segment with work, and its chevrons step through all
 * eight.
 *
 * Its own user (`queue@opentask.local`, as tq-queue-panels): with the switch
 * on, the minute cron's rollover would strip the shared user's past-target
 * one-offs. Here it holds ONE task, a Daily one-off (and, for /reminders' day
 * bar, one reminder). Unique titles; everything trashed in `finally`; the
 * switch off again after the file.
 */
import { test, expect, uniqueTitle } from './fixtures'
import type { Locator, Page } from '@playwright/test'

const TZ = process.env.E2E_TZ || 'America/Chicago'
test.use({ timezoneId: TZ })

/** SEGMENT_ORDER (src/lib/task-segments.ts), as the screens key them. */
const ORDER = [
  'deadlines',
  'queue_today',
  'queue_previous',
  'days',
  'upcoming',
  'weeks',
  'months',
  'eventually',
]
const KEYS = ORDER.map((k) => `tasks:${k}`)

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

async function trash(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

/** The user's own open tasks that sit in a segment today — this file wants exactly one. */
async function segmentRowIds(page: Page): Promise<number[]> {
  const res = await page.request.get('/api/reminders?queue=1&deck=1&handled=1&deadlines=1')
  const segs = (await res.json()).data.task_segments as { tasks: { id: number }[] }[]
  return segs.flatMap((s) => s.tasks.map((t) => t.id))
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
  { width: 375, height: 812 },
]

for (const viewport of VIEWPORTS) {
  test.describe(`at ${viewport.width}`, () => {
    test.use({ viewport })

    test('the dashboard card: all eight in order, empties done, the pager steps through all', async ({
      page,
    }) => {
      const ids: number[] = []
      try {
        ids.push(await create(page, { title: uniqueTitle('SA daily'), horizon: 'days' }))
        // Only one segment has rows (nothing left behind by another spec).
        expect(await segmentRowIds(page)).toEqual(ids)

        await page.goto('/')
        const card = page.locator('[data-tasks-panel]')
        // Opens on the first segment with work, not on the empty deadlines page.
        await expect(card).toHaveAttribute('data-tasks-page', 'tasks:days')
        await expect(card.locator(`[data-segment-task="${ids[0]}"]`)).toBeVisible()

        // The strip: every segment, in the fixed order; the empties done (green).
        const bars = card.locator('[data-slot-segment]')
        await expect(bars).toHaveCount(ORDER.length)
        for (let i = 0; i < KEYS.length; i++) {
          await expect(bars.nth(i)).toHaveAttribute('data-slot-segment', KEYS[i])
          await expect(bars.nth(i)).toHaveAttribute(
            'data-slot-state',
            KEYS[i] === 'tasks:days' ? 'behind' : 'done',
          )
        }

        // Back to the first page: the deadlines page, empty, "Nothing today ✓".
        const prev = card.getByRole('button', { name: 'Previous task segment' })
        const next = card.getByRole('button', { name: 'Next task segment' })
        for (const key of [KEYS[2], KEYS[1], KEYS[0]]) {
          await prev.click()
          await expect(card).toHaveAttribute('data-tasks-page', key)
        }
        await expect(prev).toBeDisabled()
        await expect(card.locator('[data-segment-empty]')).toHaveText('Nothing today')
        await expect(card.getByLabel('0 of 0 considered', { exact: true })).toBeVisible()

        // Forward through every page, in order, to the last.
        for (const key of KEYS.slice(1)) {
          await next.click()
          await expect(card).toHaveAttribute('data-tasks-page', key)
          // Upcoming's two sections (2026-10-25) each read "Nothing today ✓".
          await expect(card.locator('[data-segment-empty]')).toHaveCount(
            key === 'tasks:days' ? 0 : key === 'tasks:upcoming' ? 2 : 1,
          )
        }
        await expect(next).toBeDisabled()
      } finally {
        await trash(page, ids)
      }
    })

    test('/reminders: every section and day-bar segment in order, deadlines first, empties done', async ({
      page,
    }) => {
      const ids: number[] = []
      try {
        ids.push(await create(page, { title: uniqueTitle('SA daily'), horizon: 'days' }))
        // A reminder in every period today, so the headline's day bar has
        // every period's bar before the eight task segments' — the most a
        // phone's bar has to fit.
        const slots = (await (await page.request.get('/api/time-slots')).json()).data
          .time_slots as { start_time: string }[]
        expect(slots.length).toBeGreaterThan(0)
        for (const slot of slots) {
          const [h, m] = slot.start_time.split(':').map(Number)
          ids.push(
            await create(page, {
              title: uniqueTitle('SA reminder'),
              is_reminder: true,
              rrule: `FREQ=DAILY;BYHOUR=${h};BYMINUTE=${m}`,
            }),
          )
        }
        await page.goto('/reminders')

        const sections = page.locator('[data-task-segments] [data-task-segment]')
        await expect(sections).toHaveCount(ORDER.length)
        for (let i = 0; i < ORDER.length; i++) {
          const section = sections.nth(i)
          await expect(section).toHaveAttribute('data-task-segment', ORDER[i])
          if (ORDER[i] === 'days') {
            await expect(section.locator(`[data-segment-task="${ids[0]}"]`)).toBeVisible()
            await expect(section.locator('[data-segment-empty]')).toHaveCount(0)
          } else if (ORDER[i] === 'upcoming') {
            // Both sections, Tomorrow then Later, each "Nothing today ✓" (2026-10-25).
            await expect(
              section.locator('[data-upcoming-section] [data-segment-empty]'),
            ).toHaveText(['Nothing today', 'Nothing today'])
          } else {
            await expect(section.locator('[data-segment-empty]')).toHaveText('Nothing today')
          }
        }

        const bar = page.locator('[data-reminders-headline] [data-day-segment^="tasks:"]')
        await expect(bar).toHaveCount(ORDER.length)
        for (let i = 0; i < KEYS.length; i++) {
          await expect(bar.nth(i)).toHaveAttribute('data-day-segment', KEYS[i])
          if (KEYS[i] === 'tasks:days') {
            await expect(bar.nth(i)).not.toHaveAttribute('data-day-segment-done')
          } else {
            await expect(bar.nth(i)).toHaveAttribute('data-day-segment-done', '')
          }
        }

        // An empty segment's bar still goes to its section.
        await bar.nth(ORDER.indexOf('eventually')).click()
        await expect(sections.nth(ORDER.indexOf('eventually'))).toBeInViewport()

        // Eight segments after the periods still fit a phone: no sideways scroll.
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        )
        expect(overflow).toBeLessThanOrEqual(0)
      } finally {
        await trash(page, ids)
      }
    })

    test('/reminders headline: reminders and tasks counted apart, done only when both are', async ({
      page,
    }) => {
      await headlineCountsApart(page, viewport.width < 640)
    })
  })
}

/**
 * REMINDERS AND TASKS, COUNTED APART (Trent, 2026-10-26, ruling "B"): with
 * the switch on the headline counts the periods as reminders and every task
 * segment as tasks, by each segment's own "X of Y" — the line, the count and
 * the progressbar alike — and turns green only once both are handled. Full
 * words at every width (layout "b": no "rem"); on a phone the count has its
 * own line under the full-width bar, from 640px it sits beside the bar. Two
 * Anytime reminders (always "so far", whatever the hour) and one Daily task.
 */
async function headlineCountsApart(page: Page, phone: boolean) {
  const ids: number[] = []
  try {
    const taskId = await create(page, { title: uniqueTitle('SA headline'), horizon: 'days' })
    ids.push(taskId)
    for (const n of [1, 2]) {
      ids.push(
        await create(page, {
          title: uniqueTitle(`SA anytime ${n}`),
          is_reminder: true,
          rrule: null,
        }),
      )
    }
    await page.goto('/reminders')
    const headline = page.locator('[data-reminders-headline]')
    const line = headline.locator('h1')
    const count = headline.locator('[data-day-count]')

    await expect(line).toHaveText('2 reminders · 1 task waiting so far', { useInnerText: true })
    await expect(count).toHaveText('0 of 2 reminders · 0 of 1 task considered', {
      useInnerText: true,
    })
    await expect(count).toHaveAttribute('aria-valuenow', '0')
    await expect(count).toHaveAttribute('aria-valuemax', '3')
    await expect(count).toHaveAttribute(
      'aria-label',
      '0 of 2 reminders and 0 of 1 task considered today',
    )
    await expectCountPlacement(headline, phone)

    // The task considered: the tasks half leaves the line, climbs in the count.
    await page
      .locator(`[data-task-segments] [data-segment-task="${taskId}"]`)
      .getByRole('button', { name: /as considered/ })
      .click()
    await expect(line).toHaveText('2 reminders waiting so far', { useInnerText: true })
    await expect(count).toHaveText('0 of 2 reminders · 1 of 1 task considered', {
      useInnerText: true,
    })
    await expect(count).toHaveAttribute('aria-valuenow', '1')

    // "Considered all so far" is the reminders' (it says so), and with
    // both halves handled the day is done.
    await page
      .getByRole('button', { name: 'Mark all 2 reminders waiting so far as considered' })
      .click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Consider all 2' }).click()
    await expect(line).toHaveText('All clear for today')
    await expect(count).toHaveText('All 2 reminders · 1 task considered today', {
      useInnerText: true,
    })
    await expect(count).toHaveAttribute('aria-valuenow', '3')
    await expect(count).toHaveAttribute(
      'aria-label',
      '2 of 2 reminders and 1 of 1 task considered today',
    )
    await expectCountPlacement(headline, phone)
  } finally {
    await trash(page, ids)
  }
}

/**
 * Layout "b" (Trent, 2026-10-26). A phone: the count on its own line, wholly
 * below the bar, and the bar the full width of its row. From 640px: one
 * line, the count beside the bar (their boxes share a band, the count to the
 * bar's right).
 */
async function expectCountPlacement(headline: Locator, phone: boolean) {
  const bar = (await headline.locator('[data-day-bar]').boundingBox())!
  const row = (await headline.locator('[data-day-row]').boundingBox())!
  const count = (await headline.locator('[data-day-count]').boundingBox())!
  if (phone) {
    expect(count.y, 'the count starts below the bar').toBeGreaterThanOrEqual(bar.y + bar.height)
    expect(bar.width, "the bar takes the row's whole width").toBe(row.width)
    expect(bar.x).toBe(row.x)
  } else {
    expect(count.y, 'the count shares the bar’s line').toBeLessThan(bar.y + bar.height)
    expect(count.y + count.height).toBeGreaterThan(bar.y)
    expect(count.x, 'the count is right of the bar').toBeGreaterThanOrEqual(bar.x + bar.width)
  }
}

/**
 * The iOS app's Dynamic Type, as `ios/OpenTask/WebView.swift` applies it: at
 * document end it sets the root font size to the text size's percentage, and
 * every rem in the layout grows with it. 119% is "xxxLarge", the largest
 * size outside the accessibility sizes, and Trent's phone (2026-10-26).
 */
async function appTextSize(page: Page, percent: string) {
  await page.addInitScript((size) => {
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.style.fontSize = size
    })
  }, percent)
}

/**
 * A pasted link is one unbreakable word. At 119% a task segment row's four
 * 52px controls leave its title a ~76px column on a 402px phone, so this
 * title's link ran ~450px past it (Trent's phone, 2026-10-26: the page 532px
 * wide, which let iOS zoom the whole app out, and a sheet opened in that state
 * squeezed the page to half the screen). It must wrap inside its column.
 */
const LINK_TITLE =
  'Read this thread later https://social.example.com/sample_account/status/1234567890123456789?s=20&t=AbCdEfGhIjKlMnOpQrStUv'

/** A long plain title, for the wrap around the row's buttons. */
const LONG_TITLE =
  'Call the county office about the property tax appeal paperwork and ask whether the extension form needs a notary'

/**
 * A segment row's layout (2026-10-26, compact buttons, Trent's mock "B"):
 * each of the button group's hit areas, height included the done square's
 * `after:` box; and the title's lines — the first beside the group, which
 * floats right in the title's column, the second from the column's left edge
 * and running on under the group.
 */
async function segmentRowLayout(row: Locator) {
  return row.evaluate((li) => {
    const group = li.querySelector('[data-segment-actions]')!.getBoundingClientRect()
    const hits = Array.from(li.querySelectorAll('[data-segment-actions] button')).map((b) => {
      const r = b.getBoundingClientRect()
      const after = getComputedStyle(b, '::after')
      const grow =
        after.content !== 'none' && after.position === 'absolute'
          ? Math.max(0, -parseFloat(after.top)) + Math.max(0, -parseFloat(after.bottom))
          : 0
      const growLeft =
        after.content !== 'none' && after.position === 'absolute'
          ? Math.max(0, -parseFloat(after.left))
          : 0
      return {
        name: b.getAttribute('aria-label') ?? '',
        height: r.height + grow,
        left: r.left - growLeft,
        right: r.right,
      }
    })
    const today = li.querySelector('[data-segment-actions] [data-target-today]')!
    const todayRight = today.getBoundingClientRect().right
    const done = hits[hits.length - 1]
    const p = li.querySelector('p')!
    const text = p.firstChild as Text
    const lines: { left: number; right: number }[] = []
    let top = Number.NaN
    for (const m of text.data.matchAll(/\S+/g)) {
      const range = document.createRange()
      range.setStart(text, m.index!)
      range.setEnd(text, m.index! + m[0].length)
      const r = range.getClientRects()[0]
      if (Math.round(r.top) !== top) {
        top = Math.round(r.top)
        lines.push({ left: r.left, right: r.right })
      } else lines[lines.length - 1].right = r.right
    }
    return {
      groupLeft: group.left,
      titleLeft: p.getBoundingClientRect().left,
      hits,
      lines,
      todayToDone: done.left - todayRight,
    }
  })
}

/**
 * THE DAY BAR FITS A PHONE (2026-10-24). On real data — five periods of 20-odd
 * reminders each, every task segment — the bar's thumb-wide minimums pushed
 * the count beside it 7px off a 375 screen. Six periods of 21 reminders, all
 * eight segments (the switch on): at 375 and 320 the page never scrolls
 * sideways and the count is whole and on screen.
 *
 * And at the iOS app's text sizes (2026-10-26), with a long link in a task
 * segment row's title (`LINK_TITLE`): 375 and 402 (an iPhone 17 Pro) at 100%,
 * 119% ("xxxLarge", Trent's phone) and 150% (the largest accessibility size,
 * `WebView.swift`). There the rows' buttons are checked too: every hit area
 * at least 44px tall, 12px of dead space between Today's and the done square's,
 * and a long title's first line beside them, its second from the row's left
 * edge.
 */
for (const { textSize, widths } of [
  { textSize: '100%', widths: [375, 402, 320] },
  { textSize: '119%', widths: [375, 402] },
  { textSize: '150%', widths: [375, 402] },
]) {
  test(`the /reminders day bar fits at ${widths.join(' and ')} with six full periods and every segment, text ${textSize}`, async ({
    page,
  }) => {
    await appTextSize(page, textSize)
    await dayBarFits(page, widths)
  })
}

async function dayBarFits(page: Page, widths: number[]) {
  test.setTimeout(120_000)
  const ids: number[] = []
  let addedSlot: number | null = null
  try {
    // A sixth period (the user has the five defaults).
    const made = await page.request.post('/api/time-slots', {
      data: { label: 'Late night', start_time: '22:30' },
    })
    expect(made.ok()).toBeTruthy()
    addedSlot = (await made.json()).data.id as number
    const slots = (await (await page.request.get('/api/time-slots')).json()).data.time_slots as {
      start_time: string
    }[]
    expect(slots.length).toBeGreaterThanOrEqual(6)
    for (const slot of slots) {
      const [h, m] = slot.start_time.split(':').map(Number)
      const made = await Promise.all(
        Array.from({ length: 21 }, (_, i) =>
          create(page, {
            title: uniqueTitle(`SA fit ${slot.start_time} ${i}`),
            is_reminder: true,
            rrule: `FREQ=DAILY;BYHOUR=${h};BYMINUTE=${m}`,
          }),
        ),
      )
      ids.push(...made)
    }
    ids.push(await create(page, { title: uniqueTitle('SA fit daily'), horizon: 'days' }))
    const linkId = await create(page, { title: uniqueTitle(LINK_TITLE), horizon: 'days' })
    ids.push(linkId)
    const longId = await create(page, { title: uniqueTitle(LONG_TITLE), horizon: 'days' })
    ids.push(longId)

    for (const width of widths) {
      await page.setViewportSize({ width, height: 812 })
      await page.goto('/reminders')
      const headline = page.locator('[data-reminders-headline]')
      await expect(headline.locator('[data-day-segment^="tasks:"]')).toHaveCount(ORDER.length)
      await expect(
        headline.locator('[data-day-segment]:not([data-day-segment^="tasks:"])'),
      ).toHaveCount(slots.length)

      // The link's row is on the page.
      const linkRow = page.locator(`[data-task-segments] [data-segment-task="${linkId}"]`)
      await expect(linkRow).toBeVisible()

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      )
      expect(overflow, `sideways scroll at ${width}`).toBeLessThanOrEqual(0)

      // A wrapped headline line never starts with the " · " (2026-10-26, Trent:
      // "drop the dot at the wrap"): every separator that begins a line sits in
      // the clipped strip left of its box, so none is visible there.
      const dotStartsALine = await headline.evaluate((root) => {
        const lines = new Map<number, { left: number; sep: boolean }>()
        for (const box of root.querySelectorAll<HTMLElement>('[data-joined]')) {
          const clip = box.getBoundingClientRect()
          for (const item of box.querySelectorAll<HTMLElement>('[data-joined-item]')) {
            const r = item.getBoundingClientRect()
            const sep = item.querySelector('[data-joined-sep]')!
            const sepVisible = sep.textContent !== '' && r.left >= clip.left - 0.5
            const top = Math.round(r.top)
            const seen = lines.get(top)
            if (!seen || r.left < seen.left) lines.set(top, { left: r.left, sep: sepVisible })
          }
        }
        return [...lines.values()].some((l) => l.sep)
      })
      expect(dotStartsALine, `a headline line starts with a dot at ${width}`).toBe(false)

      // And its title wraps inside its column (a title spilling over a row
      // still inside the page is no better).
      const titleSpills = await linkRow
        .locator('p')
        .first()
        .evaluate((el) => el.scrollWidth > el.clientWidth)
      expect(titleSpills, `the link's title runs out of its column at ${width}`).toBe(false)

      // The buttons: every hit area a finger's height; the long title's first
      // line beside them, its second from the column's left edge and on past
      // where the buttons begin (the title wraps around them).
      const longRow = page.locator(`[data-task-segments] [data-segment-task="${longId}"]`)
      await longRow.scrollIntoViewIfNeeded()
      const layout = await segmentRowLayout(longRow)
      expect(layout.hits.length, `the row's buttons at ${width}`).toBeGreaterThanOrEqual(4)
      for (const hit of layout.hits) {
        expect(hit.height, `${hit.name}'s hit height at ${width}`).toBeGreaterThanOrEqual(44)
      }
      // Dead space between Today's and the done square's hit areas, so a tap
      // meant for one never lands on the other (Trent mis-tapped Today for
      // done, 2026-10-12, and ruled 12px).
      expect(layout.todayToDone, `Today to done at ${width}`).toBeGreaterThanOrEqual(12)
      expect(layout.lines.length, `the long title's lines at ${width}`).toBeGreaterThanOrEqual(2)
      const [first, second] = layout.lines
      expect(first.right, `the first line ends before the buttons at ${width}`).toBeLessThanOrEqual(
        layout.groupLeft,
      )
      expect(
        Math.abs(second.left - layout.titleLeft),
        `the second line's start at ${width}`,
      ).toBeLessThan(1)
      expect(second.right, `the second line runs under the buttons at ${width}`).toBeGreaterThan(
        layout.groupLeft,
      )

      // The count: whole (never clipped) and inside the screen.
      const count = headline.locator('[data-day-count]')
      await expect(count).toBeVisible()
      const box = (await count.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width, `count's right edge at ${width}`).toBeLessThanOrEqual(width)
      const clipped = await count.evaluate((el) => el.scrollWidth > el.clientWidth)
      expect(clipped).toBe(false)

      // Every bar on screen too, none collapsed to nothing, all above the
      // count (a phone's count has its own line — layout "b", 2026-10-26).
      const bars = await headline
        .locator('[data-day-segment]')
        .evaluateAll((els) => els.map((el) => el.getBoundingClientRect()))
      for (const r of bars) {
        expect(r.width).toBeGreaterThan(0)
        expect(r.left).toBeGreaterThanOrEqual(0)
        expect(r.right).toBeLessThanOrEqual(width)
        expect(r.bottom).toBeLessThanOrEqual(box.y)
      }
    }
  } finally {
    await trash(page, ids)
    if (addedSlot !== null) await page.request.delete(`/api/time-slots/${addedSlot}`)
  }
}
