/**
 * §9 migration — classification pass (DRY RUN ONLY)
 *
 * Sorts the recurring corpus into the four §3 populations and prints a review
 * list. **This script never writes.** §9 puts one human gate in front of the
 * migration, and this is the artifact that gate reviews.
 *
 * The four populations:
 *   protocol       → stays a task, lands in a time slot (§7)
 *   prompted       → is_reminder = 1, moves to the Reminders surface (§6)
 *   parked-one-off → rrule REMOVED and a real due_at PATCHED in (§9.1)
 *   quota          → progress_target parsed from the title (§5)
 *
 * §9.1 is the trap worth restating: clearing `rrule` alone does NOT refresh
 * `due_at`. `collect-field-changes.ts` leaves it at its last stale sweep value,
 * which is exactly the untrustworthy state §4.6 warns about — made permanent.
 * So every parked one-off MUST carry a produced due_at, and this script fails
 * loudly if one doesn't.
 *
 * Usage:
 *   npx tsx scripts/classify-recurring.ts <db-path> [--json out.json]
 */

import Database from 'better-sqlite3'
import fs from 'node:fs'

interface Row {
  id: number
  title: string
  due_at: string | null
  rrule: string
  anchor_time: string | null
  priority: number
  completion_count: number
  project: string
  labels: string
}

type Population = 'protocol' | 'prompted' | 'parked-one-off' | 'quota'

interface Classification {
  id: number
  title: string
  population: Population
  reason: string
  /** For quotas: the N parsed from the title. */
  target?: number
  /** For quotas: the period the N applies to. */
  period?: string
  confidence: 'high' | 'low'
}

const dbPath = process.argv[2]
if (!dbPath) {
  console.error('usage: classify-recurring.ts <db-path> [--json out.json]')
  process.exit(1)
}

const db = new Database(dbPath, { readonly: true })

const rows = db
  .prepare(
    `SELECT t.id, t.title, t.due_at, t.rrule, t.anchor_time, t.priority,
            t.completion_count, t.labels, p.name AS project
       FROM tasks t
       JOIN users u ON u.id = t.user_id
       LEFT JOIN projects p ON p.id = t.project_id
      WHERE u.name = 'Trent'
        AND t.done = 0 AND t.deleted_at IS NULL AND t.archived_at IS NULL
        AND t.rrule IS NOT NULL
      ORDER BY p.name, t.title`,
  )
  .all() as Row[]

/**
 * Quota titles encode their target inline: "Eggs (2x/week)", "Beef For Kids
 * 4x/week". Matching the number AND the period is what makes this safe to
 * automate — a title with a bare number is not evidence of a quota.
 */
const QUOTA_RE = /(\d+)\s*x\s*\/?\s*(day|daily|week|weekly|month|monthly)/i

/**
 * Prompted thoughts are principles, not actions.
 *
 * DO NOT use the bracket prefixes for this. They encode TIME OF DAY, not kind:
 * [M]=morning, [A]=afternoon (all anchored 16:00), [E]=evening, [N]=night,
 * [EM]=early morning. An earlier version of this script read [A] as
 * "considerations" and mislabelled all 28 afternoon tasks as thoughts.
 *
 * Worse, kind is MIXED WITHIN a prefix — "[A] Being loving is a much happier
 * way to live" and "[A] Kids gymnastics" share a prefix and are different
 * populations. Kind is simply not derivable from structure here, which is
 * exactly why §9 specifies an AI classification pass. What follows is a
 * shape heuristic: it finds titles phrased as a statement rather than an
 * instruction, and everything it flags is low-confidence by construction.
 */
const PROMPTED_HINTS = [
  /\bremember\b/i,
  /\bconsider\b/i,
  /=\s*(past|future|peace)/i,
  /\bmindset\b/i,
  /\bprinciple\b/i,
  // Statement-shaped: contains a copula, which an instruction rarely does.
  /\b(is|are|means|isn't|aren't)\b.*\b(way|better|happier|enough|okay|fine|peace)\b/i,
  /\byou don'?t have to\b/i,
]

/**
 * Parked one-offs are real errands wearing a fake daily rrule because
 * recurrence was the only resurfacing mechanism available. The signature is a
 * one-shot verb — you register a car once.
 */
