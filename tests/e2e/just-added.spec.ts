/**
 * Just-added previews (`src/lib/just-added.ts`): for 10 minutes after a task
 * is created, a read-only preview of it sits at the top of the Inbox (or, in
 * a view with no Inbox group, the top of the list), while the real row stays
 * at its natural place. Tapping the preview goes to the real row. After 10
 * minutes the preview leaves without a reload.
 *
 * Isolation: tasks and projects are created per test and deleted in
 * `finally`; the grouping and sort are set per test by `withPreferences`
 * (every spec shares one test user). Tasks meant to be "old" are backdated in
 * the database (`backdateCreated`) so they get no preview.
 *
 * Time-agnostic: due dates are whole days from now; the 10-minute window is
 * crossed with Playwright's `page.clock`, never by waiting.
 */
import {
  test,
  expect,
  backdateCreated,
  cmdClickRow,
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

const preview = (scope: Page | Locator, id: number) =>
  scope.locator(`[data-just-added-preview="${id}"]`)
const realRow = (page: Page, id: number) => page.locator(`#task-row-${id}`)

/** A section's rendered sequence: previews as `v<id>`, real rows as `<id>`. */
async function sequence(section: Locator): Promise<string[]> {
  return section.locator('[data-just-added-preview], [role="option"]').evaluateAll((els) =>
    els.map((el) => {
      const id = el.getAttribute('data-just-added-preview')
      return id ? `v${id}` : el.id.replace('task-row-', '')
    }),
  )
}

const PROJECTS_BY_DUE = {
  default_grouping: 'project',
  default_sort: 'due_date',
  default_sort_reversed: false,
}

test.describe('Just-added previews: placement', () => {
  test('a new task in another project is previewed at the top of the Inbox', async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
    let projectId: number | null = null
    try {
      const name = uniqueTitle('Preview project')
      projectId = await post(page, '/api/projects', { name })
      const early = await post(page, '/api/tasks', {
        title: uniqueTitle('Preview early'),
        project_id: projectId,
        due_at: inDays(1),
      })
      const inboxOld = await post(page, '/api/tasks', {
        title: uniqueTitle('Preview inbox old'),
        project_id: INBOX_ID,
        due_at: inDays(1),
      })
      ids.push(early, inboxOld)
      backdateCreated([early, inboxOld])
      const title = uniqueTitle('Preview fresh')
      const fresh = await post(page, '/api/tasks', {
        title,
        project_id: projectId,
        due_at: inDays(2),
      })
      ids.push(fresh)

      await withPreferences(page, PROJECTS_BY_DUE, async () => {
        const inbox = group(page, 'Inbox')
        const own = group(page, name)
        await waitForPrefsLoaded(page, () => page.goto('/'), own)

        // The preview heads the Inbox, naming the project the task is really in.
        await expect.poll(async () => (await sequence(inbox))[0]).toBe(`v${fresh}`)
        const card = preview(inbox, fresh)
        await expect(card).toContainText(title)
        await expect(card).toContainText(name)
        await expect(card.locator('[data-just-added-badge]')).toHaveText('New · just now')
        // It is not a row: no option role, no row id, no Done, no snooze.
        await expect(card.getByRole('option')).toHaveCount(0)
        await expect(card.locator('[id^="task-row-"]')).toHaveCount(0)
        await expect(card.getByRole('button', { name: /Mark .* as done|Snooze/ })).toHaveCount(0)

        // The real row is where it belongs, normal, wearing the same badge.
        await expect.poll(() => sequence(own)).toEqual([`${early}`, `${fresh}`])
        await expect(realRow(page, fresh).locator('[data-just-added-badge]')).toBeVisible()

        // Tapping the preview flashes the real row and selects nothing.
        await card.click()
        await expect(realRow(page, fresh)).toHaveAttribute('data-task-highlight', '')
        await expect(page.locator('[data-selection-sheet]')).toHaveCount(0)

        // Selection runs over real rows only; the preview never joins it.
        await cmdClickRow(realRow(page, early))
        await realRow(page, fresh).click({ modifiers: ['Shift'], position: { x: 56, y: 8 } })
        await expect(realRow(page, fresh)).toHaveAttribute('aria-selected', 'true')
        await expect(page.locator('[data-selection-sheet]')).toContainText('2 selected')
        await expect(card.locator('[aria-selected]')).toHaveCount(0)
        await page.keyboard.press('Escape')
      })
    } finally {
      await cleanup(page, ids, projectId)
    }
  })

  test('no preview when the real row already tops the Inbox', async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
    try {
      // Overdue by a year: first in the Inbox under due-soonest.
      const title = uniqueTitle('Tops inbox')
      const fresh = await post(page, '/api/tasks', {
        title,
        project_id: INBOX_ID,
        due_at: inDays(-365),
      })
      ids.push(fresh)

      await withPreferences(page, PROJECTS_BY_DUE, async () => {
        const inbox = group(page, 'Inbox')
        await waitForPrefsLoaded(page, () => page.goto('/'), realRow(page, fresh))
        // First real row of the Inbox (other specs' new tasks may still be
        // previewed above it — that is correct, and not this test's concern).
        await expect(inbox.getByRole('option').first()).toHaveAttribute('id', `task-row-${fresh}`)
        await expect(preview(page, fresh)).toHaveCount(0)
        await expect(realRow(page, fresh).locator('[data-just-added-badge]')).toBeVisible()
      })
    } finally {
      await cleanup(page, ids, null)
    }
  })
})

