/**
 * The web's On deck request and its toast words (D2, 2026-10-20), shared by
 * the task-segment rows (`useTaskSegments`) and the dashboard rows
 * (`useTaskActions`).
 *
 * `POST /api/tasks/deck` answers 200 even when it did nothing: a deadline
 * task refused (red-team A1) or a skipped kind comes back with `decked: 0` /
 * `undecked: 0` and its `summary` saying why ("This deadline is close and
 * already reminding you — use Today."). So the caller reads `changed`, not
 * the status: no change → put the row back and show the summary as an error.
 */
import {
  REPEATING_DECK_REFUSAL_MESSAGE,
  deckDayWords,
  type DeckResultCounts,
} from '@/lib/task-segments'

export interface DeckResponse extends DeckResultCounts {
  summary: string
}

/** Send the deck: undefined = today (the server's default), a day, or null = off deck. */
export async function sendDeck(
  ids: number[],
  day: string | null | undefined,
): Promise<DeckResponse> {
  const res = await fetch('/api/tasks/deck', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(day === undefined ? { ids } : { ids, day }),
  })
  const json = (await res.json().catch(() => null)) as {
    error?: string
    data?: DeckResponse
  } | null
  if (!res.ok || !json?.data) throw new Error(json?.error || 'Could not change On deck')
  return json.data
}

/**
 * The toast for a one-task deck write: "On deck for today: “Buy gloves”",
 * "On deck for Sat Oct 24: “…”", "Taken off deck: “…”" — the row toasts'
 * shape (`Targeted today …: “title”`). Null when nothing changed: the caller
 * shows the server's `summary` instead (a refusal or a skip, in its words).
 */
export function deckToastMessage(
  result: DeckResponse,
  title: string,
  timezone: string,
  /** The user's day boundary (`useDayStart`): "today" / "tomorrow" by OpenTask day. */
  dayStart: string,
  now: Date = new Date(),
): string | null {
  if (result.day === null) return result.undecked > 0 ? `Taken off deck: “${title}”` : null
  if (result.decked === 0) return null
  return `On deck for ${deckDayWords(result.day, timezone, now, dayStart)}: “${title}”`
}

/**
 * The error toast for a one-task deck write that changed nothing: the
 * server's `summary` — except a repeating task refused for its deadline's day
 * (`after_auto_target`, the enum kept), whose summary is worded for a
 * one-off's automatic target ("…starts reminding you"): it reads
 * `REPEATING_DECK_REFUSAL_MESSAGE` instead (2026-10-20).
 */
export function deckErrorMessage(
  result: DeckResponse,
  task: { id: number; rrule?: string | null },
): string {
  const refused = result.refused.find((r) => r.id === task.id)
  if (task.rrule && refused?.reason === 'after_auto_target') return REPEATING_DECK_REFUSAL_MESSAGE
  return result.summary
}
