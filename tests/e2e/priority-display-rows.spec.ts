/**
 * Priority Display on the reminder and quota rows (2026-10-26,
 * `src/lib/priority-display.ts`): Settings → Priority Display is one rule for
 * every row, so whatever the user turned on for tasks shows on
 *
 * - the reminder rows on /reminders, and in the dashboard's Reminders card;
 * - the quota prompt rows on /reminders;
 * - the quota chips on /quotas.
 *
 * Each option on its own, and all of them off:
 *
 * - "Show priority indicator" (Words / Icons): the priority tab inline after
 *   the title — High and Urgent only, as on the task rows' corner (Medium,
 *   Low and None get no tab, Trent's 2026-10-15 rule);
 * - "Color task titles": the title in the priority's hue, Medium up here;
 * - "Show right border": the chip's right border, 4px in the priority's
 *   colour; the reminder and prompt rows (no border of their own) a 3px bar
 *   on their right edge, the mirror of a prompt's label stripe;
 * - "Color checkbox": the done circle (a prompt's dashed ring) in the
 *   priority's colours — a chip has no circle;
 * - None shows nothing under any of them; all off shows nothing at all.
 *
 * At 1280×800 in light and 390×844 in dark. Screenshots go to
 * `.tmp/priority-display/`. Isolation: every reminder and quota is made here
 * under a unique title and trashed after; the preference is put back by
 * `withPreferences`.
 */
import { DateTime } from 'luxon'
import { test, expect, uniqueTitle, waitForPrefsLoaded, withPreferences } from './fixtures'
import type { APIRequestContext, Locator, Page } from '@playwright/test'

const SHOTS = '.tmp/priority-display'
const TEST_TZ = process.env.E2E_TZ || 'America/Chicago'

interface Display {
  trailingDot: boolean
  badgeStyle: 'words' | 'icons'
  colorTitle: boolean
  rightBorder: boolean
  colorCheckbox: boolean
}

const OFF: Display = {
  trailingDot: false,
  badgeStyle: 'words',
  colorTitle: false,
  rightBorder: false,
  colorCheckbox: false,
}

const CONFIGS: [string, Display][] = [
  ['off', OFF],
  ['indicator-words', { ...OFF, trailingDot: true }],
  ['indicator-icons', { ...OFF, trailingDot: true, badgeStyle: 'icons' }],
  ['color-title', { ...OFF, colorTitle: true }],
  ['right-border', { ...OFF, rightBorder: true }],
  ['color-checkbox', { ...OFF, colorCheckbox: true }],
]

const PRIORITIES = [
  { value: 0, name: 'None' },
  { value: 2, name: 'Medium' },
  { value: 3, name: 'High' },
  { value: 4, name: 'Urgent' },
] as const

/** The app's priority hues (`getPriorityColors`), by priority. */
const HUE: Record<number, string> = { 2: 'amber', 3: 'orange', 4: 'red' }
const TITLE = (p: number) => `text-${HUE[p]}-500`
const BORDER = (p: number) => `border-r-${HUE[p]}-500/50`
const BAR = (p: number) => `bg-${HUE[p]}-500/50`
const CIRCLE = (p: number) => `border-${HUE[p]}-400/50`
const RING = (p: number) => `text-${HUE[p]}-400/50`

const TAB: Record<'words' | 'icons', Record<number, string | null>> = {
  words: { 0: null, 2: null, 3: 'High', 4: 'Urgent' },
  icons: { 0: null, 2: null, 3: '!', 4: '!!' },
}

interface Made {
  reminders: Map<number, number>
  quotas: Map<number, number>
  titles: Map<string, string>
}

/**
 * The dashboard card's clock (2026-10-26). The card shows ONE period, the
 * clock's (`naturalSlotIndex`), and works it out again on every render, from
 * the browser's clock — so the card test, seeded from one reading of the
 * Playwright process's clock and checked over the next minute or two, failed
 * whenever a period started in between: seeded at 11:58 into Morning, the card
 * had moved to an empty Midday by a later page load (CI, 16:58 UTC). So the
 * card test pins the server's clock (POST /api/test/clock) and the browser's
 * (`page.clock.install`) to the most recent 10:30 in the user's zone, at or
 * before real now (never ahead: the cron jobs compute on the shifted clock),
 * and seeds from that instant, never from real now. 10:30 is mid-Morning, at
 * least 90 minutes from every default period start (09:00, 12:00) and from
 * either day start (midnight, 3:00), so the test never runs into one, whatever
 * the hour it starts at.
 */
