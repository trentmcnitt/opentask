/**
 * CONSIDERED IN A FAST BURST (2026-10-26, Trent on the Mac app's dashboard):
 * tapping Considered on one row after another, a row he had already handled
 * vanished, came back for a moment and vanished again — and his next tap,
 * aimed at the row below, landed on it instead.
 *
 * The cause: the surface dropped its optimistic changes on the first render
 * after the last write answered, against the payload it then held — in a
 * burst, the one fetched BEFORE the burst (each tap's follow-up refresh is
 * superseded by the next tap's and dropped by the latest-request guard). So
 * every row of the burst came back until the last refresh landed. Now each
 * change stays until a payload requested after its write answered is on
 * screen (`src/lib/pending-overlay.ts`).
 *
 * The network is as slow as a large account's: the server answers at once
 * and `page.route` delivers the answer later, so what each payload contains
 * is fixed by when it was requested. Every animation frame's waiting rows are
 * recorded, so a one-frame blip fails. Several tap paces, since the race
 * depends on how the taps fall between the answers.
 *
 * Its own user (`queue@opentask.local`, as deadlines-teal): the switch on.
 * Unique titles; every task trashed in `finally`.
 */
import { test, expect, uniqueTitle } from './fixtures'
import type { Page, Route } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

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

/** Records, on every animation frame, the ids of the card's waiting rows. */
async function recordFrames(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: string[]; __raf: number }
    w.__frames = []
    const tick = () => {
      const ids = [...document.querySelectorAll('[data-tasks-panel] [data-segment-task]')]
        .filter((r) => r.querySelector('button[aria-label^="Mark \\""]'))
        .map((r) => r.getAttribute('data-segment-task'))
      const line = ids.join(',')
      if (w.__frames[w.__frames.length - 1] !== line) w.__frames.push(line)
      w.__raf = requestAnimationFrame(tick)
    }
    tick()
  })
}

async function stopFrames(page: Page): Promise<string[][]> {
  const frames = await page.evaluate(() => {
    const w = window as unknown as { __frames: string[]; __raf: number }
    cancelAnimationFrame(w.__raf)
    return w.__frames
  })
  return frames.map((f) => (f ? f.split(',') : []))
}

/** The ids that left the waiting list and later came back into it. */
function reappeared(frames: string[][], ids: number[]): number[] {
  return ids.filter((id) => {
    let gone = false
    for (const f of frames) {
      const has = f.includes(String(id))
      if (!has) gone = true
      else if (gone) return true
    }
    return false
  })
}

const firstCircle = (page: Page) =>
  page.locator('[data-tasks-panel] button[aria-label^="Mark \\""]:visible').first()

async function rowIdOf(page: Page) {
  const row = firstCircle(page).locator('xpath=ancestor::*[@data-segment-task][1]')
  return Number(await row.getAttribute('data-segment-task'))
}

test.beforeEach(async ({ page }) => {
  await signIn(page)
  const res = await page.request.post('/api/test/task-queue', { data: { enabled: true } })
  expect(res.ok()).toBeTruthy()
})
test.afterAll(async ({ request }) => {
  await request.post('/api/test/task-queue', { data: { enabled: false } })
})

/**
 * The burst as a hand makes it: five taps on the top waiting row, each a beat
 * after the last, with the network as slow as a large account's (the server
 * answers at once; the page gets the answer later). Several paces: the race
 * depends on how the taps fall between the answers.
 */
const RUNS = [
  ...[120, 220, 320, 450].map((gap) => ({ gap, viewport: { width: 1280, height: 900 } })),
  // The phone's layout: the same card, one column.
  ...[120, 320].map((gap) => ({ gap, viewport: { width: 375, height: 812 } })),
]

for (const { gap, viewport } of RUNS) {
  test(`five taps ${gap} ms apart at ${viewport.width}: no considered row comes back`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    const ids: number[] = []
    try {
      for (let i = 0; i < 7; i++) {
        ids.push(await create(page, { title: uniqueTitle(`CB burst ${i}`), horizon: 'days' }))
      }
      const later = (ms: number) => new Promise((r) => setTimeout(r, ms))
      await page.route(/\/api\/reminders(\?|$)/, async (route: Route) => {
        const response = await route.fetch()
        await later(450)
        await route.fulfill({ response })
      })
      await page.route(/\/api\/tasks\?limit=/, async (route: Route) => {
        const response = await route.fetch()
        await later(350)
        await route.fulfill({ response })
      })
      await page.route('**/api/task-segments/consider', async (route: Route) => {
        const response = await route.fetch()
        await later(250)
        await route.fulfill({ response })
      })
      await page.goto('/?tasks=days')
      await expect(page.locator('[data-tasks-panel]')).toHaveAttribute(
        'data-tasks-page',
        'tasks:days',
      )
      await expect(firstCircle(page)).toBeVisible()
      await recordFrames(page)
      const tapped: number[] = []
      for (let i = 0; i < 5; i++) {
        const circle = firstCircle(page)
        tapped.push(await rowIdOf(page))
        const box = await circle.boundingBox()
        if (!box) throw new Error('no circle')
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        await later(gap)
      }
      // Everything answered and refreshed: the five are gone for good.
      for (const id of tapped) {
        await expect(page.locator(`[data-tasks-panel] [data-segment-task="${id}"]`)).toHaveCount(0)
      }
      await later(1500)
      const frames = await stopFrames(page)
      expect(new Set(tapped).size, `tapped ${tapped}`).toBe(5)
      expect(reappeared(frames, tapped), `frames: ${JSON.stringify(frames)}`).toEqual([])
    } finally {
      await trash(page, ids)
    }
  })
}

