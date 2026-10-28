/**
 * The dashboard row's title sits where it would without a corner tab
 * (2026-10-26, Trent's iPhone at 402 px and 119% text).
 *
 * Rows with the horizon dot in their corner showed a blank band above the
 * title — the title low in the card, the done circle centred. Two causes, both
 * in the title's float spacer (`rowCorner` in `src/components/TaskRow.tsx`):
 *
 * - WebKit: the spacer was a direct child of the title's `line-clamp-3` box
 *   (`display: -webkit-box`), which WebKit lays out as a legacy flexbox — the
 *   float became a box item of its own, stacked ABOVE the text. The band was
 *   the spacer's height: 31px with the dot on touch, 19px with a mouse, 4px
 *   for a priority tab alone. Chromium never showed it, so this spec has to
 *   run in WebKit to guard it: `E2E_WEBKIT=1 npx playwright test --project
 *   webkit tests/e2e/row-title-band.spec.ts` (CI runs Chromium only).
 * - Every engine: the dot's spacer was taller than one title line on touch
 *   (31px against a 24px line), so the clamp box grew and a one-line title
 *   sat 3.5px above the circle's centre, its meta line 7px lower.
 *
 * The rows, each made here and trashed after (the shapes a one-off can have:
 * a one-off without a picked target always shows the dot, and a picked target
 * always puts its time on the meta line — so "no tab" and "a priority tab
 * alone" have no title-only row):
 *
 *   title only:  dot (Days) · ring (unset) · dot + priority tab
 *   meta line:   no tab · priority tab · dot · ring — each with the same
 *                one line (the deadline chip and a target time)
 *   long title:  dot, clamped at three lines, wrapping around the corner
 *
 * Measured at 402×874 with touch, at the default text size and at the iOS
 * app's 119% (WebView.swift sets the root font-size from Dynamic Type), light
 * and dark. Screenshots go to `.tmp/row-title-band/` (`ROW_BAND_SHOTS` moves them).
 */
import { DateTime } from 'luxon'
import { test, expect, backdateCreated, uniqueTitle } from './fixtures'
import type { Locator, Page } from '@playwright/test'

const DAY = 24 * 60 * 60 * 1000
const SHOTS = process.env.ROW_BAND_SHOTS || '.tmp/row-title-band'

/** Root font sizes: the default, and the iOS app's 119% (`fontScalePercent`). */
const SIZES = [
  { name: 'default', root: '' },
  { name: '119', root: '19.04px' },
] as const

/**
 * Rounding only: both engines lay out in fractions of a pixel and snap at
 * paint. The faults this guards were 31px (the WebKit band) and 1.2–3.5px
 * (the over-tall spacer at 119% and at the default size).
 */
const SUBPIXEL = 1

let project: { id: number; name: string } | null = null

async function create(page: Page, data: Record<string, unknown>): Promise<number> {
  const res = await page.request.post('/api/tasks', {
    data: { project_id: project!.id, ...data },
  })
  expect(res.ok(), `create ${JSON.stringify(data)}`).toBeTruthy()
  return (await res.json()).data.id as number
}

/** Tomorrow at 10:00 local — a picked target well ahead of now. */
/**
 * Three days out at 10:00: "Sat 10:00 AM", the weekday form whatever today
 * is — shorter than "Tomorrow 10:00 AM", so the target and deadline chips
 * (`TimeChip`, 2026-10-28: padded, the deadline flagged) share one meta line
 * on a phone at the iOS app's 119% text, as the rows this compares need.
 */
function inThreeDaysAt10(): string {
  const tz = process.env.E2E_TZ || 'America/Chicago'
  return DateTime.now().setZone(tz).plus({ days: 3 }).set({ hour: 10, minute: 0 }).toUTC().toISO()!
}

/** The test's project group, with its Now fold opened so every row shows. */
async function gotoGroup(page: Page): Promise<Locator> {
  await page.goto('/')
  const group = page.locator('section[data-task-group]', {
    has: page.getByRole('button', { name: `Collapse ${project!.name}`, exact: true }),
  })
  await expect(group).toBeVisible()
  const shut = group.locator('[data-now-fold="shut"]')
  if ((await shut.count()) > 0) await shut.click()
  await expect(shut).toHaveCount(0)
  return group
}

interface RowGeometry {
  /** The title text's first line, from the top of the title's clamp box. */
  textInClamp: number
  /** The title text's first line, from the row's top. */
  textInRow: number
  /** The clamp box's first line's centre minus the done circle's centre. */
  lineVsCircle: number
  /** Title lines (distinct tops of the text's line rects). */
  lines: number
  /** The content column's height below the title (the meta line). */
  metaHeight: number
  rowHeight: number
}

