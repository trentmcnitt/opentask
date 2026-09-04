#!/usr/bin/env tsx
/**
 * §9 migration — EXECUTOR (dry-run by default)
 *
 * Applies the reviewed classification list from `scripts/classify-recurring.ts`
 * to the four §3 populations:
 *
 *   protocol       → no field changes (title cleanup only)
 *   prompted       → is_reminder = 1                                     (§6)
 *   parked-one-off → rrule = NULL, due_at = <produced value>, anchor NULL (§9.1)
 *   quota          → progress_target = N, progress_current = 0,
 *                    rrule rewritten to the period, anchor_time = NULL   (§5, §3)
 *
 * MUTATION LAYER — STATED PER §9.2:
 *   This script issues **raw SQL** against the tasks table. It follows the
 *   house precedent (`scripts/migrate-due.ts`) and deliberately BYPASSES the
 *   undo log, webhooks, and the activity log. Nothing here is undoable from
 *   inside the app: there is no `undo_log` row to redo, no `task.updated`
 *   webhook fires, and no activity entry is written.
 *
 *   Consequences you are accepting by running with --execute:
 *     • The backup file taken immediately before the transaction is the ONLY
 *       recovery path. There is no in-app undo for any of this.
 *     • The ONE human gate is the review list (§9.2) — the classification JSON
 *       a human read and adjusted. This script adds no judgement of its own;
 *       it only refuses inputs that would produce an untrustworthy state.
 *
 * §9.1 is the trap worth restating: clearing `rrule` alone does NOT refresh
 * `due_at`. It stays at its last stale sweep value — exactly the untrustworthy
 * state §4.6 warns about, made permanent. So every parked one-off MUST carry a
 * produced `proposed_due_at`, and this script REFUSES THE ENTIRE RUN if one
 * does not.
 *
 * §9.4 authorises the bracket-prefix strip ("[M] ", "[W] ", …) now that slot
 * chips render from `anchor_time`; it is applied to ALL populations.
 *
 * Usage:
 *   npx tsx scripts/migrate-v03.ts <db-path> <classifications.json> [--execute] [--force]
 *
 * Flags:
 *   --execute   Take a backup, then apply the plan in one transaction.
 *   --force     Proceed despite a probable-double-run warning (see below).
 */

import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { DateTime } from 'luxon'

type Population = 'protocol' | 'prompted' | 'parked-one-off' | 'quota'
type Period = 'day' | 'week' | 'month'

interface Classification {
  id: number
  population: Population
  confidence?: string
  reason?: string
  target: number | null
  period: Period | null
  proposed_due_at: string | null
}

interface TaskRow {
  id: number
  title: string
  due_at: string | null
  rrule: string | null
  anchor_time: string | null
  is_reminder: number
  progress_target: number
  progress_current: number
  done: number
  deleted_at: string | null
  archived_at: string | null
}

/** The field-level plan for one task. Empty `changes` = title cleanup only. */
interface PlannedChange {
  id: number
  population: Population
  confidence?: string
  oldTitle: string
  newTitle: string
  /** column → value, applied verbatim by the executor. */
  changes: Record<string, string | number | null>
  /** Human-readable annotations printed in the plan (target/period, due date). */
  notes: string[]
}

const POPULATIONS: Population[] = ['quota', 'prompted', 'parked-one-off', 'protocol']
const PERIOD_RRULE: Record<Period, string> = {
  day: 'FREQ=DAILY',
  week: 'FREQ=WEEKLY',
  month: 'FREQ=MONTHLY',
}

/**
 * §9.4 bracket prefixes. They encode time-of-day AND frequency inconsistently
 * ([W] vs [Weekly] vs [Weekend]) and can stack ("[M][W] Foo"), so this strips
 * repeatedly from the front until nothing matches.
 */
const PREFIX_RE = /^\s*\[(M|A|E|N|EM|LM|EE|W|Weekly|Weekend|Monthly|Tri-Monthly)\]\s*/i

/**
 * Quota annotation inside the title: "Eggs (2x/week)", "Beef For Kids 4x/week",
 * "Kids eat hard cereal (2x/week+)" — a trailing "+" ("at least") is swallowed
 * with the annotation so the close-paren does not survive as a stray "+)".
 * "(4 times this week, yet?)". Only stripped for the quota population — the
 * number moves into progress_target, so leaving it in the title would
 * double-state it.
 *
 * Global flag, learned the hard way: "Broccoli (3x/week) Avocado (2x/week)"
 * carries TWO annotations (really two quotas in one task), and a single-pass
 * strip left the second one stranded next to a target that contradicted it.
 * Multiple annotations also get a loud plan warning — which number wins is a
 * human call, not a regex's.
 */
