'use client'

import { useState } from 'react'
import { Folder, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { LABEL_COLORS } from '@/lib/label-colors'
import { formatDueTimeParts } from '@/lib/format-date'
import { getPriorityOption } from '@/lib/priority'
import {
  formatJustAddedLabel,
  isDeckUpdate,
  justAddedEntryKey,
  type JustAddedEntry,
} from '@/lib/just-added'
import { SLOT_FOOTER_TOGGLE_CLASS } from '@/components/reminders/ReminderSlotGroup'
import type { Project, Task } from '@/types'
import { useDayStart } from '@/components/PreferencesProvider'

interface JustAddedCardProps {
  /** Tasks added or targeted in the last 15 minutes, newest first (`selectJustAddedEntries`). */
  entries: JustAddedEntry[]
  projects: Project[]
  /** The just-added clock (`useJustAddedClock`). */
  now: number
  timezone: string
  /** Bring the task's real row on screen and flash it (or open it). */
  onShow: (task: Task) => void
  /** Hide the tasks currently listed. */
  onClear: () => void
}

/**
 * "Just now" — the tasks created, or targeted from a task segment, in the last
 * 15 minutes, in a card of their own under the add field (Trent, 2026-09-28,
 * mockup A of three; targeted entries 2026-10-12 — see `src/lib/just-added.ts`).
 *
 * The question right after adding is "did it land, where, and what did the AI
 * make of it?", and it has to be answerable WITHOUT scrolling and WITHOUT
 * moving the real row out of its place ("the real row at the top means it's
 * not in the actual place it's supposed to be"). So each entry says which
 * project the task landed in, what the AI filled in (due, priority) or that
 * it is still working, and how long ago it was added ("Added 2m ago") or targeted ("Targeted 2m
 * ago" — the line above it already shows the new target); tapping one scrolls to
 * the real row in its real group and flashes it. It replaced a dashed "ghost"
 * copy at the top of the Inbox (#121), which Trent found cheap-looking and
 * confusing next to the real row.
 *
 * Entries are not check-offs (a project-coloured dot, not a checkbox): the
 * card only points at tasks. "Clear" hides what is listed now; a task added
 * (or re-targeted) after that shows again.
 *
 * DECK UPDATES FOLD (Trent, 2026-10-22): entries that only say a task went on
 * deck (`isDeckUpdate`) sit behind "Show N on deck updates" / "Show less",
 * folded on every load — the segments' "Show N considered" toggle, in its
 * place and style. Added and targeted entries always show. Unfolded, every
 * entry is listed in its usual newest-first order.
 */
export function JustAddedCard({
  entries,
  projects,
  now,
  timezone,
  onShow,
  onClear,
}: JustAddedCardProps) {
  const [showDecks, setShowDecks] = useState(false)
  if (entries.length === 0) return null
  const deckUpdates = entries.filter((e) => isDeckUpdate(e)).length
  const listed = showDecks ? entries : entries.filter((e) => !isDeckUpdate(e))
  return (
    <section
      aria-label="Just now"
      data-just-added-card
      className="bg-muted/40 border-border/60 mb-4 rounded-xl border px-3 py-2.5 sm:px-4"
    >
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-muted-foreground text-[11px] font-semibold tracking-wider uppercase">
          Just now
        </h2>
        <button
          type="button"
          onClick={onClear}
          className="text-muted-foreground/80 hover:text-foreground text-xs"
        >
          Clear
        </button>
      </div>
      <ul className="space-y-0.5">
        {listed.map((entry) => (
          <li key={justAddedEntryKey(entry)}>
            <JustAddedRow
              entry={entry}
              project={projects.find((p) => p.id === entry.task.project_id)}
              now={now}
              timezone={timezone}
              onShow={() => onShow(entry.task)}
            />
          </li>
        ))}
      </ul>
      {deckUpdates > 0 && (
        <button
          type="button"
          onClick={() => setShowDecks((s) => !s)}
          aria-expanded={showDecks}
          data-just-added-deck-toggle
          // The slots' footer toggle, without its row-circle indent: the
          // card's entries start at the dot.
          className={cn(SLOT_FOOTER_TOGGLE_CLASS, 'pl-1.5 sm:pl-2')}
        >
          {showDecks
            ? 'Show less'
            : `Show ${deckUpdates} on deck update${deckUpdates === 1 ? '' : 's'}`}
        </button>
      )}
    </section>
  )
}

function JustAddedRow({
  entry,
  project,
  now,
  timezone,
  onShow,
}: {
  entry: JustAddedEntry
  project: Project | undefined
  now: number
  timezone: string
  onShow: () => void
}) {
  const { task } = entry
  const dayStart = useDayStart()
  const color = project?.color ? LABEL_COLORS[project.color] : null
  const enriching = task.labels.includes('ai-to-process')
  const details = entryDetails(task, timezone, dayStart)
  // "Added 2m ago" / "Targeted 2m ago": which event put it here, and when.
  const age = formatJustAddedLabel(entry, now)
  const projectName = project?.name ?? 'Inbox'

  return (
    <button
      type="button"
      onClick={onShow}
      data-just-added-entry={task.id}
      data-just-added-kind={entry.kind}
      aria-label={`${task.title} — ${age.toLowerCase()}, in ${projectName}. Show it in the list.`}
      className="hover:bg-background flex w-full items-start gap-3 rounded-lg px-1.5 py-2 text-left transition-colors sm:items-center sm:px-2"
    >
      <span
        aria-hidden
        className={cn(
          'mt-[7px] size-2.5 shrink-0 rounded-full sm:mt-0',
          color ? color.dot : 'bg-muted-foreground/40',
        )}
      />
      <span className="min-w-0 flex-1">
        {/* `break-words`: an unbroken URL in a title wraps instead of
            running past the card's edge. */}
        <span className="block text-[15px] leading-snug font-medium break-words">{task.title}</span>
        {enriching ? (
          <span className="animate-ai-shimmer flex items-center gap-1 text-xs font-medium">
            <Sparkles className="size-3" aria-hidden />
            AI is filling in details…
          </span>
        ) : (
          details && <span className="text-muted-foreground block text-xs">{details}</span>
        )}
        {/* Phone: project and age under the title. */}
        <span className="block text-xs sm:hidden">
          <span className={cn('font-medium', color ? color.text : 'text-muted-foreground')}>
            {projectName}
          </span>
          <span className="text-muted-foreground"> · {age}</span>
        </span>
      </span>
      {/* Wider: project chip and age at the end of the line. */}
      <span
        className={cn(
          'hidden shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium sm:inline-flex',
          color ? cn(color.text, color.border) : 'text-muted-foreground border-border',
        )}
      >
        <Folder className="size-3" aria-hidden />
        {projectName}
      </span>
      {/* Wide enough for "Targeted 14m ago", so the column lines up. */}
      <span className="text-muted-foreground hidden w-28 shrink-0 text-right text-xs sm:inline">
        {age}
      </span>
    </button>
  )
}

/** "Tomorrow 9:00 AM · High" — what the AI (or the title) set; null when nothing. */
function entryDetails(task: Task, timezone: string, dayStart: string): string | null {
  const parts: string[] = []
  if (task.due_at) {
    const due = formatDueTimeParts(task.due_at, timezone, dayStart)
    parts.push(due.absolute ? `${due.relative} · ${due.absolute}` : due.relative)
  }
  if (task.priority > 0) parts.push(getPriorityOption(task.priority).label)
  return parts.length > 0 ? parts.join(' · ') : null
}
