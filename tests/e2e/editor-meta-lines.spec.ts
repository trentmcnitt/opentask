/**
 * The task editor's meta lines wrap like prose (2026-10-25).
 *
 * Regression: at phone width the "this one" rows (`ThisOneFields`) came out
 * jumbled into two columns — "Not on / deck" beside "· a deck replaces /
 * target Tue 10 AM", "Horizon not in / effect ·" beside "Target set: quiet
 * until / Nov 3" — and "· since Tue" sat jammed against the "↻ Make it repeat
 * ›" box. Each fragment was its own flex item, so a narrow column made each
 * one a cell that wrapped on its own. Now every meta line is one inline run.
 *
 * THE CHECK (`expectProseFlow`): the line's text nodes (and icons), read in
 * DOM order, must read like one paragraph — each piece either continues the
 * same line just to the right of the last one, or starts a lower line at the
 * run's left edge. Two columns break it both ways: the second column starts
 * back up on the first line, far to the right of where the first one ended.
 * And nothing in the rows runs past their right edge, nor scrolls sideways.
 *
 * Hosts: the task page at 375 and 1280, the phone sheet at 375 and the
 * dashboard dialog at 1280. The deck line needs the task queue, so this runs
 * as the queue's own user with the switch on (off after the file), like
 * od-on-deck.spec.ts. Screenshots go to `.tmp/` (never committed).
 */
import path from 'path'
import Database from 'better-sqlite3'
import { test, expect, openTaskDay, uniqueTitle, withPreferences } from './fixtures'
import type { Locator, Page } from '@playwright/test'

const TZ = process.env.E2E_TZ || 'America/Chicago'
const DAY = 24 * 60 * 60 * 1000
const daysFromNow = (n: number) => new Date(Date.now() + n * DAY).toISOString()

test.use({ timezoneId: TZ })

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

/** Write a column the API never sets, straight in the E2E database. */
function sql(statement: string, ...args: unknown[]) {
  const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
  try {
    db.prepare(statement).run(...args)
  } finally {
    db.close()
  }
}

interface Made {
  /** A picked target 9 days out and a deadline after it: the busiest editor. */
  targeted: number
  /** On deck in 5 days. */
  decked: number
  /** No target, no deck: "Not on deck" and "· since …". */
  plain: number
  /** Sent to the queue from yesterday's deck: "· was on deck …". */
  wasDecked: number
}

async function makeTasks(page: Page): Promise<Made> {
  const targeted = await create(page, {
    title: uniqueTitle('Meta targeted'),
    due_at: daysFromNow(9),
    deadline_at: daysFromNow(12),
    horizon: 'days',
  })
  const decked = await create(page, { title: uniqueTitle('Meta decked'), horizon: 'weeks' })
  const deck = await page.request.post('/api/tasks/deck', {
    data: { ids: [decked], day: await openTaskDay(page, 5) },
  })
  expect(deck.ok(), await deck.text()).toBeTruthy()
  const plain = await create(page, { title: uniqueTitle('Meta plain'), horizon: 'weeks' })
  const wasDecked = await create(page, { title: uniqueTitle('Meta was decked') })
  sql(
    'UPDATE tasks SET queued_at = ?, queued_from_deck_day = ? WHERE id = ?',
    new Date().toISOString(),
    await openTaskDay(page, -1),
    wasDecked,
  )
  return { targeted, decked, plain, wasDecked }
}

/**
 * The line reads as one paragraph: in DOM order, every text fragment (and
 * icon) either continues the line it is on — starting right of the last one,
 * at most a few spaces on — or starts a lower line at the run's left edge.
 */
async function expectProseFlow(line: Locator, name: string): Promise<void> {
  await expect(line, name).toBeVisible()
  const problems = await line.evaluate((root) => {
    const run = root.getBoundingClientRect()
    const runLeft = run.left + parseFloat(getComputedStyle(root).paddingLeft)
    const pieces: { text: string; r: DOMRect }[] = []
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (n.nodeType === Node.ELEMENT_NODE) {
        if ((n as Element).tagName.toLowerCase() !== 'svg') continue
        const r = (n as Element).getBoundingClientRect()
        if (r.width > 1 && r.height > 1) pieces.push({ text: '<icon>', r })
        continue
      }
      if (!n.textContent?.trim()) continue
      const range = document.createRange()
      range.selectNodeContents(n)
      for (const r of range.getClientRects()) {
        if (r.width > 1 && r.height > 1) pieces.push({ text: n.textContent.trim(), r })
      }
    }
    const out: string[] = []
    for (let i = 1; i < pieces.length; i++) {
      const prev = pieces[i - 1]
      const cur = pieces[i]
      const sameLine = cur.r.top < prev.r.bottom && cur.r.bottom > prev.r.top
      const at = `"${prev.text}" → "${cur.text}"`
      if (sameLine) {
        const gap = cur.r.left - prev.r.right
        if (gap < -1 || gap > 12) out.push(`${at}: same line, gap ${Math.round(gap)}px`)
      } else if (cur.r.top < prev.r.bottom) {
        out.push(`${at}: goes back up a line`)
      } else if (Math.abs(cur.r.left - runLeft) > 1) {
        out.push(`${at}: a new line starts at ${Math.round(cur.r.left - runLeft)}px, not the edge`)
      }
    }
    return { pieces: pieces.length, out }
  })
  expect(problems.pieces, `${name}: has text`).toBeGreaterThan(0)
  expect(problems.out, name).toEqual([])
}

