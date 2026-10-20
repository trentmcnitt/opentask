/**
 * CLEAR DECKS — On deck's rollback tool (2026-10-20; the logic is
 * `src/core/tasks/clear-decks.ts`).
 *
 *   npx tsx scripts/clear-decks.ts <database> --user <id> [--apply]
 *
 * Lists every open task of the user that is on deck (and its day), and every
 * one the rollover sent to the queue FROM a deck (`queued_from_deck_day`)
 * that is still queued. DRY RUN by default: nothing is written without
 * `--apply`, which takes the first off deck and the second out of the queue
 * (`queued_at` and `try_tomorrow` cleared) — back to their horizon segments;
 * no target to restore, since a deck never carries a picked one.
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

const USAGE = 'Usage: npx tsx scripts/clear-decks.ts <database> --user <id> [--apply]'

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
  const { findDecks, clearDecks } = await import('../src/core/tasks/clear-decks')
  const found = args.apply ? clearDecks(args.user) : findDecks(args.user)
  for (const t of found) {
    console.log(
      t.on_deck_day
        ? `#${t.id}  on deck ${t.on_deck_day}`
        : `#${t.id}  queued ${t.queued_at} from the deck of ${t.queued_from_deck_day}`,
    )
  }
  console.log(
    args.apply
      ? `Cleared ${found.length} deck row(s) for user ${args.user}.`
      : `Dry run: ${found.length} deck row(s) would be cleared for user ${args.user}. Pass --apply to write.`,
  )
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
