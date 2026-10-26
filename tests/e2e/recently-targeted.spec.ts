/**
 * Recently targeted (2026-10-12): a task targeted from a task segment — the
 * row's Today button, or the time picker its hold / right-click opens — is
 * listed in the dashboard's Just now card for 15 minutes, labelled
 * "Targeted …", and its real row wears a "Targeted" tag
 * (`src/lib/just-added.ts`, `TaskSegmentRow`'s `TargetTodayButton`).
 *
 * Segment rows: each task gets a `days` horizon and a created_at a day back
 * (`backdateCreated(..., { inSegments: true })`), so it waits in today's Days
 * segment at any hour. The rows are driven on /reminders, where every
 * segment row is listed at every width.
 *
 * Touch is real touch: CDP `Input.dispatchTouchEvent`, so the browser makes
 * the pointer events (and any pointercancel) itself. A hold is held until the
 * picker shows, never for a fixed time; the one "nothing happened" check runs
 * the page's clock forward (`page.clock`) instead of waiting.
 *
 * Isolation: every task is created here under a unique title and trashed in
 * `finally`.
 */
import { DateTime } from 'luxon'
import {
  test,
  expect,
  backdateCreated,
  uniqueTitle,
  waitForPrefsLoaded,
  withPreferences,
} from './fixtures'
import type { CDPSession, Locator, Page } from '@playwright/test'

const TEST_TZ = process.env.E2E_TZ || 'America/Chicago'

async function create(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', { data })
  expect(res.ok(), `create ${JSON.stringify(data)}`).toBeTruthy()
  return (await res.json()).data.id as number
}

async function stateOf(page: Page, id: number): Promise<Record<string, unknown>> {
  const res = await page.request.get(`/api/tasks/${id}`)
  return (await res.json()).data as Record<string, unknown>
}

async function trash(page: Page, ids: number[]) {
  if (ids.length) await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
}

async function segmentTask(page: Page, label: string): Promise<number> {
  const id = await create(page, { title: uniqueTitle(label), horizon: 'days' })
  backdateCreated([id], { inSegments: true })
  return id
}

const segmentRow = (page: Page, id: number) =>
  page.locator('[data-task-segments]').locator(`[data-segment-task="${id}"]`)
const todayButton = (page: Page, id: number) =>
  segmentRow(page, id).getByRole('button', { name: /^Target .* today \(hold for a time\)$/ })
const picker = (page: Page) =>
  page.locator('[data-slot="popover-content"]').filter({
    has: page.getByRole('button', { name: 'Set target' }),
  })
/** The hold's Target menu: a bottom sheet on a phone, a dropdown on a desktop. */
const targetMenu = (page: Page) =>
  page
    .getByRole('dialog', { name: 'Target' })
    .or(page.getByRole('menu', { name: 'Target options' }))
const menuChoice = (page: Page, name: string | RegExp) =>
  targetMenu(page).getByRole(page.viewportSize()!.width < 768 ? 'button' : 'menuitem', { name })
const entry = (page: Page, id: number) => page.locator(`[data-just-added-entry="${id}"]`)

/** The card's entries, as task ids in on-screen order. */
function entryOrder(page: Page): Promise<Array<string | null>> {
  return page
    .locator('[data-just-added-entry]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-just-added-entry')))
}

/** The middle of an on-screen element, in CSS pixels. */
async function centre(target: Locator): Promise<{ x: number; y: number }> {
  await target.scrollIntoViewIfNeeded()
  const box = await target.boundingBox()
  if (!box) throw new Error('not on screen')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function touch(
  cdp: CDPSession,
  type: 'touchStart' | 'touchMove' | 'touchEnd',
  points: Array<{ x: number; y: number }>,
) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points })
}

