/**
 * SEARCH ACROSS KINDS (Trent, 2026-11-12, mockups S3 + R2). The dashboard's
 * search lists tasks, reminders and quotas — kind chips on top, one list
 * grouped by kind, a reminder or quota as a pointer row that goes to it. The
 * Reminders and Quotas tabs search in place and add one line for what else
 * matches, which opens the dashboard's search. Re-tapping the tab clears it
 * all (nav-retap-search.spec).
 */
import { test, expect, uniqueTitle } from './fixtures'
import type { Page } from '@playwright/test'

test.beforeEach(async ({ request, page }) => {
  const res = await request.post('/api/test/task-queue', { data: { enabled: true } })
  expect(res.ok()).toBeTruthy()
  await page.addInitScript(() => window.localStorage.setItem('opentask_task_rows', 'lean'))
})
test.afterAll(async ({ request }) => {
  await request.post('/api/test/task-queue', { data: { enabled: false } })
})

async function post(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), await res.text()).toBeTruthy()
  return (await res.json()).data.id as number
}
async function cleanup(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}
async function firstSlot(page: Page) {
  const slots = (await (await page.request.get('/api/time-slots')).json()).data.time_slots as {
    id: number
    label: string
    start_time: string
  }[]
  return [...slots].sort((a, b) => a.start_time.localeCompare(b.start_time))[0]
}

/** Whether a reminder, or a quota's prompt, waits in today's Reminders card (the server's word). */
async function waitsToday(page: Page, id: number): Promise<boolean> {
  const body = await (await page.request.get('/api/reminders')).json()
  const groups = body.data.groups as {
    reminders: { id: number }[]
    prompts?: { task_id: number; considered: boolean; done: boolean }[]
  }[]
  return groups.some(
    (g) =>
      g.reminders.some((r) => r.id === id) ||
      (g.prompts ?? []).some((p) => p.task_id === id && !p.considered && !p.done),
  )
}

const chips = (page: Page) => page.locator('[data-search-kind-chips]')
const chip = (page: Page, kind: string) => page.locator(`[data-search-kind-chip="${kind}"]`)
const pointer = (page: Page, id: number) => page.locator(`[data-search-pointer-row="${id}"]`)
const taskRow = (page: Page, id: number) => page.locator(`[data-lean-row="${id}"]`)

/** A made-up word no seeded title holds, so the counts are this test's own. */
function word(): string {
  return `zq${Math.random().toString(36).slice(2, 8)}`
}

async function seed(page: Page, w: string) {
  const slot = await firstSlot(page)
  const [h, m] = slot.start_time.split(':').map(Number)
  const dated = await post(page, {
    title: uniqueTitle(`Sign the ${w} form`),
    enrich: false,
    due_at: new Date(Date.now() - 3_600_000).toISOString(),
  })
  const queued = await post(page, {
    title: uniqueTitle(`Find the ${w} book`),
    enrich: false,
    horizon: 'days',
  })
  const reminder = await post(page, {
    title: uniqueTitle(`${w} homework`),
    is_reminder: true,
    priority: 3,
    rrule: `FREQ=DAILY;BYHOUR=${h};BYMINUTE=${m}`,
  })
  const quota = await post(page, {
    title: uniqueTitle(`Read with ${w}`),
    is_tracked: true,
    progress_target: 2,
    rrule: 'FREQ=WEEKLY',
  })
  return { slot, dated, queued, reminder, quota }
}

