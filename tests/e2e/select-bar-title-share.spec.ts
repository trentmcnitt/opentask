/**
 * THE SELECT BAR'S EDITABLE TITLE AND SHARE (Trent, 2026-11-18):
 *
 * - With one task picked the bar's title is a button; a click makes it a
 *   field holding the whole title, wrapping. Enter or leaving the field
 *   saves (one request, one Undo); Escape puts it back; an unchanged or
 *   empty title saves nothing.
 * - A hold-started selection ends once the save lands — when the edit ended
 *   on its own (Enter, a click away), not when it ended by pressing
 *   something else on the bar. The Select button's mode keeps the pick.
 * - ⋯ → Share hands the task's text to the browser's share sheet, or — with
 *   none — copies it and says "Copied". The selection stays.
 *
 * Its own user (`queue@opentask.local`, as qr-select-detail): the switch on,
 * lean rows, at 375. Unique titles; every task trashed in `finally`.
 */
import path from 'path'
import Database from 'better-sqlite3'
import { test, expect, uniqueTitle, withPreferences } from './fixtures'
import type { Locator, Page } from '@playwright/test'

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('queue@opentask.local')
  await page.getByLabel('Password').fill('testpass123')
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL('/', { timeout: 10_000 })
}

async function trash(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

async function titleOf(page: Page, id: number): Promise<string> {
  return (await (await page.request.get(`/api/tasks/${id}`)).json()).data.title
}

/** A settled `days` one-off made two days ago: it waits in today's Days segment. */
async function daysTask(page: Page, title: string, extra: object = {}): Promise<number> {
  const res = await page.request.post('/api/tasks', {
    data: { title, horizon: 'days', ...extra },
  })
  const id = (await res.json()).data.id as number
  const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
  try {
    db.prepare(
      `UPDATE tasks SET new_ended_at = created_at, created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-2 day') WHERE id = ?`,
    ).run(id)
  } finally {
    db.close()
  }
  return id
}

async function holdRow(page: Page, title: Locator, shown: () => Promise<void>) {
  await title.scrollIntoViewIfNeeded()
  const box = (await title.boundingBox())!
  await page.mouse.move(box.x + 12, box.y + 8)
  await page.mouse.down()
  try {
    await shown()
  } finally {
    await page.mouse.up()
  }
}

const card = (page: Page) => page.locator('[data-tasks-panel]')
const row = (page: Page, id: number) => card(page).locator(`[data-segment-task="${id}"]`)
const queueBar = (page: Page) => page.locator('[data-queue-selection-bar]')
/** ⋯'s Share: a button in the phone's sheet (a menu item on a desktop). */
const shareItem = (page: Page) =>
  page.getByRole('dialog', { name: 'More' }).getByRole('button', { name: 'Share' })
const field = (bar: Locator) => bar.locator('[data-selection-title-field]')

/** Every request that writes a task, counted. */
function countWrites(page: Page): () => number {
  let n = 0
  page.on('request', (r) => {
    const p = new URL(r.url()).pathname
    if (r.method() !== 'GET' && p.startsWith('/api/tasks')) n++
  })
  return () => n
}

test.describe.configure({ mode: 'serial' })
test.use({ viewport: { width: 375, height: 812 } })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('opentask_task_rows', 'lean')
    window.localStorage.setItem('opentask_dashboard_mode', 'all')
  })
  await signIn(page)
  const res = await page.request.post('/api/test/task-queue', { data: { enabled: true } })
  expect(res.ok()).toBeTruthy()
})
test.afterAll(async ({ request }) => {
  await request.post('/api/test/task-queue', { data: { enabled: false } })
})

