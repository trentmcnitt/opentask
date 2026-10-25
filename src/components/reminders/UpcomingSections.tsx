'use client'

import { useState } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { SLOT_FOOTER_TOGGLE_CLASS } from '@/components/reminders/ReminderSlotGroup'
import { ConsideredSegmentRow, EmptySegmentLine, TaskSegmentRow } from '@/components/TaskSegmentRow'
import { UPCOMING_SECTION_TITLES } from '@/lib/task-model-words'
import {
  capAcrossSections,
  upcomingSections,
  type UpcomingSectionView,
} from '@/lib/upcoming-sections'
import type { SegmentView, TaskSegmentActions } from '@/hooks/useTaskSegments'

/**
 * UPCOMING'S BODY, IN TWO SECTIONS (2026-10-25, the Upcoming split — plan
 * `plan-upcoming-split-1024.md`, PR B; docs/TASK-MODEL.md § Upcoming):
 * "Tomorrow" (the day before a target or deck day) first, then "Later" (the
 * lead-time heads-up, carried over until seen). Drawn by both surfaces —
 * /reminders' section (`TaskSegmentGroup`, `panel={false}`) and the dashboard
 * Tasks card's Upcoming page (`DashboardTasksPanel`, `panel`) — so they can
 * never disagree.
 *
 * Each section: a quiet heading (the word and its own "n of m", green with a
 * check once nothing waits — the slot header's count, `SlotHeaderRow`), its
 * rows, and its own considered rows. BOTH HEADINGS ARE ALWAYS DRAWN; an
 * empty section reads "Nothing today ✓" (decision 3), so the segment-level
 * empty line is not drawn for Upcoming. The heading wears no teal: the
 * segment's title above already carries the one accent.
 *
 * What stays the PAGE's (decision 11): the header's "N of M" (both sections),
 * one "Considered all" and one "Defer all", the over-50 nudge, and on the
 * dashboard the row cap — one budget spent on Tomorrow first, then Later
 * (`capAcrossSections`), with the page's one "Show more".
 *
 * CONSIDERED ROWS, by surface: on /reminders each section has its own "Show N
 * considered" under its rows (the slot footer). On the dashboard page there
 * are no footer toggles (the count IS the toggle — Trent, 2026-09-21: "Show
 * Considered stacked on Show More looks like a big UX no-no"), so a section's
 * own "n of m" opens its considered rows, and the page header's count opens
 * both sections' at once.
 */
export function UpcomingSections({
  segment,
  actions,
  timezone,
  panel,
  cap = null,
  narrowCap = null,
  showConsidered = false,
}: {
  segment: SegmentView
  actions: TaskSegmentActions
  timezone: string
  /** The dashboard card's page (its row geometry, count-as-toggle). */
  panel: boolean
  /** The page's row cap (null: every row), spent Tomorrow first. */
  cap?: number | null
  /** Past this page-wide index a row shows only from `xl` up (the panel's narrow cap). */
  narrowCap?: number | null
  /** The page header's count is open: every section's considered rows show. */
  showConsidered?: boolean
}) {
  const sections = upcomingSections(segment.rows)
  const budget = capAcrossSections(sections, cap)
  return (
    <div className={cn(panel ? 'pb-1' : 'space-y-1')} data-upcoming-sections>
      {sections.map((section, i) => (
        <UpcomingSectionBlock
          key={section.section}
          section={section}
          actions={actions}
          timezone={timezone}
          panel={panel}
          visible={budget[i].visible}
          offset={budget[i].offset}
          narrowCap={narrowCap}
          forceConsidered={showConsidered}
        />
      ))}
    </div>
  )
}

