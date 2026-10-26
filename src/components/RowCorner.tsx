'use client'

import { cn } from '@/lib/utils'
import { attemptsTone } from '@/lib/task-segments'
import { HorizonDotButton } from '@/components/HorizonDot'
import type { PriorityTab } from '@/lib/row-corner'
import type { HorizonValue } from '@/lib/task-segments'
import type { Task } from '@/types'

/**
 * The dashboard row's corner (2026-10-14; rules in `src/lib/row-corner.ts`):
 * tabs flush with the card's top-right corner, over its border, left to right
 *
 *     [horizon dot] [2×] [High]
 *
 * The last tab shares the card's rounded corner (`rounded-tr-lg`), the first
 * has the small inner bevel (`rounded-bl-md`), and the ones between are square,
 * so the set reads as one strip. Each tab is 18px tall.
 *
 * Only the dot is a control (it opens the horizon menu). The attempts and
 * priority tabs are labels: a press on them is a press on the row.
 */
export function RowCorner({
  task,
  dot,
  attempts,
  priority,
  onHorizonChange,
}: {
  task: Pick<Task, 'horizon' | 'title' | 'deadline_at' | 'due_at'>
  /** Show the horizon dot (`showsHorizonDot`). */
  dot: boolean
  /** Days over target; 0 shows no attempts tab. */
  attempts: number
  priority: PriorityTab | null
  onHorizonChange?: (horizon: HorizonValue | null) => void
}) {
  const parts = [dot && 'dot', attempts >= 1 && 'attempts', priority && 'priority'].filter(
    Boolean,
  ) as string[]
  if (parts.length === 0) return null
  const edge = (part: string) =>
    cn(part === parts[0] && 'rounded-bl-md', part === parts[parts.length - 1] && 'rounded-tr-lg')
  return (
    <div data-row-corner className="absolute -top-px -right-px z-[1] flex items-stretch">
      {dot && (
        <HorizonDotButton
          task={task}
          variant="corner"
          onChange={onHorizonChange}
          className={edge('dot')}
        />
      )}
      {attempts >= 1 && <AttemptsTab attempts={attempts} className={edge('attempts')} />}
      {priority && <PriorityTabMark tab={priority} className={edge('priority')} />}
    </div>
  )
}

/**
 * The priority tab itself — "High" / "Urgent", or "!" / "!!" — in the
 * corner's strip here, and inline after the title on the rows that have no
 * card corner to sit in (the reminder rows, the quota prompt rows and the
 * quota chips, 2026-10-26: `inline` gives it its own small rounding and a
 * baseline-friendly box). One element, so a tab reads the same everywhere.
 */
export function PriorityTabMark({
  tab,
  inline = false,
  className,
}: {
  tab: PriorityTab
  inline?: boolean
  className?: string
}) {
  return (
    <span
      role="img"
      data-priority-tab
      aria-label={tab.name}
      title={tab.name}
      className={cn(
        'h-[18px] items-center px-[7px] text-[10.5px] leading-none font-semibold',
        inline ? 'inline-flex rounded-[4px] align-[2px] whitespace-nowrap' : 'flex',
        tab.className,
        className,
      )}
    >
      {tab.text}
    </span>
  )
}

/**
 * "Show right border" on a row with no border of its own (the reminder and
 * quota prompt rows): a 3px bar on the row's right edge in the priority's
 * colour — the mirror of the prompt row's label-colour stripe on the left,
 * same width, inset and rounding, so the two read as one family and never
 * meet. The row must be `relative`. `panel`: the dashboard card's compact
 * rows, whose stripes sit out in the list's gutter.
 */
export function PriorityEdgeBar({ bar, panel = false }: { bar: string | null; panel?: boolean }) {
  if (!bar) return null
  return (
    <span
      aria-hidden="true"
      data-priority-edge
      className={cn(
        'absolute w-[3px] rounded-full',
        panel ? 'inset-y-1.5 -right-1.5' : 'inset-y-2.5 right-0',
        bar,
      )}
    />
  )
}

/**
 * The tab inline after a title (reminder, prompt and quota-chip rows), or
 * nothing. Spaced from the title by half its text size, so it sits the same
 * distance after a 16px /reminders title as after a 13px chip's.
 */
export function InlinePriorityTab({ tab }: { tab: PriorityTab | null }) {
  if (!tab) return null
  return <PriorityTabMark tab={tab} inline className="ml-[0.5em]" />
}

/**
 * ATTEMPTS (spec §7, 2026-10-12; replaced the "2d" target-age tab): local days
 * over target ("3×"), on any row with a target and at least one attempt. A
 * moved-ahead task keeps it, so the row still says it has slipped. Shown past
 * the deadline too: it is a count, not a second alarm beside the red. Its
 * tone deepens with the count (`attemptsTone`).
 */
function AttemptsTab({ attempts, className }: { attempts: number; className?: string }) {
  const tone = attemptsTone(attempts)
  return (
    <span
      data-attempts={attempts}
      title={`Overdue on ${attempts} day${attempts === 1 ? '' : 's'}`}
      className={cn(
        'flex h-[18px] items-center px-[7px] text-[11px] leading-none font-semibold tabular-nums',
        tone === 'light' && 'bg-over-target/10 text-over-target',
        tone === 'medium' && 'bg-over-target/25 text-over-target',
        tone === 'strong' && 'bg-over-target-badge text-white',
        className,
      )}
    >
      {attempts}×
    </span>
  )
}
