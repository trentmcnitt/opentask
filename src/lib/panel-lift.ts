/**
 * NOTIFICATION TAPS LAND ON THE DASHBOARD (Trent, 2026-11-09). A tap on a
 * named reminder push, a quota push or a period push opens the dashboard,
 * never the Reminders tab (which stays for admin work). The dashboard's
 * Reminders card pages to the item's period and, for a reminder or a quota
 * prompt, LIFTS the tapped row to the top of that period, flashing it once.
 *
 * - A lifted row stays first until it is considered or done (it leaves the
 *   waiting rows), or until the dashboard is left or reloaded (the lift is
 *   component state, and the URL param is consumed). Then it is back in its
 *   own place. "Show more" is never opened: first is always on screen.
 * - A period push only pages the card to its period.
 *
 * The links:
 * - `/?task=<id>`: every task notification's tap (`notificationTaskPath`,
 *   Web Push). When the id is a reminder, the dashboard lifts it
 *   (`DashboardClient.tsx`'s `?task=` effect; it used to forward to
 *   `/reminders?reminder=<id>&select=1`).
 * - `/?reminder=<id>`: the same lift, from `/reminders?reminder=<id>`, which
 *   the server redirects here (`next.config.ts`) — the Reminders widget's row
 *   link, and the forward older web bundles made.
 * - `/?prompt=<prompt_key>`: a quota push (native since 2026-11-09, Web Push),
 *   and `/reminders?prompt=<key>` redirected — what older app builds load.
 * - `/?slot=<slot id | "unslotted">`: a period push (native since
 *   2026-11-09). An older build loads `/`, which shows the clock's period.
 *
 * This file is the pure part: reading the links and deciding the page and the
 * row order. `DashboardRemindersPanel` applies it.
 */

import { parsePromptKey } from '@/lib/quota-prompts'

/** What a link asked the Reminders card to show. */
export type PanelLift =
  | { kind: 'reminder'; id: number }
  | { kind: 'prompt'; key: string }
  | { kind: 'slot'; slotKey: string }

/** The dashboard params that carry a lift (also the landing's: the card is where they go). */
export const LIFT_PARAMS = ['reminder', 'prompt', 'slot'] as const

/**
 * RULE NOTIF-TAP-DASHBOARD: A tap on a named reminder push, a quota
 *   push or a period push opens the dashboard, never the Reminders
 *   tab. The Reminders card pages to the item's period and lifts a
 *   reminder or prompt row to the top, flashing once; a period push
 *   only pages. The lift lasts until the row is handled or the
 *   dashboard is left.
 * Why: The dashboard is where the day is worked; the Reminders tab is for admin work.
 * Ruling: Trent 2026-11-09, recorded at this home ("NOTIFICATION TAPS LAND ON THE
 *   DASHBOARD").
 */
/** The lift a dashboard URL asks for, if any. `?task=` is resolved elsewhere (it may not be a reminder). */
export function liftFromParams(params: URLSearchParams): PanelLift | null {
  const reminder = params.get('reminder')
  if (reminder && /^\d+$/.test(reminder)) return { kind: 'reminder', id: Number(reminder) }
  const prompt = params.get('prompt')
  if (prompt) return { kind: 'prompt', key: prompt }
  const slot = params.get('slot')
  if (slot && (/^\d+$/.test(slot) || slot === 'unslotted')) return { kind: 'slot', slotKey: slot }
  return null
}

/** The shape of a page this needs: its key (`slotGroupKey`) and its group's rows. */
export interface LiftPage {
  key: string
  group: {
    reminders: { id: number }[]
    prompts: { prompt_key: string }[]
  }
}

/**
 * The page a lift belongs on, or -1. A reminder's or prompt's page is the one
 * whose group holds it WAITING (`group.reminders` holds only waiting
 * reminders; a prompt counts only while `isWaiting` says so). A slot's page
 * is its key.
 */
export function liftPageIndex<P extends LiftPage>(
  pages: P[],
  lift: PanelLift,
  isWaiting: (prompt: P['group']['prompts'][number]) => boolean,
): number {
  switch (lift.kind) {
    case 'slot':
      return pages.findIndex((p) => p.key === lift.slotKey)
    case 'reminder':
      return pages.findIndex((p) => p.group.reminders.some((r) => r.id === lift.id))
    case 'prompt':
      return pages.findIndex((p) =>
        p.group.prompts.some((x) => x.prompt_key === lift.key && isWaiting(x)),
      )
  }
}

/** A row of the card: a reminder or a waiting quota prompt (`DashboardRemindersPanel`'s `PanelSlotRow`). */
export type LiftRow =
  | { kind: 'reminder'; reminder: { id: number } }
  | { kind: 'prompt'; prompt: { prompt_key: string } }

/** The id a lift names on a row: the reminder's id or the prompt's key. Null for a slot lift. */
export function liftedId(lift: PanelLift | null): number | string | null {
  if (!lift) return null
  if (lift.kind === 'reminder') return lift.id
  if (lift.kind === 'prompt') return lift.key
  return null
}

function rowId(row: LiftRow): number | string {
  return row.kind === 'reminder' ? row.reminder.id : row.prompt.prompt_key
}

/** The rows with the lifted one moved to the top; the rest keep their order. Unchanged without it. */
export function liftFirst<R extends LiftRow>(rows: R[], lifted: number | string | null): R[] {
  if (lifted === null) return rows
  const at = rows.findIndex((r) => rowId(r) === lifted)
  if (at <= 0) return rows
  return [rows[at], ...rows.slice(0, at), ...rows.slice(at + 1)]
}

/**
 * The prompt key a link names, as it is today: that exact key if any period
 * has it (waiting or handled), else — a key from another day, a widget last
 * drawn before midnight — today's WAITING row of the same quota and number.
 * Null when nothing matches. (The Reminders tab's `?prompt=` rule, 2026-09-27,
 * moved here with the link.)
 */
export function resolvePromptKey<P extends { prompt_key: string }>(
  groups: { prompts: P[] }[],
  raw: string,
  isWaiting: (prompt: P) => boolean,
): string | null {
  if (groups.some((g) => g.prompts.some((p) => p.prompt_key === raw))) return raw
  const parsed = parsePromptKey(raw)
  if (!parsed) return null
  for (const group of groups) {
    const match = group.prompts.find((p) => {
      const other = parsePromptKey(p.prompt_key)
      return (
        isWaiting(p) &&
        other?.taskId === parsed.taskId &&
        other.number === parsed.number &&
        other.date !== parsed.date
      )
    })
    if (match) return match.prompt_key
  }
  return null
}