const QUOTA_ANNOTATION_RE =
  /\s*\(?\s*(\d+)\s*(?:x|times?)\s*(?:\/\s*|\s+(?:per\s+|this\s+)?)?(day|daily|week|weekly|month|monthly)(\s*,?\s*yet\s*\??)?\s*\+?\s*\)?/gi

function quotaAnnotations(title: string): number[] {
  return [...title.matchAll(QUOTA_ANNOTATION_RE)].map((m) => parseInt(m[1], 10))
}

function stripPrefixes(title: string, tally: Map<string, number>): string {
  let out = title
  for (;;) {
    const m = PREFIX_RE.exec(out)
    if (!m) break
    const token = `[${m[1]}]`
    tally.set(token, (tally.get(token) ?? 0) + 1)
    out = out.slice(m[0].length)
  }
  return out.trim()
}

function stripQuotaAnnotation(title: string): string {
  return title
    .replace(QUOTA_ANNOTATION_RE, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\(\s*\)/g, '')
    .trim()
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function parseArgs(): { dbPath: string; jsonPath: string; execute: boolean; force: boolean } {
  const argv = process.argv.slice(2)
  const positional = argv.filter((a) => !a.startsWith('--'))
  const flags = argv.filter((a) => a.startsWith('--'))

  const unknown = flags.filter((f) => f !== '--execute' && f !== '--force')
  if (unknown.length > 0) {
    console.error(`Unknown flag(s): ${unknown.join(', ')}`)
    process.exit(1)
  }
  if (positional.length !== 2) {
    console.error('usage: migrate-v03.ts <db-path> <classifications.json> [--execute] [--force]')
    process.exit(1)
  }
  return {
    dbPath: positional[0],
    jsonPath: positional[1],
    execute: flags.includes('--execute'),
    force: flags.includes('--force'),
  }
}

// ---------------------------------------------------------------------------
// Input validation — every failure is collected, then the run is refused whole.
// ---------------------------------------------------------------------------

function loadClassifications(jsonPath: string, errors: string[]): Classification[] {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
  } catch (err) {
    console.error(`Could not read ${jsonPath}: ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }
  if (!Array.isArray(raw)) {
    console.error(`${jsonPath} must contain a JSON array of classifications.`)
    process.exit(1)
  }

  const seen = new Set<number>()
  const out: Classification[] = []
  for (const [i, entry] of raw.entries()) {
    const c = entry as Partial<Classification>
    if (typeof c.id !== 'number' || !Number.isInteger(c.id)) {
      errors.push(`entry ${i}: missing or non-integer "id"`)
      continue
    }
    if (!POPULATIONS.includes(c.population as Population)) {
      errors.push(`#${c.id}: unknown population ${JSON.stringify(c.population)}`)
      continue
    }
    if (seen.has(c.id)) {
      errors.push(`#${c.id}: appears more than once in the classification list`)
      continue
    }
    seen.add(c.id)
    out.push({
      id: c.id,
      population: c.population as Population,
      confidence: c.confidence,
      reason: c.reason,
      target: c.target ?? null,
      period: (c.period as Period | null) ?? null,
      proposed_due_at: c.proposed_due_at ?? null,
    })
  }
  return out
}

