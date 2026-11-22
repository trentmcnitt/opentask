/**
 * EVERY MENU OPENS ABOVE THE TOASTS (Trent's phone, 2026-11-21: the select
 * bar's Horizon menu drawn under the "On deck for tomorrow … Undo" toast,
 * which hid all but its last two rows; the blue clock FAB and the card's
 * jump chevron sat over it too). The menu and picker primitives — a
 * DropdownMenu, a Popover, a Select — and OptionMenu, its phone sheet
 * included, open on one layer, `--layer-menu` (globals.css), above Sonner's
 * toasts and everything else that floats.
 *
 * At phone width, on the task queue card (its own user, the switch on, as
 * production), each menu is opened with a fresh toast up, and asserted on
 * top: the menu's layer is above the toaster's, and wherever the two
 * overlap the menu is what a finger would hit. CI runs it in WebKit too
 * (`WEBKIT_SPECS`). Unique titles; every task trashed in `finally`.
 */
import { test, expect, backdateCreated, holdUntil, uniqueTitle } from './fixtures'
import type { Locator, Page } from '@playwright/test'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
test.describe.configure({ mode: 'serial', timeout: 90_000 })

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('Username').fill('queue@opentask.local')
  await page.getByLabel('Password').fill('testpass123')
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL('/', { timeout: 10_000 })
}

async function create(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), JSON.stringify(data)).toBeTruthy()
  const id = (await res.json()).data.id as number
  backdateCreated([id], { inSegments: true })
  return id
}

test.beforeEach(async ({ page }) => {
  await signIn(page)
  const res = await page.request.post('/api/test/task-queue', { data: { enabled: true } })
  expect(res.ok()).toBeTruthy()
})
test.afterAll(async ({ request }) => {
  await request.post('/api/test/task-queue', { data: { enabled: false } })
})

/** An open menu or menu sheet (a closing one lingers through its animation). */
const OPEN_MENU = ':is([role="menu"], [role="dialog"], [role="listbox"])[data-state="open"]'

const row = (page: Page, id: number) =>
  page.locator(`[data-tasks-panel] [data-segment-task="${id}"]`)

/** A fresh toast: consider `id` from its circle ("Considered …  Undo"). */
async function freshToast(page: Page, id: number): Promise<Locator> {
  const circle = row(page, id).locator('button[aria-label^="Mark \\""]').first()
  const box = (await circle.boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  const toast = page.locator('[data-sonner-toast]').first()
  await expect(toast).toBeVisible()
  return toast
}

/**
 * The menu is on top of the toast: its portal's layer is above the
 * toaster's, and at every point the two share, and at the menu's own
 * centre, the hit element is inside the menu.
 */
async function expectAbove(menu: Locator, label: string) {
  await expect(menu, label).toBeVisible()
  // A sheet slides in: measure where it comes to rest.
  await menu.evaluate((el) =>
    Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => undefined))),
  )
  const page = menu.page()
  const result = await menu.evaluate((el) => {
    const layer = (node: Element) => {
      let top: Element = node
      while (top.parentElement && top.parentElement !== document.body) top = top.parentElement
      return Number(getComputedStyle(top).zIndex) || 0
    }
    const toaster = document.querySelector('[data-sonner-toaster]')
    const toast = document.querySelector('[data-sonner-toast]')
    // The part of it on screen: a tall sheet runs past the bottom edge.
    const r = el.getBoundingClientRect()
    const m = {
      left: Math.max(r.left, 0),
      right: Math.min(r.right, window.innerWidth),
      top: Math.max(r.top, 0),
      bottom: Math.min(r.bottom, window.innerHeight),
      width: 0,
      height: 0,
    }
    m.width = m.right - m.left
    m.height = m.bottom - m.top
    const points: [number, number][] = [[m.left + m.width / 2, m.top + m.height / 2]]
    if (toast) {
      const t = toast.getBoundingClientRect()
      const x0 = Math.max(m.left, t.left)
      const x1 = Math.min(m.right, t.right)
      const y0 = Math.max(m.top, t.top)
      const y1 = Math.min(m.bottom, t.bottom)
      if (x1 - x0 > 4 && y1 - y0 > 4) {
        points.push([(x0 + x1) / 2, (y0 + y1) / 2], [x0 + 2, y0 + 2], [x1 - 2, y1 - 2])
      }
    }
    const misses = points
      .map(([x, y]) => {
        const hit = document.elementFromPoint(x, y)
        return hit && el.contains(hit)
          ? null
          : `${Math.round(x)},${Math.round(y)} → ${hit?.tagName}.${String(hit?.className).slice(0, 40)}`
      })
      .filter(Boolean)
    return {
      menuLayer: layer(el),
      toasterLayer: toaster ? Number(getComputedStyle(toaster).zIndex) || 0 : 0,
      overlapPoints: points.length - 1,
      misses,
    }
  })
  expect(result.menuLayer, `${label}: ${JSON.stringify(result)}`).toBeGreaterThan(
    result.toasterLayer,
  )
  expect(result.misses, `${label}: ${JSON.stringify(result)}`).toEqual([])
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
}

