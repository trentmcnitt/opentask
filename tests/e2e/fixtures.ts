/**
 * E2E test fixtures
 *
 * Extends Playwright test with an authenticatedPage fixture
 * that logs in via the real login form.
 */

import {
  test as base,
  expect,
  type Frame,
  type Locator,
  type Page,
  type Request,
} from '@playwright/test'
import path from 'path'
import Database from 'better-sqlite3'
import { addDays, openTaskDayOf } from '@/lib/opentask-day'

export const TEST_EMAIL = 'test@opentask.local'
export const TEST_PASSWORD = 'testpass123'

/* eslint-disable react-hooks/rules-of-hooks -- Playwright fixtures use `use` which is not a React hook */
export const test = base.extend<{ authenticatedPage: Page }>({
  authenticatedPage: async ({ page }, use) => {
    // Navigate to login page
    await page.goto('/login')

    // Fill in login form
    await page.getByLabel('Username').fill(TEST_EMAIL)
    await page.getByLabel('Password').fill(TEST_PASSWORD)
    await page.getByRole('button', { name: /sign in/i }).click()

    // Wait for redirect to dashboard
    await page.waitForURL('/', { timeout: 10_000 })

    // Wait for dashboard content to render (task rows or empty state).
    // This confirms React has hydrated and the initial data fetch completed.
    // Note: we do NOT use waitForLoadState('networkidle') because the SSE
    // sync stream (/api/sync/stream) keeps a persistent connection open,
    // which prevents networkidle from ever being reached.
    await page.waitForSelector('[id^="task-row-"], .text-4xl', { timeout: 10_000 }).catch(() => {
      // Dashboard might be empty — that's OK
    })

    await use(page)
  },
})
/* eslint-enable react-hooks/rules-of-hooks */

export { expect }

/**
 * Resolves on the PATCH that saves `field` to `/api/user/preferences` — and on
 * nothing else. Arm it BEFORE the click that saves.
 *
 * Matching the URL alone is not enough: the page GETs the same URL on its own
 * schedule (`PreferencesProvider` on load, `useQuotaPromptPrefs` on every mount
 * of the quota editor and the Track panel's prompt setup). A GET still in
 * flight when the click lands satisfied a URL-only wait, the test then
 * reloaded, and the reload aborted the real PATCH — so the reloaded page read
 * the old value back. That made a `track.spec.ts` test (the since-removed
 * "Show as chips after a reload") fail about one run in five (2026-09-25).
 */
export function waitForPreferenceSave(page: Page, field: string) {
  return page.waitForResponse((r) => {
    if (!r.url().includes('/api/user/preferences')) return false
    const req = r.request()
    if (req.method() !== 'PATCH') return false
    try {
      return Object.hasOwn(JSON.parse(req.postData() ?? '{}') as object, field)
    } catch {
      return false
    }
  })
}

/**
 * A title no other test — and no earlier retry of this one — has used.
 *
 * Specs share one database for the whole run, and a retry runs against
 * whatever the failed attempt left behind. A fixed title then matches two rows
 * and every `getByText(title)` fails strict mode, so one flake turned into
 * three failures (snooze-guard.spec.ts, 2026-09-25).
 *
 * The suffix is short and alphanumeric: safe to drop into a `RegExp`
 * unescaped, and short enough that a brief base still fits the 20 characters
 * a toast shows before it truncates a title (`truncateTitle`,
 * src/lib/field-labels.ts).
 */
/**
 * Move tasks' `created_at` back a day, straight in the E2E database (the API
 * cannot create a task in the past). A task created in the last 10 minutes
 * also gets a read-only preview at the top of the dashboard's Inbox or list
 * (`src/lib/just-added.ts`), so a spec that counts titles or reads the top of
 * the list backdates the tasks it made first. The server reads SQLite in WAL mode, so the next
 * fetch sees the write.
 */
