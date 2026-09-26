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
 * the old value back. That made `track.spec.ts`'s "Show as chips after a
 * reload" fail about one run in five (2026-09-25).
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
 * /quotas opened on its DETAILED list (`QuotasView`: rows, selection, the
 * multi-quota editor) rather than the summary it opens on by default
 * (2026-09-25). Presses the page's own Details switch, the way a user does,
 * and waits for the save so a later reload cannot race it.
 *
 * The choice is the SERVER preference `quotas_details` on the one test user
 * every spec shares, so it outlives the test. Nothing depends on it staying
 * off: a test about the default view sets it explicitly first
 * (`track.spec.ts`, "Quotas page — summary and details").
 */
export async function gotoQuotasDetails(page: Page, path = '/quotas'): Promise<void> {
  await page.goto(path)
  const details = page
    .getByRole('group', { name: 'Quotas view' })
    .getByRole('button', { name: 'Details', exact: true })
  await page.locator('[data-quotas-view], [data-quotas-summary]').first().waitFor()
  if ((await details.count()) === 0) {
    // No quotas at all: both views are the same empty state, so the page
    // offers no switch (see `QuotasHeaderRow`). Set the preference directly;
    // the list is what a quota made next will land in.
    const res = await page.request.patch('/api/user/preferences', {
      data: { quotas_details: true },
    })
    if (!res.ok()) throw new Error(`PATCH quotas_details: ${res.status()}`)
    await page.goto(path)
  } else if ((await details.getAttribute('aria-pressed')) !== 'true') {
    const saved = waitForPreferenceSave(page, 'quotas_details')
    await details.click()
    await saved
  }
  await page.locator('[data-quotas-view]').waitFor()
}
