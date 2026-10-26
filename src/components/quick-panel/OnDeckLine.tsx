'use client'

import { DateTime } from 'luxon'
import { cn } from '@/lib/utils'
import { OnDeckButton } from '@/components/OnDeckButton'
import { deckReplaces, type DeckLimit } from '@/lib/deck-menu'
import { deckDayWords, openTaskToday } from '@/lib/task-segments'
import type { Task } from '@/types'
import { useDayStart } from '@/components/PreferencesProvider'

/**
 * THE QUICK PANEL'S ON DECK LINE (D2, 2026-10-20; spec rule 8): the On deck
 * button — the rows' own, tap = today (or off, when it is today's deck), hold
 * = the day menu — and what it is set to: "On deck today", "On deck Sat Oct
 * 24", or "Not on deck".
 *
 * STAGED like every other field in the panel: the choice is blue until Save,
 * which PATCHes `on_deck_day` (the server's checks: the A1 deadline refusal
 * comes back as the save's error, and the panel stays open). Rule 1 in the
 * editor: staging a deck drops a staged target (the caller resets it), and a
 * target staged after it wins — the line then reads "Not on deck" in blue,
 * since a picked target takes the task off deck (`shadowed`).
 *
 * A task the rollover sent to the queue from its deck says so here, and only
 * here (red-team A9: never on the queue row): "was on deck Tue Oct 20".
 *
 * A PICKED TARGET (the deadlines page, 2026-10-22, plan §5): the button is
 * faded and the line says what a deck would replace — "Not on deck · a deck
 * replaces target Fri 6 PM". No confirm here: the panel stages, and Reset or
 * Cancel undoes a stage (the rows' faded buttons ask, `ReplaceConfirm`).
 */
export function OnDeckLine({
  task,
  timezone,
  staged,
  shadowed,
  limit,
  onStage,
  showLabel = true,
}: {
  task: Task
  timezone: string
  /** The staged deck: undefined = none staged, null = off deck, else a day. */
  staged: string | null | undefined
  /** A staged target overrides the deck (it takes the task off deck on Save). */
  shadowed: boolean
  /** The hold menu's A1 limit from a staged deadline; omitted = from the task. */
  limit?: DeckLimit | null
  /**
   * Stage a deck (undefined = back to what is stored). `clearTarget`: drop a
   * staged target — any choice made here while a target is staged goes back
   * to the deck (review #3), and so does staging a new deck day.
   */
  onStage: (day: string | null | undefined, clearTarget: boolean) => void
  /** False inside the editor's labelled rows (`ThisOneFields`), whose label column says "On deck". */
  showLabel?: boolean
}) {
  const now = new Date()
  // A deck day is an OpenTask date ("Day starts at" PR 2).
  const dayStart = useDayStart()
  const shown = shadowed ? null : staged !== undefined ? staged : task.on_deck_day
  const dirty = shadowed ? !!task.on_deck_day : staged !== undefined
  const stage = (day: string | null | undefined) => {
    const next = day === undefined ? openTaskToday(timezone, now, dayStart) : day
    // Back to what is stored: nothing staged — but a staged target still goes.
    onStage(next === task.on_deck_day ? undefined : next, shadowed || typeof next === 'string')
  }
  // Only the STORED target, with nothing staged over it (a staged target is
  // the panel's own change, already blue on the Target row).
  const replaces = !shown && !shadowed ? deckReplaces(task, timezone) : null
  const wasOnDeck =
    !shown && task.queued_at && task.queued_from_deck_day
      ? DateTime.fromISO(task.queued_from_deck_day).toFormat('ccc LLL d')
      : null
  return (
    // The button, then ONE inline run of words (2026-10-25): as separate flex
    // items, a narrow column wrapped "Not on deck" and "· a deck replaces …"
    // each on its own, side by side. `items-start` keeps the button on the
    // first line (its margin box is one 16px line, so one line looks as before).
    <div data-quick-panel-deck className="flex items-start gap-1 text-xs">
      <OnDeckButton
        task={{ ...task, on_deck_day: shown }}
        timezone={timezone}
        onDeck={(_t, day) => stage(day)}
        limit={limit}
        className={cn('-my-1 -ml-1 size-6 shrink-0', replaces && 'opacity-45 hover:opacity-100')}
        iconClassName="size-3.5"
      />
      <span data-quick-panel-deck-words className="min-w-0">
        {showLabel && <span className="text-muted-foreground/70">On deck</span>}
        {showLabel && ' '}
        <span
          data-quick-panel-deck-day
          className={cn(
            dirty ? 'font-bold text-blue-500' : shown ? 'font-medium' : 'text-muted-foreground/60',
          )}
        >
          {shown ? deckDayWords(shown, timezone, now, dayStart) : 'Not on deck'}
        </span>
        {replaces && ' '}
        {replaces && (
          <span data-quick-panel-deck-replaces className="text-muted-foreground">
            · a deck replaces {replaces}
          </span>
        )}
        {wasOnDeck && ' '}
        {wasOnDeck && (
          <span data-quick-panel-was-on-deck className="text-muted-foreground">
            · was on deck {wasOnDeck}
          </span>
        )}
      </span>
    </div>
  )
}
