/**
 * Web captures for the screenshot pipeline (docs/SCREENSHOTS.md).
 *
 *   SCREENSHOTS_BASE_URL=http://localhost:3353 SCREENSHOTS_OUT=.tmp/screenshots/<run> \
 *   OPENTASK_SCREENSHOT_NOW=2026-09-15T09:41:00-05:00 npx tsx scripts/screenshots/capture-web.ts
 *
 * Expects a server already running on the seeded sample account with the
 * shifted clock — run.sh does both. Every shot is taken in LIGHT and DARK.
 *
 * Deterministic by construction, not by waiting: the browser clock is fixed
 * (`page.clock.setFixedTime`) to the same instant the server and seed use,
 * motion is reduced, carets and scrollbars are hidden, and each shot waits for
 * a named element plus "no request in flight" (see `settle`) — never a sleep.
 *
 * Locators are roles, labels and the app's own data attributes (`task-row-*`,
 * `data-fab-stack`, "View mode"), never positions, so the other dashboard
 * work in flight (the All view going back to projects, the phone "+" button)
 * doesn't break a rerun.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  webkit,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test'
import { SCREENSHOT_USER } from './account'
import { pngSize, resizePng, writeManifestPart, type ShotEntry, type Theme } from './manifest'

const BASE_URL = process.env.SCREENSHOTS_BASE_URL ?? 'http://localhost:3353'
const OUT = path.resolve(process.env.SCREENSHOTS_OUT ?? '.tmp/screenshots/latest')
const NOW = process.env.OPENTASK_SCREENSHOT_NOW
if (!NOW) throw new Error('OPENTASK_SCREENSHOT_NOW is not set — run scripts/screenshots/run.sh')
const WEB_DIR = path.join(OUT, 'web')
const THEMES: Exclude<Theme, 'n/a'>[] = ['light', 'dark']

const entries: ShotEntry[] = []

/** Hide what differs run to run or reads as noise in a still picture. */
const CAPTURE_CSS = `
  *, *::before, *::after { caret-color: transparent !important; }
  ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
  html, body { scrollbar-width: none !important; }
`

/**
 * iPhone 16 Pro screen, 402 x 874 pt. In the iOS app the page fills the whole
 * screen (`viewport-fit=cover`) and WKWebView reports these safe-area insets,
 * which the app's `.safe-top` / `.safe-bottom` classes (globals.css) and the
 * FAB stack turn into padding. Playwright can't set env(safe-area-inset-*), so
 * the phone-app shot sets the same padding on those classes directly.
 */
const IPHONE = { width: 402, height: 874, top: 62, bottom: 34 }
const IPHONE_CSS = `
  .safe-top { padding-top: ${IPHONE.top}px !important; }
  .safe-bottom { padding-bottom: ${IPHONE.bottom}px !important; }
  [data-fab-stack] { bottom: ${IPHONE.bottom + 72}px !important; }
`

// ── Browser plumbing ──────────────────────────────────

/**
 * NextAuth's session cookie carries an absolute Expires computed on the
 * server's SHIFTED clock (a week after the frozen date), which the browser
 * compares with the REAL date and drops as already expired. NextAuth re-sets
 * it on any request that reads the session (pages and API routes alike), so
 * strip Expires / Max-Age from every same-origin response's cookies, making
 * them session cookies; the JWT inside still expires on the server's own
 * clock, which is what counts. Skipped: the SSE stream (`route.fetch` would
 * buffer it forever) and hashed static assets (no cookies).
 */
async function keepAuthCookies(context: BrowserContext): Promise<void> {
  const origin = new URL(BASE_URL).origin
  const rewrite = (url: URL) =>
    url.origin === origin &&
    !url.pathname.startsWith('/api/sync/stream') &&
    !url.pathname.startsWith('/_next/static')
  await context.route(rewrite, async (route) => {
    const response = await route.fetch()
    const headers = { ...response.headers() }
    delete headers['set-cookie']
    const cookies = response
      .headersArray()
      .filter((h) => h.name.toLowerCase() === 'set-cookie')
      .map((h) => h.value.replace(/;\s*(Expires|Max-Age)=[^;]*/gi, ''))
    if (cookies.length > 0) headers['set-cookie'] = cookies.join('\n')
    await route.fulfill({ response, headers })
  })
}