export function backdateCreated(
  ids: number[],
  opts: { inSegments?: boolean; keepHorizon?: boolean } = {},
): void {
  const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
  try {
    const stmt = db.prepare(
      `UPDATE tasks SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-1 day') WHERE id = ?`,
    )
    // A task created before today shows in its horizon's task segment
    // (2026-10-10) — a second copy of its title on the dashboard. Unless a
    // spec wants exactly that (`inSegments`), keep it out: an "eventually"
    // horizon (first Saturday of a quarter) and considered a day ahead — not
    // now, which would keep it in today's segment as a considered row (and a
    // page of the dashboard panel's pager); see globalSetup.ts.
    // `keepHorizon`: leave the horizon as made (an unset one stays unset, for
    // a spec that needs the unset ring) — considered a day ahead keeps it out
    // of the segments on its own.
    const hide = db.prepare(
      opts.keepHorizon
        ? `UPDATE tasks SET
             last_considered_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+1 day') WHERE id = ?`
        : `UPDATE tasks SET horizon = COALESCE(horizon, 'eventually'),
             last_considered_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+1 day') WHERE id = ?`,
    )
    for (const id of ids) {
      stmt.run(id)
      if (!opts.inSegments) hide.run(id)
    }
  } finally {
    db.close()
  }
}

/**
 * Resolves on the next `POST /api/tasks` response — arm it BEFORE the Enter or
 * click that creates, then read the new task's id from its body so the spec
 * can trash what it made.
 */
export function waitForTaskCreate(page: Page) {
  return page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/tasks',
  )
}

/**
 * Take every open task the test user already has out of TODAY'S task segments
 * (horizon segments and Upcoming), straight in the E2E database — for a spec
 * that asserts on the segments it makes, or on a reminders screen with none.
 *
 * Other specs leave tasks behind (a quick add, a task they never trash), and
 * whether those show in today's segments depends on the DATE the suite runs,
 * not on anything the spec does (`segmentState`, `upcomingState` in
 * src/lib/task-segments.ts): an undated task reads as weeks, and a weeks task
 * created ON the check-in day — Saturday by default — shows that same day. So
 * on a Saturday every undated task the run had made so far appeared under the
 * reminder slots, and two specs that pass on any other day failed (2026-10-17,
 * first seen just after midnight). A run that crosses midnight does the same
 * for `days` tasks (created before today) and can land a stray target's
 * Upcoming heads-up day on today.
 *
 * The same stamp globalSetup gives the seeded tasks: considered a day AHEAD,
 * which is never "today" (no considered row) and on or after every segment's
 * latest day and every heads-up day, so none of them shows. Only segments read
 * `last_considered_at`. Call it BEFORE creating the spec's own tasks.
 * Reminders and quotas are left alone: they are never in a segment, and a
 * reminder's consideration is its own state.
 *
 * It also empties `segment_roster` (#328, the stable "N of M"): a task that
 * entered today's roster stays on it after it leaves, and a done one counts as
 * considered — so another spec's completed task (search.spec's subject) made
 * a Saturday Weeks segment read "1 of 1" and the card "4 of 4" (2026-10-24).
 * The next read rebuilds the roster from what is waiting now, the spec's own.
 */
export function hideStraySegmentTasks(): void {
  const db = new Database(path.join(process.cwd(), 'data', 'test-e2e.db'))
  try {
    db.prepare(
      `UPDATE tasks SET last_considered_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+1 day')
       WHERE done = 0 AND deleted_at IS NULL
         AND is_reminder = 0 AND is_tracked = 0 AND progress_target <= 1`,
    ).run()
    db.prepare('DELETE FROM segment_roster').run()
  } finally {
    db.close()
  }
}

let titleCounter = 0
export function uniqueTitle(base: string): string {
  titleCounter += 1
  return `${base} ${Date.now().toString(36).slice(-5)}${titleCounter}`
}