function midMorning(): DateTime {
  const now = DateTime.now().setZone(TEST_TZ)
  const at = now.set({ hour: 10, minute: 30, second: 0, millisecond: 0 })
  return at > now ? at.minus({ days: 1 }) : at
}

/** Pin the server's clock (null: the real one). */
async function setClock(request: APIRequestContext, now: string | null) {
  const res = await request.post('/api/test/clock', { data: { now } })
  expect(res.ok(), await res.text()).toBeTruthy()
}

/**
 * The natural slot at `now` (the latest started, else the first) — the
 * dashboard card's page.
 */
async function naturalSlotStart(page: Page, now: DateTime): Promise<DateTime> {
  const res = await page.request.get('/api/time-slots')
  const slots = ((await res.json()).data.time_slots as { start_time: string }[])
    .map((s) => s.start_time)
    .sort()
  const at = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number)
    return now.set({ hour: h, minute: m, second: 0, millisecond: 0 })
  }
  const started = slots.filter((s) => at(s) <= now)
  return at(started.at(-1) ?? slots[0]).plus({ minutes: 1 })
}

async function makeRows(page: Page, now: DateTime): Promise<Made> {
  const made: Made = { reminders: new Map(), quotas: new Map(), titles: new Map() }
  const due = (await naturalSlotStart(page, now)).toUTC().toISO()
  for (const p of PRIORITIES) {
    const rTitle = uniqueTitle(`PD reminder ${p.name}`)
    const r = await page.request.post('/api/tasks', {
      data: { title: rTitle, is_reminder: true, priority: p.value, due_at: due },
    })
    expect(r.ok(), `reminder ${p.name}`).toBeTruthy()
    made.reminders.set(p.value, (await r.json()).data.id)
    made.titles.set(`r${p.value}`, rTitle)

    const qTitle = uniqueTitle(`PD quota ${p.name}`)
    const q = await page.request.post('/api/tasks', {
      data: {
        title: qTitle,
        rrule: 'FREQ=WEEKLY',
        progress_target: 3,
        is_tracked: true,
        priority: p.value,
      },
    })
    expect(q.ok(), `quota ${p.name}`).toBeTruthy()
    made.quotas.set(p.value, (await q.json()).data.id)
    made.titles.set(`q${p.value}`, qTitle)
  }
  return made
}

async function trash(page: Page, made: Made) {
  const ids = [...made.reminders.values(), ...made.quotas.values()]
  await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

/** A class's computed colour, from a probe in the page (so it resolves in the page's theme). */
async function classColor(
  page: Page,
  className: string,
  prop: 'color' | 'borderTopColor' | 'borderRightColor' | 'backgroundColor',
): Promise<string> {
  return page.evaluate(
    ([cls, p]) => {
      const probe = document.createElement('div')
      probe.className = `border border-r-4 ${cls}`
      document.body.appendChild(probe)
      const value = getComputedStyle(probe)[p as 'color']
      probe.remove()
      return value
    },
    [className, prop] as const,
  )
}

async function css(el: Locator, prop: string): Promise<string> {
  return el.evaluate((node, p) => getComputedStyle(node).getPropertyValue(p), prop)
}

/** Every priority hue a part could wear — "shows nothing" means none of them. */
async function allHues(
  page: Page,
  make: (p: number) => string,
  prop: Parameters<typeof classColor>[2],
) {
  return Promise.all([2, 3, 4].map((p) => classColor(page, make(p), prop)))
}

/**
 * Off the rows, and every colour transition run to its end. The rows'
 * `transition-colors` animate the switch from the default display (the page's
 * first paint) to the one the preferences load — read mid-way, a border is
 * neither colour. A CSS transition is a real event with an end, so this waits
 * for it rather than for a time.
 */
async function settle(page: Page) {
  await page.mouse.move(0, 0)
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every((a) => !(a instanceof CSSTransition) || a.playState === 'finished'),
  )
}

