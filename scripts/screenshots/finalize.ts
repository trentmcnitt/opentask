/**
 * Last step of the screenshot pipeline (docs/SCREENSHOTS.md): merge every
 * step's `manifest.parts/*.json` into `manifest.json` and a human-readable
 * `README.md`, with each image's real pixel size, and fail if a listed image
 * is missing.
 *
 *   npx tsx scripts/screenshots/finalize.ts <run dir>
 */
import fs from 'node:fs'
import path from 'node:path'
import { pngSize, type ShotEntry } from './manifest'

const out = path.resolve(process.argv[2] ?? '')
const partsDir = path.join(out, 'manifest.parts')
if (!fs.existsSync(partsDir)) throw new Error(`No manifest parts in ${out}`)

const entries: (ShotEntry & { width: number; height: number })[] = []
for (const part of fs.readdirSync(partsDir).sort()) {
  const list = JSON.parse(fs.readFileSync(path.join(partsDir, part), 'utf8')) as ShotEntry[]
  for (const e of list) {
    const file = path.join(out, e.file)
    if (!fs.existsSync(file)) throw new Error(`${part} lists ${e.file}, which is missing`)
    entries.push({ ...e, ...pngSize(file) })
  }
}

/**
 * `portfolio/`: exactly the files the portfolio site expects, under its own
 * names and at its exact sizes, so staging them is a plain copy. The widget
 * is an optional fourth (present only when the native step ran).
 */
const PORTFOLIO: { name: string; from: string; size: [number, number]; optional?: boolean }[] = [
  {
    name: 'web-dashboard-light-full.png',
    from: 'web/web-dashboard-light-full.png',
    size: [2080, 1566],
  },
  { name: 'web-dashboard-light.png', from: 'web/web-dashboard-light.png', size: [520, 391] },
  { name: 'ios-dashboard-light-full.png', from: 'web/ios-dashboard-light.png', size: [1206, 2622] },
  { name: 'ios-dashboard-light.png', from: 'web/ios-dashboard-light-400.png', size: [400, 869] },
  {
    name: 'ios-widget-tasks-light.png',
    from: 'native/widget-tasks-large-today-light.png',
    size: [1092, 1146],
    optional: true,
  },
]
const portfolioDir = path.join(out, 'portfolio')
fs.rmSync(portfolioDir, { recursive: true, force: true })
fs.mkdirSync(portfolioDir)
for (const p of PORTFOLIO) {
  const src = path.join(out, p.from)
  if (!fs.existsSync(src)) {
    if (p.optional) continue
    throw new Error(`portfolio: ${p.from} is missing`)
  }
  const { width, height } = pngSize(src)
  if (width !== p.size[0] || height !== p.size[1]) {
    throw new Error(`portfolio: ${p.from} is ${width}x${height}, expected ${p.size.join('x')}`)
  }
  const dest = path.join(portfolioDir, p.name)
  fs.copyFileSync(src, dest)
  entries.push({
    file: path.relative(out, dest),
    shows: `Portfolio copy of ${p.from}`,
    theme: 'light',
    destinations: [`portfolio:${p.name}`],
    width,
    height,
  })
}

entries.sort((a, b) => a.file.localeCompare(b.file))

const now = process.env.OPENTASK_SCREENSHOT_NOW ?? ''
fs.writeFileSync(
  path.join(out, 'manifest.json'),
  JSON.stringify(
    { frozenNow: now, generatedAt: new Date().toISOString(), images: entries },
    null,
    2,
  ) + '\n',
)

const rows = entries.map(
  (e) =>
    `| \`${e.file}\` | ${e.width}×${e.height} | ${e.theme} | ${e.shows} | ${e.destinations.map((d) => `\`${d}\``).join('<br>') || '—'} |`,
)
fs.writeFileSync(
  path.join(out, 'README.md'),
  [
    '# OpenTask screenshots',
    '',
    `Frozen clock: ${now}. Sample account, invented data. How to regenerate and where each`,
    'image goes: `docs/SCREENSHOTS.md` in the opentask repo.',
    '',
    '`docs:` destinations are paths in the opentask-docs repo; `portfolio:` are the portfolio',
    "site's image names.",
    '',
    '| File | Pixels | Theme | Shows | Destination |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n'),
)
console.log(`finalize: ${entries.length} images → ${path.join(out, 'manifest.json')}`)