/**
 * Press and hold `target` until `released` resolves, then let go.
 *
 * The hold is ended by an assertion, never a timer: a hand-tuned wait against
 * the app's 400ms long-press delay (`useLongPress`, TaskRow's snooze button)
 * registers as a tap whenever the runner is slow — and a tap on an overdue
 * row's snooze button snoozes it instantly instead of opening the menu. Pass
 * whatever proves the long-press fired (the menu is visible, the row is
 * `aria-selected`), so there is nothing to tune and nothing to race.
 *
 * `target` must already be on screen — hover its row first if it only appears
 * on hover.
 */
export async function holdUntil(target: Locator, released: () => Promise<void>): Promise<void> {
  const page = target.page()
  await target.scrollIntoViewIfNeeded()
  const box = await target.boundingBox()
  if (!box) throw new Error('holdUntil: the target is not on screen')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  try {
    await released()
  } finally {
    await page.mouse.up()
  }
}

/**
 * Run `navigate` (a `reload()` or `goto()`), wait for `rendered` to show, then
 * wait until every GET of `/api/user/preferences` has come back with its body.
 *
 * `PreferencesProvider` loads the server's preferences on mount and writes them
 * over its local state — including `filters_expanded`. A click that lands
 * before that load is undone by it: the chips close again, while the click's
 * PATCH has already saved the opposite value for the next test to inherit
 * (dashboard.spec.ts's filter tests, 2026-09-25).
 *
 * Why `rendered`: the provider's GET only starts once the session resolves
 * (`status === 'authenticated'`), which is also what lets a page render its
 * own content. So once `rendered` is visible the GET has certainly STARTED,
 * and "every started GET has finished" can't pass early in the gap before it.
 * Counting requests rather than waiting for one response matters because the
 * provider is not the only caller: `useQuotaPromptPrefs` (the Track panel,
 * the quota editor) GETs the same URL, and a single `waitForResponse` can
 * resolve on its request instead.
 *
 * This is the network half. Where the page shows the preference (a toggle's
 * `aria-expanded`), also assert on that — and set the server to the
 * NON-default value first, so the assertion can only pass once the load has
 * actually been applied.
 */
export function waitForPrefsLoaded(
  page: Page,
  navigate: () => Promise<unknown>,
  rendered: Locator,
): Promise<void> {
  return waitForGetsSettled(page, '/api/user/preferences', navigate, rendered)
}

/**
 * Run `navigate`, wait for `rendered`, then wait until every GET of `pathname`
 * the page has started has finished (body included).
 *
 * `rendered` must be something that only shows once the component doing the
 * fetch has mounted — its fetch has then certainly started, so the count can't
 * read "all done" in the gap before it begins. Failed requests count as
 * finished, so a load that errors doesn't hang the test here; the assertions
 * after it are what catch that.
 *
 * Only the NEW document's requests count: the tally resets whenever the main
 * frame commits a navigation. A GET the old page still had in flight when
 * `reload()` tore it down reports neither `requestfinished` nor
 * `requestfailed`, and counting it left the wait hanging forever.
 */
export async function waitForGetsSettled(
  page: Page,
  pathname: string,
  navigate: () => Promise<unknown>,
  rendered: Locator,
): Promise<void> {
  let pending = new Set<Request>()
  let seen = 0
  const matches = (req: Request) =>
    req.method() === 'GET' && new URL(req.url()).pathname === pathname
  const onNavigated = (frame: Frame) => {
    if (frame !== page.mainFrame()) return
    pending = new Set()
    seen = 0
  }
  const onRequest = (req: Request) => {
    if (!matches(req)) return
    pending.add(req)
    seen += 1
  }
  const onDone = (req: Request) => {
    pending.delete(req)
  }
  page.on('framenavigated', onNavigated)
  page.on('request', onRequest)
  page.on('requestfinished', onDone)
  page.on('requestfailed', onDone)
  try {
    await navigate()
    await expect(rendered).toBeVisible()
    await expect.poll(() => seen > 0 && pending.size === 0).toBe(true)
  } finally {
    page.off('framenavigated', onNavigated)
    page.off('request', onRequest)
    page.off('requestfinished', onDone)
    page.off('requestfailed', onDone)
  }
}

