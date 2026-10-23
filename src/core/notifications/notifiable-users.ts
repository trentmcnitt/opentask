/**
 * WHO THE CRON SENDERS NOTIFY — one rule for every minute-cron sender
 * (overdue, slot opens, the slot nag, the deadlines nag; nag-map fix #10,
 * 2026-10-22): notifications switched on AND not the demo user.
 *
 * Before this, the event-driven pushes (sweep and cap feedback, "AI
 * finished", widget push) left the demo account out while the cron senders
 * checked `notifications_enabled` alone, so a demo account with notifications
 * switched on (a reset that seeded it so, or a visitor's toggle) would have
 * been nagged. The demo seeds with notifications off, so nothing reached it in
 * practice; this makes the rule the same everywhere instead of relying on that.
 */

import { getDb } from '@/core/db'

/**
 * The condition on `users` (aliased `alias`) for a query that joins its own
 * user columns — the overdue checker's task JOIN.
 */
export function notifiableUserSql(alias = 'users'): string {
  return `${alias}.notifications_enabled = 1 AND ${alias}.is_demo = 0`
}

export interface NotifiableUser {
  id: number
  timezone: string
}

/** Every user the cron senders may notify, by id. */
export function notifiableUsers(): NotifiableUser[] {
  return getDb()
    .prepare(`SELECT id, timezone FROM users WHERE ${notifiableUserSql()} ORDER BY id`)
    .all() as NotifiableUser[]
}
