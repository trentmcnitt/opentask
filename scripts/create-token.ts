/**
 * Token provisioning script
 *
 * Creates an API token for a user, identified by username (case-insensitive).
 *
 * Usage: tsx scripts/create-token.ts <username> [token-name]
 *
 * Examples:
 *   tsx scripts/create-token.ts admin                → name defaults to "API"
 *   tsx scripts/create-token.ts admin "iOS Shortcut" → custom token name
 */

import { getDb, closeDb } from '../src/core/db'
import { createApiToken } from '../src/core/auth/tokens'

const username = process.argv[2]
const tokenName = process.argv[3] || 'API'

if (!username) {
  console.error('Usage: tsx scripts/create-token.ts <username> [token-name]')
  process.exit(1)
}

const db = getDb()

const user = db
  .prepare('SELECT id, name FROM users WHERE name = ? COLLATE NOCASE')
  .get(username) as { id: number; name: string } | undefined

if (!user) {
  console.error(`User "${username}" not found`)
  closeDb()
  process.exit(1)
}

const { raw } = createApiToken(user.id, tokenName)

console.log(`Token created for ${user.name} (name: "${tokenName}"):`)
console.log(raw)

closeDb()
