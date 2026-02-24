/**
 * Demo engagement notifications via Pushover
 *
 * Sends a fire-and-forget Pushover notification to Trent when the demo
 * user interacts with tasks. Used to gauge whether the demo drives real
 * engagement (as opposed to just page views).
 *
 * Rate limited to 1 notification per action type per 60 seconds to
 * prevent alert flooding from rapid editing.
 *
 * Enabled when PUSHOVER_TRENT_CRITICAL_KEY and PUSHOVER_TRENT_USER are set.
 */

const APP_TOKEN = process.env.PUSHOVER_TRENT_CRITICAL_KEY || ''
const USER_KEY = process.env.PUSHOVER_TRENT_USER || ''
const RATE_LIMIT_MS = 60_000

const lastNotified = new Map<string, number>()

export type DemoAction = 'create' | 'update' | 'done' | 'delete'

function isConfigured(): boolean {
  return Boolean(APP_TOKEN && USER_KEY)
}

const messages: Record<DemoAction, string> = {
  create: 'Demo user created a task',
  update: 'Demo user edited a task',
  done: 'Demo user completed a task',
  delete: 'Demo user deleted a task',
}

/**
 * Notify Trent that the demo user performed an action.
 * Fire-and-forget — never throws, never blocks.
 */
export function notifyDemoEngagement(userName: string, action: DemoAction): void {
  if (userName !== 'demo') return
  if (!isConfigured()) return

  const now = Date.now()
  const last = lastNotified.get(action) ?? 0
  if (now - last < RATE_LIMIT_MS) return
  lastNotified.set(action, now)

  fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: APP_TOKEN,
      user: USER_KEY,
      message: messages[action],
      title: 'OpenTask Demo',
    }),
  }).catch(() => {})
}
