// The notification avatars (Trent, 2026-11-07, round 4 of the mockups): one
// per push kind, a white lucide glyph — the app's own icons — on a solid
// tile. Written as full-bleed squares; iOS masks a communication
// notification's sender image to a circle. 180×180 (60pt at 3x).
//
//   node ios/scripts/render-notification-avatars.mjs
//
// Writes ios/OpenTaskNotificationService/Avatars/<kind>.png. Re-run after a
// colour or glyph change; the PNGs are committed (the extension bundles them).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = path.join(ROOT, 'ios/OpenTaskNotificationService/Avatars')
const PX = 180

const NODE = {}
for (const n of ['gauge', 'lightbulb', 'calendar-clock', 'flag']) {
  const mod = await import(path.join(ROOT, `node_modules/lucide-react/dist/esm/icons/${n}.js`))
  NODE[n] = mod.__iconNode
    .map(
      ([t, a]) =>
        `<${t} ${Object.entries(a)
          .filter(([k]) => k !== 'key')
          .map(([k, v]) => `${k}="${v}"`)
          .join(' ')}/>`,
    )
    .join('')
}

// The tiles (round 4, section 1): quota indigo-600, reminder and period the
// reminders' violet (--badge-reminders), task amber-600, deadlines teal
// (--deadlines-fill).
const VIOLET = '#7e4ed7'
const TILE = {
  quota: '#4f46e5',
  reminder: VIOLET,
  period: VIOLET,
  task: '#e17100',
  deadline: '#0d9488',
}

/** One glyph centred on its tile: 21/40 of the tile, stroke 2 (the mockups' avatar). */
function single(n) {
  const k = 21 / 40
  const off = ((1 - k) / 2) * 40
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PX}" height="${PX}" viewBox="0 0 40 40">
    <svg x="${off}" y="${off}" width="${40 * k}" height="${40 * k}" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${NODE[n]}</svg></svg>`
}

/**
 * P8, the ORIGINAL (Trent: not the "moved" variant) — three Lightbulbs on a
 * tight diagonal, fading toward the back; each front bulb cuts a thin halo in
 * the tile colour out of the one behind (.tmp/today-next/notif-icons-3.mjs).
 */
function p8(tile) {
  const spec = [
    { x: 14, y: 15.5, s: 15, op: 0.35 },
    { x: 19.5, y: 19.5, s: 15, op: 0.65 },
    { x: 25, y: 23.5, s: 15 },
  ]
  const g = spec
    .map((b, i) => {
      const k = b.s / 24
      const sw = 1.75 / k
      const tf = `translate(${b.x - b.s / 2} ${b.y - b.s / 2}) scale(${k})`
      const halo =
        i > 0
          ? `<g fill="${tile}" stroke="${tile}" stroke-width="${sw + 2.6 / k}"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5Z"/><rect x="9" y="14" width="6" height="8"/></g>`
          : ''
      return `<g transform="${tf}" fill="none" stroke-linecap="round" stroke-linejoin="round">${halo}<g stroke="#fff" stroke-opacity="${b.op ?? 1}" stroke-width="${sw}">${NODE.lightbulb}</g></g>`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PX}" height="${PX}" viewBox="0 0 40 40">${g}</svg>`
}

const GLYPH = {
  quota: single('gauge'),
  reminder: single('lightbulb'),
  period: p8(TILE.period),
  task: single('calendar-clock'),
  deadline: single('flag'),
}

fs.mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: PX, height: PX }, deviceScaleFactor: 1 })
for (const [kind, svg] of Object.entries(GLYPH)) {
  await page.setContent(
    `<html><body style="margin:0"><div style="width:${PX}px;height:${PX}px;background:${TILE[kind]}">${svg}</div></body></html>`,
  )
  await page.locator('div').screenshot({ path: path.join(OUT, `${kind}.png`) })
}
await browser.close()
console.log(`wrote ${Object.keys(GLYPH).length} avatars to ${path.relative(ROOT, OUT)}`)
