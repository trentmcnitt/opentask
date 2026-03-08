/**
 * User creation script
 *
 * Creates a new user with default projects.
 * Safe to run multiple times — skips if the username already exists.
 *
 * Usage: tsx scripts/create-user.ts <username> <password> [email] [timezone]
 *
 * Examples:
 *   tsx scripts/create-user.ts admin changeme
 *   tsx scripts/create-user.ts admin changeme admin@example.com America/New_York
 */

import bcrypt from 'bcrypt'
import { getDb, closeDb } from '../src/core/db'

const SALT_ROUNDS = 10

const DEFAULT_PROJECTS = [
  { name: 'Inbox', color: 'blue', sort_order: 0 },
  { name: 'Personal', color: 'green', sort_order: 1 },
  { name: 'Work', color: 'purple', sort_order: 2 },
  { name: 'Errands', color: 'orange', sort_order: 3 },
]

const username = process.argv[2]
const password = process.argv[3]
const email = process.argv[4] || `${(username || 'user').toLowerCase()}@localhost`
const timezone =
  process.argv[5] || process.env.OPENTASK_DEFAULT_TIMEZONE || process.env.OPENTASK_INIT_TIMEZONE

if (!username || !password) {
  console.error('Usage: tsx scripts/create-user.ts <username> <password> [email] <timezone>')
  console.error('')
  console.error('Examples:')
  console.error('  tsx scripts/create-user.ts admin changeme admin@example.com America/New_York')
  console.error('')
  console.error('Timezone can also be set via OPENTASK_DEFAULT_TIMEZONE env var.')
  process.exit(1)
}

if (!timezone) {
  console.error('Error: timezone is required.')
  console.error('Provide as 5th argument or set OPENTASK_DEFAULT_TIMEZONE env var.')
  console.error(
    'Example: tsx scripts/create-user.ts admin changeme admin@example.com America/New_York',
  )
  console.error('Full list: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones')
  process.exit(1)
}

async function createUser() {
  const db = getDb()

  // Check if user already exists
  const existing = db
    .prepare('SELECT id, name FROM users WHERE name = ? COLLATE NOCASE')
    .get(username) as { id: number; name: string } | undefined

  if (existing) {
    console.log(`User "${existing.name}" already exists (ID: ${existing.id}). Skipping.`)
    closeDb()
    return
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS)

  const result = db
    .prepare('INSERT INTO users (email, name, password_hash, timezone) VALUES (?, ?, ?, ?)')
    .run(email, username, passwordHash, timezone)

  const userId = result.lastInsertRowid as number
  console.log(`Created user "${username}" (ID: ${userId})`)

  // Create default projects
  const insertProject = db.prepare(
    'INSERT INTO projects (name, owner_id, shared, sort_order, color) VALUES (?, ?, 0, ?, ?)',
  )

  for (const project of DEFAULT_PROJECTS) {
    insertProject.run(project.name, userId, project.sort_order, project.color)
    console.log(`  Project: ${project.name}`)
  }

  closeDb()
  console.log(`\nDone! Login with username "${username}" at your OpenTask URL.`)
}

createUser().catch((err) => {
  console.error('Failed to create user:', err)
  process.exit(1)
})