interface ContextOptions {
  theme: Exclude<Theme, 'n/a'>
  width: number
  height: number
  scale: number
  mobile?: boolean
  extraCss?: string
}

async function openPage(browser: Browser, opts: ContextOptions): Promise<Page> {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    viewport: { width: opts.width, height: opts.height },
    deviceScaleFactor: opts.scale,
    isMobile: opts.mobile ?? false,
    hasTouch: opts.mobile ?? false,
    colorScheme: opts.theme,
    reducedMotion: 'reduce',
    timezoneId: SCREENSHOT_USER.timezone,
    locale: 'en-US',
  })
  await keepAuthCookies(context)
  const css = CAPTURE_CSS + (opts.extraCss ?? '')
  // A string, not a function: tsx/esbuild wraps functions in helpers
  // (`__name`) that don't exist in the page, and a throwing init script also
  // takes Playwright's own clock script down with it.
  await context.addInitScript(`
    try { localStorage.setItem('opentask_demo_tour_seen', '1') } catch {}
    (() => {
      const add = () => {
        const style = document.createElement('style')
        style.textContent = ${JSON.stringify(css)}
        document.head.appendChild(style)
      }
      if (document.head) add()
      else document.addEventListener('DOMContentLoaded', add)
    })()
  `)
  const page = await context.newPage()
  await page.clock.setFixedTime(new Date(NOW!))
  trackRequests(page)
  await login(page)
  return page
}

async function login(page: Page): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Username').fill(SCREENSHOT_USER.username)
  await page.getByLabel('Password').fill(SCREENSHOT_USER.password)
  await page.getByRole('button', { name: /sign in/i }).click()
  await page.waitForURL(`${BASE_URL}/`)
  await page.locator('[id^="task-row-"]').first().waitFor()
}

/**
 * Requests in flight, minus the SSE sync stream (it never finishes, which is
 * why fixtures.ts warns off `networkidle`).
 */
const inFlight = new WeakMap<Page, Set<unknown>>()
function trackRequests(page: Page): void {
  const pending = new Set<unknown>()
  inFlight.set(page, pending)
  page.on('request', (r) => {
    if (!r.url().includes('/api/sync/stream')) pending.add(r)
  })
  const done = (r: unknown) => pending.delete(r)
  page.on('requestfinished', done)
  page.on('requestfailed', done)
}

/**
 * Ready to photograph: fonts loaded, nothing in flight, two frames painted.
 * `expect.poll`-style loop on a real condition — returns the moment it holds.
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  const pending = inFlight.get(page)!
  const deadline = Date.now() + 15_000
  while (pending.size > 0) {
    if (Date.now() > deadline) throw new Error(`requests still in flight on ${page.url()}`)
    await page.waitForEvent('requestfinished', { timeout: 15_000 }).catch(() => undefined)
  }
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  // Park the pointer off the page so no row wears a hover state.
  await page.mouse.move(0, 0)
}

async function gotoAndSettle(page: Page, url: string, ready: Locator): Promise<void> {
  if (new URL(page.url()).pathname + new URL(page.url()).search !== url) await page.goto(url)
  await ready.first().waitFor()
  await settle(page)
}

// ── Output helpers ────────────────────────────────────

function outPath(name: string): string {
  fs.mkdirSync(WEB_DIR, { recursive: true })
  return path.join(WEB_DIR, name)
}

function record(file: string, shows: string, theme: Theme, destinations: string[]): void {
  entries.push({ file: path.relative(OUT, file), shows, theme, destinations })
}

/** Downscale to exact widths, keeping the aspect ratio. Returns the paths. */
function downscales(src: string, widths: number[]): { width: number; file: string }[] {
  const { width, height } = pngSize(src)
  return widths.map((w) => {
    const file = src.replace(/\.png$/, `-${w}.png`)
    resizePng(src, file, w, Math.round((height * w) / width))
    return { width: w, file }
  })
}

