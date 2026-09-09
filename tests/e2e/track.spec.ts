/**
 * Track on the web (REDESIGN-V03 §5): a tracked task's row is a progress row —
 * count, bar, +1 and −1 — and reaching the target reads as "met" without
 * closing the task.
 */
import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'

async function createTask(page: Page, body: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data: body })
  expect(res.ok()).toBeTruthy()
  const json = await res.json()
  return json.data.id as number
}

async function deleteTasks(page: Page, ids: number[]): Promise<void> {
  for (const id of ids) await page.request.delete(`/api/tasks/${id}`)
}

const VIEWS = ['Today', 'Projects', 'All'] as const
type View = (typeof VIEWS)[number]
/** The view toggle persists server-side for the shared test user; tests put it back. */
async function pressedView(page: Page): Promise<View | null> {
  for (const v of VIEWS) {
    const b = page.getByRole('button', { name: v, exact: true })
    if ((await b.getAttribute('aria-pressed')) === 'true') return v
  }
  return null
}
async function switchView(page: Page, v: View) {
  const saved = page.waitForResponse((r) => r.url().includes('/api/user/preferences'))
  await page.getByRole('button', { name: v, exact: true }).click()
  await saved
}

/** The panel starts folded; open it (the choice persists, so tests close it again). */
async function openTrack(page: Page) {
  const panel = page.getByRole('region', { name: 'Track' })
  await expect(panel).toBeVisible()
  const fold = panel.getByRole('button', { name: 'Expand Track' })
  if (await fold.isVisible()) {
    // The choice is saved fire-and-forget; wait for it so a reload can't race it.
    const saved = page.waitForResponse((r) => r.url().includes('/api/user/preferences'))
    await fold.click()
    await saved
  }
  await expect(panel.getByRole('button', { name: 'Collapse Track' })).toBeVisible()
}
async function closeTrack(page: Page) {
  const fold = page.getByRole('button', { name: 'Collapse Track' })
  if (await fold.isVisible()) {
    const saved = page.waitForResponse((r) => r.url().includes('/api/user/preferences'))
    await fold.click()
    await saved
  }
}

