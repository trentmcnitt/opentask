/**
 * Session-based authentication using NextAuth
 *
 * Web UI uses session cookies managed by NextAuth.
 */

import bcrypt from 'bcrypt'
import { getDb } from '@/core/db'
import type { AuthUser } from '@/types'

/**
 * Validate credentials and return the user
 *
 * Accepts either username (name) or email as the identifier.
 * Used by NextAuth credentials provider.
 */
export async function validateCredentials(
  identifier: string,
  password: string,
): Promise<AuthUser | null> {
  if (!identifier || !password) {
    return null
  }

  const db = getDb()

  const row = db
    .prepare(
      `
    SELECT id, email, name, password_hash, timezone
    FROM users
    WHERE email = ? OR name = ?
  `,
    )
    .get(identifier, identifier) as
    | { id: number; email: string; name: string; password_hash: string; timezone: string }
    | undefined

  if (!row) {
    return null
  }

  const passwordMatch = await bcrypt.compare(password, row.password_hash)
  if (!passwordMatch) {
    return null
  }

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    timezone: row.timezone,
  }
}

/**
 * Get a user by ID
 *
 * Used by NextAuth session callback.
 */
export function getUserById(id: number): AuthUser | null {
  const db = getDb()

  const row = db
    .prepare(
      `
    SELECT id, email, name, timezone
    FROM users
    WHERE id = ?
  `,
    )
    .get(id) as { id: number; email: string; name: string; timezone: string } | undefined

  if (!row) {
    return null
  }

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    timezone: row.timezone,
  }
}