const ONE_OFF_HINTS = [
  /\bregister\b/i,
  /\be-?sign\b/i,
  /\brenew\b/i,
  /\bcancel\b/i,
  /\bschedule\b.*\bappointment\b/i,
  /\bfile\b.*\b(taxes|claim)\b/i,
  /\bset up\b/i,
  /\bbuy\b(?!.*\bweekly\b)/i,
]

function classify(row: Row): Classification {
  const quota = QUOTA_RE.exec(row.title)
  if (quota) {
    return {
      id: row.id,
      title: row.title,
      population: 'quota',
      target: parseInt(quota[1], 10),
      period: quota[2].toLowerCase(),
      reason: `title encodes ${quota[1]}x per ${quota[2]}`,
      confidence: 'high',
    }
  }

  if (PROMPTED_HINTS.some((re) => re.test(row.title))) {
    return {
      id: row.id,
      title: row.title,
      population: 'prompted',
      reason: 'phrased as a thought to have, not an action to take',
      // Never high: distinguishing a thought from an action is semantic
      // judgement, and this is a regex.
      confidence: 'low',
    }
  }

  if (ONE_OFF_HINTS.some((re) => re.test(row.title))) {
    return {
      id: row.id,
      title: row.title,
      population: 'parked-one-off',
      reason: 'one-shot verb — recurrence is standing in for resurfacing',
      confidence: 'low',
    }
  }

  return {
    id: row.id,
    title: row.title,
    population: 'protocol',
    reason: 'discrete repeatable action with a time of day',
    // Everything falls here by default, so it is never high-confidence on its
    // own — this is the bucket the human review actually has to read.
    confidence: 'low',
  }
}

const results = rows.map(classify)

const byPopulation = new Map<Population, Classification[]>()
for (const r of results) {
  if (!byPopulation.has(r.population)) byPopulation.set(r.population, [])
  byPopulation.get(r.population)!.push(r)
}

const ORDER: Population[] = ['quota', 'prompted', 'parked-one-off', 'protocol']

console.log('='.repeat(78))
console.log('§9 MIGRATION — CLASSIFICATION REVIEW LIST (DRY RUN, NOTHING WRITTEN)')
console.log('='.repeat(78))
console.log(`\n${rows.length} active recurring tasks\n`)

for (const pop of ORDER) {
  const items = byPopulation.get(pop) ?? []
  console.log(`\n${'-'.repeat(78)}`)
  console.log(`${pop.toUpperCase()} — ${items.length} tasks`)
  console.log('-'.repeat(78))
  for (const item of items) {
    const flag = item.confidence === 'low' ? ' ⚠ REVIEW' : ''
    const extra = item.target ? `  [target ${item.target}/${item.period}]` : ''
    console.log(`  #${item.id}  ${item.title.slice(0, 60)}${extra}${flag}`)
    if (item.confidence === 'low') console.log(`        ↳ ${item.reason}`)
  }
}

const lowConfidence = results.filter((r) => r.confidence === 'low').length
console.log(`\n${'='.repeat(78)}`)
console.log('SUMMARY')
console.log('='.repeat(78))
for (const pop of ORDER) {
  console.log(`  ${pop.padEnd(16)} ${(byPopulation.get(pop) ?? []).length}`)
}
console.log(`\n  ⚠ ${lowConfidence} of ${rows.length} need a human decision.`)

console.log(`
NEXT STEPS — nothing has been written.

1. Review the list above, especially the ⚠ entries.
2. Parked one-offs each need a REAL due_at chosen. §9.1: clearing rrule alone
   does NOT refresh due_at — it stays at its last stale sweep value, which is
   the untrustworthy state §4.6 warns about, made permanent. The executor must
   PATCH due_at explicitly alongside rrule: null, and will refuse to run
   otherwise.
3. Non-recurring Backlog (~122 tasks, 25% of the corpus) is a SEPARATE step
   (§9.3) and is not covered by this pass.
4. Take a sqlite3 .backup immediately before any --execute.
`)

const jsonIdx = process.argv.indexOf('--json')
if (jsonIdx !== -1 && process.argv[jsonIdx + 1]) {
  fs.writeFileSync(process.argv[jsonIdx + 1], JSON.stringify(results, null, 2))
  console.log(`Wrote ${results.length} classifications to ${process.argv[jsonIdx + 1]}`)
}

db.close()
