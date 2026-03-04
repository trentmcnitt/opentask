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
 *   npx tsx scripts/reset-demo-user.ts trent_m --ai-context "I'm Trent..."  # Set AI context after seed
 *
 * Cron: every 4 hours — see CLAUDE.local.md for the full cron line
 */

import { getDb, closeDb } from '../src/core/db'
import { seedDemoData } from './seed-demo'

function resetUser(username: string, empty: boolean, aiContext: string | null): void {
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
    { name: 'webhooks', col: 'user_id' },
    { name: 'tasks', col: 'user_id' },
    { name: 'projects', col: 'owner_id' },
  ]

  // Only delete API tokens for the demo user — other users need theirs preserved across resets
  if (username === 'demo') {
    tables.push({ name: 'api_tokens', col: 'user_id' })
  }

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

  // Set AI context on the user row if provided — useful for initial setup or restoring
  // after a full wipe. The column survives normal resets since the user row is preserved.
  if (aiContext !== null) {
    db.prepare('UPDATE users SET ai_context = ? WHERE id = ?').run(aiContext, userId)
    console.log(`  AI context set (${aiContext.length} chars)`)
  }

  closeDb()
}

// Parse args: [username] [--empty] [--ai-context "..."]
const args = process.argv.slice(2)
const empty = args.includes('--empty')
const aiContextIdx = args.indexOf('--ai-context')
if (aiContextIdx !== -1 && args[aiContextIdx + 1] === undefined) {
  console.error('--ai-context requires a value')
  process.exit(1)
}
const aiContext = aiContextIdx !== -1 ? args[aiContextIdx + 1] : null
const positional = args.filter(
  (a, i) => !a.startsWith('--') && (aiContextIdx === -1 || i !== aiContextIdx + 1),
)
const username = positional[0] || 'demo'

try {
  resetUser(username, empty, aiContext)
} catch (err) {
  console.error('Reset failed:', err)
  process.exit(1)
}