for (const [name, viewport] of [
  ['desktop', { width: 1280, height: 800 }],
  ['phone', { width: 390, height: 844 }],
] as const) {
  test.describe(`Dashboard search across kinds · ${name}`, () => {
    test.use({ viewport })

    test('chips for the kinds that matched; one list by kind; a chip narrows it in place', async ({
      authenticatedPage: page,
    }) => {
      const w = word()
      const made = await seed(page, w)
      try {
        await page.goto('/')
        if (name === 'phone')
          await page.getByRole('button', { name: 'Search', exact: true }).click()
        await page.getByRole('textbox', { name: 'Search tasks' }).fill(w)

        await expect(page.locator('[data-search-result-count]')).toContainText('4 results')
        await expect(chips(page).getByRole('radio')).toHaveText([
          /^All\s*4$/,
          /^Tasks\s*2$/,
          /^Reminders\s*1$/,
          /^Quotas\s*1$/,
        ])
        // Task hits are real rows; the queued one says where it sits.
        await expect(taskRow(page, made.dated)).toBeVisible()
        await expect(taskRow(page, made.queued).locator('[data-search-queue-word]')).toHaveText(
          'Task queue · Days',
        )
        await expect(taskRow(page, made.dated).locator('[data-search-queue-word]')).toHaveCount(0)
        // Reminders and quotas point at where they live.
        await expect(pointer(page, made.reminder).locator('[data-search-where]')).toHaveText(
          `${made.slot.label} · Daily`,
        )
        await expect(pointer(page, made.quota).locator('[data-search-where]')).toHaveText(
          '2 a week · 0 done',
        )
        // In order: Tasks, Reminders, Quotas.
        expect(
          await page
            .locator('[data-search-kind-heading]')
            .evaluateAll((hs) => hs.map((h) => h.getAttribute('data-search-kind-heading'))),
        ).toEqual(['task', 'reminder', 'quota'])

        // A chip narrows the one list in place.
        await chip(page, 'reminder').click()
        await expect(pointer(page, made.reminder)).toBeVisible()
        await expect(taskRow(page, made.dated)).toHaveCount(0)
        await expect(pointer(page, made.quota)).toHaveCount(0)
        await chip(page, 'task').click()
        await expect(taskRow(page, made.queued)).toBeVisible()
        await expect(pointer(page, made.reminder)).toHaveCount(0)
        await chip(page, 'all').click()
        await expect(pointer(page, made.quota)).toBeVisible()

        // The quota's tap: its prompt waits today, so the search ends and
        // the Reminders card shows it, lifted; with none waiting (handled, or
        // prompts off) it would open its details.
        const promptWaits = await waitsToday(page, made.quota)
        await pointer(page, made.quota).click()
        if (promptWaits) {
          await expect(chips(page)).toHaveCount(0)
          await expect(
            page.locator('[data-reminders-panel]').getByText(new RegExp(`Read with ${w}`)),
          ).toBeVisible()
        } else {
          await page.waitForURL(`/tasks/${made.quota}`)
        }
      } finally {
        await cleanup(
          page,
          Object.values(made).filter((v): v is number => typeof v === 'number'),
        )
      }
    })
  })
}

test.describe('Dashboard search · one kind, and the lift', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('only reminders match: All and Reminders chips, no Tasks group; a reminder waiting today is lifted in the card', async ({
    authenticatedPage: page,
  }) => {
    const w = word()
    // Whether it waits today depends on the hour (its period may not have
    // opened, or the day may have turned): the test asks the server which,
    // and checks the tap's matching path.
    const slot = await firstSlot(page)
    const [h, m] = slot.start_time.split(':').map(Number)
    const reminder = await post(page, {
      title: uniqueTitle(`${w} vitamins`),
      is_reminder: true,
      rrule: `FREQ=DAILY;BYHOUR=${h};BYMINUTE=${m}`,
    })
    try {
      await page.goto('/')
      await page.getByRole('textbox', { name: 'Search tasks' }).fill(w)
      await expect(chips(page).getByRole('radio')).toHaveText([/^All\s*1$/, /^Reminders\s*1$/])
      await expect(page.locator('[data-search-kind-heading="task"]')).toHaveCount(0)

      const waits = await waitsToday(page, reminder)
      await pointer(page, reminder).click()
      if (waits) {
        // The search ends and the Reminders card shows the row, lifted.
        await expect(page.getByRole('textbox', { name: 'Search tasks' })).toHaveValue('')
        await expect(page.locator('[data-search-kind-chips]')).toHaveCount(0)
        await expect(
          page.locator('[data-reminders-panel]').getByText(new RegExp(`${w} vitamins`)),
        ).toBeVisible()
        expect(new URL(page.url()).pathname).toBe('/')
      } else {
        await page.waitForURL(`/tasks/${reminder}`)
      }
    } finally {
      await cleanup(page, [reminder])
    }
  })
})

