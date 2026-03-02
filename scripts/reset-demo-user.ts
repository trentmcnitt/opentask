/**
 * Demo user reset script
 *
 * Deletes all data for the demo user and re-seeds it.
 * Does NOT touch any other users. Safe for cron on production.
 *
 * Usage: npm run db:reset-demo
 *
 * Cron: every 4 hours — see CLAUDE.local.md for the full cron line
 */

import { getDb, closeDb } from '../src/core/db'
import { seedDemoData } from './seed-demo'

function resetDemoUser(): void {
  const db = getDb()

  // Look up demo user
  const user = db.prepare('SELECT id FROM users WHERE name = ? COLLATE NOCASE').get('demo') as
    | { id: number }
    | undefined

  if (!user) {
    console.error('Demo user not found. Run db:seed-demo first.')
    closeDb()
    process.exit(1)
  }

  const userId = user.id
  console.log(`Resetting demo user (ID: ${userId})...`)

  // Delete all demo user data (order matters for foreign keys)
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
  // seedDemoUser() would create a new user with a new auto-increment ID,
  // so instead we re-seed only projects, tokens, and tasks.
  console.log(`  User row preserved (ID: ${userId})`)

  // Re-seed projects, token, and tasks (but not the user row)
  console.log('\nRe-seeding demo data...')
  seedDemoData(db, userId)

  // Print summary
  const taskCount = (
    db.prepare('SELECT COUNT(*) as c FROM tasks WHERE user_id = ?').get(userId) as {
      c: number
    }
  ).c
  console.log(`\nDemo reset complete! User ID: ${userId}, ${taskCount} tasks.`)

  closeDb()
}

try {
  resetDemoUser()
} catch (err) {
  console.error('Demo reset failed:', err)
  process.exit(1)
}