// ── Shots ─────────────────────────────────────────────

const dashboardReady = (page: Page) => page.locator('[id^="task-row-"]')

/** The Just added card pushes the list down; clear it for the hero shots. */
async function clearJustAdded(page: Page): Promise<void> {
  const card = page.getByRole('region', { name: 'Just added' })
  if (await card.isVisible()) await card.getByRole('button', { name: 'Clear' }).click()
  await card.waitFor({ state: 'hidden' })
}

/**
 * Scroll the task list to the top of the screen, just under the sticky top
 * bar — the landing the app's own "Jump to tasks" uses (the list wrapper's
 * `scroll-below-header` margin, globals.css). Reduced motion makes it instant.
 */
async function scrollToTasks(page: Page): Promise<void> {
  await page
    .getByRole('listbox', { name: 'Task list' })
    .evaluate((el) => (el.closest('.scroll-below-header') ?? el).scrollIntoView({ block: 'start' }))
  await settle(page)
}

async function desktopDashboards(browser: Browser, theme: Exclude<Theme, 'n/a'>): Promise<void> {
  // Docs: 1440 x 1084 CSS px at 2x, like the March set (2880 x 2168, -1040, -520).
  {
    const page = await openPage(browser, { theme, width: 1440, height: 1084, scale: 2 })
    await clearJustAdded(page)
    await settle(page)
    const file = outPath(`web-dashboard-full-${theme}.png`)
    await page.screenshot({ path: file })
    record(file, 'Desktop dashboard (All view, AI insights on), 1440x1084 @2x', theme, [
      `docs:public/images/dashboard/web-dashboard-full-${theme}.png`,
    ])
    for (const d of downscales(file, [1040, 520])) {
      record(d.file, `Desktop dashboard, ${d.width}px wide`, theme, [
        `docs:public/images/dashboard/web-dashboard-full-${theme}-${d.width}.png`,
      ])
    }
    await scrollToTasks(page)
    const tasksFile = outPath(`web-dashboard-tasks-${theme}.png`)
    await page.screenshot({ path: tasksFile })
    record(
      tasksFile,
      'Desktop dashboard scrolled to the task list (AI scores and commentary)',
      theme,
      [`docs:public/images/dashboard/web-dashboard-tasks-${theme}.png`],
    )
    for (const d of downscales(tasksFile, [1040, 520])) {
      record(d.file, `Desktop task list, ${d.width}px wide`, theme, [
        `docs:public/images/dashboard/web-dashboard-tasks-${theme}-${d.width}.png`,
      ])
    }
    await page.context().close()
  }
  // Portfolio: 1040 x 783 CSS px at 2x, plus a 520 x 391 downscale.
  {
    const page = await openPage(browser, { theme, width: 1040, height: 783, scale: 2 })
    await clearJustAdded(page)
    await settle(page)
    const file = outPath(`web-dashboard-${theme}-full.png`)
    await page.screenshot({ path: file })
    record(file, 'Desktop dashboard, 1040x783 @2x (portfolio)', theme, [
      `portfolio:web-dashboard-${theme}-full.png`,
    ])
    const small = outPath(`web-dashboard-${theme}.png`)
    resizePng(file, small, 520, 391)
    record(small, 'Desktop dashboard, 520x391 (portfolio thumbnail)', theme, [
      `portfolio:web-dashboard-${theme}.png`,
    ])
    await page.context().close()
  }
}