test.describe('Dashboard search · three more paths (state combinations, 2026-11-12)', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('acting on a task result while the Tasks chip narrows the list: the row leaves, the counts follow, the chip stays', async ({
    authenticatedPage: page,
  }) => {
    const w = word()
    const made = await seed(page, w)
    try {
      await page.goto('/')
      await page.getByRole('textbox', { name: 'Search tasks' }).fill(w)
      await chip(page, 'task').click()
      await expect(taskRow(page, made.dated)).toBeVisible()
      await expect(pointer(page, made.reminder)).toHaveCount(0)

      await taskRow(page, made.dated).locator('[data-lean-done]').click()
      await expect(taskRow(page, made.dated)).toHaveCount(0)
      // Still searching, still narrowed to tasks: one task left of three results.
      await expect(page.getByRole('textbox', { name: 'Search tasks' })).toHaveValue(w)
      await expect(chip(page, 'task')).toHaveAttribute('aria-checked', 'true')
      await expect(chip(page, 'task')).toContainText('1')
      await expect(chip(page, 'all')).toContainText('3')
      await expect(taskRow(page, made.queued)).toBeVisible()
      await expect(pointer(page, made.reminder)).toHaveCount(0)
    } finally {
      await cleanup(
        page,
        Object.values(made).filter((v): v is number => typeof v === 'number'),
      )
    }
  })

  test('arriving by /?search= with a project filter: the search shows everything, the chips dimmed; "only <project>" narrows the results and back', async ({
    authenticatedPage: page,
  }) => {
    const w = word()
    const made = await seed(page, w)
    const projects = (await (await page.request.get('/api/projects')).json()).data.projects as {
      id: number
      name: string
    }[]
    const dated = (await (await page.request.get(`/api/tasks/${made.dated}`)).json()).data as {
      project_id: number
    }
    const other = projects.find((p) => p.id !== dated.project_id)!
    try {
      await page.goto(`/?search=${w}&project=${other.id}`)
      await expect(page.getByRole('textbox', { name: 'Search tasks' })).toHaveValue(w)
      await expect(page).toHaveURL(/\/$/)
      // Both tasks are in ANOTHER project than the filter names, and found.
      await expect(taskRow(page, made.dated)).toBeVisible()
      await expect(taskRow(page, made.queued)).toBeVisible()
      await expect(pointer(page, made.reminder)).toBeVisible()
      await expect(chip(page, 'all')).toContainText('4')
      const line = page.locator('[data-search-filter-line]')
      await expect(line).toHaveAttribute('data-search-filter-line', 'everything')
      await expect(line).toHaveText(`Searching everything · only ${other.name}`)
      await expect(page.locator('[data-filters-idle]')).toHaveCount(1)

      // "only <project>": the filter over the results. Nothing here is in it.
      await line.click()
      await expect(line).toHaveAttribute('data-search-filter-line', 'narrowed')
      await expect(line).toHaveText(`Only ${other.name} · search everything`)
      await expect(taskRow(page, made.dated)).toHaveCount(0)
      await expect(pointer(page, made.reminder)).toHaveCount(0)
      await expect(pointer(page, made.quota)).toHaveCount(0)
      await expect(page.locator('[data-search-result-count]')).toContainText('0 results')
      await expect(page.locator('[data-filters-idle]')).toHaveCount(0)

      // And back.
      await line.click()
      await expect(taskRow(page, made.dated)).toBeVisible()
      await expect(chip(page, 'all')).toContainText('4')
    } finally {
      await cleanup(
        page,
        Object.values(made).filter((v): v is number => typeof v === 'number'),
      )
    }
  })

  test('a filter chip on, then a search: everything is found; clearing the search puts the filter back as it was', async ({
    authenticatedPage: page,
  }) => {
    const w = word()
    const made = await seed(page, w)
    const projects = (await (await page.request.get('/api/projects')).json()).data.projects as {
      id: number
    }[]
    const dated = (await (await page.request.get(`/api/tasks/${made.dated}`)).json()).data as {
      project_id: number
    }
    const other = projects.find((p) => p.id !== dated.project_id)!
    try {
      await page.goto(`/?project=${other.id}`)
      await expect(page).toHaveURL(/\/$/)
      const search = page.getByRole('textbox', { name: 'Search tasks' })
      await search.fill(w)
      await expect(taskRow(page, made.dated)).toBeVisible()
      await expect(page.locator('[data-search-filter-line]')).toBeVisible()
      await search.fill('')
      // The search is over: the project filter narrows the list again.
      await expect(page.locator('[data-search-filter-line]')).toHaveCount(0)
      await expect(page.locator('[data-filters-idle]')).toHaveCount(0)
      await expect(taskRow(page, made.dated)).toHaveCount(0)
    } finally {
      await cleanup(
        page,
        Object.values(made).filter((v): v is number => typeof v === 'number'),
      )
    }
  })

  test('a pointer row tapped after the reminder was handled elsewhere (the hidden card is stale): no error, and it lands on the card or its details', async ({
    authenticatedPage: page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    // No live sync: what the page knows of the Reminders card is its last load.
    await page.route('**/api/sync/stream', (route) => route.abort())
    const w = word()
    const slot = await firstSlot(page)
    const [h, m] = slot.start_time.split(':').map(Number)
    const reminder = await post(page, {
      title: uniqueTitle(`${w} vitamins`),
      is_reminder: true,
      rrule: `FREQ=DAILY;BYHOUR=${h};BYMINUTE=${m}`,
    })
    try {
      await page.goto('/')
      await page.getByRole('textbox', { name: 'Search tasks' }).fill(w)
      await expect(pointer(page, reminder)).toBeVisible()
      // Another device considers it.
      const done = await page.request.post(`/api/tasks/${reminder}/done`, { data: {} })
      expect(done.ok()).toBeTruthy()
      expect(await waitsToday(page, reminder)).toBe(false)

      await pointer(page, reminder).click()
      await expect(page.locator('[data-search-kind-chips]')).toHaveCount(0)
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toMatch(new RegExp(`^/$|^/tasks/${reminder}$`))
      expect(errors).toEqual([])
    } finally {
      await cleanup(page, [reminder])
    }
  })
})