test('a held row: the title opens whole in a field; Escape and an unchanged title save nothing; Enter saves once, with Undo, and ends the hold', async ({
  page,
}) => {
  const long = uniqueTitle(
    'TE held: a synthetic title long enough that the bar has to cut it short on a phone',
  )
  const id = await daysTask(page, long)
  try {
    await page.goto('/')
    const bar = queueBar(page)
    await holdRow(page, row(page, id).getByText(/^TE held/), () => expect(bar).toBeVisible())
    const writes = countWrites(page)

    // The whole title, in a field that wraps: taller than one line.
    await bar.locator('[data-selection-title]').click()
    await expect(field(bar)).toBeFocused()
    await expect(field(bar)).toHaveValue(long)
    const box = (await field(bar).boundingBox())!
    expect(box.height).toBeGreaterThan(30)
    await expect(bar).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: '.tmp/screens/title-edit-open-375.png', animations: 'disabled' })

    // Escape: back to the title, the selection kept, nothing sent.
    await field(bar).fill('TE thrown away')
    await page.keyboard.press('Escape')
    await expect(field(bar)).toHaveCount(0)
    await expect(bar.locator('[data-selection-title]')).toContainText('TE held')
    await expect(bar).toBeVisible()

    // Unchanged, and emptied: nothing sent, the selection kept.
    await bar.locator('[data-selection-title]').click()
    await page.keyboard.press('Enter')
    await expect(field(bar)).toHaveCount(0)
    await bar.locator('[data-selection-title]').click()
    await field(bar).fill('   ')
    await page.keyboard.press('Enter')
    await expect(bar.locator('[data-selection-title]')).toContainText('TE held')
    expect(writes()).toBe(0)

    // Enter saves: one request, the hold's selection ends, Undo puts it back.
    const renamed = uniqueTitle('TE renamed')
    await bar.locator('[data-selection-title]').click()
    await field(bar).fill(renamed)
    await page.keyboard.press('Enter')
    await expect.poll(() => titleOf(page, id)).toBe(renamed)
    await expect(bar).toHaveCount(0)
    expect(writes()).toBe(1)
    await expect(row(page, id)).toContainText(renamed)
    const undo = await page.request.post('/api/undo')
    expect(undo.ok()).toBeTruthy()
    expect(await titleOf(page, id)).toBe(long)
  } finally {
    await trash(page, [id])
  }
})

test('the Select button’s mode keeps the pick after a title save; a pasted line break becomes a space', async ({
  page,
}) => {
  const id = await daysTask(page, uniqueTitle('TE kept'))
  try {
    await page.goto('/')
    await expect(row(page, id)).toBeVisible()
    await card(page).locator('[data-queue-select-toggle]').click()
    await row(page, id)
      .getByText(/^TE kept/)
      .click()
    const bar = queueBar(page)
    await bar.locator('[data-selection-title]').click()
    const stamp = uniqueTitle('TE two')
    await field(bar).fill(`${stamp}\nlines`)
    await page.keyboard.press('Enter')
    await expect.poll(() => titleOf(page, id)).toBe(`${stamp} lines`)
    await expect(bar.locator('[data-selection-title]')).toContainText(`${stamp} lines`)
    await expect(bar).toBeVisible()
  } finally {
    await trash(page, [id])
  }
})

test('the list’s bar: leaving the field by pressing a verb saves and keeps the bar; a click away saves and ends it', async ({
  page,
}) => {
  const id = await daysTask(page, uniqueTitle('TE list'))
  try {
    await withPreferences(page, { default_grouping: 'new' }, async () => {
      await page.goto('/')
      const bar = page.locator('[data-selection-sheet]:not([data-queue-selection-bar])')
      const pick = (title: RegExp) =>
        page
          .locator(`#task-row-${id}`)
          .getByText(title)
          .click({ modifiers: ['ControlOrMeta'] })
      await pick(/^TE list/)
      await bar.locator('[data-selection-title]').click()
      const first = uniqueTitle('TE list one')
      await field(bar).fill(first)
      // ⋯ takes the focus: the title is saved, and ⋯'s menu is the action.
      await bar.locator('[data-bar-more]').click()
      await expect.poll(() => titleOf(page, id)).toBe(first)
      await expect(shareItem(page)).toBeVisible()
      await expect(bar).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(bar.locator('[data-selection-title]')).toContainText(first)

      // A click away from the bar: saved, and that was the one action.
      await bar.locator('[data-selection-title]').click()
      const second = uniqueTitle('TE list two')
      await field(bar).fill(second)
      await page.locator('h1, h2').first().click()
      await expect.poll(() => titleOf(page, id)).toBe(second)
      await expect(bar).toHaveCount(0)
    })
  } finally {
    await trash(page, [id])
  }
})