/** Desktop pages at 1280 x 860 @2x: Reminders, Quotas, the views, the detail panel. */
async function desktopPages(browser: Browser, theme: Exclude<Theme, 'n/a'>): Promise<void> {
  const page = await openPage(browser, { theme, width: 1280, height: 860, scale: 2 })

  // Just added card (created minutes before the frozen now).
  const justAdded = page.getByRole('region', { name: 'Just added' })
  await justAdded.waitFor()
  await settle(page)
  const jaFile = outPath(`web-just-added-${theme}.png`)
  await shootWithPadding(page, justAdded, jaFile, 12)
  record(jaFile, 'The dashboard "Just added" card', theme, [
    `docs:public/images/dashboard/web-just-added-${theme}.png`,
  ])
  // The AI add input, with a natural-language task typed (not submitted).
  const input = page.getByRole('textbox', { name: 'Quick add task' })
  await input.fill('Call the dentist next Tuesday at 2pm to reschedule, it’s important')
  await input.blur()
  await settle(page)
  // The row holding the add field and the AI chip: the innermost element that
  // contains both (ancestors come first in document order, so `.last()`).
  const addBar = page
    .locator('main div')
    .filter({ has: input })
    .filter({ has: page.getByRole('button', { name: 'AI settings' }) })
    .last()
  const aiFile = outPath(`filled-task-input-${theme}.png`)
  await shootWithPadding(page, addBar, aiFile, 12)
  record(aiFile, 'Quick add field with a natural-language task typed in', theme, [
    `docs:public/images/ai/filled-task-input-${theme}.png`,
  ])
  await input.fill('')

  await clearJustAdded(page)

  // A task card with its AI commentary and score.
  const card = page.locator('[id^="task-row-"]').filter({ hasText: 'Draft Q4 budget review' })
  await card.scrollIntoViewIfNeeded()
  await settle(page)
  const cardFile = outPath(`web-task-card-ai-insight-${theme}.png`)
  await card.screenshot({ path: cardFile })
  record(cardFile, 'One task row with AI commentary, signal and score', theme, [
    `docs:public/images/tasks/web-task-card-ai-insight-${theme}.png`,
  ])

  // Quick panel: double-click the row's own padding (not the title link, not
  // the Done circle), as tests/e2e/quick-panel-overflow.spec.ts does.
  const cardBox = await card.boundingBox()
  await card.dblclick({ position: { x: 56, y: (cardBox?.height ?? 12) - 6 } })
  const dialog = page.getByRole('dialog')
  await dialog.waitFor()
  await settle(page)
  const panelFile = outPath(`web-task-detail-panel-desktop-${theme}.png`)
  await dialog.screenshot({ path: panelFile })
  record(panelFile, 'Quick panel (task details: snooze, priority, recurrence)', theme, [
    `docs:public/images/tasks/web-task-detail-panel-desktop-${theme}.png`,
  ])
  const modalFile = outPath(`web-task-quick-panel-${theme}.png`)
  await page.screenshot({ path: modalFile })
  record(modalFile, 'Quick panel open over the dashboard', theme, [
    `docs:public/images/tasks/web-task-quick-panel-${theme}.png`,
  ])
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })

  // Task detail page.
  const detailHref = await card.getByRole('link').first().getAttribute('href')
  await gotoAndSettle(page, detailHref!, page.getByRole('main'))
  const detailFile = outPath(`web-task-detail-page-${theme}.png`)
  await page.screenshot({ path: detailFile })
  record(detailFile, 'Task detail page', theme, [
    `docs:public/images/tasks/web-task-detail-page-${theme}.png`,
  ])

  // Reminders and Quotas pages.
  await gotoAndSettle(page, '/reminders', page.getByRole('region', { name: 'Reminders' }))
  const remFile = outPath(`web-reminders-${theme}.png`)
  await page.screenshot({ path: remFile })
  record(remFile, 'Reminders page (periods, considered and waiting)', theme, [
    `docs:public/images/concepts/web-reminders-${theme}.png`,
  ])
  await gotoAndSettle(page, '/quotas', page.getByRole('region', { name: 'Quotas' }))
  const quotaFile = outPath(`web-quotas-${theme}.png`)
  await page.screenshot({ path: quotaFile })
  record(quotaFile, 'Quotas page (day, week and month targets)', theme, [
    `docs:public/images/concepts/web-quotas-${theme}.png`,
  ])

  // The Today and Newest views. The toggle saves `default_grouping` on the
  // (throwaway) account, so put All back at the end.
  await gotoAndSettle(page, '/', dashboardReady(page))
  await clearJustAdded(page)
  const views = page.getByRole('group', { name: 'View mode' })
  for (const view of ['Today', 'Newest'] as const) {
    await views.getByRole('button', { name: view }).click()
    await views.getByRole('button', { name: view, pressed: true }).waitFor()
    await settle(page)
    await scrollToTasks(page)
    const file = outPath(`web-dashboard-${view.toLowerCase()}-${theme}.png`)
    await page.screenshot({ path: file })
    record(file, `Dashboard, ${view} view`, theme, [
      `docs:public/images/dashboard/web-dashboard-${view.toLowerCase()}-${theme}.png`,
    ])
  }
  await page.evaluate(() => window.scrollTo(0, 0))
  await views.getByRole('button', { name: 'All' }).click()
  await views.getByRole('button', { name: 'All', pressed: true }).waitFor()
  await settle(page)
  await page.context().close()
}

