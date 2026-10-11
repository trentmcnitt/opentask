'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import { getPriorityOption, URGENT_PRIORITY } from '@/lib/priority'
import type { GrowthItem } from '@/lib/process-client'
import { HORIZON_LABELS, HORIZON_UNSET_LABEL, HORIZON_WORD } from '@/lib/task-model-words'

/**
 * Process step 3 — grow horizons that have been sat on a long time (spec §5;
 * the rule and its thresholds are `src/lib/process-rules.ts`).
 *
 * BATCHED WITH A DEFAULT, never a run of one-by-one questions: every row
 * starts checked (= grow one step), and one Apply settles the lot. An
 * unchecked row is a "keep": its horizon stays and its clock restarts, so it
 * is not asked again until it is long past again. P2+ rows also offer "Do it"
 * (target today) and "Raise" (priority one step up), each acting at once and
 * leaving the list (Trent, 10-10).
 */
export function ProcessGrowthStep({
  items,
  busy,
  onApply,
  onDoIt,
  onRaise,
}: {
  items: GrowthItem[]
  busy: boolean
  onApply: (grow: GrowthItem[], keep: GrowthItem[]) => void
  onDoIt: (item: GrowthItem) => void
  onRaise: (item: GrowthItem) => void
}) {
  const [kept, setKept] = useState<Set<number>>(() => new Set())

  if (items.length === 0) {
    return <p className="text-muted-foreground py-6 text-center text-sm">Nothing to grow.</p>
  }

  const grow = items.filter((i) => !kept.has(i.task.id))
  const keep = items.filter((i) => kept.has(i.task.id))
  const toggle = (id: number) =>
    setKept((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        These have sat on their {HORIZON_WORD.toLowerCase()} a long time. Checked ones grow a step;
        unchecked ones keep theirs.
      </p>
      <ul className="flex flex-col divide-y">
        {items.map((item) => (
          <GrowthRow
            key={item.task.id}
            item={item}
            checked={!kept.has(item.task.id)}
            onToggle={() => toggle(item.task.id)}
            onDoIt={() => onDoIt(item)}
            onRaise={() => onRaise(item)}
            disabled={busy}
          />
        ))}
      </ul>
      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() =>
            setKept(keep.length === 0 ? new Set(items.map((i) => i.task.id)) : new Set())
          }
        >
          {keep.length === 0 ? 'Keep all' : 'Grow all'}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => onApply(grow, keep)}
          data-process-growth-apply
        >
          {applyLabel(grow.length, keep.length)}
        </Button>
      </div>
    </div>
  )
}

function applyLabel(grow: number, keep: number): string {
  if (keep === 0) return `Grow ${grow}`
  if (grow === 0) return `Keep ${keep}`
  return `Grow ${grow}, keep ${keep}`
}

function GrowthRow({
  item,
  checked,
  onToggle,
  onDoIt,
  onRaise,
  disabled,
}: {
  item: GrowthItem
  checked: boolean
  onToggle: () => void
  onDoIt: () => void
  onRaise: () => void
  disabled: boolean
}) {
  const id = `process-grow-${item.task.id}`
  const priority = getPriorityOption(item.task.priority)
  return (
    <li className="flex items-start gap-3 py-2" data-process-growth-row={item.task.id}>
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={onToggle}
        disabled={disabled}
        className="mt-0.5"
      />
      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
        <span className="block text-sm break-words">{item.task.title}</span>
        <span className="text-muted-foreground block text-xs">
          {item.from
            ? HORIZON_LABELS[item.from]
            : `${HORIZON_LABELS.weeks} (${HORIZON_UNSET_LABEL.toLowerCase()})`}{' '}
          → <span className={cn(checked && 'text-foreground')}>{HORIZON_LABELS[item.to]}</span> ·{' '}
          {item.days_on_horizon} days
          {item.task.priority > 0 && (
            <span className={cn('ml-1', priority.color)}>· {priority.label}</span>
          )}
        </span>
      </label>
      {item.can_act && (
        <div className="flex flex-shrink-0 gap-1">
          <Button type="button" variant="outline" size="xs" disabled={disabled} onClick={onDoIt}>
            Do it
          </Button>
          {item.task.priority < URGENT_PRIORITY && (
            <Button type="button" variant="outline" size="xs" disabled={disabled} onClick={onRaise}>
              Raise
            </Button>
          )}
        </div>
      )}
    </li>
  )
}
