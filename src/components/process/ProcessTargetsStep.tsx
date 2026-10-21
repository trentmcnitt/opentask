'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DateTime } from 'luxon'
import { ATTEMPTS_OFFER_REMOVE } from '@/lib/task-segments'
import type { StaleTargetItem } from '@/lib/process-client'

/**
 * Process step 4 — remove targets missed ATTEMPTS_OFFER_REMOVE (3) days or
 * more (spec §7, 2026-10-12: "At 3×, Process … offer 'remove target?'"; it
 * replaced "remove targets aged 7d+"). Over-target tasks only. A removed
 * target sends the task back to its horizon's task segment; nothing is lost
 * but the nag. Offered, never automatic.
 *
 * Tasks WITH a deadline are listed apart and start UNCHECKED (amendment 7): a
 * deadline task never loses its target — removing the one the user picked
 * puts the deadline's automatic target back (§8.3, 2026-10-12), which may
 * nag sooner. Checking one is a deliberate choice. A task already on its
 * automatic target is not listed (`planProcess`).
 *
 * One tap removes every checked target in one bulk edit — one Undo.
 */
export function ProcessTargetsStep({
  plain,
  withDeadline,
  timezone,
  busy,
  onRemove,
}: {
  plain: StaleTargetItem[]
  withDeadline: StaleTargetItem[]
  timezone: string
  busy: boolean
  onRemove: (ids: number[]) => void
}) {
  // Stored as the exceptions to each list's default, so a list that refreshes
  // keeps its defaults for rows it has not seen.
  const [unchecked, setUnchecked] = useState<Set<number>>(() => new Set())
  const [checkedDeadline, setCheckedDeadline] = useState<Set<number>>(() => new Set())

  if (plain.length === 0 && withDeadline.length === 0) {
    return <p className="text-muted-foreground py-6 text-center text-sm">No old targets left.</p>
  }

  const picked = [
    ...plain.filter((i) => !unchecked.has(i.task.id)),
    ...withDeadline.filter((i) => checkedDeadline.has(i.task.id)),
  ].map((i) => i.task.id)
  const flip = (set: Set<number>, id: number) => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        Overdue on {ATTEMPTS_OFFER_REMOVE} or more days. Removing a target sends the task back to
        its segment.
      </p>
      {plain.length > 0 && (
        <TargetList
          items={plain}
          isChecked={(id) => !unchecked.has(id)}
          onToggle={(id) => setUnchecked((s) => flip(s, id))}
          timezone={timezone}
        />
      )}
      {withDeadline.length > 0 && (
        <div className="flex flex-col gap-1" data-process-deadline-targets>
          <p className="text-sm font-medium">With a deadline</p>
          <p className="text-muted-foreground text-xs">
            Left unchecked: these go back to the deadline&rsquo;s automatic target.
          </p>
          <TargetList
            items={withDeadline}
            isChecked={(id) => checkedDeadline.has(id)}
            onToggle={(id) => setCheckedDeadline((s) => flip(s, id))}
            timezone={timezone}
          />
        </div>
      )}
      <div className="flex justify-end">
        <Button
          type="button"
          size="sm"
          disabled={busy || picked.length === 0}
          onClick={() => onRemove(picked)}
          data-process-remove-targets
        >
          Remove {picked.length} target{picked.length === 1 ? '' : 's'}
        </Button>
      </div>
    </div>
  )
}

function TargetList({
  items,
  isChecked,
  onToggle,
  timezone,
}: {
  items: StaleTargetItem[]
  isChecked: (id: number) => boolean
  onToggle: (id: number) => void
  timezone: string
}) {
  return (
    <ul className="flex flex-col divide-y">
      {items.map(({ task, attempts }) => {
        const id = `process-target-${task.id}`
        return (
          <li
            key={task.id}
            className="flex items-start gap-3 py-2"
            data-process-target-row={task.id}
          >
            <Checkbox
              id={id}
              checked={isChecked(task.id)}
              onCheckedChange={() => onToggle(task.id)}
              className="mt-0.5"
            />
            <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
              <span className="block text-sm break-words">{task.title}</span>
              {task.deadline_at && (
                <span className="text-muted-foreground block text-xs">
                  Deadline{' '}
                  {DateTime.fromISO(task.deadline_at).setZone(timezone).toFormat('EEE, MMM d')}
                </span>
              )}
            </label>
            <span
              className="text-over-target flex-shrink-0 text-xs font-semibold tabular-nums"
              title={`Overdue on ${attempts} days`}
            >
              {attempts}×
            </span>
          </li>
        )
      })}
    </ul>
  )
}
