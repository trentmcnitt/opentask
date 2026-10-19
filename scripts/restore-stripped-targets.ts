/**
 * RESTORE STRIPPED TARGETS — the task queue's rollback tool (task-queue PR 2;
 * the logic is `src/core/tasks/restore-stripped.ts`).
 *
 *   npx tsx scripts/restore-stripped-targets.ts <database> --user <id> [--apply]
 *
 * Lists every one-off the rollover stripped that is still in the queue with no
 * target, and the target it would get back (`queued_from_due_at`). DRY RUN by
 * default: nothing is written without `--apply`.
 *
 * Opens <database> directly (with --apply it WRITES to it). Stop the server
 * first, take a `.backup`, and never run it on production without Trent. Ids
 * and dates only — no titles.
 */
import fs from 'fs'

interface Args {
  db: string
  user: number
  apply: boolean
}

const USAGE = 'Usage: npx tsx scripts/restore-stripped-targets.ts <database> --user <id> [--apply]'

function parseArgs(argv: string[]): Args {
  const args: Args = { db: '', user: NaN, apply: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--user') args.user = Number(argv[++i])
    else if (a === '--apply') args.apply = true
    else if (!a.startsWith('--') && !args.db) args.db = a
    else throw new Error(`Unknown argument: ${a}\n${USAGE}`)
  }
  if (!args.db || !Number.isInteger(args.user)) throw new Error(USAGE)
  if (!fs.existsSync(args.db)) throw new Error(`No database at ${args.db}`)
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  // Point the app's database at the file BEFORE any core module loads.
  process.env.OPENTASK_DB_PATH = args.db
  process.env.OPENTASK_AI_ENABLED = 'false'
  const { findStrippedTargets, restoreStrippedTargets } =
    await import('../src/core/tasks/restore-stripped')
  const found = args.apply ? restoreStrippedTargets(args.user) : findStrippedTargets(args.user)
  for (const t of found) {
    console.log(`#${t.id}  queued ${t.queued_at}  →  target ${t.queued_from_due_at}`)
  }
  console.log(
    args.apply
      ? `Restored ${found.length} target(s) for user ${args.user}.`
      : `Dry run: ${found.length} target(s) would be restored for user ${args.user}. Pass --apply to write.`,
  )
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