/** Refuse ids that don't exist, or that are done / deleted / archived. */
function fetchRows(db: Database.Database, list: Classification[], errors: string[]) {
  const stmt = db.prepare(`
    SELECT id, title, due_at, rrule, anchor_time, is_reminder,
           progress_target, progress_current, done, deleted_at, archived_at
      FROM tasks WHERE id = ?
  `)
  const rows = new Map<number, TaskRow>()
  const missing: number[] = []
  const inactive: string[] = []

  for (const c of list) {
    const row = stmt.get(c.id) as TaskRow | undefined
    if (!row) {
      missing.push(c.id)
      continue
    }
    const reasons: string[] = []
    if (row.done) reasons.push('done')
    if (row.deleted_at) reasons.push('deleted')
    if (row.archived_at) reasons.push('archived')
    if (reasons.length > 0) {
      inactive.push(`#${row.id} (${reasons.join(', ')}) "${row.title}"`)
      continue
    }
    rows.set(row.id, row)
  }

  if (missing.length > 0) {
    errors.push(`task id(s) not present in this database: ${missing.join(', ')}`)
  }
  for (const line of inactive) {
    errors.push(`task is done/deleted/archived and must not be migrated: ${line}`)
  }
  return rows
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function planQuota(c: Classification, row: TaskRow, plan: PlannedChange, errors: string[]) {
  if (typeof c.target !== 'number' || !Number.isInteger(c.target) || c.target < 2) {
    errors.push(
      `#${c.id}: quota requires an integer "target" >= 2 (got ${JSON.stringify(c.target)})`,
    )
    return
  }
  if (!c.period || !(c.period in PERIOD_RRULE)) {
    errors.push(
      `#${c.id}: quota requires "period" of day|week|month (got ${JSON.stringify(c.period)})`,
    )
    return
  }
  // §5: Track and the Reminders flag are mutually exclusive.
  if (row.is_reminder === 1) {
    errors.push(
      `#${c.id}: MUTUAL EXCLUSIVITY — classified quota but is_reminder is already 1 ` +
        `(§5/§6: an item is tracked or a reminder, never both)`,
    )
    return
  }
  // Surface title/classification disagreements for the human gate: a title
  // carrying several annotations is really several quotas in one task, and a
  // title whose N contradicts the classified target means one of them is wrong.
  const annotations = quotaAnnotations(plan.newTitle)
  if (annotations.length > 1) {
    plan.notes.push(
      `⚠ title carries ${annotations.length} quota annotations (${annotations.join(', ')}) — ` +
        `this may be multiple quotas in one task; classified target ${c.target} keeps only one`,
    )
  } else if (annotations.length === 1 && annotations[0] !== c.target) {
    plan.notes.push(
      `⚠ title says ${annotations[0]}x but classification says ${c.target} — verify before trusting either`,
    )
  }

  plan.newTitle = stripQuotaAnnotation(plan.newTitle)
  plan.changes.progress_target = c.target
  plan.changes.progress_current = 0
  plan.changes.is_reminder = 0
  plan.changes.rrule = PERIOD_RRULE[c.period]
  // §3: quotas are N-per-period targets with no time of day.
  plan.changes.anchor_time = null
  plan.notes.push(`target ${c.target}/${c.period} → rrule ${PERIOD_RRULE[c.period]}`)
}

function planPrompted(c: Classification, row: TaskRow, plan: PlannedChange, errors: string[]) {
  // §5/§6: progress_target > 1 and is_reminder are rejected together.
  if (row.progress_target > 1) {
    errors.push(
      `#${c.id}: MUTUAL EXCLUSIVITY — classified prompted (is_reminder = 1) but ` +
        `progress_target is ${row.progress_target} (§5/§6: tracked or reminder, never both)`,
    )
    return
  }
  plan.changes.is_reminder = 1
  // Assert, don't assume: pin the column so the row cannot drift to a tracked
  // state through this migration.
  plan.changes.progress_target = 1
  plan.notes.push('is_reminder = 1 (progress_target asserted at 1)')
}

function planParkedOneOff(c: Classification, plan: PlannedChange, errors: string[]) {
  if (!c.proposed_due_at) {
    errors.push(
      `#${c.id}: parked-one-off has NO proposed_due_at. §9.1: clearing rrule alone ` +
        `leaves due_at at its stale sweep value — the untrustworthy state §4.6 warns ` +
        `about, made permanent. Produce a real due date and re-run.`,
    )
    return
  }
  const dt = DateTime.fromISO(c.proposed_due_at, { zone: 'utc' })
  if (!dt.isValid) {
    errors.push(`#${c.id}: proposed_due_at is not a valid ISO timestamp: ${c.proposed_due_at}`)
    return
  }
  const dueAt = dt.toUTC().toISO()
  plan.changes.rrule = null
  plan.changes.due_at = dueAt
  plan.changes.anchor_time = null
  plan.notes.push(`due_at → ${dueAt}`)
}

function buildPlan(
  list: Classification[],
  rows: Map<number, TaskRow>,
  prefixTally: Map<string, number>,
  errors: string[],
): PlannedChange[] {
  const plans: PlannedChange[] = []
  for (const c of list) {
    const row = rows.get(c.id)
    if (!row) continue // already reported by fetchRows

    const plan: PlannedChange = {
      id: c.id,
      population: c.population,
      confidence: c.confidence,
      oldTitle: row.title,
      // §9.4: universal, all four populations.
      newTitle: stripPrefixes(row.title, prefixTally),
      changes: {},
      notes: [],
    }

    if (c.population === 'quota') planQuota(c, row, plan, errors)
    else if (c.population === 'prompted') planPrompted(c, row, plan, errors)
    else if (c.population === 'parked-one-off') planParkedOneOff(c, plan, errors)
    // protocol: no field changes beyond the title cleanup.

    if (plan.newTitle !== row.title) plan.changes.title = plan.newTitle
    if (plan.newTitle.length === 0) {
      errors.push(`#${c.id}: title cleanup would empty the title ("${row.title}")`)
    }
    plans.push(plan)
  }
  return plans
}

/**
 * Idempotency detection. A second run over the same list is not destructive by
 * itself, but it is almost always a mistake — and for quotas it silently resets
 * progress_current to 0, discarding real logged progress. So: warn loudly and
 * demand --force.
 */
function detectDoubleRun(list: Classification[], rows: Map<number, TaskRow>): string[] {
  const hits: string[] = []
  for (const c of list) {
    const row = rows.get(c.id)
    if (!row) continue
    if (c.population === 'prompted' && row.is_reminder === 1) {
      hits.push(`#${row.id} already has is_reminder = 1 — "${row.title}"`)
    }
    if (c.population === 'quota' && row.progress_target > 1) {
      hits.push(
        `#${row.id} already has progress_target = ${row.progress_target} ` +
          `(progress_current = ${row.progress_current}, WOULD BE RESET TO 0) — "${row.title}"`,
      )
    }
  }
  return hits
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

function printPlan(plans: PlannedChange[], prefixTally: Map<string, number>, execute: boolean) {
  const banner = execute ? 'EXECUTE' : 'DRY RUN — NOTHING WILL BE WRITTEN'
  console.log('='.repeat(78))
  console.log(`§9 MIGRATION EXECUTOR — ${banner}`)
  console.log('='.repeat(78))
  console.log(`\n${plans.length} tasks in the plan\n`)

  for (const pop of POPULATIONS) {
    const items = plans.filter((p) => p.population === pop)
    console.log(`\n${'-'.repeat(78)}`)
    console.log(`${pop.toUpperCase()} — ${items.length} tasks`)
    console.log('-'.repeat(78))
    if (items.length === 0) console.log('  (none)')
    for (const p of items) {
      const flag = p.confidence === 'low' ? '  ⚠ low confidence' : ''
      console.log(`  #${p.id}${flag}`)
      if (p.newTitle === p.oldTitle) {
        console.log(`      title  "${p.oldTitle}" (unchanged)`)
      } else {
        console.log(`      title  "${p.oldTitle}"`)
        console.log(`          →  "${p.newTitle}"`)
      }
      const fields = Object.entries(p.changes).filter(([k]) => k !== 'title')
      if (fields.length === 0) {
        console.log('      fields (none)')
      } else {
        for (const [k, v] of fields) {
          console.log(`      ${k} = ${v === null ? 'NULL' : JSON.stringify(v)}`)
        }
      }
      for (const note of p.notes) console.log(`      ↳ ${note}`)
    }
  }

  console.log(`\n${'='.repeat(78)}`)
  console.log('SUMMARY')
  console.log('='.repeat(78))
  for (const pop of POPULATIONS) {
    console.log(`  ${pop.padEnd(16)} ${plans.filter((p) => p.population === pop).length}`)
  }

  console.log('\n  Title prefixes stripped (§9.4):')
  if (prefixTally.size === 0) {
    console.log('    (none)')
  } else {
    for (const [token, count] of [...prefixTally.entries()].sort()) {
      console.log(`    ${token.padEnd(12)} ${count}`)
    }
  }
  const retitled = plans.filter((p) => p.newTitle !== p.oldTitle).length
  console.log(`    titles changed: ${retitled}`)
}

function refuse(errors: string[]): never {
  console.error(`\n${'='.repeat(78)}`)
  console.error(`RUN REFUSED — ${errors.length} problem(s). NOTHING WAS WRITTEN.`)
  console.error('='.repeat(78))
  for (const e of errors) console.error(`  ✗ ${e}`)
  console.error('\nFix the classification list (or the database) and re-run.\n')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

async function takeBackup(db: Database.Database, dbPath: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.join(path.dirname(path.resolve(dbPath)), `pre-migrate-v03-${stamp}.db`)
  await db.backup(dest)
  return dest
}

function applyPlan(db: Database.Database, plans: PlannedChange[]) {
  const apply = db.transaction((items: PlannedChange[]) => {
    for (const p of items) {
      const cols = Object.keys(p.changes)
      if (cols.length === 0) continue
      const set = cols.map((c) => `${c} = ?`).join(', ')
      const values = cols.map((c) => p.changes[c])
      db.prepare(`UPDATE tasks SET ${set}, updated_at = ? WHERE id = ?`).run(
        ...values,
        new Date().toISOString(),
        p.id,
      )
    }
  })
  apply(plans)
}

function verify(db: Database.Database, plans: PlannedChange[]) {
  const ids = plans.map((p) => p.id)
  const placeholders = ids.map(() => '?').join(',')
  const counts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN is_reminder = 1 THEN 1 ELSE 0 END)      AS reminders,
         SUM(CASE WHEN progress_target > 1 THEN 1 ELSE 0 END)  AS tracked,
         SUM(CASE WHEN rrule IS NULL THEN 1 ELSE 0 END)        AS cleared_rrules,
         SUM(CASE WHEN title LIKE '[%' THEN 1 ELSE 0 END)      AS remaining_prefixes
       FROM tasks WHERE id IN (${placeholders})`,
    )
    .get(...ids) as Record<string, number>

  const expected = {
    reminders: plans.filter((p) => p.changes.is_reminder === 1).length,
    tracked: plans.filter(
      (p) => typeof p.changes.progress_target === 'number' && p.changes.progress_target > 1,
    ).length,
    cleared_rrules: plans.filter((p) => p.population === 'parked-one-off').length,
  }

  console.log(`\n${'='.repeat(78)}`)
  console.log('VERIFICATION (read back from the same connection)')
  console.log('='.repeat(78))
  console.log(
    `  reminders (is_reminder = 1)     ${counts.reminders ?? 0}  (expected ${expected.reminders})`,
  )
  console.log(
    `  tracked   (progress_target > 1) ${counts.tracked ?? 0}  (expected ${expected.tracked})`,
  )
  console.log(
    `  cleared rrules (rrule IS NULL)  ${counts.cleared_rrules ?? 0}  (expected ${expected.cleared_rrules})`,
  )
  console.log(`  titles still starting with "["  ${counts.remaining_prefixes ?? 0}  (expected 0)`)

  const ok =
    (counts.reminders ?? 0) === expected.reminders &&
    (counts.tracked ?? 0) === expected.tracked &&
    (counts.cleared_rrules ?? 0) === expected.cleared_rrules
  console.log(
    ok ? '\n  ✓ counts match the plan' : '\n  ✗ COUNTS DO NOT MATCH THE PLAN — inspect the backup',
  )
}

// ---------------------------------------------------------------------------

async function main() {
  const { dbPath, jsonPath, execute, force } = parseArgs()
  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`)
    process.exit(1)
  }

  const errors: string[] = []
  const list = loadClassifications(jsonPath, errors)
  const db = new Database(dbPath)
  const rows = fetchRows(db, list, errors)
  const prefixTally = new Map<string, number>()
  const plans = buildPlan(list, rows, prefixTally, errors)

  if (errors.length > 0) refuse(errors)

  printPlan(plans, prefixTally, execute)

  const doubleRun = detectDoubleRun(list, rows)
  if (doubleRun.length > 0) {
    console.log(`\n${'!'.repeat(78)}`)
    console.log(
      `PROBABLE DOUBLE-RUN — ${doubleRun.length} task(s) already carry this migration's state`,
    )
    console.log('!'.repeat(78))
    for (const h of doubleRun) console.log(`  ! ${h}`)
    if (!force) {
      console.log(
        '\n  Re-running is not idempotent for quotas: progress_current is reset to 0,\n' +
          '  discarding logged progress. Pass --force only if you are certain.\n',
      )
      if (execute) {
        console.error('REFUSED: --force required. Nothing was written.\n')
        process.exit(1)
      }
    } else {
      console.log('\n  --force given: proceeding anyway.\n')
    }
  }

  if (!execute) {
    console.log(`
NOTHING HAS BEEN WRITTEN.

This is a dry run. Review the plan above — it is the §9.2 human gate.
Re-run with --execute to take a backup and apply it.

Mutation layer: raw SQL. Undo log, webhooks, and the activity log are all
bypassed. The backup file taken at --execute time is the only recovery path.
`)
    db.close()
    return
  }

  const backupPath = await takeBackup(db, dbPath)
  console.log(`\nBackup written: ${backupPath}`)
  console.log(
    '(raw SQL — no undo log, no webhooks, no activity log. This file is the only rollback.)',
  )

  applyPlan(db, plans)
  console.log(`\nApplied ${plans.length} task(s) in one transaction.`)

  verify(db, plans)
  db.close()
}

main().catch((err) => {
  console.error('Migration failed:', err)
  process.exit(1)
})
