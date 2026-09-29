/**
 * The last app-icon badge value each user's devices were sent.
 *
 * Why this exists: the overdue checker runs every minute, and it used to send
 * a badge push to every device of every user with anything overdue, every
 * minute, whether or not the number had changed (about one push a minute all
 * day for a user who leaves two tasks overdue). The checker now sends only
 * when the count differs from what was last sent, and this map is how it
 * knows. User actions (`syncBadgeCount` in dismiss.ts) always send, and
 * record what they sent here, so the checker doesn't repeat them.
 *
 * In memory, on `globalThis` (the same pattern as the enrichment state in
 * `src/core/ai/enrichment.ts`: Next.js can load a module more than once, and
 * `globalThis` keeps one map per process). Nothing is lost by a restart: the
 * map starts empty, so the first checker tick re-sends each user's count once.
 *
 * Only a send that reached every device is recorded (see
 * `sendApnsBadgeUpdate`). A failed one clears the entry, so the next checker
 * tick tries again rather than believing the device has the number.
 */

const globalForBadge = globalThis as unknown as {
  __opentaskLastBadgeSent?: Map<number, number>
}

function store(): Map<number, number> {
  if (!globalForBadge.__opentaskLastBadgeSent) {
    globalForBadge.__opentaskLastBadgeSent = new Map()
  }
  return globalForBadge.__opentaskLastBadgeSent
}

/** The badge value last delivered to this user's devices, if known. */
export function lastBadgeSent(userId: number): number | undefined {
  return store().get(userId)
}

export function recordBadgeSent(userId: number, badge: number): void {
  store().set(userId, badge)
}

/** Forget the user's value, so the next checker tick sends the count again. */
export function forgetBadgeSent(userId: number): void {
  store().delete(userId)
}

/**
 * Users whose devices were last told a non-zero badge. The checker only looks
 * at users who have something overdue; this lets it also reach a user whose
 * count has dropped to zero without a user action sending the zero.
 */
export function usersWithNonZeroBadge(): number[] {
  return [...store()].filter(([, badge]) => badge > 0).map(([userId]) => userId)
}

/** Tests only: start from an empty map. */
export function resetBadgeState(): void {
  store().clear()
}
