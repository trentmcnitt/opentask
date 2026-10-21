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
      {priority && (
        <span
          role="img"
          data-priority-tab
          aria-label={priority.name}
          title={priority.name}
          className={cn(
            'flex h-[18px] items-center px-[7px] text-[10.5px] leading-none font-semibold',
            priority.className,
            edge('priority'),
          )}
        >
          {priority.text}
        </span>
      )}
    </div>
  )
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