/** Pick 11:45 PM on the day the picker opened on (tomorrow, Custom's default). */
async function pickLateTonight(page: Page) {
  const p = picker(page)
  await p.getByLabel('Hour').fill('11')
  await p.getByLabel('Minute').fill('45')
  const ampm = p.getByRole('button', { name: /^Toggle AM\/PM/ })
  if ((await ampm.textContent())?.trim() !== 'PM') await ampm.click()
  await expect(ampm).toHaveText('PM')
}

const tomorrow2345 = () =>
  DateTime.now()
    .setZone(TEST_TZ)
    .plus({ days: 1 })
    .set({ hour: 23, minute: 45, second: 0, millisecond: 0 })
    .toUTC()
    .toISO()

/** Every open task in one flat list, so a targeted task's real row is on screen. */
const FLAT = { default_grouping: 'unified', default_sort: 'due_date', default_sort_reversed: false }

test.describe('Recently targeted: Today → the Just now card', () => {
  test('a tap on Today lists the task in the card as "Targeted", and tags its real row', async ({
    authenticatedPage: page,
  }) => {
    const added = await create(page, { title: uniqueTitle('RT added') })
    const id = await segmentTask(page, 'RT tapped')
    try {
      await page.goto('/reminders')
      await todayButton(page, id).click()
      await expect(segmentRow(page, id)).toHaveCount(0)
      await expect.poll(async () => (await stateOf(page, id)).segment_targeted_at).not.toBeNull()

      await withPreferences(page, FLAT, async () => {
        await waitForPrefsLoaded(page, () => page.goto('/'), entry(page, id))
        await expect(entry(page, id)).toHaveAttribute('data-just-added-kind', 'targeted')
        await expect(entry(page, id)).toContainText('Targeted just now')
        await expect(entry(page, added)).toContainText('Added just now')
        // Newest event first: the targeting came after the add.
        const order = await entryOrder(page)
        expect(order.indexOf(String(id))).toBeLessThan(order.indexOf(String(added)))
        const row = page.locator(`#task-row-${id}`)
        await expect(row.locator('[data-just-added-badge]')).toHaveText('Targeted')
        await expect(page.locator(`#task-row-${added} [data-just-added-badge]`)).toHaveText('New')

        // A tap on the entry brings the real row on screen, to re-target it.
        await entry(page, id).click()
        await expect(row).toBeInViewport()

        // Clear hides it; a re-target after the Clear is a new event and shows.
        await page
          .locator('[data-just-added-card]')
          .getByRole('button', { name: 'Clear', exact: true })
          .click()
        await expect(entry(page, id)).toHaveCount(0)
        await page.request.post('/api/task-segments/target-today', { data: { ids: [id] } })
        await expect(entry(page, id)).toBeVisible()
      })
    } finally {
      await trash(page, [added, id])
    }
  })
})

