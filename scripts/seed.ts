/**
 * Seed script for OpenTask database
 *
 * Creates initial users, projects, and API tokens.
 * Safe to run multiple times - uses INSERT OR IGNORE.
 *
 * Usage: npm run db:seed
 */

import bcrypt from 'bcrypt'
import crypto from 'crypto'
import { getDb, closeDb } from '../src/core/db'
import { hashToken, tokenPreview } from '../src/core/auth/token-hash'

const SALT_ROUNDS = 10

interface SeedUser {
  email: string
  name: string
  password: string
  timezone: string
}

interface SeedProject {
  name: string
  shared: boolean
  sort_order: number
  color: string
}

// Initial users - passwords should be changed after first login
const USERS: SeedUser[] = [
  {
    email: 'admin@opentask.local',
    name: 'admin',
    password: process.env.OPENTASK_ADMIN_PASSWORD || 'changeme',
    timezone: 'America/Chicago',
  },
  {
    email: 'user2@opentask.local',
    name: 'user2',
    password: process.env.OPENTASK_USER2_PASSWORD || 'changeme',
    timezone: 'America/Chicago',
  },
]

// Default projects per user (not shared)
const USER_PROJECTS: SeedProject[] = [
  { name: 'Inbox', shared: false, sort_order: 0, color: 'blue' },
  { name: 'Personal', shared: false, sort_order: 1, color: 'green' },
  { name: 'Work', shared: false, sort_order: 2, color: 'purple' },
  { name: 'Errands', shared: false, sort_order: 3, color: 'orange' },
]

async function seed() {
  console.log('Seeding OpenTask database...')

  const db = getDb()

  // Create users
  const insertUser = db.prepare(`
    INSERT OR IGNORE INTO users (email, name, password_hash, timezone)
    VALUES (?, ?, ?, ?)
  `)

  const getUserByEmail = db.prepare(`
    SELECT id FROM users WHERE email = ?
  `)

  const userIds: Map<string, number> = new Map()

  for (const user of USERS) {
    const passwordHash = await bcrypt.hash(user.password, SALT_ROUNDS)
    insertUser.run(user.email, user.name, passwordHash, user.timezone)

    const row = getUserByEmail.get(user.email) as { id: number }
    userIds.set(user.email, row.id)
    console.log(`  User: ${user.name} (${user.email}) - ID: ${row.id}`)
  }

  // Create user-specific projects
  const insertProject = db.prepare(`
    INSERT OR IGNORE INTO projects (name, owner_id, shared, sort_order, color)
    SELECT ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM projects WHERE name = ? AND owner_id = ?
    )
  `)

  const getProject = db.prepare(`
    SELECT id FROM projects WHERE name = ? AND owner_id = ?
  `)

  for (const [email, userId] of userIds) {
    for (const project of USER_PROJECTS) {
      insertProject.run(
        project.name,
        userId,
        project.shared ? 1 : 0,
        project.sort_order,
        project.color,
        project.name,
        userId,
      )

      const row = getProject.get(project.name, userId) as { id: number } | undefined
      if (row) {
        console.log(`  Project: ${project.name} for ${email} - ID: ${row.id}`)
      }
    }
  }

  // Create API tokens (stored as SHA-256 hashes)
  const insertToken = db.prepare(`
    INSERT OR IGNORE INTO api_tokens (user_id, token, token_preview, name)
    SELECT ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM api_tokens WHERE user_id = ? AND name = ?
    )
  `)

  for (const [email, userId] of userIds) {
    const tokenName = 'Claude Code'
    const raw = crypto.randomBytes(32).toString('hex')
    const hashed = hashToken(raw)
    const preview = tokenPreview(raw)

    const result = insertToken.run(userId, hashed, preview, tokenName, userId, tokenName)

    if (result.changes === 1) {
      console.log(`  API Token for ${email} (${tokenName}): ${raw}`)
    }
  }

  closeDb()
  console.log('\nSeed complete!')
}

seed().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