type Kind = 'reminder' | 'prompt' | 'chip' | 'panel'

/**
 * One row against one setting: the tab, the title colour, the right border
 * and the circle each either show the priority (when that option is on and the
 * priority is above None) or show nothing.
 */
async function expectRow(page: Page, kind: Kind, row: Locator, priority: number, d: Display) {
  await expect(row).toBeVisible()
  const coloured = priority > 0

  // The tab — High and Urgent only.
  const tabText = d.trailingDot ? TAB[d.badgeStyle][priority] : null
  const tab = row.locator('[data-priority-tab]')
  if (tabText) {
    await expect(tab).toHaveCount(1)
    await expect(tab).toHaveText(tabText)
    await expect(tab).toBeVisible()
  } else {
    await expect(tab).toHaveCount(0)
  }

  // The title's colour.
  const title = row.locator('[data-row-title]')
  const titleColor = await css(title, 'color')
  if (d.colorTitle && coloured) {
    expect(titleColor, `${kind} P${priority} title`).toBe(
      await classColor(page, TITLE(priority), 'color'),
    )
  } else {
    expect(await allHues(page, TITLE, 'color'), `${kind} P${priority} title`).not.toContain(
      titleColor,
    )
  }

  // The right border. A chip has a border of its own and colours its right
  // side (the task row's 4px border); the reminder and prompt rows have none
  // and draw a bar on their right edge instead (`PriorityEdgeBar`).
  const edge = row.locator('[data-priority-edge]')
  const width = await css(row, 'border-right-width')
  if (d.rightBorder && coloured) {
    if (kind === 'chip') {
      expect(width, `${kind} P${priority} border`).toBe('4px')
      expect(await css(row, 'border-right-color')).toBe(
        await classColor(page, BORDER(priority), 'borderRightColor'),
      )
    } else {
      await expect(edge).toHaveCount(1)
      await expect(edge).toBeVisible()
      expect(await css(edge, 'background-color'), `${kind} P${priority} edge`).toBe(
        await classColor(page, BAR(priority), 'backgroundColor'),
      )
    }
  } else {
    expect(width, `${kind} P${priority} border`).toBe('1px')
    await expect(edge).toHaveCount(0)
  }

  // The done circle (a prompt's dashed ring, drawn in currentColor). Chips have none.
  if (kind === 'chip') return
  const circle =
    kind === 'prompt'
      ? row.locator('[data-prompt-consider]')
      : row.getByRole('button', { name: /as considered$/ })
  const ringProp = kind === 'prompt' ? 'color' : 'border-top-color'
  const make = kind === 'prompt' ? RING : CIRCLE
  const probeProp = kind === 'prompt' ? 'color' : 'borderTopColor'
  const circleColor = await css(circle, ringProp)
  if (d.colorCheckbox && coloured) {
    expect(circleColor, `${kind} P${priority} circle`).toBe(
      await classColor(page, make(priority), probeProp),
    )
  } else {
    expect(await allHues(page, make, probeProp), `${kind} P${priority} circle`).not.toContain(
      circleColor,
    )
  }
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.emulateMedia({ colorScheme: theme })
}

async function expectTheme(page: Page, theme: 'light' | 'dark') {
  await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark)/)
}

/** /reminders: the four reminder rows and the four quota prompt rows. */
async function checkReminders(page: Page, made: Made, name: string, d: Display, tag: string) {
  const first = page.locator(`li[data-reminder-id="${made.reminders.get(0)}"]`)
  await waitForPrefsLoaded(page, () => page.goto('/reminders'), first)
  await settle(page)
  for (const p of PRIORITIES) {
    const reminder = page.locator(`li[data-reminder-id="${made.reminders.get(p.value)}"]`)
    await expectRow(page, 'reminder', reminder, p.value, d)
    const prompt = page.locator(`li[data-prompt-task="${made.quotas.get(p.value)}"]`).first()
    await expectRow(page, 'prompt', prompt, p.value, d)
  }
  // The slot card holding the rows, whole (an element shot scrolls it into view).
  const card = (row: Locator) => row.locator('xpath=ancestor::*[@data-slot-group][1]')
  await card(first).screenshot({ path: `${SHOTS}/reminders-${name}-${tag}.png` })
  const prompt = page.locator(`li[data-prompt-task="${made.quotas.get(0)}"]`).first()
  await card(prompt).screenshot({ path: `${SHOTS}/prompts-${name}-${tag}.png` })
}

