/**
 * ONLY THE SEGMENTS WITH ROWS (Trent, 2026-10-30, reversing 10-24's "always
 * show every queue segment, every day"; docs/TASK-MODEL.md § Task segments).
 * With the task-queue switch on, the server still sends every kind
 * (`?fill=1`), and the web shows only the ones with rows today — waiting or
 * considered — in `SEGMENT_ORDER`, the deadlines page first, on the
 * dashboard's Tasks card and on /reminders. A segment finished today keeps
 * its rows, so it stays, done, until the rollover. With one segment the
 * card's strip still shows its one word; a hidden group leaves no stray
 * hairline.
 *
 * Its own user (`queue@opentask.local`, as tq-queue-panels): with the switch
 * on, the minute cron's rollover would strip the shared user's past-target
 * one-offs. Here it holds a Daily one-off and, part-way, a deadline on the
 * deadlines page (and, for /reminders' day bar, reminders). Unique titles;
 * everything trashed in `finally`; the switch off again after the file.
 */
import path from 'path'
import Database from 'better-sqlite3'
import { test, expect, backdateCreated, uniqueTitle } from './fixtures'
import type { Locator, Page } from '@playwright/test'

const TZ = process.env.E2E_TZ || 'America/Chicago'
test.use({ timezoneId: TZ })

/**
 * SEGMENT_ORDER (src/lib/task-segments.ts), as the web's screens key them:
 * the queue's two panels are ONE "Pulled" segment there since 2026-10-29
 * (`mergePulled`), drawn as `queue_today`.
 */
const ORDER = ['deadlines', 'upcoming', 'queue_today', 'days', 'weeks', 'months', 'eventually']
const DAY = 24 * 60 * 60 * 1000

/** A deadline five days out with a long lead: on the deadlines page today. */
const deadlineTask = () => ({
  title: uniqueTitle('SA deadline'),
  deadline_at: new Date(Date.now() + 5 * DAY).toISOString(),
  lead_days: 30,
})

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('queue@opentask.local')
  await page.getByLabel('Password').fill('testpass123')
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL('/', { timeout: 10_000 })
}

/**
 * Made "yesterday": a task made today waits for its segment's next cadence
 * day (2026-10-31), and this spec reads tasks in today's segments.
 */
async function create(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), `create ${JSON.stringify(data)}`).toBeTruthy()
  const id = (await res.json()).data.id as number
  backdateCreated([id], { inSegments: true })
  return id
}

