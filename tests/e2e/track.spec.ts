/**
 * Track on the web (REDESIGN-V03 §5): a tracked task's row is a progress row —
 * count, bar, +1 and −1 — and reaching the target reads as "met" without
 * closing the task.
 */
import { test, expect } from './fixtures'
import { request as apiRequest, type Page, type Response } from '@playwright/test'

/**
 * Tasks made by the running test, deleted by the `afterEach` below — and
 * deliberately NOT by a `finally` inside the test body.
 *
 * A body-level `finally` shares the test's own timeout. When the body times
 * out that budget is already spent, so the cleanup's first API call rejects
 * immediately and every row it was meant to remove survives into the retry.
 * Playwright gives hooks a separate budget once the test function has
 * finished, so an `afterEach` still runs. This is not a tolerance: it is the
 * difference between a cleanup that runs and one that provably cannot.
 *
 * What the old shape cost (2026-09-21): the quota-range test below timed out
 * on a slow CI runner, leaked its two probe quotas into the shared E2E
 * database, and both retries then failed on the leftovers rather than on the
 * thing under test — four red CI runs whose retries were never diagnostic.
 */
const madeByThisTest: number[] = []
function cleanUpLater(...ids: number[]): void {
  madeByThisTest.push(...ids)
}

/**
 * Quota titles that are adjacent by construction, and unique to the run.
 *
 * `trackedItems()` sorts EVERY quota the user has by title, and a shift range
 * covers whatever sits between its two anchors — so an assertion about the size
 * of a range only means something if nothing else can sort into the gap. A
 * shared run-unique prefix with single-letter suffixes guarantees that: another
 * run's rows, or another test's, sort as a block on one side of the group
 * rather than through the middle of it.
 *
 * Unique titles alone would NOT be enough. The range pair used to be "Probe
 * quota one"/"Probe quota two", and "Probe quota to retire" — made by the same
 * test — sorts between them. That is how a row leaked by a timed-out attempt
 * turned "2 selected" into "3 selected" on every CI retry (2026-09-21). The
 * bulk-label test below had the same hole and nobody noticed, because it never
 * asserted the size of its range: its "third" quota sorted between "one" and
 * "two", so the range swept in the very row the test claims was never selected.
 *
 * Suffixes are given in the order they should sort, so a caller can put a row
 * deliberately outside a pair by naming it last.
 */
function adjacentTitles(prefix: string, ...suffixes: string[]): string[] {
  const tag = `${prefix}-${Date.now()}`
  return suffixes.map((s) => `${tag} ${s}`)
}

async function createTask(page: Page, body: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data: body })
  expect(res.ok()).toBeTruthy()
  const json = await res.json()
  const id = json.data.id as number
  cleanUpLater(id)
  return id
}

test.afterEach(async ({ authenticatedPage: page }) => {
  // `splice` rather than a re-assignment: the list must be empty for the next
  // test even if a delete throws part-way through.
  const ids = madeByThisTest.splice(0)
  // Already-trashed rows answer 400 ("Task is already in trash"), which is the
  // normal case for anything the test deleted through the UI. Cleanup asserts
  // nothing; it only has to leave the database as it found it.
  for (const id of ids) await page.request.delete(`/api/tasks/${id}`)
})

/**
 * Compile /quotas before any test's clock is running.
 *
 * The E2E server is `next dev`, which compiles a route the first time it is
 * asked for, and this file holds the suite's only /quotas navigations — so the
 * whole compile landed inside whichever test reached the page first. On CI that
 * was the quota-range test, which is why it needed 15s of its 30s budget on a
 * healthy runner and ran straight past 30s on a slow one. Measured locally:
 * 22.2s for that test on a cold route, 6-7s once warm.
 *
 * A `beforeAll` has its own budget, so the compile is no longer charged to a
 * test. The tradeoff is a request that asserts nothing — a few seconds on a
 * cold server, next to nothing on a warm one. It relocates the cost rather than
 * removing it; the real fix is to stop serving E2E from a dev server at all
 * (`next build && next start`, the way the integration suite already runs).
 */
