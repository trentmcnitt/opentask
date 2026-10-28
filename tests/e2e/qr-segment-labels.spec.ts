/**
 * Labels on task rows: a chip is NEVER cut (Trent, 2026-10-24).
 *
 * The task-segment rows (the dashboard's Tasks card and /reminders) show the
 * task's labels on their meta line with the dashboard row's chips
 * (`LabelBadges`: every label since 2026-10-28; two, then "+N", before). Until 10-24 they were clipped into what the
 * line had left, with a fade (a long chip lost its end on a phone); now the
 * meta line wraps and the chips move, whole, to a second meta line — the
 * dashboard's `TaskRow` approach. The row's controls stay where they are.
 *
 * Two long labels on a Days row and on an Upcoming row ("Task queue ·
 * Upcoming"), each beside a bare twin with the same title, plus a Days row
 * with one label longer than any row (labels allow 100 characters): at 390,
 * 1280, 1440 and 1600, on the dashboard's Tasks card (and the Upcoming task's
 * `TaskRow` in the Now list) and on /reminders, every chip shows its whole
 * label — no chip scrolls, no ancestor up to the page clips or fades it — and
 * sits inside its row's box; the controls sit at the same offset as the bare
 * twin's; nothing scrolls sideways.
 *
 * The queue's own user, with a quota for the file's length: a quota puts the
 * dashboard in two columns at `xl` (`twoColumn` in `DashboardClient`; this
 * app's `xl` is 1450px, so 1280 and 1440 are the single 640px column), and at
 * 1600 the Tasks card is the right-hand column (`dashboard-layout.spec.ts`
 * uses 1600 for the same reason: past the breakpoint whatever the scrollbar).
 * The Days rows and the Upcoming rows are checked one after the other, so each
 * is the natural page of that card.
 * Isolation: unique titles and label names; tasks trashed and labels deleted
 * in `finally`.
 */
import path from 'path'
import Database from 'better-sqlite3'
import { DateTime } from 'luxon'
import { test, expect, uniqueTitle } from './fixtures'
import type { Locator, Page } from '@playwright/test'

const TZ = process.env.E2E_TZ || 'America/Chicago'
const DAY = 24 * 60 * 60 * 1000
const SIZES = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1600, height: 900 },
]

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

function withDb(fn: (db: Database.Database) => void) {
  const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
  try {
    fn(db)
  } finally {
    db.close()
  }
}

/** Created yesterday, so a Days task shows in its segment today. */
function madeYesterday(ids: number[]) {
  withDb((db) => {
    const stmt = db.prepare(
      `UPDATE tasks SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day') WHERE id = ?`,
    )
    for (const id of ids) stmt.run(id)
  })
}

/** Targeted 10 days ago for tomorrow: today is a heads-up day at any hour. */
function targetedLongAgo(ids: number[]) {
  withDb((db) => {
    const stmt = db.prepare('UPDATE tasks SET target_set_at = ? WHERE id = ?')
    for (const id of ids) stmt.run(new Date(Date.now() - 10 * DAY).toISOString(), id)
  })
}

const tomorrowAt = (hour: number) =>
  DateTime.now().setZone(TZ).plus({ days: 1 }).set({ hour, minute: 0 }).toUTC().toISO()!

/**
 * Every chip of the row shows its whole label: the chip doesn't scroll, no
 * ancestor that clips (any `overflow` but visible) cuts it, none fades it
 * (`mask-image`), and it lies inside the row's box. And the page doesn't
 * scroll sideways.
 */
async function chipsWhole(row: Locator, labels: string[]) {
  const chips = row.locator('[data-label-badges] [data-slot="badge"]')
  await expect(chips).toHaveCount(labels.length)
  for (let i = 0; i < labels.length; i++) await expect(chips.nth(i)).toHaveText(labels[i])
  const problems = await row.evaluate((rowEl) => {
    const out: string[] = []
    const r = rowEl.getBoundingClientRect()
    const inside = (a: DOMRect, b: DOMRect) =>
      a.left >= b.left && a.right <= b.right && a.top >= b.top && a.bottom <= b.bottom
    const chips = rowEl.querySelectorAll<HTMLElement>('[data-label-badges] [data-slot="badge"]')
    for (const chip of chips) {
      const name = chip.textContent ?? ''
      const c = chip.getBoundingClientRect()
      if (chip.scrollWidth > chip.clientWidth) out.push(`${name}: scrolls inside its chip`)
      if (!inside(c, r)) out.push(`${name}: outside its row`)
      for (let el = chip.parentElement; el && el !== document.body; el = el.parentElement) {
        const s = getComputedStyle(el)
        if (s.maskImage && s.maskImage !== 'none') out.push(`${name}: faded by an ancestor`)
        const clips = s.overflowX !== 'visible' || s.overflowY !== 'visible'
        if (clips && !inside(c, el.getBoundingClientRect())) {
          out.push(`${name}: clipped by <${el.tagName.toLowerCase()} class="${el.className}">`)
        }
      }
    }
    if (document.documentElement.scrollWidth > window.innerWidth) out.push('page scrolls sideways')
    return out
  })
  expect(problems).toEqual([])
}