/** Nothing in the rows ends past their right edge, and the page doesn't scroll sideways. */
async function expectNoOverflow(page: Page, scope: Locator): Promise<void> {
  const rows = scope.locator('[data-this-one]')
  const past = await rows.evaluate((d) => {
    const edge = d.getBoundingClientRect().right
    const out: string[] = []
    for (const el of d.querySelectorAll('*')) {
      const r = el.getBoundingClientRect()
      if (r.width <= 1) continue
      if (r.right > edge + 0.5) out.push(`${el.tagName} ends at ${Math.round(r.right)} > ${edge}`)
    }
    return out
  })
  expect(past).toEqual([])
  const sideways = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(sideways).toBeLessThanOrEqual(0)
}

/**
 * The sheet slides in and the dialog zooms in: measure (and shoot) once their
 * animations have finished, not mid-transform (a looping spinner never does,
 * so it is left out).
 */
async function settled(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Infinity)
        .map((a) => a.finished),
    ),
  )
}

/** Every meta line the task has, checked in `scope` (the page, sheet or dialog). */
async function checkLines(page: Page, scope: Locator, which: keyof Made): Promise<void> {
  const rows = scope.locator('[data-this-one]')
  await expect(rows).toBeVisible()
  await settled(page)
  await expectProseFlow(rows.locator('[data-quick-panel-date]'), `${which}: target`)
  await expectProseFlow(rows.locator('[data-quick-panel-deck-words]'), `${which}: on deck`)
  await expectProseFlow(rows.locator('[data-quick-panel-repeat-line]'), `${which}: repeat link`)
  await expect(rows.locator('[data-quick-panel-repeat-line]')).toContainText('· since')
  if (which === 'targeted') {
    await expect(rows.locator('[data-quick-panel-deck-replaces]')).toBeVisible()
    await expectProseFlow(rows.locator('[data-quick-panel-deadline]'), `${which}: deadline`)
    await expectProseFlow(rows.locator('[data-lead-words]'), `${which}: lead time`)
    await expectProseFlow(rows.locator('[data-quick-panel-horizon-quiet]'), `${which}: horizon`)
  }
  if (which === 'wasDecked') {
    await expect(rows.locator('[data-quick-panel-was-on-deck]')).toBeVisible()
  }
  await expectNoOverflow(page, scope)
}

/** The busiest editor's screenshot (`.tmp/`, never committed), taken before the checks. */
async function shoot(page: Page, scope: Locator, kind: keyof Made, file: string): Promise<void> {
  if (kind !== 'targeted') return
  await expect(scope.locator('[data-this-one]')).toBeVisible()
  await settled(page)
  await page.screenshot({ path: file })
}

const KINDS: (keyof Made)[] = ['targeted', 'decked', 'plain', 'wasDecked']

test.describe.configure({ mode: 'serial' })

test.beforeEach(async ({ page }) => {
  await signIn(page)
  const res = await page.request.post('/api/test/task-queue', { data: { enabled: true } })
  expect(res.ok()).toBeTruthy()
})
test.afterAll(async ({ request }) => {
  await request.post('/api/test/task-queue', { data: { enabled: false } })
})

test.describe('1280', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('the task page and the dashboard dialog: every meta line is one run', async ({ page }) => {
    let made: Made | null = null
    try {
      made = await makeTasks(page)
      const ids = made
      for (const kind of KINDS) {
        await page.goto(`/tasks/${ids[kind]}`)
        await shoot(page, page.locator('main'), kind, '.tmp/meta-page-1280-light.png')
        await checkLines(page, page.locator('main'), kind)
      }
      await withPreferences(page, { default_grouping: 'unified' }, async () => {
        for (const kind of KINDS) {
          await page.goto('/')
          const row = page.locator(`#task-row-${ids[kind]}`)
          await row.evaluate((el) => el.scrollIntoView({ block: 'center' }))
          await row.dblclick()
          const dialog = page.getByRole('dialog')
          await expect(dialog.getByRole('button', { name: 'Save' })).toBeVisible()
          await shoot(page, dialog, kind, '.tmp/meta-dialog-1280-light.png')
          await checkLines(page, dialog, kind)
        }
      })
    } finally {
      if (made) await trash(page, Object.values(made))
    }
  })
})

test.describe('375', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true })

  test('the task page and the phone sheet, dark: every meta line is one run', async ({ page }) => {
    let made: Made | null = null
    try {
      made = await makeTasks(page)
      const ids = made
      await page.emulateMedia({ colorScheme: 'dark' })
      for (const kind of KINDS) {
        await page.goto(`/tasks/${ids[kind]}`)
        await shoot(page, page.locator('main'), kind, '.tmp/meta-page-375-dark.png')
        await checkLines(page, page.locator('main'), kind)
      }
      await withPreferences(page, { default_grouping: 'unified' }, async () => {
        for (const kind of KINDS) {
          await page.goto('/')
          const row = page.locator(`#task-row-${ids[kind]}`)
          await row.evaluate((el) => el.scrollIntoView({ block: 'center' }))
          const box = await row.boundingBox()
          if (!box) throw new Error('row not on screen')
          // The row's own padding: not the title link, not the Done circle.
          await row.tap({ position: { x: 56, y: box.height - 6 } })
          const sheet = page.locator('[data-slot="sheet-content"]')
          await expect(sheet.getByRole('button', { name: 'Save' })).toBeVisible()
          await shoot(page, sheet, kind, '.tmp/meta-sheet-375-dark.png')
          await checkLines(page, sheet, kind)
        }
      })
    } finally {
      if (made) await trash(page, Object.values(made))
    }
  })
})