async function geometry(row: Locator): Promise<RowGeometry> {
  return row.evaluate((el) => {
    const link = el.querySelector('a[href^="/tasks/"]')!
    const circle = el.querySelector('button[aria-label$=" as done"]')!
    const titleRow = link.parentElement!
    const column = titleRow.parentElement!
    const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT)
    let text: Node | null = walker.nextNode()
    while (text && !text.textContent?.trim()) text = walker.nextNode()
    const range = document.createRange()
    range.selectNodeContents(text!)
    const rects = [...range.getClientRects()]
    const r = el.getBoundingClientRect()
    const l = link.getBoundingClientRect()
    const c = circle.getBoundingClientRect()
    const lh = parseFloat(getComputedStyle(link).lineHeight)
    return {
      textInClamp: rects[0].top - l.top,
      textInRow: rects[0].top - r.top,
      lineVsCircle: l.top + lh / 2 - (c.top + c.height / 2),
      lines: new Set(rects.map((x) => Math.round(x.top))).size,
      metaHeight: column.getBoundingClientRect().height - titleRow.getBoundingClientRect().height,
      rowHeight: r.height,
    }
  })
}

test.describe('Row title band · phone', () => {
  test.use({ viewport: { width: 402, height: 874 }, hasTouch: true, isMobile: true })

  test('a corner tab never moves the title: no band, centred on the circle', async ({
    authenticatedPage: page,
  }) => {
    const res = await page.request.post('/api/projects', { data: { name: uniqueTitle('RB') } })
    expect(res.ok()).toBeTruthy()
    project = (await res.json()).data as { id: number; name: string }

    const deadline = new Date(Date.now() + 10 * DAY).toISOString()
    const titleOnly = {
      dot: await create(page, { title: uniqueTitle('RB dot'), horizon: 'days' }),
      unset: await create(page, { title: uniqueTitle('RB unset') }),
      dotHigh: await create(page, { title: uniqueTitle('RB high'), horizon: 'weeks', priority: 3 }),
    }
    const withMeta = {
      plain: await create(page, {
        title: uniqueTitle('RB plain'),
        target_at: inThreeDaysAt10(),
        deadline_at: deadline,
      }),
      high: await create(page, {
        title: uniqueTitle('RB high'),
        priority: 3,
        target_at: inThreeDaysAt10(),
        deadline_at: deadline,
      }),
      // No picked target: the dot shows (the deadline's automatic target, or
      // none on the task queue's deadlines page).
      dot: await create(page, {
        title: uniqueTitle('RB dot'),
        horizon: 'days',
        deadline_at: deadline,
      }),
      unset: await create(page, { title: uniqueTitle('RB unset'), deadline_at: deadline }),
    }
    // A title long enough to clamp: the fix must keep the wrap around the
    // corner and the three-line clamp.
    const long = await create(page, {
      title: uniqueTitle(`RB long ${'wrapping words '.repeat(14)}`),
      horizon: 'days',
    })
    const ids = [...Object.values(titleOnly), ...Object.values(withMeta), long]
    // Out of the 15-minute "New" window: a "New" tag takes the spacer's
    // place, and the band came from the spacer.
    backdateCreated(ids, { keepHorizon: true })

    try {
      const group = await gotoGroup(page)
      const row = (id: number) => page.locator(`#task-row-${id}`)
      for (const id of ids) await expect(row(id)).toBeVisible()

      // The shapes are what they say.
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
      await expect(row(titleOnly.dot).locator('[data-horizon-dot]')).toHaveAttribute(
        'data-horizon-dot',
        'days',
      )
      await expect(row(titleOnly.unset).locator('[data-horizon-dot]')).toBeVisible()
      await expect(row(titleOnly.dotHigh).locator('[data-priority-tab]')).toBeVisible()
      await expect(row(withMeta.plain).locator('[data-row-corner]')).toHaveCount(0)
      await expect(row(withMeta.high).locator('[data-horizon-dot]')).toHaveCount(0)
      await expect(row(withMeta.high).locator('[data-priority-tab]')).toBeVisible()
      await expect(row(withMeta.dot).locator('[data-horizon-dot]')).toBeVisible()
      await expect(row(withMeta.unset).locator('[data-horizon-dot]')).toBeVisible()
      for (const id of Object.values(titleOnly)) {
        await expect(row(id).locator('[data-target-time]')).toHaveCount(0)
      }

      for (const size of SIZES) {
        await page.evaluate((root) => (document.documentElement.style.fontSize = root), size.root)
        const geo = async (id: number) => geometry(row(id))
        // First, and the checks below are soft, so a failing run still
        // leaves every size's pictures and every row's numbers.
        for (const theme of ['light', 'dark'] as const) {
          await page.emulateMedia({ colorScheme: theme })
          await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark)/)
          await group.screenshot({
            path: `${SHOTS}/${test.info().project.name}-${size.name}-${theme}.png`,
            animations: 'disabled',
          })
        }
        await page.emulateMedia({ colorScheme: 'light' })
        const ref = await geo(withMeta.plain)

        // No band: the title's first line starts at the top of its clamp box
        // in every row, as in the row with no corner at all.
        for (const id of ids) {
          const g = await geo(id)
          expect
            .soft(
              Math.abs(g.textInClamp - ref.textInClamp),
              `${size.name}: row ${id} ${JSON.stringify(g)}`,
            )
            .toBeLessThanOrEqual(SUBPIXEL)
        }

        // Title only, one line: the line is centred on the done circle.
        for (const [name, id] of Object.entries(titleOnly)) {
          const g = await geo(id)
          expect.soft(g.lines, `${size.name}: ${name} is one line`).toBe(1)
          expect.soft(g.metaHeight, `${size.name}: ${name} has no meta line`).toBe(0)
          expect
            .soft(Math.abs(g.lineVsCircle), `${size.name}: ${name} ${JSON.stringify(g)}`)
            .toBeLessThanOrEqual(SUBPIXEL)
        }

        // One meta line each: the title sits at the same height in the row
        // whichever tab — or none — the row has.
        for (const [name, id] of Object.entries(withMeta)) {
          const g = await geo(id)
          const shape = `${size.name}: ${name} ${JSON.stringify(g)} vs plain ${JSON.stringify(ref)}`
          expect.soft(g.lines, shape).toBe(1)
          expect.soft(Math.abs(g.metaHeight - ref.metaHeight), shape).toBeLessThanOrEqual(SUBPIXEL)
          expect.soft(Math.abs(g.textInRow - ref.textInRow), shape).toBeLessThanOrEqual(SUBPIXEL)
          expect.soft(Math.abs(g.rowHeight - ref.rowHeight), shape).toBeLessThanOrEqual(SUBPIXEL)
        }

        // The long title: clamped at three lines, its text clear of the
        // corner tabs, and no band above it either.
        const clamp = await row(long).evaluate((el) => {
          const link = el.querySelector('a[href^="/tasks/"]')!
          const corner = el.querySelector('[data-row-corner]')!.getBoundingClientRect()
          const l = link.getBoundingClientRect()
          // The text's own line boxes — not the float spacer's, which sits
          // under the corner on purpose.
          const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT)
          let text: Node | null = walker.nextNode()
          while (text && !text.textContent?.trim()) text = walker.nextNode()
          const range = document.createRange()
          range.selectNodeContents(text!)
          const visible = [...range.getClientRects()].filter(
            (r) => r.width > 0 && r.top < l.bottom && r.bottom > l.top,
          )
          return {
            // Lines shown whole (their text inside the clamp box's bottom).
            lines: new Set(
              visible.filter((r) => r.bottom <= l.bottom).map((r) => Math.round(r.top)),
            ).size,
            clamped: link.scrollHeight > link.clientHeight,
            underCorner: visible.some(
              (r) =>
                r.right > corner.left &&
                r.left < corner.right &&
                r.top < corner.bottom &&
                r.bottom > corner.top,
            ),
          }
        })
        expect.soft(clamp.clamped, `${size.name}: long ${JSON.stringify(clamp)}`).toBe(true)
        expect.soft(clamp.lines, `${size.name}: long ${JSON.stringify(clamp)}`).toBe(3)
        expect.soft(clamp.underCorner, `${size.name}: long ${JSON.stringify(clamp)}`).toBe(false)
        const longGeo = await geo(long)
        expect
          .soft(Math.abs(longGeo.textInClamp - ref.textInClamp), `${size.name}: long`)
          .toBeLessThanOrEqual(SUBPIXEL)
      }
    } finally {
      await page.request.post('/api/tasks/bulk/delete', { data: { ids } })
      await page.request.delete(`/api/projects/${project.id}`)
      project = null
    }
  })
})
