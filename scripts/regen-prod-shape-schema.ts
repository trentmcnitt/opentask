/**
 * Regenerate tests/fixtures/schema/prod-shape.sql — the schema of a
 * long-lived, production-shaped OpenTask database (2026-10-24).
 *
 *   npx tsx scripts/regen-prod-shape-schema.ts --to <ref> [--from <sha>]
 *
 * WHY: getDb() runs schema.sql and then runMigrations() against whatever
 * database it opens. A database that has lived through every release does
 * not look like a fresh one: its tables were created by the schema.sql of
 * their day, and every later column was appended by an ALTER TABLE (other
 * column order, old defaults, no CHECK where a fresh table has one). CI
 * builds every database fresh, so it cannot see a migration that only
 * breaks on such a database (prod, 10-24: a CREATE INDEX in schema.sql on a
 * column only runMigrations adds). The upgrade test (tests/upgrade/) opens
 * this fixture with the PR's code.
 *
 * HOW: REPLAY, never a real database. Starting from an empty file, the
 * script walks `main`'s first-parent history (each merge ≈ a release) from
 * `--from` to `--to`, and at every commit that touched src/core/db/ it
 * extracts that commit's `src/` (`git archive`) into a temp directory and
 * opens the database with THAT commit's getDb() — its schema.sql, then its
 * runMigrations(). The result is the shape a database gets by being upgraded
 * release by release. Then it dumps `sqlite_master` (tables, indexes,
 * triggers, views) — schema only. The database never holds a row: no data
 * exists to leak (this is a public repo), and the script fails if any table
 * has one.
 *
 * --from  default: 9f9baf11 (2026-02-13, "remove legacy migrations"), the
 *         oldest database today's code can upgrade: that commit deleted
 *         every migration before it, so an older database has no upgrade
 *         path at all. (Replaying from v0.1 stops at 422407e0, 02-08, on the
 *         same bug class as 10-24: schema.sql indexed tasks.ai_status before
 *         a migration added it.)
 * --to    required: the last release the fixture's database has run. The
 *         committed fixture used 'ba3d4bbe' (2026-10-24, the release before
 *         relative targets #342: what prod ran after that deploy's rollback).
 *         Leave it behind main: the upgrade test then exercises every
 *         migration since.
 *
 * SKIPPED commits (SKIP below) are releases that never ran on a real
 * database — rolled back. Every other step must succeed: a step that fails
 * is a migration that would fail an upgrade, and the script stops.
 *
 * About 30 s (69 steps, one tsx process each). Needs node_modules.
 * Deterministic: a rerun with the same --to writes the same file.
 */

import Database from 'better-sqlite3'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'tests', 'fixtures', 'schema', 'prod-shape.sql')
const DEFAULT_FROM = '9f9baf11' // 2026-02-13: removed every earlier migration (see --from above)

/**
 * Releases that never ran against a real database (rolled back), by short
 * sha. Not on the committed fixture's path (it stops before them); a later
 * `--to` replays past them without the step that breaks.
 */
const SKIP: Record<string, string> = {
  '80a5c95b':
    'relative targets #342: schema.sql indexed tasks.target_slot_id before runMigrations added it; rolled back on prod 10-24 (fixed by #343)',
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 }).trim()
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

/** First-parent commits of `to` from `from` (inclusive) that touched src/core/db/, oldest first. */
function steps(from: string, to: string): string[] {
  const fromSha = git(['rev-parse', '--short=8', from])
  const all = git([
    'log',
    '--first-parent',
    '--reverse',
    '--format=%h',
    '--abbrev=8',
    to,
    '--',
    'src/core/db/',
  ])
    .split('\n')
    .filter(Boolean)
  const start = all.indexOf(fromSha)
  if (start === -1) {
    throw new Error(`${from} is not a first-parent commit of ${to} that touched src/core/db/`)
  }
  return all.slice(start)
}

/** Open `dbPath` with commit `sha`'s getDb() (its schema.sql, then its runMigrations()). */
function runStep(sha: string, dbPath: string, work: string): void {
  const dir = path.join(work, 'src-tree')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const tar = path.join(work, 'src.tar')
  git(['archive', '-o', tar, sha, 'src'])
  execFileSync('tar', ['-xf', tar, '-C', dir])
  // A minimal tsconfig: only the `@/` alias, so every commit resolves the same way.
  fs.writeFileSync(
    path.join(dir, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
  )
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'))
  const code =
    "import('./src/core/db/index.ts').then((mod) => { const m = mod.getDb ? mod : mod.default; m.getDb(); m.closeDb(); process.exit(0) })"
  execFileSync(path.join(ROOT, 'node_modules', '.bin', 'tsx'), ['--eval', code], {
    cwd: dir,
    env: { ...process.env, OPENTASK_DB_PATH: dbPath, LOG_LEVEL: 'error', NODE_ENV: 'test' },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
}

/** The schema as SQL: tables, then indexes, then triggers and views, each in creation order. */
function dump(dbPath: string, header: string[]): string {
  const db = new Database(dbPath, { readonly: true })
  const rows = db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
        WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
        ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, rowid`,
    )
    .all() as { type: string; name: string; sql: string }[]
  for (const r of rows.filter((x) => x.type === 'table')) {
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM "${r.name}"`).get() as { n: number }).n
    if (n !== 0) throw new Error(`table ${r.name} has ${n} row(s): the fixture must be schema only`)
  }
  db.close()
  return [...header.map((l) => `-- ${l}`), '', ...rows.map((r) => `${r.sql};`), ''].join('\n')
}

function main(): void {
  const to = arg('to')
  if (!to) {
    console.error('usage: npx tsx scripts/regen-prod-shape-schema.ts --to <ref> [--from <sha>]')
    process.exit(2)
  }
  const from = arg('from') ?? DEFAULT_FROM
  const toSha = git(['rev-parse', '--short=8', to])
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'opentask-prod-shape-'))
  const dbPath = path.join(work, 'replay.db')
  const list = steps(from, toSha)
  const skipped: string[] = []
  console.log(`replaying ${list.length} release(s) ${list[0]}..${toSha} into ${dbPath}`)
  try {
    list.forEach((sha, i) => {
      if (SKIP[sha]) {
        skipped.push(sha)
        console.log(`  [${i + 1}/${list.length}] ${sha} SKIPPED: ${SKIP[sha]}`)
        return
      }
      const subject = git(['log', '-1', '--format=%ad %s', '--date=short', sha]).slice(0, 90)
      console.log(`  [${i + 1}/${list.length}] ${sha} ${subject}`)
      try {
        runStep(sha, dbPath, work)
      } catch (err) {
        throw new Error(`step ${sha} failed to open the replayed database: ${String(err)}`)
      }
    })
    const header = [
      'GENERATED by scripts/regen-prod-shape-schema.ts — do not edit by hand.',
      'Schema only (no rows): an empty database upgraded release by release, each',
      "with that commit's own getDb() (schema.sql, then runMigrations()), along main's",
      `first-parent history from ${list[0]} to ${toSha}${skipped.length ? ` (skipped, rolled back: ${skipped.join(', ')})` : ''}.`,
      `Regenerate: npx tsx scripts/regen-prod-shape-schema.ts --to ${toSha}`,
    ]
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    fs.writeFileSync(OUT, dump(dbPath, header))
    console.log(`wrote ${path.relative(ROOT, OUT)}`)
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

main()