function UpcomingSectionBlock({
  section,
  actions,
  timezone,
  panel,
  visible,
  offset,
  narrowCap,
  forceConsidered,
}: {
  section: UpcomingSectionView
  actions: TaskSegmentActions
  timezone: string
  panel: boolean
  visible: number
  offset: number
  narrowCap: number | null
  forceConsidered: boolean
}) {
  const [shown, setShown] = useState(false)
  const title = UPCOMING_SECTION_TITLES[section.section]
  const { handled, total } = section.counts
  const consideredOpen = shown || forceConsidered
  const putBack = (task: SegmentView['rows'][number]['task']) => void actions.restore(task)
  return (
    <div data-upcoming-section={section.section} role="group" aria-label={title}>
      <SectionHeading
        title={title}
        handled={handled}
        total={total}
        waiting={section.waiting.length}
        panel={panel}
        // On the dashboard page the count opens the considered rows.
        toggle={
          panel && handled > 0
            ? { open: consideredOpen, onToggle: () => setShown((s) => !s) }
            : null
        }
      />
      {section.empty && <EmptySegmentLine className={cn('px-3', panel ? 'pb-2' : 'pb-1')} />}
      {visible > 0 && (
        <ul className={cn('space-y-0.5', panel ? 'px-2 pb-1' : 'px-1')} aria-label={title}>
          {section.waiting.slice(0, visible).map((row, i) => (
            <TaskSegmentRow
              key={row.task.id}
              row={row}
              actions={actions}
              timezone={timezone}
              panel={panel}
              segmentHorizon="upcoming"
              hiddenWhenNarrow={narrowCap !== null && offset + i >= narrowCap}
            />
          ))}
        </ul>
      )}
      {!panel && handled > 0 && (
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          aria-expanded={shown}
          data-segment-considered-toggle
          className={SLOT_FOOTER_TOGGLE_CLASS}
        >
          {shown ? 'Hide' : 'Show'} {handled} considered
        </button>
      )}
      {consideredOpen && handled > 0 && (
        <ul
          className={cn('space-y-0.5', panel ? 'px-2 pb-1' : 'px-1')}
          aria-label={`Considered in ${title}`}
        >
          {section.handled.map((row) => (
            <ConsideredSegmentRow key={row.task.id} row={row} panel={panel} onPutBack={putBack} />
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * "Tomorrow                1 of 3" — the section's word (small, muted, not
 * uppercase: it sits under the segment's own uppercase title) and its count,
 * read exactly as the slot header's: "n of m", climbing; green with a check
 * when nothing waits (an empty section too: "0 of 0 ✓", done from the start).
 */
function SectionHeading({
  title,
  handled,
  total,
  waiting,
  panel,
  toggle,
}: {
  title: string
  handled: number
  total: number
  waiting: number
  panel: boolean
  toggle: { open: boolean; onToggle: () => void } | null
}) {
  const finished = waiting === 0
  const count = (
    <span
      data-upcoming-section-count
      className={cn(
        'inline-flex items-center gap-1 text-xs whitespace-nowrap tabular-nums',
        finished ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground',
      )}
    >
      {handled} of {total}
      {finished && <Check className="size-3.5" strokeWidth={2.5} aria-hidden="true" />}
    </span>
  )
  return (
    <div className={cn('flex min-h-8 items-center gap-2 px-3', panel ? 'pt-1' : 'pt-1.5')}>
      <span className="text-muted-foreground text-xs font-medium" data-upcoming-section-title>
        {title}
      </span>
      <span className="flex-1" />
      {toggle ? (
        <button
          type="button"
          onClick={toggle.onToggle}
          aria-expanded={toggle.open}
          data-upcoming-section-considered-toggle
          aria-label={`${handled} of ${total} considered in ${title} — show what was considered`}
          className={cn(
            'hover:bg-foreground/5 -mr-1.5 rounded-lg px-1.5 py-1 transition-colors',
            toggle.open && 'bg-foreground/5',
          )}
        >
          {count}
        </button>
      ) : (
        <span aria-label={`${handled} of ${total} considered in ${title}`}>{count}</span>
      )}
    </div>
  )
}
