'use client'

import { Check, ChevronDown, Minus, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { trackedItems } from '@/lib/slot-view'
import { periodLabel, trackSummary } from '@/lib/track'
import { useTrackProgress } from '@/hooks/useTrackProgress'
import { useTrackPanelPreference } from '@/components/PreferencesProvider'
import type { Task } from '@/types'

/**
 * Track (REDESIGN-V03 §5): the quotas' home on the Tasks page.
 *
 * Trent, on the first cut (quotas as full task rows at the top of "Anytime
 * today"): "the alignment is all weird and the things just look sloppy…
 * wherever they go, it can't be buried on the Tasks page." So the quotas are
 * an instrument panel above the day, not rows inside it:
 *
 * - One line per quota, every line the same shape: title · bar · count · − · +1.
 *   The control cluster has fixed widths and sits flush right, so the eight
 *   lines align as one object. No circle, no stripes, no AI commentary, no
 *   recurrence glyph — none of that is what a counter is about.
 * - The panel starts FOLDED to one line — label, period, a slim bar, "2 of
 *   23" — and opens to the full rows on a tap; the choice is remembered as a
 *   user preference, like the filter section. Trent (2026-09-05): open by
 *   default, eight rows pushed the first task of the day below the fold on a
 *   phone. It always comes first.
 * - Order is by title and never changes on a tap — the widget's "order jumps
 *   under your finger" complaint applied verbatim here.
 * - "Met" is a state, not an exit: green check, count keeps going (3/2).
 *
 * Tracked tasks still appear as plain rows in the All / Projects lists (with a
 * "0 / 4" chip and no controls); logging happens here.
 */
export function TrackPanel({ tasks }: { tasks: Task[] }) {
  const { trackExpanded: open, setTrackExpanded: setOpen } = useTrackPanelPreference()
  const quotas = trackedItems(tasks)
  if (quotas.length === 0) return null

  // One shared period label when every quota counts over the same period.
  const periods = new Set(quotas.map((t) => periodLabel(t.rrule)))
  const sharedPeriod = periods.size === 1 ? [...periods][0] : null
  const summary = trackSummary(quotas)
  const allMet = summary.total > 0 && summary.done >= summary.total

  return (
    <section
      aria-label="Track"
      data-track-panel
      // Its own box in both states (Trent, 2026-09-05: folded, it read as a
      // stray line between the filters and "Select all"). The header row is
      // built exactly like a group header — same padding, chevron size and
      // negative margin — so the caret and label line up with "Early morning".
      className={cn('bg-muted/30 mb-6 rounded-2xl transition-colors', open ? 'pb-1' : 'py-0.5')}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={open ? 'Collapse Track' : 'Expand Track'}
        className="hover:text-foreground flex min-h-10 w-full items-center gap-2 rounded-2xl px-1 py-1.5 text-left transition-colors"
      >
        <span className="-mr-1.5 flex items-center justify-center p-0.5">
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'text-muted-foreground size-3 shrink-0 transition-transform duration-200',
              !open && '-rotate-90',
            )}
          />
        </span>
        <span className="text-muted-foreground text-xs font-semibold tracking-wider whitespace-nowrap uppercase">
          Track
        </span>
        {sharedPeriod && (
          <span className="text-muted-foreground/50 text-xs whitespace-nowrap">
            &middot; {sharedPeriod}
          </span>
        )}
        {open ? (
          <span className="text-muted-foreground/60 text-xs tabular-nums">{quotas.length}</span>
        ) : (
          <>
            {/* Folded: the week at a glance, so the line earns its place. */}
            <span
              className="bg-muted relative ml-2 h-1.5 min-w-10 flex-1 overflow-hidden rounded-full"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={summary.total}
              aria-valuenow={summary.done}
              aria-label={`${summary.done} of ${summary.total}${sharedPeriod ? ` ${sharedPeriod}` : ''}`}
            >
              <span
                className={cn(
                  'absolute inset-y-0 left-0 rounded-full transition-[width] duration-300 ease-out',
                  allMet ? 'bg-green-600' : 'bg-foreground/50',
                )}
                style={{
                  width: `${summary.total > 0 ? (summary.done / summary.total) * 100 : 0}%`,
                }}
              />
            </span>
            <span
              data-track-summary
              className={cn(
                'pr-2 text-xs whitespace-nowrap tabular-nums',
                allMet ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground',
              )}
            >
              <span className="text-foreground font-medium">{summary.done}</span> of {summary.total}
            </span>
          </>
        )}
      </button>

      {open && (
        <ul className="px-2">
          {quotas.map((task) => (
            <TrackRow key={task.id} task={task} showPeriod={!sharedPeriod} />
          ))}
        </ul>
      )}
    </section>
  )
}

function TrackRow({ task, showPeriod }: { task: Task; showPeriod: boolean }) {
  const { state, period, log } = useTrackProgress(task)

  return (
    <li
      data-track-row={task.id}
      className="hover:bg-background flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl px-2 py-2 transition-colors"
    >
      <span
        className={cn(
          'basis-full truncate text-[15px] sm:flex-1 sm:basis-0',
          state.met ? 'text-foreground/70' : 'text-foreground',
        )}
        title={task.title}
      >
        {task.title}
      </span>

      {/* Fixed-width cluster, flush right: the same columns on every line. */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <div
          className="bg-muted relative h-1.5 w-24 overflow-hidden rounded-full sm:w-28"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={state.target}
          aria-valuenow={state.current}
          aria-label={`${state.current} of ${state.target}${period ? ` ${period}` : ''}`}
        >
          <div
            className={cn(
              'h-full rounded-full transition-[width] duration-300 ease-out',
              state.met ? 'bg-green-600' : 'bg-foreground/60',
            )}
            style={{ width: `${state.fraction * 100}%` }}
          />
        </div>

        <span
          data-track-count
          className={cn(
            'flex w-16 items-center justify-end gap-1 text-sm whitespace-nowrap tabular-nums',
            state.met ? 'text-green-700 dark:text-green-400' : 'text-muted-foreground',
          )}
        >
          {state.met && <Check className="size-3.5" strokeWidth={3} aria-hidden="true" />}
          <span>
            <span className="text-foreground font-medium">{state.current}</span> / {state.target}
          </span>
          {showPeriod && period && <span className="sr-only"> {period}</span>}
        </span>

        <button
          type="button"
          onClick={() => void log(-1)}
          disabled={state.current === 0}
          aria-label={`Remove one from "${task.title}"`}
          title="Remove one"
          className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground flex size-7 items-center justify-center rounded-full border transition-colors disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <Minus className="size-3.5" strokeWidth={2.5} />
        </button>
        <button
          type="button"
          onClick={() => void log(1)}
          aria-label={`Log one more for "${task.title}"`}
          title="Log one more"
          className="text-foreground hover:bg-foreground/5 flex h-7 w-14 items-center justify-center gap-1 rounded-full border text-xs font-medium transition-colors"
        >
          <Plus className="size-3.5" strokeWidth={2.5} />1
        </button>
      </div>
    </li>
  )
}