/** The row's controls (its last child) sit where the bare twin's do. */
async function controlsInPlace(row: Locator, twin: Locator) {
  const offset = (el: Element) => {
    const li = el.getBoundingClientRect()
    const c = (el.lastElementChild as Element).getBoundingClientRect()
    return { top: c.top - li.top, right: li.right - c.right, width: c.width }
  }
  expect(await row.evaluate(offset)).toEqual(await twin.evaluate(offset))
}

/** At 1600 the dashboard's Tasks card is the right-hand column. */
async function twoColumnsAtXl(page: Page, url: string) {
  if (url !== '/' || page.viewportSize()!.width < 1600) return
  const card = page.locator('[data-tasks-page]')
  await expect(card).toBeVisible()
  const { width, x } = (await card.boundingBox())!
  expect(width).toBeLessThan(page.viewportSize()!.width / 2)
  expect(x).toBeGreaterThan(page.viewportSize()!.width / 2)
}

test.beforeEach(async ({ page }) => {
  await signIn(page)
})

test('a label chip is never cut: segment rows, Upcoming rows and the task row wrap it whole', async ({
  page,
}) => {
  const ids: number[] = []
  const stamp = Date.now().toString(36)
  const two = ['quarterly-paperwork-pile', 'waiting-on-a-reply-from'].map((l) => `${l}-${stamp}`)
  // Longer than any row is wide, even at 1440 (labels allow 100 characters).
  const huge = `one-very-long-label-that-is-longer-than-the-row-is-wide-at-any-size-${stamp}`
  const labels = [...two, huge]
  let quota: number | null = null
  try {
    for (const name of labels) {
      const res = await page.request.post('/api/labels', { data: { name } })
      expect(res.ok(), `label ${name}`).toBeTruthy()
    }
    quota = await create(page, {
      title: uniqueTitle('SL quota'),
      progress_target: 2,
      rrule: 'FREQ=WEEKLY',
    })

    // 1. Days rows (the dashboard card's natural page while they wait).
    const daysTitle = uniqueTitle('SL days row')
    const days = await create(page, { title: daysTitle, horizon: 'days', priority: 2, labels: two })
    const daysBare = await create(page, { title: daysTitle, horizon: 'days', priority: 2 })
    const daysHuge = await create(page, {
      title: uniqueTitle('SL huge label'),
      horizon: 'days',
      labels: [huge],
    })
    ids.push(days, daysBare, daysHuge)
    madeYesterday([days, daysBare, daysHuge])

    for (const size of SIZES) {
      await page.setViewportSize(size)
      for (const url of ['/', '/reminders']) {
        await page.goto(url)
        await twoColumnsAtXl(page, url)
        const row = page.locator(`[data-segment-task="${days}"]`)
        const bare = page.locator(`[data-segment-task="${daysBare}"]`)
        await expect(row).toBeVisible()
        await expect(bare).toBeVisible()
        await chipsWhole(row, two)
        await chipsWhole(page.locator(`[data-segment-task="${daysHuge}"]`), [huge])
        await expect(bare.locator('[data-label-badges]')).toHaveCount(0)
        await controlsInPlace(row, bare)
      }
    }
    await page.request.post('/api/tasks/bulk/delete', { data: { ids: [days, daysBare, daysHuge] } })

    // 2. Upcoming rows: "Inbox · Medium · Target <tomorrow> ⌄ · chip chip".
    const upTitle = uniqueTitle('SL upcoming row')
    const up = await create(page, {
      title: upTitle,
      target_at: tomorrowAt(10),
      priority: 2,
      labels: two,
    })
    const upBare = await create(page, { title: upTitle, target_at: tomorrowAt(10), priority: 2 })
    ids.push(up, upBare)
    targetedLongAgo([up, upBare])

    for (const size of SIZES) {
      await page.setViewportSize(size)
      for (const url of ['/', '/reminders']) {
        await page.goto(url)
        await twoColumnsAtXl(page, url)
        const section = page.locator('[data-task-segment="upcoming"]')
        const row = section.locator(`[data-segment-task="${up}"]`)
        const bare = section.locator(`[data-segment-task="${upBare}"]`)
        await expect(row).toBeVisible()
        await chipsWhole(row, two)
        await expect(bare.locator('[data-label-badges]')).toHaveCount(0)
        await controlsInPlace(row, bare)
        if (url === '/') {
          // The same task's dashboard row (today's Upcoming heads-up is "now").
          const taskRow = page.locator(`#task-row-${up}`)
          await expect(taskRow).toBeVisible()
          await chipsWhole(taskRow, two)
        }
      }
    }
  } finally {
    if (quota) ids.push(quota)
    if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
    for (const name of labels) await page.request.delete(`/api/labels/${encodeURIComponent(name)}`)
  }
})