test('the select bar’s Horizon menu, ⋯ More and the rows’ hold menus open above a toast', async ({
  page,
}) => {
  const ids: number[] = []
  try {
    // Five: the card shows five rows at phone width.
    for (let i = 0; i < 5; i++) {
      ids.push(await create(page, { title: uniqueTitle(`MT toast row ${i}`), horizon: 'days' }))
    }
    await page.goto('/?tasks=days')
    await expect(row(page, ids[4])).toBeVisible()

    // A row's On deck hold menu (OptionMenu — a sheet at phone width).
    await freshToast(page, ids[0])
    const deck = row(page, ids[2]).locator('[data-deck-tomorrow]')
    await holdUntil(deck, () => expect(page.locator(OPEN_MENU).last()).toBeVisible())
    await expectAbove(page.locator(OPEN_MENU).last(), 'deck hold menu')

    // A row's Target hold menu ("hold for a time"). The Grow hold menu is
    // the same DropdownMenu as the bar's Horizon menu below; these rows,
    // made in the past, are no longer New, so they draw no Grow.
    await freshToast(page, ids[1])
    const target = row(page, ids[3]).getByRole('button', { name: /^Target .* today/ })
    // Its right-click is the hold's twin (`TargetToday`), and the steadier
    // trigger here: the clock sits beside the deck the hold above just used.
    await target.click({ button: 'right' })
    const opened = page.locator(OPEN_MENU).last()
    await expectAbove(opened, 'row Target hold menu')

    // The select bar: Select, pick a row, then its Horizon chip (a
    // DropdownMenu) and ⋯ More (OptionMenu's sheet).
    await page
      .locator('[data-tasks-panel]')
      .getByRole('button', { name: 'Select', exact: true })
      .click()
    await row(page, ids[4]).click()
    const bar = page.locator('[data-selection-sheet]')
    await expect(bar).toBeVisible()
    // A fresh toast in select mode: put the deck back from its own toast's
    // Undo is not needed — the earlier toasts are still up (five seconds);
    // if they have gone, a pick of the deck row's deck puts up a new one.
    if ((await page.locator('[data-sonner-toast]').count()) === 0) {
      await freshToast(page, ids[2])
    }
    await bar
      .getByRole('button', { name: /Days|Weeks|Months|Eventually|Mixed/ })
      .first()
      .click()
    await expectAbove(page.locator(OPEN_MENU).last(), 'select bar Horizon menu')
    await bar.getByRole('button', { name: /^More/ }).click()
    await expectAbove(page.locator(OPEN_MENU).last(), 'select bar ⋯ More')
  } finally {
    await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
  }
})

test('a dashboard row’s target menu (a DropdownMenu) opens above a toast', async ({ page }) => {
  const ids: number[] = []
  try {
    ids.push(await create(page, { title: uniqueTitle('MT toast maker'), horizon: 'days' }))
    // An hour ago: overdue, its target chip on the dashboard at any hour
    // ("now + 3h" crosses the day start late in the evening).
    const at = new Date(Date.now() - 3_600_000).toISOString()
    ids.push(await create(page, { title: uniqueTitle('MT targeted'), target_at: at }))
    await page.addInitScript(() => window.localStorage.setItem('opentask_dashboard_mode', 'all'))
    await page.goto('/?tasks=days')
    await expect(row(page, ids[0])).toBeVisible()
    const chip = page.locator(`#task-row-${ids[1]} [data-target-time]`)
    await chip.evaluate((el) => el.scrollIntoView({ block: 'end', behavior: 'instant' }))
    await freshToast(page, ids[0])
    await chip.tap()
    await expectAbove(page.locator(OPEN_MENU).last(), 'row target menu')
  } finally {
    await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
  }
})
