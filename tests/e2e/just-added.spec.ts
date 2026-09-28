/**
 * Just added (`src/lib/just-added.ts`, `JustAddedCard`): for 10 minutes after
 * a task is created it is listed in the Just added card under the add field —
 * its project, what the AI filled in, how long ago — while the real row stays
 * at its natural place wearing a "New" tag. Tapping an entry goes to the real
 * row. After 10 minutes the entry and the tag leave without a reload.
 *
 * Isolation: tasks and projects are created per test and deleted in
 * `finally`; the grouping and sort are set per test by `withPreferences`
 * (every spec shares one test user). Tasks meant to be "old" are backdated in
 * the database (`backdateCreated`) so they are not listed.
 *
 * Time-agnostic: due dates are whole days from now; the 10-minute window is
 * crossed with Playwright's `page.clock`, never by waiting.
 */
import {
  test,
  expect,
  backdateCreated,
  uniqueTitle,
  waitForPrefsLoaded,
  withPreferences,
} from './fixtures'
import type { Locator, Page } from '@playwright/test'

const DAY = 24 * 60 * 60 * 1000
const inDays = (d: number) => new Date(Date.now() + d * DAY).toISOString()
const INBOX_ID = 1 // seeded as "Inbox" (tests/e2e/globalSetup.ts)

async function post(page: Page, url: string, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post(url, { data })
  expect(res.ok(), `POST ${url} ${JSON.stringify(data)}`).toBeTruthy()
  return (await res.json()).data.id as number
}

async function cleanup(page: Page, taskIds: number[], projectId: number | null) {
  if (taskIds.length > 0) {
    await page.request.post('/api/tasks/bulk/delete', { data: { ids: taskIds } })
  }
  if (projectId !== null) await page.request.delete(`/api/projects/${projectId}`)
}

/** A Projects-view group, found by its collapse button. */
function group(page: Page, name: string): Locator {
  return page.locator('section[data-task-group]', {
    has: page.getByRole('button', { name: `Collapse ${name}`, exact: true }),
  })
}

const card = (page: Page) => page.locator('[data-just-added-card]')
const entry = (page: Page, id: number) => page.locator(`[data-just-added-entry="${id}"]`)
const realRow = (page: Page, id: number) => page.locator(`#task-row-${id}`)

/** A group's real rows, as ids in on-screen order. */
function rowOrder(section: Locator): Promise<string[]> {
  return section
    .locator('[role="option"]')
    .evaluateAll((els) => els.map((el) => el.id.replace('task-row-', '')))
}

const PROJECTS_BY_DUE = {
  default_grouping: 'project',
  default_sort: 'due_date',
  default_sort_reversed: false,
}

test.describe('Just added: the card', () => {
  test('a quick add is listed in the card, and its real row stays in place with a New tag', async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
    try {
      const inboxOld = await post(page, '/api/tasks', {
        title: uniqueTitle('Card inbox old'),
        project_id: INBOX_ID,
        due_at: inDays(1),
      })
      ids.push(inboxOld)
      backdateCreated([inboxOld])

      await withPreferences(page, PROJECTS_BY_DUE, async () => {
        const inbox = group(page, 'Inbox')
        await waitForPrefsLoaded(page, () => page.goto('/'), inbox)
        await expect(card(page)).toHaveCount(0)

        const title = uniqueTitle('Carded quick add')
        const created = page.waitForResponse(
          (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/tasks',
        )
        await page.getByRole('textbox', { name: 'Quick add task' }).fill(title)
        await page.keyboard.press('Enter')
        const id = (await (await created).json()).data.id as number
        ids.push(id)

        await expect(entry(page, id)).toContainText(title)
        await expect(entry(page, id)).toContainText('Inbox')
        await expect(entry(page, id)).toContainText('just now')
        // The real row is where the sort puts it (undated, so after the dated
        // old task), not pulled to the top — and it wears the tag.
        const order = await rowOrder(inbox)
        expect(order.indexOf(String(id))).toBeGreaterThan(order.indexOf(String(inboxOld)))
        await expect(realRow(page, id).locator('[data-just-added-badge]')).toHaveText('New')
        // Not a second task: the card is not in the list.
        await expect(
          page.getByRole('listbox', { name: 'Task list' }).locator('[data-just-added-card]'),
        ).toHaveCount(0)
      })
    } finally {
      await cleanup(page, ids, null)
    }
  })

  test('a task added through the API from elsewhere is listed with its project, without a reload', async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
    try {
      await withPreferences(page, PROJECTS_BY_DUE, async () => {
        await waitForPrefsLoaded(page, () => page.goto('/'), group(page, 'Inbox'))

        // Not through the page: the dashboard only learns of it over the
        // sync stream, as it would from an iOS Shortcut or the Mac menu bar.
        const title = uniqueTitle('Synced fresh')
        const id = await post(page, '/api/tasks', { title, project_id: 3, due_at: inDays(4) })
        ids.push(id)

        await expect(entry(page, id)).toContainText(title)
        await expect(entry(page, id)).toContainText('Work')
        await expect(realRow(page, id)).toBeVisible()
      })
    } finally {
      await cleanup(page, ids, null)
    }
  })

  test('an entry still being enriched says so', async ({ authenticatedPage: page }) => {
    const ids: number[] = []
    try {
      const id = await post(page, '/api/tasks', {
        title: uniqueTitle('Enriching fresh'),
        labels: ['ai-to-process'],
      })
      ids.push(id)
      await withPreferences(page, PROJECTS_BY_DUE, async () => {
        await waitForPrefsLoaded(page, () => page.goto('/'), entry(page, id))
        await expect(entry(page, id)).toContainText('AI is filling in details')
      })
    } finally {
      await cleanup(page, ids, null)
    }
  })

  test('Clear hides what is listed; a task added after it shows', async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
    try {
      const first = await post(page, '/api/tasks', { title: uniqueTitle('Clear first') })
      ids.push(first)
      await withPreferences(page, PROJECTS_BY_DUE, async () => {
        await waitForPrefsLoaded(page, () => page.goto('/'), entry(page, first))
        await card(page).getByRole('button', { name: 'Clear', exact: true }).click()
        await expect(entry(page, first)).toHaveCount(0)
        // The real row is untouched, tag and all.
        await expect(realRow(page, first).locator('[data-just-added-badge]')).toBeVisible()

        const second = await post(page, '/api/tasks', { title: uniqueTitle('Clear second') })
        ids.push(second)
        await expect(entry(page, second)).toBeVisible()
        await expect(entry(page, first)).toHaveCount(0)
      })
    } finally {
      await cleanup(page, ids, null)
    }
  })
})

