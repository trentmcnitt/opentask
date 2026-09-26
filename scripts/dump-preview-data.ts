/**
 * Dump a real account's API responses into ios/Previews.local/ (gitignored),
 * so the iOS/watchOS `#Preview`s can render against real data LOCALLY.
 *
 *   OPENTASK_URL=https://your-server OPENTASK_TOKEN=<api token> \
 *     npx tsx scripts/dump-preview-data.ts [--out ios/Previews.local]
 *
 * The committed previews use realistic sample data (this repo is public);
 * `ios/Shared/PreviewLocalData.swift` reads these files first when they
 * exist. See ios/CLAUDE.md § "Previews: sample data and local data".
 *
 * This script holds no data of its own. It writes each response in the API's
 * own `{ "data": ... }` shape, which is what the Swift DTOs decode, with one
 * change: every non-blank `notes` becomes a placeholder, because the previews
 * only need to know that notes exist (the notes glyph), never what they say.
 * Only the `label_config` field of /api/user/preferences is kept.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const NOTES_PLACEHOLDER = '(notes)'

function usage(message: string): never {
  console.error(message)
  console.error(
    'Usage: OPENTASK_URL=https://your-server OPENTASK_TOKEN=<api token> npx tsx scripts/dump-preview-data.ts [--out <dir>]',
  )
  process.exit(1)
}

const baseUrl = process.env.OPENTASK_URL?.replace(/\/+$/, '')
const token = process.env.OPENTASK_TOKEN
if (!baseUrl) usage('OPENTASK_URL is not set.')
if (!token) usage('OPENTASK_TOKEN is not set.')

const outFlag = process.argv.indexOf('--out')
const outDir = resolve(
  outFlag > -1 && process.argv[outFlag + 1] ? process.argv[outFlag + 1] : 'ios/Previews.local',
)

/** Replace every non-blank `notes` string, at any depth, with a placeholder. */
function stripNotes(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNotes)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, v] of Object.entries(value)) {
      if (key === 'notes' && typeof v === 'string') {
        out[key] = v.trim() ? NOTES_PLACEHOLDER : v
      } else {
        out[key] = stripNotes(v)
      }
    }
    return out
  }
  return value
}

async function get(path: string): Promise<{ data: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`)
  return (await res.json()) as { data: unknown }
}

async function main() {
  const [reminders, tasks, projects, timeSlots, preferences] = await Promise.all([
    get('/api/reminders'),
    get('/api/tasks?done=false&limit=300'),
    get('/api/projects'),
    get('/api/time-slots'),
    get('/api/user/preferences'),
  ])
  const labelConfig = (preferences.data as { label_config?: unknown }).label_config ?? []

  const files: Record<string, unknown> = {
    'reminders.json': stripNotes(reminders),
    'tasks.json': stripNotes(tasks),
    'projects.json': projects,
    'time-slots.json': timeSlots,
    'label-config.json': { data: { label_config: labelConfig } },
  }

  mkdirSync(outDir, { recursive: true })
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(outDir, name), JSON.stringify(body, null, 2) + '\n')
  }
  console.log(`Wrote ${Object.keys(files).length} files to ${outDir}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