/**
 * The dashboard's task list, the same race: its rows are whole tasks the
 * fetch replaces, and a refresh started before the next tap's write used to
 * land after that tap had taken its row off, putting it back. Done, five
 * times, a beat apart, on a project's list.
 */
for (const gap of [120, 650]) {
  test(`the task list: five Done taps ${gap} ms apart, no row comes back`, async ({ page }) => {
    const ids: number[] = []
    const later = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const project = await page.request.post('/api/projects', {
      data: { name: uniqueTitle('CB project') },
    })
    const projectId = (await project.json()).data.id as number
    try {
      const at = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString()
      for (let i = 0; i < 7; i++) {
        ids.push(
          await create(page, {
            title: uniqueTitle(`CB list ${i}`),
            project_id: projectId,
            target_at: at,
          }),
        )
      }
      // A write answering slower than a refresh: the order that let an older
      // refresh land after the next tap had taken its row off.
      await page.route(/\/api\/tasks\?limit=/, async (route: Route) => {
        const response = await route.fetch()
        await later(300)
        await route.fulfill({ response })
      })
      await page.route(/\/api\/tasks\/\d+\/done$/, async (route: Route) => {
        const response = await route.fetch()
        await later(600)
        await route.fulfill({ response })
      })
      await page.goto(`/?project=${projectId}`)
      const doneButton = () => page.getByRole('button', { name: /^Mark ".*CB list.*" as done$/ })
      // Six of the seven show (the list's row cap): enough for five taps.
      await expect(doneButton().nth(5)).toBeVisible()
      await page.evaluate(() => {
        const w = window as unknown as { __frames: string[]; __raf: number }
        w.__frames = []
        const tick = () => {
          const line = [...document.querySelectorAll('[id^="task-row-"]')]
            .map((r) => r.id.slice('task-row-'.length))
            .join(',')
          if (w.__frames[w.__frames.length - 1] !== line) w.__frames.push(line)
          w.__raf = requestAnimationFrame(tick)
        }
        tick()
      })
      const tapped: number[] = []
      for (let i = 0; i < 5; i++) {
        const button = doneButton().first()
        const row = button.locator('xpath=ancestor::*[starts-with(@id, "task-row-")][1]')
        tapped.push(Number((await row.getAttribute('id'))!.slice('task-row-'.length)))
        await button.click()
        await later(gap)
      }
      for (const id of tapped) await expect(page.locator(`#task-row-${id}`)).toHaveCount(0)
      await later(1500)
      const frames = await stopFrames(page)
      expect(new Set(tapped).size, `tapped ${tapped}`).toBe(5)
      expect(reappeared(frames, tapped), `frames: ${JSON.stringify(frames)}`).toEqual([])
    } finally {
      await trash(page, ids)
      await page.request.delete(`/api/projects/${projectId}`)
    }
  })
}

/**
 * Reminders, the same race (the /reminders page): a considered reminder's id
 * is stripped from every payload while its write is out — and must stay
 * stripped until a payload requested after its write answered lands, even
 * when the refresh the answer asks for waits behind a row still leaving.
 */
for (const gap of [120, 650]) {
  test(`reminders: five Considered taps ${gap} ms apart, no row comes back`, async ({ page }) => {
    const ids: number[] = []
    const later = (ms: number) => new Promise((r) => setTimeout(r, ms))
    try {
      const slots = (await (await page.request.get('/api/time-slots')).json()).data.time_slots as {
        start_time: string
      }[]
      const [h, m] = slots[0].start_time.split(':').map(Number)
      for (let i = 0; i < 7; i++) {
        ids.push(
          await create(page, {
            title: uniqueTitle(`CB reminder ${i}`),
            is_reminder: true,
            rrule: `FREQ=DAILY;BYHOUR=${h};BYMINUTE=${m}`,
          }),
        )
      }
      await page.route(/\/api\/reminders(\?|$)/, async (route: Route) => {
        const response = await route.fetch()
        await later(300)
        await route.fulfill({ response })
      })
      await page.route('**/api/tasks/bulk/complete', async (route: Route) => {
        const response = await route.fetch()
        await later(600)
        await route.fulfill({ response })
      })
      await page.goto('/reminders')
      const circle = () =>
        page.getByRole('button', { name: /^Mark ".*CB reminder.*" as considered$/ })
      await expect(circle()).toHaveCount(7)
      await page.evaluate(() => {
        const w = window as unknown as { __frames: string[]; __raf: number }
        w.__frames = []
        const tick = () => {
          const line = [...document.querySelectorAll('[data-reminder-id]')]
            .filter((r) => r.querySelector('button[aria-label^="Mark \\""]'))
            .map((r) => r.getAttribute('data-reminder-id'))
            .join(',')
          if (w.__frames[w.__frames.length - 1] !== line) w.__frames.push(line)
          w.__raf = requestAnimationFrame(tick)
        }
        tick()
      })
      const tapped: number[] = []
      for (let i = 0; i < 5; i++) {
        const button = circle().first()
        const row = button.locator('xpath=ancestor::*[@data-reminder-id][1]')
        tapped.push(Number(await row.getAttribute('data-reminder-id')))
        const box = await button.boundingBox()
        if (!box) throw new Error('no circle')
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        await later(gap)
      }
      await expect(circle()).toHaveCount(2)
      await later(1500)
      const frames = await stopFrames(page)
      expect(new Set(tapped).size, `tapped ${tapped}`).toBe(5)
      expect(reappeared(frames, tapped), `frames: ${JSON.stringify(frames)}`).toEqual([])
    } finally {
      await trash(page, ids)
    }
  })
}
