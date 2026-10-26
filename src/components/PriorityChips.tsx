'use client'

import { cn } from '@/lib/utils'
import { PRIORITY_OPTIONS, getPriorityBadgeClasses } from '@/lib/priority'

/**
 * The priority row of the reminder and quota editors (`ReminderDetail`,
 * `QuotaDetail`): the same five values and colours as a task's priority, as
 * chips, with the one-line hint under them.
 *
 * On these surfaces priority is prominence — order within the slot and weight
 * of the row — and, since 2026-10-22 (Trent), how often the period's one nag
 * repeats while the item waits (`slot-nags.ts`). Since 2026-10-26 a Medium+
 * REMINDER also gets its own named push until considered, paced by its
 * priority (`reminder-nags.ts`; priority is a reminder's only dial, it has no
 * Nag option). A quota prompt has no push of its own yet, so the two editors
 * show different hints (`kind`).
 *
 * Chips and hint only: each editor wraps them in its own heading, because the
 * two editors head their sections differently (the reminder's uppercase
 * `SectionHeading` with a dirty dot, the quota's `<legend>`).
 *
 * `value` null is a selection that disagrees: no chip is pressed until one is
 * chosen.
 */
export function PriorityChips({
  value,
  onSelect,
  kind,
}: {
  value: number | null
  onSelect: (value: number) => void
  kind: 'reminder' | 'quota'
}) {
  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {PRIORITY_OPTIONS.map((option) => {
          const selected = value === option.value
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={selected}
              data-priority-chip={option.value}
              onClick={() => onSelect(option.value)}
              className={cn(
                'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                getPriorityBadgeClasses(option.value, selected ? 'included' : 'unselected'),
              )}
            >
              {option.label}
            </button>
          )
        })}
      </div>
      {/* Priority's non-obvious effect on this kind of item (see the header). */}
      <p className="text-muted-foreground text-xs">
        {kind === 'reminder'
          ? 'Medium and up notify you by name until considered. Higher repeats sooner.'
          : 'Also sets how often its period nags.'}
      </p>
    </>
  )
}