test.describe('Track', () => {
  test('the Track panel shows a quota, logs +1 and −1, and reads "met" at target', async ({
    authenticatedPage: page,
  }) => {
    // A weekly quota whose rule "occurs" on some other weekday: the panel must
    // show it every day regardless.
    const id = await createTask(page, {
      title: 'Eggs for the kids',
      progress_target: 2,
      rrule: 'FREQ=WEEKLY;BYDAY=WE',
    })
    // A quota with a target of 1 — only the flag makes it one — on a different
    // period, so the chips say their periods and the header says none.
    const nightId = await createTask(page, {
      title: 'Date night',
      rrule: 'FREQ=MONTHLY',
      is_tracked: true,
    })

    try {
      await page.goto('/')
      const panel = page.getByRole('region', { name: 'Track' })
      await expect(panel).toBeVisible()
      // Folded by default: the header's total, and the quota as a chip.
      await expect(panel.getByRole('button', { name: 'Expand Track' })).toBeVisible()
      const night = panel.locator(`[data-track-chip="${nightId}"]`)
      await expect(night).toContainText('Date night')
      // The period is two letters on the chip's own count, since the panel
      // groups by LABEL now and a label group mixes days, weeks and months.
      await expect(night.locator('[data-track-count]')).toHaveText('0/1·mo')
      // One card, one list: no period cards and no summed bar (a bar across
      // mixed periods is meaningless — §5, Trent 2026-09-09).
      await expect(panel.locator('[data-track-period]')).toHaveCount(0)
      const stream = panel.getByRole('list', { name: 'Quotas' })
      await expect(stream).toHaveCount(1)
      await expect(stream).toContainText('Date night')
      await expect(stream).toContainText('Eggs for the kids')
      await expect(panel.getByRole('progressbar')).toHaveCount(0)
      await expect(panel.getByRole('button', { name: 'Expand Track' })).not.toContainText('this')
      await expect(panel.locator(`[data-track-row="${id}"]`)).toHaveCount(0)
      const chip = panel.locator(`[data-track-chip="${id}"]`)
      const chipCount = chip.locator('[data-track-count]')
      await expect(chipCount).toHaveText('0/2·wk')

      // Tap: +1, with a toast whose Undo takes it back.
      await chip.click()
      await expect(chipCount).toHaveText('1/2·wk')
      const toast = page
        .locator('[data-sonner-toast]')
        .filter({ hasText: 'Logged one for \u201cEggs for the kids\u201d \u00b7 1/2' })
      await expect(toast).toBeVisible()
      await toast.getByRole('button', { name: 'Undo' }).click()
      await expect(chipCount).toHaveText('0/2·wk')
      // ...and the server ends where the chip says it does. The +1 and the −1
      // that takes it back are one gesture apart, so they used to be in flight
      // together; applied in the wrong order the server's clamp-at-zero ate the
      // −1 and left 1 behind, which nothing showed until the next reload.
      // `useTrackProgress` queues a task's requests for exactly this.
      await expect
        .poll(async () => {
          const res = await page.request.get(`/api/tasks/${id}`)
          return (await res.json()).data.progress_current
        })
        .toBe(0)

      // Subtracting: shift-click and right-click. A hold no longer subtracts —
      // since 2026-09-06 it opens the detail sheet, and the swipe took over −1.
      await chip.click()
      await chip.click()
      await expect(chipCount).toHaveText('2/2·wk')
      await chip.click({ modifiers: ['Shift'] })
      await expect(chipCount).toHaveText('1/2·wk')
      await chip.click({ button: 'right' })
      await expect(chipCount).toHaveText('0/2·wk')

      // A hold opens a popover anchored to the chip — the shape Trent asked
      // for on 2026-09-06 ("still the same concept but not hover"). It reads,
      // it does not edit, and the click trailing the hold is not a tap.
      await chip.click({ delay: 500 })
      const pop = page.locator('[data-track-popover]')
      await expect(pop).toBeVisible()
      await expect(pop).toContainText('Never yet')
      await expect(pop.getByRole('textbox')).toHaveCount(0)
      await expect(chipCount).toHaveText('0/2·wk')

      // Open is the answer to "how do I even edit the Track items": a quota is
      // an ordinary task, and it gets its OWN editor — no due date, no snooze
      // grid, no Done, none of which mean anything for "twice a week".
      await pop.getByRole('button', { name: 'Open' }).click()
      await page.waitForURL(`**/tasks/${id}`)
      const editor = page.locator(`[data-quota-detail="${id}"]`)
      await expect(editor).toBeVisible()
      await expect(editor.getByRole('button', { name: 'Every week' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      await expect(page.getByRole('button', { name: '+1 hr' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Done', exact: true })).toHaveCount(0)

      await page.goto('/')

      await openTrack(page)
      // The choice sticks across a reload.
      await page.reload()
      await expect(panel.getByRole('button', { name: 'Collapse Track' })).toBeVisible()
      const row = panel.locator(`[data-track-row="${id}"]`)
      await expect(row).toBeVisible()
      // On the Today view it is not also a row in the day's groups: the panel
      // is its only home there (other views list it as a plain row).
      const todayToggle = page.getByRole('button', { name: 'Today', exact: true })
      await todayToggle.click()
      await expect(todayToggle).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator(`#task-row-${id}`)).toHaveCount(0)
      await expect(row).toBeVisible()
      const count = row.locator('[data-track-count]')
      const plus = row.getByRole('button', { name: 'Log one more for "Eggs for the kids"' })
      const minus = row.getByRole('button', { name: 'Remove one from "Eggs for the kids"' })

      // One aligned line: title, bar, count, −, +1.
      await expect(count).toContainText('0 / 2')
      await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
      await expect(minus).toBeDisabled()

      // +1 moves the count at once (optimistic) and the server agrees.
      await plus.click()
      await expect(count).toContainText('1 / 2')
      await expect
        .poll(async () => {
          const res = await page.request.get(`/api/tasks/${id}`)
          return (await res.json()).data.progress_current
        })
        .toBe(1)

      // −1 is a correction, never below zero.
      await minus.click()
      await expect(count).toContainText('0 / 2')
      await expect(minus).toBeDisabled()

      // Reaching the target is "met": a state, not an exit — the line stays.
      await plus.click()
      await plus.click()
      await expect(count).toContainText('2 / 2')
      await expect(row.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2')
      await expect(row).toBeVisible()

      // Overflow stays observable (Trent, Jul 26): the third egg shows as 3/2.
      await plus.click()
      await expect(count).toContainText('3 / 2')

      // The task itself is still open — progress is not completion. Polled, not
      // read once: the count on screen is optimistic and the +1 behind it is
      // still on the wire (`useTrackProgress` sends a task's logs one at a
      // time), so a single read races the request it is checking on.
      await expect
        .poll(async () => {
          const res = await page.request.get(`/api/tasks/${id}`)
          const task = (await res.json()).data
          return { done: task.done, progress_current: task.progress_current }
        })
        .toEqual({ done: false, progress_current: 3 })
    } finally {
      await closeTrack(page)
      await deleteTasks(page, [id, nightId])
    }
  })

  test('a quota edits its cadence in its own editor, and is retired by deleting', async ({
    authenticatedPage: page,
  }) => {
    const id = await createTask(page, {
      title: 'Walk the dog',
      progress_target: 3,
      is_tracked: true,
      rrule: 'FREQ=WEEKLY',
    })

    try {
      await page.goto(`/tasks/${id}`)
      const editor = page.locator(`[data-quota-detail="${id}"]`)
      await expect(editor).toBeVisible()

      // Target, flag and rule travel together in one PATCH — validation rejects
      // a bare FREQ rrule that does not also say the task is tracked.
      await editor.getByRole('textbox', { name: 'Times per period' }).fill('5')
      await editor.getByRole('button', { name: 'Every day' }).click()
      await editor.getByRole('button', { name: 'Save' }).click()
      await page.waitForResponse(
        (r) => r.url().includes(`/api/tasks/${id}`) && r.request().method() === 'PATCH',
      )

      await page.reload()
      const after = page.locator(`[data-quota-detail="${id}"]`)
      await expect(after.getByRole('button', { name: 'Every day' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      await expect(after.getByRole('textbox', { name: 'Times per period' })).toHaveValue('5')

      // A quota is retired by deleting it, not by being turned back into a
      // task: there is no "stop tracking", because a quota is its own kind of
      // thing rather than a task wearing a counter.
      await expect(after.getByRole('button', { name: 'Stop tracking' })).toHaveCount(0)
      await expect(after.getByRole('button', { name: 'Move to Trash' })).toBeVisible()
    } finally {
      await deleteTasks(page, [id])
    }
  })

  /**
   * §5, Trent 2026-09-09, choosing variation G of the `track-by-label` mockup:
   * the panel groups by LABEL and draws the whole thing as one wrapping row,
   * so a cluster's heading is a PEER of the chips rather than a box around
   * them. That is the load-bearing part — a heading that is its own container
   * would start a new line, which is the height the layout was chosen to save
   * — so it is asserted as DOM shape (same flex parent, one wrapping list),
   * never as pixel positions.
   */
  test('quotas stream under inline label titles, in label order, unlabelled last', async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
    try {
      // "dev" and "work" are registered by the seed, and sort in that order.
      const devId = await createTask(page, {
        title: 'Probe stream dev quota',
        progress_target: 2,
        rrule: 'FREQ=WEEKLY',
        labels: ['dev'],
        create_label: true,
      })
      const workId = await createTask(page, {
        title: 'Probe stream work quota',
        progress_target: 3,
        rrule: 'FREQ=DAILY',
        labels: ['work'],
        create_label: true,
      })
      const bareId = await createTask(page, {
        title: 'Probe stream bare quota',
        progress_target: 1,
        is_tracked: true,
        rrule: 'FREQ=MONTHLY',
      })
      ids.push(devId, workId, bareId)

      await page.goto('/')
      const panel = page.getByRole('region', { name: 'Track' })
      await expect(panel.getByRole('button', { name: 'Expand Track' })).toBeVisible()
      const stream = panel.getByRole('list', { name: 'Quotas' })

      // One list holds every cluster: no card, no sub-list, per label.
      await expect(stream).toHaveCount(1)
      for (const key of ['dev', 'work', 'unlabelled']) {
        await expect(stream.locator(`[data-track-cluster="${key}"]`)).toBeVisible()
      }

      // A title and the chips it introduces are siblings — direct children of
      // the same wrapping list — which is what lets the title attach after the
      // previous cluster's last chip instead of forcing a break.
      for (const [key, id] of [
        ['dev', devId],
        ['work', workId],
        ['unlabelled', bareId],
      ] as const) {
        await expect(stream.locator(`:scope > li[data-track-cluster="${key}"]`)).toHaveCount(1)
        await expect(stream.locator(`:scope > li:has([data-track-chip="${id}"])`)).toHaveCount(1)
      }

      // ...and that parent is the wrapping flex row itself, so a title can
      // never be pushed onto a line of its own.
      expect(
        await stream.evaluate((el) => {
          const s = getComputedStyle(el)
          return { display: s.display, wrap: s.flexWrap }
        }),
      ).toEqual({ display: 'flex', wrap: 'wrap' })

      // Alphabetical by label, and the unlabelled cluster is the leftovers —
      // last however the names happen to sort.
      const order = await stream
        .locator('[data-track-cluster]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-track-cluster')))
      expect(order.indexOf('dev')).toBeLessThan(order.indexOf('work'))
      expect(order[order.length - 1]).toBe('unlabelled')

      // Each quota is in the stream exactly once, and carries its own period
      // as a suffix now that no card names one.
      for (const id of ids) await expect(stream.locator(`[data-track-chip="${id}"]`)).toHaveCount(1)
      await expect(stream.locator(`[data-track-chip="${devId}"] [data-track-count]`)).toHaveText(
        '0/2\u00b7wk',
      )
      await expect(stream.locator(`[data-track-chip="${workId}"] [data-track-count]`)).toHaveText(
        '0/3\u00b7d',
      )
      await expect(stream.locator(`[data-track-chip="${bareId}"] [data-track-count]`)).toHaveText(
        '0/1\u00b7mo',
      )

      // Expanded, the same clusters become headings over the full rows — the
      // grouping does not vanish when the panel opens.
      await openTrack(page)
      await expect(panel.locator(`[data-track-row="${devId}"]`)).toBeVisible()
      await expect(panel.locator('[data-track-cluster="dev"]')).toBeVisible()
      await closeTrack(page)
    } finally {
      await deleteTasks(page, ids)
    }
  })

  test('an ordinary task is a row in the day, not a line in the panel', async ({
    authenticatedPage: page,
  }) => {
    const id = await createTask(page, { title: 'Plain one-off task' })
    let before: View | null = null
    try {
      await page.goto('/')
      await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeVisible()
      before = await pressedView(page)
      if (before !== 'Today') await switchView(page, 'Today')
      // Undated one-offs sit in the day's folded "Undated" group (§7.3).
      const fold = page.getByRole('button', { name: 'Expand Undated' })
      await expect(fold).toBeVisible()
      await fold.click()
      await expect(page.getByRole('button', { name: 'Collapse Undated' })).toBeVisible()
      const row = page.locator(`#task-row-${id}`)
      await expect(row).toBeVisible()
      await expect(page.locator(`[data-track-row="${id}"]`)).toHaveCount(0)
    } finally {
      if (before && before !== 'Today') await switchView(page, before)
      await deleteTasks(page, [id])
    }
  })

  /**
   * §5, amended 2026-09-08 (Trent): "a quota is not a task. It appears on the
   * Quotas page and in the Track panel and nowhere else." It used to be a plain
   * row in the All list wearing a "1 / 3 this week" chip, which put a thing
   * with no due date, no snooze and no Done in among things that have all
   * three. This pins both halves: gone from the list, still in the panel.
   */
  test('a quota is absent from the All list but still in the Track panel', async ({
    authenticatedPage: page,
  }) => {
    const id = await createTask(page, {
      title: 'Chip quota',
      progress_target: 3,
      rrule: 'FREQ=WEEKLY;BYDAY=WE',
    })
    let before: View | null = null
    try {
      const logged = await page.request.post(`/api/tasks/${id}/progress`, { data: { delta: 1 } })
      expect(logged.ok()).toBeTruthy()
      await page.goto('/')
      await expect(page.getByRole('button', { name: 'All', exact: true })).toBeVisible()
      before = await pressedView(page)
      if (before !== 'All') await switchView(page, 'All')

      // A plain task is here, so an empty assertion below cannot pass by the
      // list simply not having rendered.
      const plainId = await createTask(page, { title: 'Plain sibling task' })
      try {
        await page.reload()
        if ((await pressedView(page)) !== 'All') await switchView(page, 'All')
        await expect(page.locator(`#task-row-${plainId}`)).toBeVisible()
        await expect(page.locator(`#task-row-${id}`)).toHaveCount(0)

        // ...and the panel above the list still has it, with its count.
        await openTrack(page)
        const row = page.locator(`[data-track-row="${id}"]`)
        await expect(row).toBeVisible()
        await expect(row).toContainText('1')
        await closeTrack(page)
      } finally {
        await deleteTasks(page, [plainId])
      }
    } finally {
      if (before && before !== 'All') await switchView(page, before)
      await deleteTasks(page, [id])
    }
  })
})

/**
 * The Quotas page (§5) — where quotas are made, managed and retired, as
 * opposed to the dashboard's Track panel, which is where they are tapped.
 */
test.describe('Quotas page', () => {
  test('makes a quota, selects a range of them, and retires them together', async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
    try {
      await page.goto('/quotas')
      const view = page.locator('[data-quotas-view]')
      await expect(view).toBeVisible()
      const before = await view.locator('[data-quota-row]').count()

      // Creating one: the only route that existed before this page was the API.
      for (const title of ['Probe quota one', 'Probe quota two']) {
        await view.getByRole('button', { name: 'New quota' }).click()
        // A modal, not an inline form.
        const form = page.getByRole('dialog')
        await expect(form).toBeVisible()
        await form.getByRole('textbox').first().fill(title)
        const created = page.waitForResponse(
          (r) => r.url().endsWith('/api/tasks') && r.request().method() === 'POST',
        )
        await form.getByRole('button', { name: 'Create' }).click()
        ids.push((await (await created).json()).data.id)
      }
      await expect(view.locator('[data-quota-row]')).toHaveCount(before + 2)

      // A brand new quota has never been met, and says so.
      const row = page.locator(`[data-quota-row="${ids[0]}"]`)
      await expect(row).toContainText('never met')

      // Nobody labelled these, so they are in the Unlabelled group — a real
      // group with a name, not a gap. And the row carries its own period now
      // that the card it sits in is a label rather than a cadence.
      const unlabelled = view.locator('[data-quota-group="unlabelled"]')
      await expect(unlabelled).toContainText('Unlabelled')
      await expect(unlabelled.locator(`[data-quota-row="${ids[0]}"]`)).toHaveCount(1)
      await expect(row.locator('[data-quota-period]')).toHaveText('· week')

      // The house selection model: a plain click selects EXACTLY one and never
      // navigates. It does not accumulate — which is what it wrongly did when
      // this page first shipped.
      await row.click()
      await expect(row).toHaveAttribute('aria-selected', 'true')
      await expect(page).toHaveURL(/\/quotas$/)
      await page.locator(`[data-quota-row="${ids[1]}"]`).click()
      await expect(page.locator('[data-quota-row][aria-selected="true"]')).toHaveCount(1)

      // Shift takes a range.
      await row.click({ modifiers: ['Shift'] })
      const bar = page.locator('[data-quota-selection-bar]')
      await expect(bar).toContainText('2 selected')

      // Editing several at once — the reason selection exists here beyond
      // retiring things.
      await bar.getByRole('button', { name: 'Details' }).click()
      // A modal, like every other editor in the app — not an inline panel.
      const bulk = page.getByRole('dialog')
      await expect(bulk).toContainText('Editing 2 quotas')
      await bulk.getByRole('textbox', { name: 'Times per period' }).fill('7')
      const edited = page.waitForResponse(
        (r) => r.url().includes('/bulk/edit') && r.request().method() === 'POST',
      )
      await bulk.getByRole('button', { name: 'Save' }).click()
      expect((await edited).status()).toBe(200)
      await expect(page.locator(`[data-quota-row="${ids[0]}"]`)).toContainText('/ 7')

      // A double-click opens the editor as a MODAL and stays on the surface —
      // the same contract reminders have.
      await page.locator(`[data-quota-row="${ids[0]}"]`).dblclick()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page).toHaveURL(/\/quotas$/)
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)

      // And the bar retires the set.
      await page.locator(`[data-quota-row="${ids[0]}"]`).click()
      await page.locator(`[data-quota-row="${ids[1]}"]`).click({ modifiers: ['Shift'] })
      await page
        .locator('[data-quota-selection-bar]')
        .getByRole('button', { name: /Move .*to Trash/ })
        .click()
      await expect(page.locator(`[data-quota-row="${ids[0]}"]`)).toHaveCount(0)
      await expect(page.locator(`[data-quota-row="${ids[1]}"]`)).toHaveCount(0)

      // §5/A3+A4, over the API — last, because both of these mutate the list
      // this page is showing. Every write emits a sync event and QuotasView
      // refreshes on it, so doing them mid-sequence re-rendered the rows out
      // from under the clicks above. There is no "stop tracking" button (see
      // the editor test), so the API is the whole of the retire path.
      //
      // Retiring takes the period rule with it: a bare "FREQ=WEEKLY" left on an
      // untracked task with no due date is evaluated as a schedule, and rrule.js
      // places it on an arbitrary weekday, so the task would surface on a day
      // nobody chose.
      const retireId = await createTask(page, {
        title: 'Probe quota to retire',
        progress_target: 2,
        rrule: 'FREQ=WEEKLY',
      })
      ids.push(retireId)
      // Reload rather than waiting for the row to be pushed in. This quota was
      // made through the API, so the only thing that would bring it to a page
      // already open is the sync stream — and asserting on a push makes the
      // test depend on delivery timing rather than on server state. Same for
      // the reload after the undo below.
      await page.reload()
      await expect(page.locator(`[data-quota-row="${retireId}"]`)).toBeVisible()

      const retired = await page.request.patch(`/api/tasks/${retireId}`, {
        data: { is_tracked: false, progress_target: 1 },
      })
      expect(retired.status()).toBe(200)
      const retiredBody = (await retired.json()).data
      expect(retiredBody.is_tracked).toBe(false)
      expect(retiredBody.rrule).toBeNull()
      expect(retiredBody.due_at).toBeNull()
      // It is no longer a quota, so it leaves this page.
      await page.reload()
      await expect(page.locator(`[data-quota-row="${retireId}"]`)).toHaveCount(0)

      // Undo puts it back, flag and rule together. This is the path that used
      // to throw inside undo's column allowlist and wedge the whole stack
      // (`is_tracked` was not on it), so a green 200 here is the contract.
      const undone = await page.request.post('/api/undo')
      expect(undone.status()).toBe(200)
      await page.reload()
      await expect(page.locator(`[data-quota-row="${retireId}"]`)).toBeVisible()

      // And a quota refuses a snooze outright (§5/A4).
      const snoozed = await page.request.post(`/api/tasks/${retireId}/snooze`, {
        data: { until: new Date(Date.now() + 3_600_000).toISOString() },
      })
      expect(snoozed.status()).toBe(400)
    } finally {
      await deleteTasks(page, ids)
    }
  })

  /**
   * Rapid-tapping +1 is how a count gets to three, so the two clicks must both
   * land — but the dblclick riding behind them must not also open the editor.
   * The buttons stop the row's `click`; `dblclick` is a separate event that
   * ignored that, which is exactly what Trent hit (2026-09-06): "if I
   * double-tap the +1 on Broccoli Avocado, then the modal pops up".
   */
  test('double-tapping +1 counts twice and does not open the editor', async ({
    authenticatedPage: page,
  }) => {
    const id = await createTask(page, {
      title: 'Probe rapid tap',
      progress_target: 5,
      rrule: 'FREQ=WEEKLY',
    })
    try {
      await page.goto('/quotas')
      const row = page.locator(`[data-quota-row="${id}"]`)
      await expect(row.locator('[data-quota-count]')).toHaveText('0 / 5')

      await row.getByRole('button', { name: /Log one more/ }).dblclick()

      // Both taps counted...
      await expect(row.locator('[data-quota-count]')).toHaveText('2 / 5')
      // ...and nothing opened on top of them.
      await expect(page.getByRole('dialog')).toHaveCount(0)

      // The row itself still opens on a double-click — the guard is about where
      // the click landed, not about disabling the gesture.
      await row.getByText('Probe rapid tap').dblclick()
      await expect(page.getByRole('dialog')).toBeVisible()
      await page.keyboard.press('Escape')
    } finally {
      await deleteTasks(page, [id])
    }
  })
})

test.describe('Quota labels', () => {
  /**
   * §5, Trent 2026-09-08: "I think we need to have one label for quotas… there's
   * a bunch of stuff for the kids and there are other things." The label is the
   * page's grouping, so the picker in the editor and the group a row sits in are
   * one feature and are tested as one.
   */
  test('a quota is grouped by its one label, and the picker moves it', async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
    try {
      // A quota that still carries TWO labels — six on Trent's corpus do, and
      // the migration deliberately left them alone. It belongs to the FIRST.
      // `create_label` is §7.2's opt-in: an unknown label is refused without it.
      ids.push(
        await createTask(page, {
          title: 'Probe label two-label',
          progress_target: 2,
          rrule: 'FREQ=WEEKLY',
          labels: ['health', 'kids'],
          create_label: true,
        }),
      )
      ids.push(
        await createTask(page, {
          title: 'Probe label house one',
          progress_target: 1,
          is_tracked: true,
          rrule: 'FREQ=MONTHLY',
          labels: ['house'],
          create_label: true,
        }),
      )

      await page.goto('/quotas')
      const view = page.locator('[data-quotas-view]')
      await expect(view).toBeVisible()

      // Each lands under its own label, and the two-label one appears ONCE.
      await expect(
        view.locator(`[data-quota-group="health"] [data-quota-row="${ids[0]}"]`),
      ).toHaveCount(1)
      await expect(view.locator(`[data-quota-row="${ids[0]}"]`)).toHaveCount(1)
      await expect(
        view.locator(`[data-quota-group="house"] [data-quota-row="${ids[1]}"]`),
      ).toHaveCount(1)
      // The header counts quotas, never a sum of mixed targets.
      await expect(view.locator('[data-quota-group="house"]')).toContainText('1 quota')

      // Picking a different label moves the row to that group.
      await view.locator(`[data-quota-row="${ids[1]}"]`).dblclick()
      const editor = page.getByRole('dialog')
      await expect(editor).toBeVisible()
      await expect(editor.getByRole('button', { name: 'house', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      const saved = page.waitForResponse(
        (r) => r.url().includes(`/api/tasks/${ids[1]}`) && r.request().method() === 'PATCH',
      )
      await editor.getByRole('button', { name: 'health', exact: true }).click()
      await editor.getByRole('button', { name: 'Save' }).click()
      expect((await saved).status()).toBe(200)
      await expect(
        view.locator(`[data-quota-group="health"] [data-quota-row="${ids[1]}"]`),
      ).toHaveCount(1)
      await expect(view.locator('[data-quota-group="house"]')).toHaveCount(0)

      // A label the registry has never heard of is typed in the same picker and
      // registered by the save itself (`create_label`), so the new quota has a
      // group of its own the moment it exists.
      await view.getByRole('button', { name: 'New quota' }).click()
      const form = page.getByRole('dialog')
      await form.getByRole('textbox').first().fill('Probe label brand new')
      await form.getByRole('button', { name: '+ New' }).click()
      await form.getByRole('textbox', { name: 'New label' }).fill('probe-domain')
      await form.getByRole('textbox', { name: 'New label' }).press('Enter')
      await expect(form.getByRole('button', { name: 'probe-domain' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      const created = page.waitForResponse(
        (r) => r.url().endsWith('/api/tasks') && r.request().method() === 'POST',
      )
      await form.getByRole('button', { name: 'Create' }).click()
      const newId = (await (await created).json()).data.id as number
      ids.push(newId)
      await expect(
        view.locator(`[data-quota-group="probe-domain"] [data-quota-row="${newId}"]`),
      ).toHaveCount(1)
    } finally {
      await deleteTasks(page, ids)
    }
  })

  /**
   * Second review finding 1: a label typed while editing SEVERAL quotas goes
   * through `POST /api/tasks/bulk/edit`, which writes `labels` as raw SQL and
   * never registered the name. Both rows carried it and the registry had never
   * heard of it, so the NEXT editor did not offer the chip — which is what this
   * asserts, by opening a third quota that was never part of the selection.
   */
  test('a new label typed while editing several quotas reaches the registry', async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
    const fresh = `probe-bulk-${Date.now()}`
    try {
      for (const title of [
        'Probe bulk label one',
        'Probe bulk label two',
        'Probe bulk label third',
      ]) {
        ids.push(await createTask(page, { title, progress_target: 2, rrule: 'FREQ=WEEKLY' }))
      }

      await page.goto('/quotas')
      const view = page.locator('[data-quotas-view]')
      await expect(view).toBeVisible()

      // Two selected → the bulk endpoint.
      await view.locator(`[data-quota-row="${ids[0]}"]`).click()
      await view.locator(`[data-quota-row="${ids[1]}"]`).click({ modifiers: ['Shift'] })
      const bar = page.locator('[data-quota-selection-bar]')
      await bar.getByRole('button', { name: 'Details' }).click()

      const editor = page.getByRole('dialog')
      await expect(editor).toBeVisible()
      await editor.getByRole('button', { name: '+ New' }).click()
      await editor.getByRole('textbox', { name: 'New label' }).fill(fresh)
      await editor.getByRole('textbox', { name: 'New label' }).press('Enter')
      const edited = page.waitForResponse(
        (r) => r.url().includes('/bulk/edit') && r.request().method() === 'POST',
      )
      await editor.getByRole('button', { name: 'Save' }).click()
      expect((await edited).status()).toBe(200)

      // Both rows moved into the new group...
      await expect(
        view.locator(`[data-quota-group="${fresh}"] [data-quota-row="${ids[0]}"]`),
      ).toHaveCount(1)
      await expect(
        view.locator(`[data-quota-group="${fresh}"] [data-quota-row="${ids[1]}"]`),
      ).toHaveCount(1)

      // ...and the registry learned the name: a THIRD quota, never selected,
      // is offered the chip in its own editor. This is the half that was
      // broken — the rows carried a label nothing else knew existed.
      await page.reload()
      await expect(view.locator(`[data-quota-row="${ids[2]}"]`)).toBeVisible()
      await view.locator(`[data-quota-row="${ids[2]}"]`).dblclick()
      const third = page.getByRole('dialog')
      await expect(third).toBeVisible()
      await expect(third.getByRole('button', { name: fresh, exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
    } finally {
      await deleteTasks(page, ids)
    }
  })
})