test.describe('Recently targeted: the Today picker on a phone', () => {
  // The picker's calendar works in the browser's local days, so the browser
  // runs in the user's zone (as selection-tasks does); a UTC runner after 7 PM
  // Chicago otherwise opened it on tomorrow.
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    timezoneId: TEST_TZ,
  })

  test("Today's 34×44 hit area keeps 12px clear of the done square, on /reminders and the Tasks card", async ({
    authenticatedPage: page,
  }) => {
    // Trent tapped Today while reaching for done (2026-10-12): the two sat 2px apart.
    // Since the compact row buttons (2026-10-26) every action's hit area is
    // 34 wide and 44 tall, in px at any text size; the 12px stays.
    const id = await segmentTask(page, 'RT hit areas')
    try {
      const check = async (scope: Locator) => {
        const today = scope.getByRole('button', { name: /^Target .* today \(hold for a time\)$/ })
        const done = scope.getByRole('button', { name: /^Done: / })
        const t = (await today.boundingBox())!
        const d = (await done.boundingBox())!
        expect(t.width).toBeGreaterThanOrEqual(34)
        expect(t.height).toBeGreaterThanOrEqual(44)
        // Today sits left of done; the gap between the two hit areas is dead space.
        expect(d.x - (t.x + t.width)).toBeGreaterThanOrEqual(12)
        // The glyph matches the done square's size.
        const glyph = (await today.locator('svg').boundingBox())!
        expect(Math.abs(glyph.width - d.width)).toBeLessThanOrEqual(1)
      }
      await page.goto('/reminders')
      await check(segmentRow(page, id))
      await page.goto('/')
      const card = page.locator(`[data-segment-task="${id}"]`).first()
      await expect(card).toBeVisible()
      await check(card)
    } finally {
      await trash(page, [id])
    }
  })

  test('a hold opens the Target menu without targeting; Custom... opens the picker, whose time targets the task', async ({
    authenticatedPage: page,
  }) => {
    const id = await segmentTask(page, 'RT held')
    try {
      await page.goto('/reminders')
      const cdp = await page.context().newCDPSession(page)
      const at = await centre(todayButton(page, id))
      await touch(cdp, 'touchStart', [at])
      await expect(targetMenu(page)).toBeVisible()
      await touch(cdp, 'touchEnd', [])

      // The hold did not also tap: still waiting in its segment, untargeted.
      await expect(segmentRow(page, id)).toHaveAttribute('data-segment-state', 'waiting')
      expect((await stateOf(page, id)).segment_targeted_at).toBeNull()

      // The bulk snooze's periods, then Custom... for the picker.
      await expect(menuChoice(page, '1 hour')).toBeVisible()
      await menuChoice(page, 'Custom...').click()
      await expect(targetMenu(page)).toHaveCount(0)
      await expect(picker(page)).toBeVisible()

      // Using the picker never reaches the row (whose click would consider it).
      await pickLateTonight(page)
      await expect(segmentRow(page, id)).toHaveAttribute('data-segment-state', 'waiting')

      await picker(page).getByRole('button', { name: 'Set target' }).click()
      await expect(picker(page)).toHaveCount(0)
      await expect(segmentRow(page, id)).toHaveCount(0)
      await expect.poll(async () => (await stateOf(page, id)).target_at).toBe(tomorrow2345())
      expect((await stateOf(page, id)).segment_targeted_at).not.toBeNull()

      await withPreferences(page, FLAT, async () => {
        await waitForPrefsLoaded(page, () => page.goto('/'), entry(page, id))
        await expect(entry(page, id)).toContainText('Targeted just now')
      })
    } finally {
      await trash(page, [id])
    }
  })

  test('a tap on Today targets only that task, not the row that slides up under the finger', async ({
    authenticatedPage: page,
  }) => {
    // The tap used to fire on pointerup: the row left the list before the
    // browser's click, which then landed on the next row's Today and targeted
    // that task too (seen on dev, 2026-10-12).
    const a = await segmentTask(page, 'RT ghost first')
    const b = await segmentTask(page, 'RT ghost second')
    try {
      await page.goto('/reminders')
      await expect(todayButton(page, a)).toBeVisible()
      await expect(todayButton(page, b)).toBeVisible()
      const [ya, yb] = await Promise.all(
        [a, b].map(async (id) => (await todayButton(page, id).boundingBox())!.y),
      )
      const [upper, lower] = ya < yb ? [a, b] : [b, a]
      const cdp = await page.context().newCDPSession(page)
      const at = await centre(todayButton(page, upper))
      await touch(cdp, 'touchStart', [at])
      await touch(cdp, 'touchEnd', [])

      await expect(segmentRow(page, upper)).toHaveCount(0)
      await expect.poll(async () => (await stateOf(page, upper)).segment_targeted_at).not.toBeNull()
      // The one that slid up is untouched: still waiting, never targeted.
      await expect(segmentRow(page, lower)).toHaveAttribute('data-segment-state', 'waiting')
      const other = await stateOf(page, lower)
      expect(other.segment_targeted_at).toBeNull()
      expect(other.target_at).toBeNull()
    } finally {
      await trash(page, [a, b])
    }
  })

  test('a hold that moves is abandoned — no picker, no target — and the next tap targets', async ({
    authenticatedPage: page,
  }) => {
    const id = await segmentTask(page, 'RT moved')
    try {
      await page.clock.install()
      await page.goto('/reminders')
      const cdp = await page.context().newCDPSession(page)
      const at = await centre(todayButton(page, id))
      await touch(cdp, 'touchStart', [at])
      await touch(cdp, 'touchMove', [{ x: at.x - 40, y: at.y + 30 }])
      await touch(cdp, 'touchEnd', [])
      // Well past the hold's 400ms: nothing opened, nothing was targeted.
      await page.clock.runFor(1500)
      await expect(targetMenu(page)).toHaveCount(0)
      await expect(picker(page)).toHaveCount(0)
      await expect(segmentRow(page, id)).toHaveAttribute('data-segment-state', 'waiting')
      expect((await stateOf(page, id)).target_at).toBeNull()

      // A plain tap still targets today.
      await todayButton(page, id).tap()
      await expect(segmentRow(page, id)).toHaveCount(0)
      await expect.poll(async () => (await stateOf(page, id)).target_at).not.toBeNull()
    } finally {
      await trash(page, [id])
    }
  })
})