test('Share: the task’s text to the share sheet, the selection kept; with no share sheet it is copied', async ({
  page,
  context,
  browserName,
}) => {
  const title = uniqueTitle('TE shared')
  const id = await daysTask(page, title, {
    notes: 'Ask which shelf it goes on.\n[relay fetch <abc123@example.test>]',
  })
  try {
    // The share sheet, stubbed: what it was handed.
    await page.addInitScript(() => {
      const w = window as unknown as { __shared: unknown[] }
      w.__shared = []
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: (data: unknown) => {
          w.__shared.push(data)
          return Promise.resolve()
        },
      })
    })
    await page.goto('/')
    const bar = queueBar(page)
    await holdRow(page, row(page, id).getByText(/^TE shared/), () => expect(bar).toBeVisible())
    await bar.locator('[data-bar-more]').click()
    await page.screenshot({ path: '.tmp/screens/share-menu-375.png', animations: 'disabled' })
    await shareItem(page).click()
    const shared = await page.evaluate(
      () => (window as unknown as { __shared: { text: string }[] }).__shared,
    )
    expect(shared).toHaveLength(1)
    // Title, then the notes without their machine line (dates: share-task.test.ts).
    expect(shared[0].text).toBe(`${title}\n\nAsk which shelf it goes on.`)
    expect(Object.keys(shared[0])).toEqual(['text'])
    // Nothing changed: the hold's selection is still up.
    await expect(bar).toBeVisible()

    // No share sheet (a desktop browser without one): the clipboard.
    if (browserName === 'chromium') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write'])
      await page.evaluate(() =>
        Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }),
      )
      await bar.locator('[data-bar-more]').click()
      await shareItem(page).click()
      await expect(page.getByText('Copied', { exact: true })).toBeVisible()
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shared[0].text)
    }
  } finally {
    await trash(page, [id])
  }
})

test('Share in the editors: a reminder’s link (title and notes only) and a task’s ⋯', async ({
  page,
}) => {
  const title = uniqueTitle('TE reminder')
  const res = await page.request.post('/api/tasks', {
    data: { title, is_reminder: true, notes: 'Bring the lantern.' },
  })
  const id = (await res.json()).data.id as number
  const taskTitle = uniqueTitle('TE plain')
  const taskId = await daysTask(page, taskTitle)
  try {
    await page.addInitScript(() => {
      const w = window as unknown as { __shared: unknown[] }
      w.__shared = []
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: (data: unknown) => {
          w.__shared.push(data)
          return Promise.resolve()
        },
      })
    })
    const shared = () =>
      page.evaluate(() =>
        (window as unknown as { __shared: { text: string }[] }).__shared.map((s) => s.text),
      )
    // A reminder's editor has no ⋯: Share is one of its links.
    await page.goto(`/tasks/${id}`)
    await page.locator('[data-share-item]').click()
    expect(await shared()).toEqual([`${title}\n\nBring the lantern.`])
    // A task's details: Share is in ⋯.
    await page.goto(`/tasks/${taskId}`)
    await page.getByRole('button', { name: 'More options' }).click()
    await page.locator('[data-share-item]').click()
    expect(await shared()).toEqual([taskTitle])
  } finally {
    await trash(page, [id, taskId])
  }
})
