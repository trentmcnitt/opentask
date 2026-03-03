/**
 * Demo data reset script
 *
 * Deletes all data for a user and re-seeds it with demo tasks.
 * Does NOT touch any other users. Safe for cron on production.
 *
 * Usage:
 *   npm run db:reset-demo              # Resets the 'demo' user (default)
 *   npx tsx scripts/reset-demo-user.ts trent_m   # Resets 'trent_m' with demo data
 *   npx tsx scripts/reset-demo-user.ts trent_m --empty  # Wipes 'trent_m' to blank slate
 *
 * Cron: every 4 hours — see CLAUDE.local.md for the full cron line
 */

import { getDb, closeDb } from '../src/core/db'
import { seedDemoData } from './seed-demo'

function resetUser(username: string, empty: boolean): void {
  const db = getDb()

  const user = db.prepare('SELECT id FROM users WHERE name = ? COLLATE NOCASE').get(username) as
    | { id: number }
    | undefined

  if (!user) {
    console.error(`User "${username}" not found.`)
    closeDb()
    process.exit(1)
  }

  const userId = user.id
  console.log(`Resetting user "${username}" (ID: ${userId})...`)

  // Delete all user data (order matters for foreign keys)
  const tables = [
    { name: 'ai_insights_results', col: 'user_id' },
    { name: 'ai_insights_sessions', col: 'user_id' },
    { name: 'ai_activity_log', col: 'user_id' },
    { name: 'completions', col: 'user_id' },
    { name: 'activity_log', col: 'user_id' },
    { name: 'undo_log', col: 'user_id' },
    { name: 'push_subscriptions', col: 'user_id' },
    { name: 'apns_devices', col: 'user_id' },
    { name: 'user_daily_stats', col: 'user_id' },
    { name: 'tasks', col: 'user_id' },
    { name: 'api_tokens', col: 'user_id' },
    { name: 'projects', col: 'owner_id' },
  ]

  for (const { name, col } of tables) {
    const result = db.prepare(`DELETE FROM ${name} WHERE ${col} = ?`).run(userId)
    if (result.changes > 0) {
      console.log(`  Deleted ${result.changes} rows from ${name}`)
    }
  }

  // Preserve the user row so the ID stays stable across resets.
  // This keeps existing JWT sessions valid — no sign-out/sign-in needed.
  console.log(`  User row preserved (ID: ${userId})`)

  if (empty) {
    console.log(`\nUser "${username}" wiped to blank slate.`)
  } else {
    console.log('\nRe-seeding demo data...')
    seedDemoData(db, userId, username)

    const taskCount = (
      db.prepare('SELECT COUNT(*) as c FROM tasks WHERE user_id = ?').get(userId) as {
        c: number
      }
    ).c
    console.log(`\nReset complete! User "${username}" (ID: ${userId}), ${taskCount} tasks.`)
  }

  closeDb()
}

// Parse args: [username] [--empty]
const args = process.argv.slice(2)
const empty = args.includes('--empty')
const positional = args.filter((a) => !a.startsWith('--'))
const username = positional[0] || 'demo'

try {
  resetUser(username, empty)
} catch (err) {
  console.error('Reset failed:', err)
  process.exit(1)
}