/** /quotas: the four chips. */
async function checkQuotas(page: Page, made: Made, name: string, d: Display, tag: string) {
  const chip = (p: number) => page.locator(`[data-track-chip="${made.quotas.get(p)}"]`)
  await waitForPrefsLoaded(page, () => page.goto('/quotas'), chip(0))
  await settle(page)
  for (const p of PRIORITIES) await expectRow(page, 'chip', chip(p.value), p.value, d)
  // The chip list holding the four (one period, one unlabelled cluster).
  const list = chip(0).locator('xpath=ancestor::ul[1]')
  await list.screenshot({ path: `${SHOTS}/quotas-${name}-${tag}.png` })
}

test.describe('Priority display on reminder and quota rows · desktop light', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('/reminders and /quotas follow each option; None and all-off show nothing', async ({
    authenticatedPage: page,
  }) => {
    test.setTimeout(180_000)
    await setTheme(page, 'light')
    const made = await makeRows(page, DateTime.now().setZone(TEST_TZ))
    try {
      await withPreferences(page, { quota_prompts_enabled: true }, async () => {
        for (const [name, d] of CONFIGS) {
          await withPreferences(page, { priority_display: d }, async () => {
            await checkReminders(page, made, name, d, '1280-light')
            await expectTheme(page, 'light')
            await checkQuotas(page, made, name, d, '1280-light')
          })
        }
      })
    } finally {
      await trash(page, made)
    }
  })

  test.afterAll(async ({ request }) => {
    await setClock(request, null)
  })

  test("the dashboard's Reminders card follows each option", async ({
    authenticatedPage: page,
  }) => {
    test.setTimeout(120_000)
    await setTheme(page, 'light')
    // Both clocks on mid-Morning, before anything is seeded — see `midMorning`.
    // The task rollover is stamped as of real now first, so a cron run on the
    // shifted clock finds its day already done (src/core/test-clock.ts).
    const pin = midMorning()
    const stamp = await page.request.post('/api/test/rollover', { data: {} })
    expect(stamp.ok(), await stamp.text()).toBeTruthy()
    await setClock(page.request, pin.toUTC().toISO())
    await page.clock.install({ time: pin.toJSDate() })
    const made = await makeRows(page, pin)
    try {
      for (const [name, d] of CONFIGS) {
        await withPreferences(page, { priority_display: d }, async () => {
          const panel = page.locator('[data-reminders-panel]')
          const row = (p: number) =>
            panel.locator(`li[data-reminder-id="${made.reminders.get(p)}"]`)
          await waitForPrefsLoaded(page, () => page.goto('/'), row(0))
          await settle(page)
          for (const p of PRIORITIES) await expectRow(page, 'panel', row(p.value), p.value, d)
          await row(0).evaluate((el) => el.scrollIntoView({ block: 'center' }))
          await panel.screenshot({ path: `${SHOTS}/dashboard-card-${name}-1280-light.png` })
        })
      }
    } finally {
      await trash(page, made)
      await setClock(page.request, null)
    }
  })
})

test.describe('Priority display on reminder and quota rows · phone dark', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  test('/reminders and /quotas follow each option; None and all-off show nothing', async ({
    authenticatedPage: page,
  }) => {
    test.setTimeout(180_000)
    await setTheme(page, 'dark')
    const made = await makeRows(page, DateTime.now().setZone(TEST_TZ))
    try {
      await withPreferences(page, { quota_prompts_enabled: true }, async () => {
        for (const [name, d] of CONFIGS) {
          await withPreferences(page, { priority_display: d }, async () => {
            await checkReminders(page, made, name, d, '390-dark')
            await expectTheme(page, 'dark')
            await checkQuotas(page, made, name, d, '390-dark')
          })
        }
      })
    } finally {
      await trash(page, made)
      await setTheme(page, 'light')
    }
  })
})