/**
 * Now's "Show all" (the dashboard, `default_grouping = 'project'`): lift every
 * project's "+ N more" fold, for a spec whose subject is a row that isn't
 * relevant now (undated, or due later). Since 2026-10-14 Now shows only what
 * is relevant now, so such a row is behind its project's fold until this.
 */
export async function showAllNow(page: Page): Promise<void> {
  const summary = page.locator('[data-now-summary]')
  await summary.getByRole('button', { name: /^Show all \d+$/ }).click()
  await expect(summary.getByRole('button', { name: /^Show \d+ now$/ })).toBeVisible()
}

/**
 * Run `run` with these server preferences set, and put the old values back
 * afterwards — pass or fail.
 *
 * Every spec shares one test user, so a preference a test depends on (the
 * dashboard's `default_grouping`, the quota-reminders switch) is only what the
 * test needs if the test sets it; and whatever it sets must not leak into the
 * next spec. Set it BEFORE loading the page the test drives, then load with
 * `waitForPrefsLoaded` so the page has applied it before the first click.
 */
export async function withPreferences(
  page: Page,
  prefs: Record<string, unknown>,
  run: () => Promise<void>,
): Promise<void> {
  const current = (await (await page.request.get('/api/user/preferences')).json()).data as Record<
    string,
    unknown
  >
  const before = Object.fromEntries(Object.keys(prefs).map((k) => [k, current[k] ?? null]))
  const written = await page.request.patch('/api/user/preferences', { data: prefs })
  if (!written.ok()) throw new Error(`PATCH preferences: ${written.status()}`)
  try {
    await run()
  } finally {
    await page.request.patch('/api/user/preferences', { data: before })
  }
}

/**
 * Cmd/Ctrl-click a dashboard task row, on the row itself: its bottom-left
 * padding, scrolled toward the middle of the viewport.
 *
 * Where on the row matters:
 * - Not its centre. Once anything is selected, the floating selection bar
 *   sits fixed, centred, over the bottom of the page. The LAST row of a list
 *   cannot scroll higher than the page's bottom padding allows, and there the
 *   bar covers the row's centre — where a plain `row.click()` aims — so the
 *   click hit the bar and Playwright waited out the whole test timeout for
 *   the row to be uncovered (selection-fab.spec.ts, 2026-09-27).
 * - Not the title. Outside selection mode it is a link to the task page, and
 *   the link keeps the click from the row — Cmd-click there never selects.
 * - Not the far left edge: outside selection mode that is the Done circle.
 * The row's own padding, just past the circle and below the text, is none of
 * these on any row.
 */
export async function cmdClickRow(row: Locator): Promise<void> {
  await row.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  const box = await row.boundingBox()
  if (!box) throw new Error('cmdClickRow: the row is not on screen')
  await row.click({ modifiers: ['ControlOrMeta'], position: { x: 56, y: box.height - 6 } })
}

/**
 * The floating selection bar's Clear (X) is level with its FIRST row of verbs,
 * never on a row of its own below them (2026-10-26: at the iOS app's 119% text
 * the X wrapped under "3 selected · Done · More · trash", and under Reminders'
 * "Considered · Details · trash"; it sits on the pill's corner now). Its top is
 * above the first verb's bottom edge, its centre no lower, and it is on screen.
 *
 * `oneRow`: every verb shares that first row too, the trash included (the
 * shell's tighter phone padding, 2026-10-26: at 375 and 119% text the trash
 * had wrapped to a row of its own).
 */
