/**
 * Apple Watch notification shot (docs/SCREENSHOTS.md): composite a watch
 * SCREEN capture into the watch bezel, cropped to the 495 x 558 the docs use
 * (`opentask-docs/public/images/watch/apple-watch-notification.png`).
 *
 *   npx tsx scripts/screenshots/capture-watch.ts <run dir>
 *
 * Inputs:
 *   SCREENSHOTS_WATCH_SCREEN  the watch screen capture (PNG, any 4:5-ish size);
 *                             default <run dir>/watch-screen.png
 *   SCREENSHOTS_WATCH_FRAME   the bezel (540 x 860, transparent screen);
 *                             default ~/working_dir/opentask-docs/source-assets/apple-watch-frame.png
 *
 * THE SCREEN CAPTURE IS NOT AUTOMATED — see docs/SCREENSHOTS.md § Apple Watch.
 * In the watchOS simulator a pushed notification (`simctl push`) never shows
 * its long look with action buttons (the app's notification permission can't
 * be granted from the command line: `simctl privacy … notifications` is
 * "Operation not permitted"), and `simctl status_bar` doesn't support
 * watchOS, so the clock can't be pinned. Without a screen capture this step
 * prints a note and adds nothing to the manifest; the compositing itself is
 * automatic.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { webkit } from '@playwright/test'
import { writeManifestPart } from './manifest'

/** Where the frame's transparent screen sits (flood-filled from its centre). */
const HOLE = { x: 72, y: 188, width: 396, height: 484, radius: 58 }
/** The crop of the 540 x 860 frame the docs image uses: the case, no band. */
const CROP = { x: 33, y: 150, width: 495, height: 558 }

async function main(): Promise<void> {
  const runDir = path.resolve(process.argv[2] ?? '')
  const screen = process.env.SCREENSHOTS_WATCH_SCREEN ?? path.join(runDir, 'watch-screen.png')
  const frame =
    process.env.SCREENSHOTS_WATCH_FRAME ??
    path.join(os.homedir(), 'working_dir/opentask-docs/source-assets/apple-watch-frame.png')

  if (!fs.existsSync(screen)) {
    console.log(
      `watch: no screen capture at ${screen} — skipped (not automatable; see docs/SCREENSHOTS.md § Apple Watch)`,
    )
    writeManifestPart(runDir, 'watch', [])
    return
  }
  if (!fs.existsSync(frame)) throw new Error(`watch: bezel not found at ${frame}`)

  const dataUrl = (file: string) =>
    `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`
  const html = `<!doctype html><html><body style="margin:0;background:transparent">
    <div style="position:relative;width:${CROP.width}px;height:${CROP.height}px;overflow:hidden">
      <img src="${dataUrl(screen)}" style="position:absolute;left:${HOLE.x - CROP.x}px;top:${HOLE.y - CROP.y}px;width:${HOLE.width}px;height:${HOLE.height}px;object-fit:cover;border-radius:${HOLE.radius}px">
      <img src="${dataUrl(frame)}" style="position:absolute;left:${-CROP.x}px;top:${-CROP.y}px">
    </div></body></html>`

  const browser = await webkit.launch()
  try {
    const page = await browser.newPage({ viewport: { width: CROP.width, height: CROP.height } })
    await page.setContent(html)
    await page.evaluate(() =>
      Promise.all(Array.from(document.images, (img) => img.decode())).then(() => undefined),
    )
    const out = path.join(runDir, 'native', 'apple-watch-notification.png')
    fs.mkdirSync(path.dirname(out), { recursive: true })
    await page.screenshot({ path: out, omitBackground: true })
    writeManifestPart(runDir, 'watch', [
      {
        file: path.relative(runDir, out),
        shows: 'Apple Watch notification in the bezel (screen capture supplied by hand)',
        theme: 'n/a',
        destinations: ['docs:public/images/watch/apple-watch-notification.png'],
      },
    ])
    console.log(`watch: composited → ${out}`)
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error('Watch composite failed:', err)
  process.exit(1)
})