/**
 * EVERY LABEL SHOWS (2026-10-28, Trent: "I don't want to hide tags"): a row
 * with five labels shows five whole chips and no "+N" — the segment row (the
 * dashboard's Tasks card and /reminders) and the dashboard's task row —
 * wrapping with the meta line, at a phone's width and a desktop's.
 */
test('every label shows: five chips, no "+N"', async ({ page }) => {
  const ids: number[] = []
  const stamp = Date.now().toString(36)
  const five = ['errands', 'kitchen', 'weekend', 'call-back', 'paperwork'].map(
    (l) => `${l}-${stamp}`,
  )
  try {
    for (const name of five) {
      const res = await page.request.post('/api/labels', { data: { name } })
      expect(res.ok(), `label ${name}`).toBeTruthy()
    }
    // Upcoming: on the Tasks card, on /reminders and in the Now list.
    const id = await create(page, {
      title: uniqueTitle('SL five labels'),
      target_at: tomorrowAt(10),
      labels: five,
    })
    ids.push(id)
    targetedLongAgo([id])
    for (const size of [SIZES[0], SIZES[1]]) {
      await page.setViewportSize(size)
      for (const url of ['/', '/reminders']) {
        await page.goto(url)
        const rows = [
          page.locator('[data-task-segment="upcoming"]').locator(`[data-segment-task="${id}"]`),
        ]
        if (url === '/') rows.push(page.locator(`#task-row-${id}`))
        for (const row of rows) {
          await expect(row).toBeVisible()
          await chipsWhole(row, five)
          await expect(row.locator('[data-label-badges]')).not.toContainText(/\+\d/)
        }
      }
    }
  } finally {
    if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
    for (const name of five) await page.request.delete(`/api/labels/${encodeURIComponent(name)}`)
  }
})

/**
 * AI LABELS (2026-10-28, Trent: "anything AI shows the Bot glyph, wherever it
 * appears"): on a row, `ai-proposed` and `ai-failed` wear the glyph and
 * `ai-added` / `ai-monitored` aren't shown ("irrelevant unless I'm doing
 * forensics"); the editor shows every one, the AI ones with the glyph. The
 * task keeps all its labels — display only.
 */
test('AI labels: the Bot glyph; ai-added and ai-monitored only in the editor', async ({ page }) => {
  const ids: number[] = []
  const stamp = Date.now().toString(36)
  const plain = `chores-${stamp}`
  const ai = ['ai-proposed', 'ai-failed', 'ai-added', 'ai-monitored']
  try {
    expect((await page.request.post('/api/labels', { data: { name: plain } })).ok()).toBeTruthy()
    const id = await create(page, {
      title: uniqueTitle('SL ai labels'),
      target_at: tomorrowAt(10),
      labels: [plain, ...ai],
    })
    ids.push(id)
    targetedLongAgo([id])
    // The task keeps every label.
    const stored = (await (await page.request.get(`/api/tasks/${id}`)).json()).data.labels
    expect([...stored].sort()).toEqual([plain, ...ai].sort())

    await page.goto('/')
    const chips = page.locator(`#task-row-${id} [data-label-badges] [data-slot="badge"]`)
    await expect(chips).toHaveText([plain, 'ai-proposed', 'ai-failed'])
    await expect(chips.nth(0).locator('[data-ai-label-glyph]')).toHaveCount(0)
    await expect(chips.nth(1).locator('[data-ai-label-glyph]')).toHaveCount(1)
    await expect(chips.nth(2).locator('[data-ai-label-glyph]')).toHaveCount(1)

    await page.goto(`/tasks/${id}`)
    for (const name of ai) {
      const chip = page.locator('[data-slot="badge"]', { hasText: name }).first()
      await expect(chip).toBeVisible()
      await expect(chip.locator('[data-ai-label-glyph]')).toHaveCount(1)
    }
    const plainChip = page.locator('[data-slot="badge"]', { hasText: plain }).first()
    await expect(plainChip.locator('[data-ai-label-glyph]')).toHaveCount(0)
  } finally {
    if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
    await page.request.delete(`/api/labels/${encodeURIComponent(plain)}`)
  }
})
