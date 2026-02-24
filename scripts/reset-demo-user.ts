/**
 * Demo user reset script
 *
 * Deletes all data for the demo user and re-seeds it.
 * Does NOT touch any other users. Safe for cron on production.
 *
 * Usage: npm run db:reset-demo
 *
 * Cron (server, 3 AM CT = 8:00 UTC):
 *   0 8 * * * cd /opt/opentask && OPENTASK_DB_PATH=/opt/opentask/data/tasks.db npx tsx scripts/reset-demo-user.ts >> /var/log/opentask-demo-reset.log 2>&1
 */

import { getDb, closeDb } from '../src/core/db'
import { seedDemoUser } from './seed-demo'

async function resetDemoUser(): Promise<void> {
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

  // Delete the user itself
  db.prepare('DELETE FROM users WHERE id = ?').run(userId)
  console.log('  Deleted demo user')

  // Re-seed
  console.log('\nRe-seeding demo user...')
  await seedDemoUser(db)

  // Print summary
  const newUser = db.prepare('SELECT id FROM users WHERE name = ? COLLATE NOCASE').get('demo') as {
    id: number
  }
  const taskCount = (
    db.prepare('SELECT COUNT(*) as c FROM tasks WHERE user_id = ?').get(newUser.id) as {
      c: number
    }
  ).c
  console.log(`\nDemo reset complete! User ID: ${newUser.id}, ${taskCount} tasks.`)

  closeDb()
}

resetDemoUser().catch((err) => {
  console.error('Demo reset failed:', err)
  process.exit(1)
})