test.describe('Just-added previews: tapping through', () => {
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

        await preview(page, id).click()
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
})

test.describe('Just-added previews: arrival and age-out', () => {
  test('a quick add is previewed at the top of the Inbox', async ({ authenticatedPage: page }) => {
    const ids: number[] = []
    try {
      const inboxOld = await post(page, '/api/tasks', {
        title: uniqueTitle('Quick inbox old'),
        project_id: INBOX_ID,
        due_at: inDays(1),
      })
      ids.push(inboxOld)
      backdateCreated([inboxOld])

      await withPreferences(page, PROJECTS_BY_DUE, async () => {
        const inbox = group(page, 'Inbox')
        await waitForPrefsLoaded(page, () => page.goto('/'), inbox)

        const title = uniqueTitle('Previewed quick add')
        const created = page.waitForResponse(
          (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/tasks',
        )
        await page.getByRole('textbox', { name: 'Quick add task' }).fill(title)
        await page.keyboard.press('Enter')
        const id = (await (await created).json()).data.id as number
        ids.push(id)

        // Undated, so due-soonest puts the real row last in the Inbox.
        await expect.poll(async () => (await sequence(inbox))[0]).toBe(`v${id}`)
        await expect(preview(inbox, id)).toContainText(title)
        await expect(inbox.locator(`#task-row-${id}`)).toBeVisible()
      })
    } finally {
      await cleanup(page, ids, null)
    }
  })

  test('a task added through the API from elsewhere is previewed without a reload', async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
    try {
      await withPreferences(page, PROJECTS_BY_DUE, async () => {
        const inbox = group(page, 'Inbox')
        await waitForPrefsLoaded(page, () => page.goto('/'), inbox)

        // Not through the page: the dashboard only learns of it over the
        // sync stream, as it would from an iOS Shortcut.
        const title = uniqueTitle('Synced fresh')
        const id = await post(page, '/api/tasks', { title, project_id: 3, due_at: inDays(4) })
        ids.push(id)

        await expect(preview(inbox, id)).toContainText(title)
        await expect(preview(inbox, id)).toContainText('Work')
        await expect(realRow(page, id)).toBeVisible()
      })
    } finally {
      await cleanup(page, ids, null)
    }
  })

  test('in Today, a task with no row there is previewed on top and opens on tap', async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
    try {
      await withPreferences(page, { default_grouping: 'slot' }, async () => {
        const title = uniqueTitle('Next week fresh')
        const id = await post(page, '/api/tasks', { title, due_at: inDays(7) })
        ids.push(id)
        await waitForPrefsLoaded(page, () => page.goto('/'), preview(page, id))

        // Above every group, and there is no real row in Today to go to.
        const list = page.getByRole('listbox', { name: 'Task list' })
        await expect(list.locator('[data-just-added-previews]')).toBeVisible()
        await expect(realRow(page, id)).toHaveCount(0)

        await preview(page, id).click()
        await expect(page.getByRole('dialog')).toContainText(title)
        await page.keyboard.press('Escape')
      })
    } finally {
      await cleanup(page, ids, null)
    }
  })

  test('the preview and badges leave after 10 minutes, without a reload', async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
    try {
      const inboxOld = await post(page, '/api/tasks', {
        title: uniqueTitle('Age inbox old'),
        project_id: INBOX_ID,
        due_at: inDays(1),
      })
      ids.push(inboxOld)
      backdateCreated([inboxOld])
      const id = await post(page, '/api/tasks', {
        title: uniqueTitle('Age fresh'),
        project_id: INBOX_ID,
        due_at: inDays(30),
      })
      ids.push(id)

      await withPreferences(page, PROJECTS_BY_DUE, async () => {
        // The page's clock is Playwright's from here on; it still runs, and
        // `fastForward` jumps it (firing the one age-out timer on the way).
        await page.clock.install()
        await waitForPrefsLoaded(page, () => page.goto('/'), preview(page, id))
        await expect(realRow(page, id).locator('[data-just-added-badge]')).toBeVisible()

        await page.clock.fastForward('10:30')

        await expect(preview(page, id)).toHaveCount(0)
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