/** Element screenshot with a margin of page around it. */
async function shootWithPadding(page: Page, el: Locator, file: string, pad: number) {
  await el.scrollIntoViewIfNeeded()
  const box = await el.boundingBox()
  if (!box) throw new Error(`not visible for ${file}`)
  await page.screenshot({
    path: file,
    clip: {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: box.width + pad * 2,
      height: box.height + pad * 2,
    },
  })
}

/** Phone web (393 x 852 @3x) and the iPhone app composite (402 x 874 @3x). */
async function phoneShots(browser: Browser, theme: Exclude<Theme, 'n/a'>): Promise<void> {
  {
    const page = await openPage(browser, {
      theme,
      width: 393,
      height: 852,
      scale: 3,
      mobile: true,
    })
    await clearJustAdded(page)
    await settle(page)
    const file = outPath(`web-mobile-dashboard-${theme}.png`)
    await page.screenshot({ path: file })
    record(file, 'Dashboard in a phone browser, 393x852 @3x', theme, [
      `docs:public/images/dashboard/web-mobile-dashboard-${theme}.png`,
    ])

    await scrollToTasks(page)
    const mTasks = outPath(`web-mobile-dashboard-tasks-${theme}.png`)
    await page.screenshot({ path: mTasks })
    record(mTasks, 'Phone browser, scrolled to the task list', theme, [
      `docs:public/images/dashboard/web-mobile-dashboard-tasks-${theme}.png`,
    ])
    await page.evaluate(() => window.scrollTo(0, 0))

    const fab = page.locator('[data-fab-stack]')
    await settle(page)
    const fabFile = outPath(`phone-fab-column-${theme}.png`)
    await shootWithPadding(page, fab, fabFile, 12)
    record(fabFile, 'Phone floating buttons column (bottom right)', theme, [
      `docs:public/images/dashboard/phone-fab-column-${theme}.png`,
    ])

    for (const [url, name, region] of [
      ['/reminders', 'reminders', 'Reminders'],
      ['/quotas', 'quotas', 'Quotas'],
    ] as const) {
      await gotoAndSettle(page, url, page.getByRole('region', { name: region }))
      const f = outPath(`web-mobile-${name}-${theme}.png`)
      await page.screenshot({ path: f })
      record(f, `${region} page on a phone, 393x852 @3x`, theme, [
        `docs:public/images/concepts/web-mobile-${name}-${theme}.png`,
      ])
    }
    await page.context().close()
  }

  // The iPhone app: the same page, full screen, with the app's safe-area
  // padding and a status bar (9:41, full battery) drawn on top.
  {
    const page = await openPage(browser, {
      theme,
      width: IPHONE.width,
      height: IPHONE.height,
      scale: 3,
      mobile: true,
      extraCss: IPHONE_CSS,
    })
    await clearJustAdded(page)
    await drawStatusBar(page, theme)
    await settle(page)
    const file = outPath(`ios-dashboard-${theme}.png`)
    await page.screenshot({ path: file })
    record(file, 'iPhone app dashboard, raw 1206x2622 screen (no frame)', theme, [
      `docs:public/images/dashboard/ios-dashboard-${theme}.png`,
      `portfolio:ios-dashboard-${theme}-full.png`,
    ])
    for (const d of downscales(file, [400, 200])) {
      record(d.file, `iPhone app dashboard, ${d.width}px wide`, theme, [
        `docs:public/images/dashboard/ios-dashboard-${theme}-${d.width}.png`,
        ...(d.width === 400 ? [`portfolio:ios-dashboard-${theme}.png`] : []),
      ])
    }
    await page.context().close()
  }
}