async function trash(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

/** The user's own open tasks that sit in a segment today — this file wants only its own. */
async function segmentRowIds(page: Page): Promise<number[]> {
  const res = await page.request.get('/api/reminders?queue=1&deck=1&handled=1&deadlines=1')
  const segs = (await res.json()).data.task_segments as { tasks: { id: number }[] }[]
  return segs.flatMap((s) => s.tasks.map((t) => t.id))
}

/** The kinds the web draws today — those with rows, Pulled's two panels as one. */
async function drawnKinds(page: Page): Promise<string[]> {
  const res = await page.request.get('/api/reminders?queue=1&deck=1&handled=1&deadlines=1&fill=1')
  const segs = (await res.json()).data.task_segments as { horizon: string; tasks: unknown[] }[]
  const kinds = segs
    .filter((s) => s.tasks.length > 0)
    .map((s) => (s.horizon === 'queue_previous' ? 'queue_today' : s.horizon))
  return ORDER.filter((k) => kinds.includes(k))
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

    test('the dashboard card: only segments with rows, in order; one alone keeps its word; a finished one stays', async ({
      page,
    }) => {
      const ids: number[] = []
      try {
        ids.push(await create(page, { title: uniqueTitle('SA daily'), horizon: 'days' }))
        // Only one segment has rows (nothing left behind by another spec).
        expect(await segmentRowIds(page)).toEqual(ids)

        await page.goto('/')
        const card = page.locator('[data-tasks-panel]')
        await expect(card).toHaveAttribute('data-tasks-page', 'tasks:days')
        await expect(card.locator(`[data-segment-task="${ids[0]}"]`)).toBeVisible()

        // One segment with rows: one bar, its word still shown; no hairline.
        const bars = card.locator('[data-slot-segment]')
        await expect(bars).toHaveCount(1)
        await expect(bars.first()).toHaveAttribute('data-slot-segment', 'tasks:days')
        await expect(bars.first().locator('[data-strip-word]')).toBeVisible()
        await expect(card.locator('[data-strip-group-divider]')).toHaveCount(0)

        // A deadline joins: the deadlines page's bar, FIRST, one hairline
        // between the two groups (Dated | Horizon), nothing in between.
        ids.push(await create(page, deadlineTask()))
        await page.reload()
        await expect(bars).toHaveCount(2)
        await expect(bars.nth(0)).toHaveAttribute('data-slot-segment', 'tasks:deadlines')
        await expect(bars.nth(1)).toHaveAttribute('data-slot-segment', 'tasks:days')
        await expect(card.locator('[data-strip-group-divider]')).toHaveCount(1)

        // The chevrons step through those two only.
        const prev = card.getByRole('button', { name: 'Previous task segment' })
        const next = card.getByRole('button', { name: 'Next task segment' })
        await expect(card).toHaveAttribute('data-tasks-page', 'tasks:deadlines')
        await expect(prev).toBeDisabled()
        await next.click()
        await expect(card).toHaveAttribute('data-tasks-page', 'tasks:days')
        await expect(next).toBeDisabled()

        // The deadline considered: its segment is finished, and STAYS, done.
        const res = await page.request.post('/api/task-segments/consider', {
          data: { ids: [ids[1]] },
        })
        expect(res.ok()).toBeTruthy()
        await page.reload()
        await expect(bars).toHaveCount(2)
        await expect(bars.nth(0)).toHaveAttribute('data-slot-state', 'done')
        await expect(bars.nth(1)).toHaveAttribute('data-slot-state', 'behind')
      } finally {
        await trash(page, ids)
      }
    })

    test('/reminders: only sections and day-bar segments with rows, in order, deadlines first', async ({
      page,
    }) => {
      const ids: number[] = []
      try {
        ids.push(await create(page, { title: uniqueTitle('SA daily'), horizon: 'days' }))
        ids.push(await create(page, deadlineTask()))
        // A reminder in every period today, so the headline's day bar has
        // every period's bar before the task segments'.
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
        // Consider the deadline: finished today, it stays (done).
        const res = await page.request.post('/api/task-segments/consider', {
          data: { ids: [ids[1]] },
        })
        expect(res.ok()).toBeTruthy()
        await page.goto('/reminders')

        const sections = page.locator('[data-task-segments] [data-task-segment]')
        await expect(sections).toHaveCount(2)
        await expect(sections.nth(0)).toHaveAttribute('data-task-segment', 'deadlines')
        await expect(sections.nth(1)).toHaveAttribute('data-task-segment', 'days')
        await expect(sections.nth(1).locator(`[data-segment-task="${ids[0]}"]`)).toBeVisible()
        await expect(page.locator('[data-task-segments] [data-segment-empty]')).toHaveCount(0)

        const bar = page.locator('[data-reminders-headline] [data-day-segment^="tasks:"]')
        await expect(bar).toHaveCount(2)
        await expect(bar.nth(0)).toHaveAttribute('data-day-segment', 'tasks:deadlines')
        await expect(bar.nth(0)).toHaveAttribute('data-day-segment-done', '')
        await expect(bar.nth(1)).toHaveAttribute('data-day-segment', 'tasks:days')
        await expect(bar.nth(1)).not.toHaveAttribute('data-day-segment-done')

        // A finished segment's bar still goes to its section.
        await bar.nth(0).click()
        await expect(sections.nth(0)).toBeInViewport()

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
 * the count beside it 7px off a 375 screen. Six periods of 21 reminders and
 * every segment with rows (the switch on; empty ones hidden since 2026-10-30):
 * at 375 and 320 the page never scrolls sideways and the count is whole and
 * on screen.
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
      // Every segment with rows (2026-10-30: the empty ones are hidden).
      await expect(headline.locator('[data-day-segment^="tasks:"]')).toHaveCount(
        (await drawnKinds(page)).length,
      )
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

/**
 * THE HORIZONS BY NAME (Trent, 2026-10-30: "dot makes no sense without the
 * other dots around it"): the strip writes "Days", "Weeks" … like its other
 * words, and falls back to the dots only when the words don't fit
 * (`useStripWords`) — here, the card squeezed to 100px (the three words need ~124).
 */
test('the strip writes the horizons, and shows their dots only when the words do not fit', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const ids: number[] = []
  try {
    ids.push(await create(page, { title: uniqueTitle('SA words daily'), horizon: 'days' }))
    const weekly = await create(page, { title: uniqueTitle('SA words weekly'), horizon: 'weeks' })
    ids.push(weekly)
    // Made a month ago: in Weeks today, whatever the check-in day.
    const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
    try {
      db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(
        new Date(Date.now() - 30 * DAY).toISOString(),
        weekly,
      )
    } finally {
      db.close()
    }
    ids.push(await create(page, deadlineTask()))
    await page.goto('/')
    const card = page.locator('[data-tasks-panel]')
    const strip = card.getByRole('group', { name: "Today's task segments" })
    const word = (key: string) => strip.locator(`[data-slot-segment="${key}"] [data-strip-word]`)
    await expect(word('tasks:days')).toHaveText('Days', { useInnerText: true })
    await expect(word('tasks:weeks')).toHaveText('Weeks', { useInnerText: true })
    await expect(word('tasks:deadlines')).toHaveText(/^(Deadlines|Due)$/, { useInnerText: true })
    await expect(strip).not.toHaveAttribute('data-strip-dots')

    // Squeezed: the horizons' words give way to their dots; the others stay.
    await page.addStyleTag({ content: '[data-tasks-panel] { width: 100px !important; }' })
    await expect(strip).toHaveAttribute('data-strip-dots', '')
    await expect(word('tasks:days')).toHaveText('', { useInnerText: true })
    await expect(word('tasks:days').locator('*').first()).toBeVisible()
    await expect(word('tasks:deadlines')).toHaveText('Due', { useInnerText: true })
    // Room again: the words come back.
    await page.evaluate(() =>
      document.querySelectorAll('style').forEach((s) => {
        if (s.textContent?.includes('[data-tasks-panel] { width: 100px')) s.remove()
      }),
    )
    await expect(strip).not.toHaveAttribute('data-strip-dots')
    await expect(word('tasks:weeks')).toHaveText('Weeks', { useInnerText: true })
  } finally {
    await trash(page, ids)
  }
})
