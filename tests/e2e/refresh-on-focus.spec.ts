/**
 * Resume refresh (`useSyncStream`): coming back to the page refreshes what it
 * shows even when the sync stream is dead.
 *
 * The bug: in the Mac app a window covered by other windows stays `visible`,
 * so clicking back into it fires no visibilitychange — the only trigger that
 * used to run a full refresh. A change made on another device while the
 * stream was down stayed on screen until a reload. Now window `focus`,
 * `online` and the native apps' `opentask-app-active` event also refresh, and
 * re-open a stream that has closed.
 *
 * "Another device" is the API: the change is a PATCH through `page.request`,
 * which the page cannot see except by refetching. The stream is kept from
 * ever connecting (`page.route`), so no sync event can deliver the change.
 *
 * Resume refreshes are deduped against a refresh that started within the
 * last few seconds (`RESUME_REFRESH_DEDUPE_MS`). The page runs under a fake
 * clock that is moved past that window before the event is dispatched, so a
 * stray focus event at load cannot swallow the one under test.
 */
import { test, expect, uniqueTitle } from './fixtures'
import type { Page } from '@playwright/test'

const DAY = 24 * 60 * 60 * 1000
const inDays = (d: number) => new Date(Date.now() + d * DAY).toISOString()
const STREAM = '**/api/sync/stream'

async function post(page: Page, url: string, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post(url, { data })
  expect(res.ok(), `POST ${url} ${JSON.stringify(data)}`).toBeTruthy()
  return (await res.json()).data.id as number
}

/**
 * A task in a fresh project, the project's page loaded under a fake clock
 * with the sync stream blocked. Returns the ids to clean up.
 */
async function openProjectWithTask(
  page: Page,
  title: string,
): Promise<{ projectId: number; taskId: number }> {
  const projectId = await post(page, '/api/projects', { name: uniqueTitle('Resume project') })
  const taskId = await post(page, '/api/tasks', {
    title,
    project_id: projectId,
    due_at: inDays(1),
  })
  await page.clock.install({ time: new Date() })
  await page.goto(`/?project=${projectId}`)
  await expect(page.locator(`#task-row-${taskId}`)).toContainText(title)
  return { projectId, taskId }
}

async function cleanup(page: Page, ids: { projectId: number; taskId: number } | null) {
  if (!ids) return
  await page.request.post('/api/tasks/bulk/delete', { data: { ids: [ids.taskId] } })
  await page.request.delete(`/api/projects/${ids.projectId}`)
}

const TRIGGERS: { name: string; dispatch: string }[] = [
  { name: 'window focus', dispatch: "window.dispatchEvent(new Event('focus'))" },
  { name: 'window online', dispatch: "window.dispatchEvent(new Event('online'))" },
  {
    name: 'the native app-active event',
    dispatch: "window.dispatchEvent(new CustomEvent('opentask-app-active'))",
  },
]

test.describe('Resume refresh with the sync stream down', () => {
  for (const trigger of TRIGGERS) {
    test(`${trigger.name} shows a change made elsewhere, without a reload`, async ({
      authenticatedPage: page,
    }) => {
      // Aborted: EventSource keeps retrying (CONNECTING) and never connects.
      await page.route(STREAM, (route) => route.abort())
      let ids: { projectId: number; taskId: number } | null = null
      try {
        const before = uniqueTitle('Resume before')
        ids = await openProjectWithTask(page, before)
        const row = page.locator(`#task-row-${ids.taskId}`)

        const after = uniqueTitle('Resume after')
        const res = await page.request.patch(`/api/tasks/${ids.taskId}`, {
          data: { title: after },
        })
        expect(res.ok()).toBeTruthy()
        // Nothing has told the page yet.
        await expect(row).toContainText(before)

        await page.clock.fastForward('00:10')
        await page.evaluate(trigger.dispatch)

        await expect(row).toContainText(after)
      } finally {
        await cleanup(page, ids)
      }
    })
  }

  test('focus re-opens a stream the server closed', async ({ authenticatedPage: page }) => {
    // A non-200 answer makes EventSource give up for good (CLOSED) — it does
    // not retry on its own, so a stream request after this point can only
    // come from the resume handler re-opening it.
    const refused: string[] = []
    await page.route(STREAM, (route) => {
      refused.push(route.request().url())
      return route.fulfill({ status: 503, body: '' })
    })
    let ids: { projectId: number; taskId: number } | null = null
    try {
      ids = await openProjectWithTask(page, uniqueTitle('Resume stream'))
      await expect.poll(() => refused.length).toBeGreaterThan(0)

      await page.clock.fastForward('00:10')
      const reopened = page.waitForRequest((req) => req.url().includes('/api/sync/stream'))
      await page.evaluate("window.dispatchEvent(new Event('focus'))")
      await reopened
    } finally {
      await cleanup(page, ids)
    }
  })
})