test.describe('Just added: tapping through', () => {
  test("a tap unfolds the real row's group and flashes it, even mid-enrichment", async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
    let projectId: number | null = null
    try {
      const name = uniqueTitle('Fold project')
      projectId = await post(page, '/api/projects', { name })
      // Still being enriched: its row pulses, and the flash must win over it.
      const id = await post(page, '/api/tasks', {
        title: uniqueTitle('Fold fresh'),
        project_id: projectId,
        labels: ['ai-to-process'],
      })
      ids.push(id)

      await withPreferences(page, PROJECTS_BY_DUE, async () => {
        const own = group(page, name)
        await waitForPrefsLoaded(page, () => page.goto('/'), own)
        await page.getByRole('button', { name: `Collapse ${name}`, exact: true }).click()
        await expect(realRow(page, id)).toHaveCount(0)

        await entry(page, id).click()
        await expect(realRow(page, id)).toBeVisible()
        await expect(realRow(page, id)).toHaveAttribute('data-task-highlight', '')
        // The flash plays out and clears itself (it would hang if the
        // enrichment pulse overrode its animation).
        await expect(realRow(page, id)).not.toHaveAttribute('data-task-highlight')
      })
    } finally {
      await cleanup(page, ids, projectId)
    }
  })

  test('in Today, a task with no row there opens on tap', async ({ authenticatedPage: page }) => {
    const ids: number[] = []
    try {
      await withPreferences(page, { default_grouping: 'slot' }, async () => {
        const title = uniqueTitle('Next week fresh')
        const id = await post(page, '/api/tasks', { title, due_at: inDays(7) })
        ids.push(id)
        await waitForPrefsLoaded(page, () => page.goto('/'), entry(page, id))
        await expect(realRow(page, id)).toHaveCount(0)

        await entry(page, id).click()
        await expect(page.getByRole('dialog')).toContainText(title)
        await page.keyboard.press('Escape')
      })
    } finally {
      await cleanup(page, ids, null)
    }
  })
})

test.describe('Just added: age-out', () => {
  test('the entry and the tag leave after 10 minutes, without a reload', async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
    try {
      const id = await post(page, '/api/tasks', {
        title: uniqueTitle('Age fresh'),
        project_id: INBOX_ID,
        due_at: inDays(30),
      })
      ids.push(id)

      await withPreferences(page, PROJECTS_BY_DUE, async () => {
        // The page's clock is Playwright's from here on; it still runs, and
        // `fastForward` jumps it (firing the age timers on the way).
        await page.clock.install()
        await waitForPrefsLoaded(page, () => page.goto('/'), entry(page, id))
        await expect(realRow(page, id).locator('[data-just-added-badge]')).toBeVisible()

        await page.clock.fastForward('03:00')
        await expect(entry(page, id)).toContainText('3m ago')

        await page.clock.fastForward('07:30')
        await expect(entry(page, id)).toHaveCount(0)
        await expect(realRow(page, id)).toBeVisible()
        await expect(realRow(page, id).locator('[data-just-added-badge]')).toHaveCount(0)
      })
    } finally {
      await cleanup(page, ids, null)
    }
  })

  test('the Recent view is gone from the view switch', async ({ authenticatedPage: page }) => {
    const toggle = page.getByRole('group', { name: 'View mode' })
    await expect(toggle.getByRole('button')).toHaveText(['Today', 'Projects', 'All'])
  })
})