test.describe('Recently targeted: the Today picker on a desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, timezoneId: TEST_TZ })

  test('a right-click opens the Target menu and never targets; Custom... and a plain click still do', async ({
    authenticatedPage: page,
  }) => {
    const [held, clicked] = [
      await segmentTask(page, 'RT right'),
      await segmentTask(page, 'RT click'),
    ]
    try {
      await page.goto('/reminders')
      await todayButton(page, held).click({ button: 'right' })
      await expect(targetMenu(page)).toBeVisible()
      await expect(segmentRow(page, held)).toHaveAttribute('data-segment-state', 'waiting')
      expect((await stateOf(page, held)).target_at).toBeNull()

      await menuChoice(page, 'Custom...').click()
      await expect(picker(page)).toBeVisible()
      await pickLateTonight(page)
      await picker(page).getByRole('button', { name: 'Set target' }).click()
      await expect(segmentRow(page, held)).toHaveCount(0)
      await expect.poll(async () => (await stateOf(page, held)).target_at).toBe(tomorrow2345())

      await todayButton(page, clicked).click()
      await expect(segmentRow(page, clicked)).toHaveCount(0)
      await expect.poll(async () => (await stateOf(page, clicked)).target_at).not.toBeNull()
      expect((await stateOf(page, clicked)).target_at).not.toBe(tomorrow2345())
    } finally {
      await trash(page, [held, clicked])
    }
  })

  test('a choice in the Target menu targets the task at that time', async ({
    authenticatedPage: page,
  }) => {
    const id = await segmentTask(page, 'RT menu hour')
    try {
      await page.goto('/reminders')
      await todayButton(page, id).click({ button: 'right' })
      const before = Date.now()
      await menuChoice(page, '1 hour').click()
      await expect(targetMenu(page)).toHaveCount(0)
      await expect(segmentRow(page, id)).toHaveCount(0)
      await expect.poll(async () => (await stateOf(page, id)).target_at).not.toBeNull()
      const after = Date.now()
      // "1 hour" is the bulk snooze's: an hour from the click, snapped to an
      // hour (`snapToHour`, which rounds up from :35) — so on the hour, 25 to
      // 85 minutes after the click, which fell between `before` and `after`.
      const target = Date.parse((await stateOf(page, id)).target_at as string)
      expect(target % 3_600_000).toBe(0)
      expect(target).toBeGreaterThanOrEqual(before + 25 * 60_000)
      expect(target).toBeLessThanOrEqual(after + 85 * 60_000)
    } finally {
      await trash(page, [id])
    }
  })
})