/**
 * An iOS status bar over the top safe area: 9:41, full signal, Wi-Fi and
 * battery, in the glyph color iOS uses over a light or dark page.
 */
async function drawStatusBar(page: Page, theme: Exclude<Theme, 'n/a'>): Promise<void> {
  const color = theme === 'dark' ? '#fff' : '#000'
  await page.evaluate(
    ({ color, height }) => {
      const bar = document.createElement('div')
      bar.setAttribute('aria-hidden', 'true')
      bar.style.cssText = `position:fixed;top:0;left:0;right:0;height:${height}px;z-index:2147483647;pointer-events:none;color:${color};font:600 17px -apple-system, 'SF Pro Text', system-ui;`
      bar.innerHTML = `
        <span style="position:absolute;left:0;width:134px;top:21px;text-align:center;letter-spacing:-0.2px">9:41</span>
        <svg style="position:absolute;right:30px;top:23px" width="80" height="13" viewBox="0 0 80 13" fill="currentColor">
          <rect x="0" y="9" width="3" height="4" rx="1"/><rect x="4.5" y="6.5" width="3" height="6.5" rx="1"/>
          <rect x="9" y="4" width="3" height="9" rx="1"/><rect x="13.5" y="1" width="3" height="12" rx="1"/>
          <path d="M31 3.2c2.3 0 4.4.9 6 2.4l1.1-1.1A10 10 0 0 0 31 1.6c-2.7 0-5.2 1.1-7.1 2.9l1.1 1.1A8.5 8.5 0 0 1 31 3.2Zm0 3.3c1.4 0 2.6.5 3.6 1.4l1.1-1.1a6.7 6.7 0 0 0-9.4 0l1.1 1.1c1-.9 2.2-1.4 3.6-1.4Zm0 3.2c-.6 0-1.1.2-1.5.6L31 11.9l1.5-1.6c-.4-.4-.9-.6-1.5-.6Z"/>
          <rect x="47.5" y="0.5" width="25" height="12" rx="3.8" fill="none" stroke="currentColor" stroke-opacity=".4"/>
          <rect x="49.5" y="2.5" width="21" height="8" rx="2.2"/>
          <path d="M74 4.3v4.4c.8-.3 1.4-1.2 1.4-2.2s-.6-1.9-1.4-2.2Z" fill-opacity=".45"/>
        </svg>`
      document.body.appendChild(bar)
    },
    { color, height: 62 },
  )
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await webkit.launch()
  try {
    for (const theme of THEMES) {
      console.log(`web: ${theme}`)
      await desktopDashboards(browser, theme)
      await desktopPages(browser, theme)
      await phoneShots(browser, theme)
    }
  } finally {
    await browser.close()
    writeManifestPart(OUT, 'web', entries)
  }
  console.log(`web: ${entries.length} images → ${WEB_DIR}`)
}

main().catch((err) => {
  console.error('Web capture failed:', err)
  process.exit(1)
})