test.describe('The tabs: in place, plus what else matches', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('Reminders: its own results, and "N also match" opens the dashboard search', async ({
    authenticatedPage: page,
  }) => {
    const w = word()
    const made = await seed(page, w)
    try {
      await page.goto('/reminders')
      await page.getByRole('button', { name: 'Search', exact: true }).click()
      await page.getByRole('textbox', { name: 'Search reminders' }).fill(w)
      const line = page.locator('[data-also-match]')
      // The two tasks. The quota is counted only when its prompt row is not
      // already among this tab's results.
      const promptShown = await waitsToday(page, made.quota)
      await expect(line).toContainText(
        promptShown
          ? `2 tasks also match “${w}” · show them`
          : `2 tasks and 1 quota also match “${w}” · show them`,
      )
      await line.click()
      await page.waitForURL((u) => u.pathname === '/')
      // The dashboard arrives searching, every kind listed; the param is gone.
      await expect(page.getByRole('textbox', { name: 'Search tasks' })).toHaveValue(w)
      await expect(chip(page, 'all')).toContainText('4')
      await expect(pointer(page, made.reminder)).toBeVisible()
      expect(new URL(page.url()).search).toBe('')
    } finally {
      await cleanup(
        page,
        Object.values(made).filter((v): v is number => typeof v === 'number'),
      )
    }
  })

  test('Quotas: "N also match", and none when nothing else does', async ({
    authenticatedPage: page,
  }) => {
    const w = word()
    const made = await seed(page, w)
    try {
      await page.goto('/quotas')
      await page.getByRole('button', { name: 'Search', exact: true }).click()
      const input = page.getByRole('textbox', { name: 'Search quotas' })
      await input.fill(w)
      await expect(page.locator('[data-also-match]')).toContainText(
        '2 tasks and 1 reminder also match',
      )
      await input.fill(`Read with ${w}`)
      await expect(page.locator('[data-track-chip]').first()).toBeVisible()
      await expect(page.locator('[data-also-match]')).toHaveCount(0)
    } finally {
      await cleanup(
        page,
        Object.values(made).filter((v): v is number => typeof v === 'number'),
      )
    }
  })
})