export async function expectClearOnFirstRow(
  page: Page,
  label: string,
  { oneRow = false }: { oneRow?: boolean } = {},
): Promise<void> {
  const sheet = page.locator('[data-selection-sheet]')
  const clear = (await sheet.getByRole('button', { name: 'Clear selection' }).boundingBox())!
  const first = (await sheet
    .locator('button:not([aria-label="Clear selection"])')
    .first()
    .boundingBox())!
  const firstRowBottom = first.y + first.height
  expect(clear.y, `Clear's top, ${label}`).toBeLessThan(firstRowBottom)
  expect(clear.y + clear.height / 2, `Clear's centre, ${label}`).toBeLessThanOrEqual(firstRowBottom)
  expect(clear.x, `Clear's left edge, ${label}`).toBeGreaterThanOrEqual(0)
  expect(clear.x + clear.width, `Clear's right edge, ${label}`).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  )
  if (!oneRow) return
  const verbs = await sheet
    .locator('button:not([aria-label="Clear selection"])')
    .evaluateAll((els) =>
      els.map((el) => ({
        name: el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '',
        top: el.getBoundingClientRect().top,
      })),
    )
  for (const verb of verbs) {
    expect(verb.top, `${verb.name}'s top, ${label}`).toBeLessThan(firstRowBottom)
  }
}

/**
 * The signed-in user's OpenTask day, `n` days on (yyyy-MM-dd), as the server
 * reckons it with the task-queue switch on: the user's resolved day start
 * (`rollover_time`, 3:00 AM by default) read from the server, and the
 * product's own rule (`openTaskDayOf`, docs/TASK-MODEL.md § The OpenTask day).
 * Not the calendar date: between midnight and the day start the OpenTask day
 * is still yesterday's, so a spec expecting the calendar date fails in that
 * window (CI, on UTC, runs in it too). The twin of `openTaskToday` in
 * tests/integration/helpers.ts. Read it where it is used, not when the file
 * loads.
 */
export async function openTaskDay(
  page: Page,
  n = 0,
  timezone = process.env.E2E_TZ || 'America/Chicago',
): Promise<string> {
  const res = await page.request.get('/api/user/preferences')
  expect(res.ok(), await res.text()).toBeTruthy()
  const { rollover_time } = (await res.json()).data as { rollover_time: string }
  return addDays(openTaskDayOf(new Date(), timezone, rollover_time), n)
}

/**
 * A chip's text-on-background contrast, as drawn: its text colour against its
 * own (translucent) background composited over the nearest opaque ancestor.
 * Colours go through a canvas, so any CSS colour syntax (oklch included)
 * comes back as sRGB.
 */
export async function chipContrast(chip: Locator): Promise<number> {
  return chip.evaluate((el) => {
    const ctx = document.createElement('canvas').getContext('2d')!
    const paint = (...colors: string[]) => {
      ctx.clearRect(0, 0, 1, 1)
      for (const c of colors) {
        ctx.fillStyle = c
        ctx.fillRect(0, 0, 1, 1)
      }
      return [...ctx.getImageData(0, 0, 1, 1).data.slice(0, 3)]
    }
    const opaque = (c: string) => {
      ctx.clearRect(0, 0, 1, 1)
      ctx.fillStyle = c
      ctx.fillRect(0, 0, 1, 1)
      return ctx.getImageData(0, 0, 1, 1).data[3] === 255
    }
    let base = 'white'
    for (let a = el.parentElement; a; a = a.parentElement) {
      const bg = getComputedStyle(a).backgroundColor
      if (opaque(bg)) {
        base = bg
        break
      }
    }
    const lum = ([r, g, b]: number[]) => {
      const f = (v: number) => {
        const c = v / 255
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const style = getComputedStyle(el)
    const back = lum(paint(base, style.backgroundColor))
    const text = lum(paint(base, style.backgroundColor, style.color))
    return (Math.max(back, text) + 0.05) / (Math.min(back, text) + 0.05)
  })
}
