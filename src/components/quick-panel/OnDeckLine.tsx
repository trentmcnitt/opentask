'use client'

import { DateTime } from 'luxon'
import { cn } from '@/lib/utils'
import { OnDeckButton } from '@/components/OnDeckButton'
import { calendarToday, deckDayWords } from '@/lib/task-segments'
import type { Task } from '@/types'

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
 */
export function OnDeckLine({
  task,
  timezone,
  staged,
  shadowed,
  onStage,
}: {
  task: Task
  timezone: string
  /** The staged deck: undefined = none staged, null = off deck, else a day. */
  staged: string | null | undefined
  /** A staged target overrides the deck (it takes the task off deck on Save). */
  shadowed: boolean
  onStage: (day: string | null | undefined) => void
}) {
  const now = new Date()
  const shown = shadowed ? null : staged !== undefined ? staged : task.on_deck_day
  const dirty = shadowed ? !!task.on_deck_day : staged !== undefined
  const stage = (day: string | null | undefined) => {
    const next = day === undefined ? calendarToday(timezone, now) : day
    // Back to what is stored: nothing staged.
    onStage(next === task.on_deck_day ? undefined : next)
  }
  const wasOnDeck =
    !shown && task.queued_at && task.queued_from_deck_day
      ? DateTime.fromISO(task.queued_from_deck_day).toFormat('ccc LLL d')
      : null
  return (
    <div data-quick-panel-deck className="mt-0.5 flex items-center gap-1 text-xs">
      <OnDeckButton
        task={{ ...task, on_deck_day: shown }}
        timezone={timezone}
        onDeck={(_t, day) => stage(day)}
        className="-my-1 -ml-1 size-6"
        iconClassName="size-3.5"
      />
      <span className="text-muted-foreground/70">On deck</span>
      <span
        data-quick-panel-deck-day
        className={cn(
          dirty ? 'font-bold text-blue-500' : shown ? 'font-medium' : 'text-muted-foreground/60',
        )}
      >
        {shown ? deckDayWords(shown, timezone, now) : 'Not on deck'}
      </span>
      {wasOnDeck && (
        <span data-quick-panel-was-on-deck className="text-muted-foreground">
          · was on deck {wasOnDeck}
        </span>
      )}
    </div>
  )
}
