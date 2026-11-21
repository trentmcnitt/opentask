/**
 * A MENU OPENED ON A SCROLLED PAGE STAYS ON SCREEN (Trent's phone,
 * 2026-11-21: "the top bar just disappeared when I pressed it. I think the
 * app froze"). Scrolled down, the header's ☰ opened its menu off the top of
 * the screen and took the header with it: the menu's scroll lock put
 * `overflow: hidden` on <body>, which <html>'s sideways clip (10-30) keeps
 * from reaching the viewport, so body became a scroll container and the
 * sticky header stuck to it instead of the screen. The open menu kept every
 * tap and the scroll, so nothing got out of it. Now <html> takes the lock
 * (globals.css, "THE LOCK IS THE VIEWPORT'S").
 *
 * Here, at phone width: the header's menu opens under ☰ with the header in
 * place and a tap outside closes it; the page keeps its place; the 10-30
 * clip still holds with the menu open and after (no sideways pan over a box
 * wider than the screen); and the other modal menus opened on a scrolled
 * page — a row's target menu, a Settings select — are on screen.
 * CI runs it in WebKit too (`WEBKIT_SPECS`).
 */
import { test, expect, uniqueTitle } from './fixtures'
import type { Locator, Page } from '@playwright/test'

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
test.describe.configure({ mode: 'serial' })

async function longPage(page: Page): Promise<number[]> {
  const ids: number[] = []
  for (let i = 0; i < 14; i++) {
    const res = await page.request.post('/api/tasks', {
      data: {
        title: uniqueTitle(`MSC scrolled page ${i}`),
        due_at: new Date(Date.now() + 3 * 3_600_000).toISOString(),
      },
    })
    expect(res.ok()).toBeTruthy()
    ids.push((await res.json()).data.id as number)
  }
  return ids
}

/** Scroll the page down `y` px (or as far as it goes) and wait for it. */
async function scrollDown(page: Page, y: number): Promise<number> {
  await page.evaluate((y) => window.scrollTo(0, y), y)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100)
  return page.evaluate(() => window.scrollY)
}

/** Whether a box is wholly on screen. */
async function onScreen(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return (
      r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth
    )
  })
}

const headerTop = (page: Page) =>
  page.evaluate(() => Math.round(document.querySelector('header')!.getBoundingClientRect().top))

/**
 * A sideways pan: how far a scroll to the right moves the page. Programmatic
 * — Playwright's mobile WebKit has no wheel and no drag — which asks the
 * same question: is there any width to the right to scroll to?
 */
async function panRight(page: Page): Promise<number> {
  return page.evaluate(() => {
    window.scrollTo(240, window.scrollY)
    window.scrollBy(240, 0)
    document.documentElement.scrollLeft = 240
    return Math.max(window.scrollX, document.documentElement.scrollLeft, document.body.scrollLeft)
  })
}

test('scrolled down, the header menu opens under ☰ and a tap outside closes it', async ({
  authenticatedPage: page,
}) => {
  const ids = await longPage(page)
  try {
    await page.goto('/')
    await expect(page.locator(`#task-row-${ids[0]}`)).toBeAttached()
    const y = await scrollDown(page, 900)
    expect(await headerTop(page)).toBe(0)

    await page.getByRole('button', { name: 'Menu', exact: true }).tap()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    // The header stays where it is, and the menu is on screen under it.
    expect(await headerTop(page)).toBe(0)
    expect(await onScreen(menu)).toBe(true)
    await expect(page.getByRole('menuitem', { name: 'Settings' })).toBeVisible()
    expect(await page.evaluate(() => window.scrollY)).toBe(y)

    // A press on the page — a thumb's way out — closes it. A mouse press:
    // Playwright's WebKit turns a touchscreen tap into touch events with no
    // pointer events (Radix closes on pointerdown), so an emulated tap there
    // closes no menu even at the top of an unchanged page; a real iPhone
    // sends both, which the simulator check of 2026-11-21 covers.
    await page.mouse.click(195, 600)
    await expect(menu).toBeHidden()
    expect(await headerTop(page)).toBe(0)
    expect(await page.evaluate(() => window.scrollY)).toBe(y)
  } finally {
    await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
  }
})

test('the 10-30 clip holds with a menu open and after: no sideways pan', async ({
  authenticatedPage: page,
}) => {
  const ids = await longPage(page)
  try {
    await page.goto('/')
    await expect(page.locator(`#task-row-${ids[0]}`)).toBeAttached()
    // A box wider than the screen — what a long unbroken URL once made.
    await page.evaluate(() => {
      const wide = document.createElement('div')
      wide.setAttribute('data-test-wide', '')
      wide.style.cssText = 'width:900px;height:20px'
      wide.textContent = 'https://example.com/' + 'an-invented-unbroken-path-'.repeat(12)
      document.querySelector('main')!.prepend(wide)
    })
    await scrollDown(page, 600)
    expect(await panRight(page)).toBe(0)

    await page.getByRole('button', { name: 'Menu', exact: true }).tap()
    await expect(page.getByRole('menu')).toBeVisible()
    expect(await panRight(page)).toBe(0)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toBeHidden()
    expect(await panRight(page)).toBe(0)
  } finally {
    await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
  }
})

test("scrolled down, a row's target menu and a Settings select open on screen", async ({
  authenticatedPage: page,
}) => {
  const ids = await longPage(page)
  try {
    await page.goto('/')
    const row = page.locator(`#task-row-${ids[ids.length - 1]}`)
    await expect(row).toBeAttached()
    await row.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }))
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(100)
    // The row's target time opens its menu (`TargetTimeText`).
    const target = row.locator('[data-target-time]')
    await target.tap()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    expect(await onScreen(menu)).toBe(true)
    expect(await headerTop(page)).toBe(0)
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()

    await page.goto('/settings')
    const select = page.locator('[data-default-reminder-slot]')
    await select.evaluate((el) => el.scrollIntoView({ block: 'end', behavior: 'instant' }))
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(100)
    await select.tap()
    const list = page.getByRole('listbox')
    await expect(list).toBeVisible()
    expect(await onScreen(list)).toBe(true)
    expect(await headerTop(page)).toBe(0)
    await page.keyboard.press('Escape')
    await expect(list).toBeHidden()
  } finally {
    await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
  }
})
