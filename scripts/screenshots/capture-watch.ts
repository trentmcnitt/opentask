/**
 * Apple Watch shots (docs/SCREENSHOTS.md): composite each watch app screen
 * that capture-watch-app.sh saved (`<run dir>/native/watch-<page>.png`) into
 * the watch bezel, as the whole frame (540 x 860, with the band stubs) and
 * cropped to the case (495 x 558, the size the docs and portfolio use).
 *
 *   npx tsx scripts/screenshots/capture-watch.ts <run dir>
 *
 * SCREENSHOTS_WATCH_FRAME overrides the bezel (540 x 860, transparent
 * screen); default scripts/screenshots/assets/apple-watch-frame.png.
 */
import fs from 'node:fs'
import path from 'node:path'
import { webkit, type Page } from '@playwright/test'
import { writeManifestPart, type ShotEntry } from './manifest'

/** Where the frame's transparent screen sits (flood-filled from its centre). */
const HOLE = { x: 72, y: 188, width: 396, height: 484, radius: 58 }
/** The frame's full size, and the crop the docs image uses: the case, no band. */
const FRAME = { width: 540, height: 860 }
const CROP = { x: 33, y: 150, width: 495, height: 558 }

const PAGES = [
  { page: 'reminders', shows: "Reminders page: the current period's reminders and quota prompts" },
  { page: 'tasks', shows: 'Tasks page: the overdue banner and Up next' },
  { page: 'quotas', shows: 'Quotas page: open quotas grouped by period' },
] as const

/** The page the portfolio and the docs overview use. */
const HERO = 'reminders'

const dataUrl = (file: string) =>
  `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`

/**
 * Draw `screen` into the bezel's hole (scaled to cover it, corners rounded
 * like the display) with the frame on top, then shoot the `area` of the
 * frame. `object-fit: cover` crops a few pixels off the sides: the 46mm
 * screen (416 x 496) is a touch wider than the hole.
 */
async function composite(
  page: Page,
  screen: string,
  frame: string,
  area: { x: number; y: number; width: number; height: number },
  out: string,
): Promise<void> {
  await page.setViewportSize({ width: area.width, height: area.height })
  await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">
    <div style="position:relative;width:${area.width}px;height:${area.height}px;overflow:hidden">
      <img src="${dataUrl(screen)}" style="position:absolute;left:${HOLE.x - area.x}px;top:${HOLE.y - area.y}px;width:${HOLE.width}px;height:${HOLE.height}px;object-fit:cover;border-radius:${HOLE.radius}px">
      <img src="${dataUrl(frame)}" style="position:absolute;left:${-area.x}px;top:${-area.y}px">
    </div></body></html>`)
  await page.evaluate(() =>
    Promise.all(Array.from(document.images, (img) => img.decode())).then(() => undefined),
  )
  await page.screenshot({ path: out, omitBackground: true })
}

async function main(): Promise<void> {
  const runDir = path.resolve(process.argv[2] ?? '')
  const native = path.join(runDir, 'native')
  const frame =
    process.env.SCREENSHOTS_WATCH_FRAME ?? path.join(__dirname, 'assets', 'apple-watch-frame.png')
  if (!fs.existsSync(frame)) throw new Error(`watch: bezel not found at ${frame}`)

  const captured = PAGES.filter(({ page }) => fs.existsSync(path.join(native, `watch-${page}.png`)))
  if (captured.length === 0) {
    console.log('watch: no screens captured — nothing to composite')
    writeManifestPart(runDir, 'watch', [])
    return
  }

  const entries: ShotEntry[] = []
  const browser = await webkit.launch()
  try {
    const page = await browser.newPage()
    for (const { page: name, shows } of captured) {
      const screen = path.join(native, `watch-${name}.png`)
      const framedFull = path.join(native, `apple-watch-${name}-full.png`)
      const framed = path.join(native, `apple-watch-${name}.png`)
      await composite(page, screen, frame, { x: 0, y: 0, ...FRAME }, framedFull)
      await composite(page, screen, frame, CROP, framed)
      const hero = name === HERO
      entries.push(
        {
          file: path.relative(runDir, screen),
          shows: `Apple Watch ${shows} — the raw simulator screen`,
          theme: 'dark',
          destinations: [],
        },
        {
          file: path.relative(runDir, framedFull),
          shows: `Apple Watch ${shows}, in the bezel (whole frame, band stubs included)`,
          theme: 'dark',
          destinations: [],
        },
        {
          file: path.relative(runDir, framed),
          shows: `Apple Watch ${shows}, in the bezel (cropped to the case)`,
          theme: 'dark',
          destinations: [
            `docs:public/images/watch/apple-watch-${name}.png`,
            ...(hero ? ['portfolio:apple-watch-app.png'] : []),
          ],
        },
      )
    }
  } finally {
    await browser.close()
  }
  writeManifestPart(runDir, 'watch', entries)
  console.log(`watch: composited ${captured.map((c) => c.page).join(', ')} → ${native}`)
}

main().catch((err) => {
  console.error('Watch composite failed:', err)
  process.exit(1)
})