test.beforeAll(async () => {
  const ctx = await apiRequest.newContext({ baseURL: test.info().project.use.baseURL })
  try {
    // Unauthenticated is fine: /quotas redirects on the client, so the server
    // still renders — and therefore compiles — the route. /api/quotas answers
    // 401 and compiles just the same. Warm-up only, so failures are ignored.
    await Promise.all([ctx.get('/quotas'), ctx.get('/api/quotas')])
  } catch {
    // A cold server that cannot be reached yet is the webServer's problem, not
    // this hook's — the first real test will report it properly.
  } finally {
    await ctx.dispose()
  }
})

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
  const panel = page.getByRole('region', { name: 'Quotas' })
  await expect(panel).toBeVisible()
  const fold = panel.getByRole('button', { name: 'Expand Quotas' })
  if (await fold.isVisible()) {
    // The choice is saved fire-and-forget; wait for it so a reload can't race it.
    const saved = page.waitForResponse((r) => r.url().includes('/api/user/preferences'))
    await fold.click()
    await saved
  }
  await expect(panel.getByRole('button', { name: 'Collapse Quotas' })).toBeVisible()
}
async function closeTrack(page: Page) {
  const fold = page.getByRole('button', { name: 'Collapse Quotas' })
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
      const panel = page.getByRole('region', { name: 'Quotas' })
      await expect(panel).toBeVisible()
      // Folded by default: the header's total, and the quota as a chip.
      await expect(panel.getByRole('button', { name: 'Expand Quotas' })).toBeVisible()
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
      await expect(panel.getByRole('button', { name: 'Expand Quotas' })).not.toContainText('this')
      await expect(panel.locator(`[data-track-row="${id}"]`)).toHaveCount(0)
      const chip = panel.locator(`[data-track-chip="${id}"]`)
      const chipCount = chip.locator('[data-track-count]')
      await expect(chipCount).toHaveText('0/2·wk')

      // Tap: +1, with a toast whose Undo takes it back — and the server ends
      // where the chip says it does.
      //
      // This is the ordering guard, so the two clicks must stay BACK TO BACK:
      // nothing here may wait for the +1 to reach the server, because the bug
      // it pins only exists while the +1 and the −1 are in flight together.
      // From a count of 0, applied in the wrong order, the server's
      // clamp-at-zero ate the −1 and left 1 behind — invisible until the next
      // reload, since the optimistic display shows the local value throughout.
      // `useTrackProgress` queues a task's logs for exactly this.
      //
      // Counting the responses rather than polling the count to 0 matters: the
      // task starts AT 0, so a poll would be satisfied by its own first read,
      // before either mutation had landed, and would pass on the broken code.
      // Waiting for both logs to come back and then reading once cannot.
      let settledLogs = 0
      const countLogs = (r: Response) => {
        if (r.request().method() === 'POST' && r.url().endsWith(`/api/tasks/${id}/progress`))
          settledLogs++
      }
      page.on('response', countLogs)
      await chip.click()
      await expect(chipCount).toHaveText('1/2·wk')
      const toast = page
        .locator('[data-sonner-toast]')
        .filter({ hasText: 'Logged one for \u201cEggs for the kids\u201d \u00b7 1/2' })
      await expect(toast).toBeVisible()
      await toast.getByRole('button', { name: 'Undo' }).click()
      await expect(chipCount).toHaveText('0/2·wk')
      await expect.poll(() => settledLogs).toBe(2)
      page.off('response', countLogs)
      expect(
        (await (await page.request.get(`/api/tasks/${id}`)).json()).data.progress_current,
      ).toBe(0)

      // Subtracting: shift-click and right-click. A hold no longer subtracts —
      // since 2026-09-06 it opens the detail sheet, and the swipe took over −1.
      await chip.click()
      await chip.click()
      // Met DURING the session, so it stays put, green — only what was met
      // when the page loaded is put away (Trent, 2026-09-22: "things should
      // not disappear until reload").
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
      // grid, no Done, none of which mean anything for "twice a week". It
      // opens AS A MODAL, in place — Trent, 2026-09-21: "whenever I do things
      // with tasks it opens a modal... that's how I like to work: with a
      // modal" — not a navigation, so the URL never changes.
      const urlBeforeOpen = page.url()
      await pop.getByRole('button', { name: 'Open' }).click()
      const editor = page.getByRole('dialog')
      await expect(editor).toBeVisible()
      expect(page.url()).toBe(urlBeforeOpen)
      // The bubble it was pressed from is gone — the editor replaced it.
      await expect(pop).toBeHidden()
      await expect(editor.getByRole('button', { name: 'Every week' })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      await expect(editor.getByRole('button', { name: '+1 hr' })).toHaveCount(0)
      await expect(editor.getByRole('button', { name: 'Done', exact: true })).toHaveCount(0)
      // The full page is still one button away.
      await expect(editor.getByRole('button', { name: 'Open full page' })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)

      await openTrack(page)
      // The choice sticks across a reload.
      await page.reload()
      await expect(panel.getByRole('button', { name: 'Collapse Quotas' })).toBeVisible()
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

      // Reaching the target is "met": a state, not an exit — the line stays
      // until the next load puts it away.
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
    }
  })

  /**
   * The chip's popover Open button now opens `QuotaDetailModal` in place
   * (see the test above) instead of navigating to the task page — this pins
   * that its delete still goes through the same soft-delete-with-undo path
   * the Quotas page and the full-page editor use.
   */
  test("deletes a quota from the chip's modal, with an Undo", async ({
    authenticatedPage: page,
  }) => {
    const id = await createTask(page, {
      title: 'Probe track modal delete',
      progress_target: 2,
      rrule: 'FREQ=WEEKLY',
    })
    await page.goto('/')
    const panel = page.getByRole('region', { name: 'Quotas' })
    await expect(panel.getByRole('button', { name: 'Expand Quotas' })).toBeVisible()
    const chip = panel.locator(`[data-track-chip="${id}"]`)
    await expect(chip).toBeVisible()

    await chip.click({ delay: 500 })
    await page.locator('[data-track-popover]').getByRole('button', { name: 'Open' }).click()
    const editor = page.getByRole('dialog')
    await expect(editor).toBeVisible()

    const deleted = page.waitForResponse(
      (r) => r.url().includes('/api/tasks/bulk/delete') && r.request().method() === 'POST',
    )
    await editor.getByRole('button', { name: 'Move to Trash' }).click()
    expect((await deleted).status()).toBe(200)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator(`[data-track-chip="${id}"]`)).toHaveCount(0)

    // The same Undo every soft delete offers.
    await page.locator('[data-sonner-toast]').getByRole('button', { name: 'Undo' }).click()
    await expect(page.locator(`[data-track-chip="${id}"]`)).toBeVisible()
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
  })

  /**
   * §5, Trent 2026-09-23: the widget shows every quota as a small tappable
   * chip, and a quota's title is often a full sentence — too long for a chip.
   * The optional "Short name" field is per-quota (single-task editor only,
   * same as Title and Notes), trimmed, and capped at 24 characters.
   */
  test("a quota's short name is edited in its own editor, and persists across reload", async ({
    authenticatedPage: page,
  }) => {
    const id = await createTask(page, {
      title: 'Kids all blow up balloon (teach Josie breathing)',
      progress_target: 4,
      is_tracked: true,
      rrule: 'FREQ=WEEKLY',
    })

    await page.goto(`/tasks/${id}`)
    const editor = page.locator(`[data-quota-detail="${id}"]`)
    await expect(editor).toBeVisible()

    const shortName = editor.getByRole('textbox', { name: 'Short name' })
    await expect(shortName).toBeVisible()
    await expect(shortName).toHaveValue('')

    // Leading/trailing whitespace is trimmed by the server, not the widget.
    await shortName.fill('  Balloon  ')
    const saved = page.waitForResponse(
      (r) => r.url().includes(`/api/tasks/${id}`) && r.request().method() === 'PATCH',
    )
    await editor.getByRole('button', { name: 'Save' }).click()
    const patchBody = (await saved).request().postDataJSON()
    expect(patchBody.short_title).toBe('Balloon')

    await page.reload()
    const after = page.locator(`[data-quota-detail="${id}"]`)
    await expect(after.getByRole('textbox', { name: 'Short name' })).toHaveValue('Balloon')
  })

  /**
   * §5, Trent 2026-09-09, choosing variation G of the `track-by-label` mockup:
   * the panel groups by LABEL and draws the whole thing as one wrapping row,
   * so a cluster's heading is a PEER of the chips rather than a box around
   * them — asserted as DOM shape (same flex parent, one wrapping list).
   *
   * Amended the same day, after Trent saw it on dev: a title landing mid-row
   * after the previous cluster's last chip read as confusing rather than
   * compact, so every title now starts its own row. That is measured as an
   * equality — the title's left edge IS the list's left edge — not a tolerance.
   */
  test('each label title starts a row, in label order, the no-label cluster last', async ({
    authenticatedPage: page,
  }) => {
    const ids: number[] = []
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
    const panel = page.getByRole('region', { name: 'Quotas' })
    await expect(panel.getByRole('button', { name: 'Expand Quotas' })).toBeVisible()
    const stream = panel.getByRole('list', { name: 'Quotas' })

    // One list holds every cluster: no card, no sub-list, per label.
    await expect(stream).toHaveCount(1)
    // '' is the no-label cluster's key: a label name is validated non-empty,
    // so it is the one key no real label can collide with.
    for (const key of ['dev', 'work', '']) {
      await expect(stream.locator(`[data-track-cluster="${key}"]`)).toBeVisible()
    }

    // A title and the chips it introduces are siblings — direct children of
    // the same wrapping list — which is what lets the title attach after the
    // previous cluster's last chip instead of forcing a break.
    for (const [key, id] of [
      ['dev', devId],
      ['work', workId],
      ['', bareId],
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
    // The panel calls the no-label group "Other"; the Quotas page still says
    // "Unlabelled", which has a card header with room for the longer word.
    //
    // Read off the name span, not the whole heading: the heading also carries
    // the cluster's shut-state summary ("1 left"), which is in the DOM at
    // every width — it is CSS, not React, that decides whether it shows, so
    // that the fold's default needs no JavaScript to paint correctly.
    await expect(stream.locator('[data-track-cluster=""] [data-track-cluster-name]')).toHaveText(
      'Other',
    )
    expect(order[order.length - 1]).toBe('')

    // EVERY title starts its own row (Trent, 2026-09-09): its left edge is
    // the list's own left edge, and no chip shares that row to its left. A
    // zero-height full-basis <li> before each title is what forces the wrap.
    // Measured as equalities, not tolerances: an offset of exactly 0, and a
    // count of exactly 0 chips overlapping the title's band to its left.
    const rowStarts = await stream.evaluate((ul) => {
      const listLeft = ul.getBoundingClientRect().left
      const chips = [...ul.querySelectorAll('[data-track-chip]')].map((c) =>
        c.getBoundingClientRect(),
      )
      return [...ul.querySelectorAll('[data-track-cluster]')].map((el) => {
        const r = el.getBoundingClientRect()
        return {
          cluster: el.getAttribute('data-track-cluster'),
          offsetFromListLeft: r.left - listLeft,
          // Vertical overlap, not centre equality — a boolean about boxes,
          // with no pixel slack in it.
          chipsLeftOfItOnItsRow: chips.filter(
            (c) => c.bottom > r.top && c.top < r.bottom && c.right <= r.left,
          ).length,
        }
      })
    })
    expect(rowStarts.length).toBe(3)
    for (const t of rowStarts) {
      expect({ cluster: t.cluster, offset: t.offsetFromListLeft }).toEqual({
        cluster: t.cluster,
        offset: 0,
      })
      expect({ cluster: t.cluster, chipsBefore: t.chipsLeftOfItOnItsRow }).toEqual({
        cluster: t.cluster,
        chipsBefore: 0,
      })
    }

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
  })

  test('what was met at load is put away; a finished label stacks at the foot; the count shows them', async ({
    authenticatedPage: page,
  }) => {
    // A run-unique label, so this cluster holds exactly these two.
    const label = `zz-hide-${Date.now()}`
    const done = await createTask(page, {
      title: 'Hide probe done',
      progress_target: 1,
      is_tracked: true,
      rrule: 'FREQ=MONTHLY',
      labels: [label],
      create_label: true,
    })
    const open = await createTask(page, {
      title: 'Hide probe open',
      progress_target: 1,
      is_tracked: true,
      rrule: 'FREQ=MONTHLY',
      labels: [label],
    })
    expect(
      (await page.request.post(`/api/tasks/${done}/progress`, { data: { delta: 1 } })).ok(),
    ).toBeTruthy()

    await page.goto('/')
    await closeTrack(page)
    const panel = page.getByRole('region', { name: 'Quotas' })
    const cluster = panel.locator(`[data-track-cluster="${label}"]`)
    const doneChip = panel.locator(`[data-track-chip="${done}"]`)
    const openChip = panel.locator(`[data-track-chip="${open}"]`)
    const finished = panel.locator(`[data-track-finished-cluster="${label}"]`)
    const toggle = panel.locator('[data-track-met-toggle]')

    // Met at load: put away. The label stays for its unmet quota, and says
    // how many it has closed beside its name.
    await expect(openChip).toBeVisible()
    await expect(doneChip).toHaveCount(0)
    await expect(cluster.locator('[data-track-cluster-met]')).toHaveText('1')
    await expect(finished).toHaveCount(0)
    await expect(toggle).toHaveText(/^\d+ of \d+$/)

    // Met now, mid-session: nothing disappears and nothing moves.
    await openChip.click()
    await expect(openChip.locator('[data-track-count]')).toHaveText('1/1·mo')
    await expect(openChip).toBeVisible()
    await expect(cluster).toBeVisible()

    // The next load puts the whole label away, and it stacks at the foot as
    // one finished chip carrying how many it closed.
    await expect
      .poll(async () => (await (await page.request.get(`/api/tasks/${open}`)).json()).data)
      .toMatchObject({ progress_current: 1 })
    await page.reload()
    await expect(finished).toBeVisible()
    await expect(finished).toContainText('2')
    await expect(cluster).toHaveCount(0)
    await expect(openChip).toHaveCount(0)

    // Tapping it — or the header count — shows them in place, and the count
    // holds its box while they are showing.
    await finished.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(cluster).toBeVisible()
    await expect(doneChip).toBeVisible()
    await expect(openChip).toBeVisible()
    await expect(finished).toHaveCount(0)
    await toggle.click()
    await expect(cluster).toHaveCount(0)
    await expect(finished).toBeVisible()
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
      if (before && before !== 'All') await switchView(page, before)
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
    await page.goto('/quotas')
    const view = page.locator('[data-quotas-view]')
    await expect(view).toBeVisible()
    const before = await view.locator('[data-quota-row]').count()

    // Creating one: the only route that existed before this page was the API.
    for (const title of adjacentTitles('probe-range', 'a', 'b')) {
      await view.getByRole('button', { name: 'New quota' }).click()
      // A modal, not an inline form.
      const form = page.getByRole('dialog')
      await expect(form).toBeVisible()
      await form.getByRole('textbox').first().fill(title)
      const created = page.waitForResponse(
        (r) => r.url().endsWith('/api/tasks') && r.request().method() === 'POST',
      )
      await form.getByRole('button', { name: 'Create' }).click()
      // Made through the UI, so `createTask` never saw it — register it by hand
      // or the afterEach has nothing to clean up.
      const id = (await (await created).json()).data.id as number
      cleanUpLater(id)
      ids.push(id)
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

    // Shift takes a range — and the range is exactly the two anchors.
    //
    // Asserting the pair BY ID as well as by count is the point: a count on its
    // own agrees just as readily with a range that has quietly swallowed a row
    // nobody asked for, which is what a leaked quota did here. Together the
    // three assertions say "these two, and only these two".
    await row.click({ modifiers: ['Shift'] })
    const bar = page.locator('[data-quota-selection-bar]')
    await expect(page.locator(`[data-quota-row="${ids[0]}"]`)).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(page.locator(`[data-quota-row="${ids[1]}"]`)).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(page.locator('[data-quota-row][aria-selected="true"]')).toHaveCount(2)
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
  })

  /**
   * §5/A3+A4 over the API, split out of the selection test above (2026-09-21).
   *
   * Together they were the most expensive test in the suite: 15s of a 30s
   * budget on a healthy CI runner, and a timeout on a slow one — the two halves
   * share no state, and all three page reloads belong to this one. Splitting
   * them is what buys the headroom back; the clock was never the problem, the
   * amount of work under one clock was.
   *
   * Retiring takes the period rule with it: a bare "FREQ=WEEKLY" left on an
   * untracked task with no due date is evaluated as a schedule, and rrule.js
   * places it on an arbitrary weekday, so the task would surface on a day
   * nobody chose. There is no "stop tracking" button (see the editor test), so
   * the API is the whole of the retire path.
   */
  test('retiring a quota over the API takes its period rule with it, and Undo brings both back', async ({
    authenticatedPage: page,
  }) => {
    const retireId = await createTask(page, {
      title: 'Probe quota to retire',
      progress_target: 2,
      rrule: 'FREQ=WEEKLY',
    })
    await page.goto('/quotas')
    await expect(page.locator('[data-quotas-view]')).toBeVisible()
    await expect(page.locator(`[data-quota-row="${retireId}"]`)).toBeVisible()

    const retired = await page.request.patch(`/api/tasks/${retireId}`, {
      data: { is_tracked: false, progress_target: 1 },
    })
    expect(retired.status()).toBe(200)
    const retiredBody = (await retired.json()).data
    expect(retiredBody.is_tracked).toBe(false)
    expect(retiredBody.rrule).toBeNull()
    expect(retiredBody.due_at).toBeNull()
    // It is no longer a quota, so it leaves this page. Reload rather than
    // waiting for the row to be pushed out: this went through the API, so the
    // only thing that would move a page already open is the sync stream — and
    // asserting on a push makes the test depend on delivery timing rather than
    // on server state. Same for the reload after the undo below.
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
  })

  /**
   * `?quota=<id>` — the Track widget's deep link. Trent, 2026-09-22: "quota
   * still opens up the full detail menu when really it should just
   * highlight it in the Quotas tab." Mirrors `?reminder=<id>` on
   * `/reminders` and `?task=<id>&highlight=1` on `/`.
   */
  test('?quota=<id> brings that quota into view without opening it', async ({
    authenticatedPage: page,
  }) => {
    const id = await createTask(page, {
      title: 'Probe quota the widget links to',
      progress_target: 3,
      rrule: 'FREQ=WEEKLY',
    })
    // `createTask` registers it for the afterEach cleanup.
    await page.goto(`/quotas?quota=${id}`)
    const row = page.locator(`[data-quota-row="${id}"]`)
    await expect(row).toHaveAttribute('data-quota-highlight', '')
    await expect(row).toBeInViewport()
    // A link is a place to look, not an edit. Nothing opens.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    // The param is spent, so a reload does not flash the same row again.
    await expect(page).toHaveURL('/quotas')
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
    // Made through the UI, so `createTask` never saw it — register it by hand
    // or the afterEach has nothing to clean up.
    const newId = (await (await created).json()).data.id as number
    cleanUpLater(newId)
    ids.push(newId)
    await expect(
      view.locator(`[data-quota-group="probe-domain"] [data-quota-row="${newId}"]`),
    ).toHaveCount(1)
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
    // `a` and `b` are the pair the shift-range takes; `c` is the one that must
    // stay OUT of it, since the whole assertion below is that a quota which was
    // never selected still learns the label from the registry. The old titles
    // were "… one"/"… two"/"… third", which sort one, third, two — so the range
    // quietly swallowed the third row and this test asserted its premise away.
    for (const title of adjacentTitles('probe-bulk', 'a', 'b', 'c')) {
      ids.push(await createTask(page, { title, progress_target: 2, rrule: 'FREQ=WEEKLY' }))
    }

    await page.goto('/quotas')
    const view = page.locator('[data-quotas-view]')
    await expect(view).toBeVisible()

    // Two selected → the bulk endpoint. The size of the range is asserted, not
    // assumed: if a third row ever sorts into the gap this test stops proving
    // what it says it proves, and it should fail rather than quietly pass.
    await view.locator(`[data-quota-row="${ids[0]}"]`).click()
    await view.locator(`[data-quota-row="${ids[1]}"]`).click({ modifiers: ['Shift'] })
    const bar = page.locator('[data-quota-selection-bar]')
    await expect(view.locator('[data-quota-row][aria-selected="true"]')).toHaveCount(2)
    await expect(bar).toContainText('2 selected')
    await expect(view.locator(`[data-quota-row="${ids[2]}"]`)).toHaveAttribute(
      'aria-selected',
      'false',
    )
    await bar.getByRole('button', { name: 'Details' }).click()

    const editor = page.getByRole('dialog')
    await expect(editor).toBeVisible()
    await expect(editor).toContainText('Editing 2 quotas')
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
  })
})
