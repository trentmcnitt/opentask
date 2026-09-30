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
