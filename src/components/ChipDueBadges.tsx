/**
 * The two little pills a filter chip shows after its muted total (feat/chip-due-badges,
 * Trent 2026-09-23): a soft indigo pill for "due later today" and a solid red pill for
 * "overdue". Shared by `ProjectFilterBar` (each project chip) and `DueDateFilterBar`
 * (the "Today" chip) so both draw the same two pills instead of two near-identical
 * copies of the same markup drifting apart.
 *
 * Colors intentionally reuse existing tokens/conventions rather than inventing new
 * ones: `bg-badge-destructive` is the same dark-mode-aware solid red the nav badges
 * (Header, BottomTabs) already use for "overdue", and the soft indigo pairing
 * (`bg-indigo-100`/`dark:bg-indigo-900/40` + `text-indigo-700`/`dark:text-indigo-300`)
 * matches the signal-badge treatment in TaskRow.tsx.
 */
import { cn } from '@/lib/utils'

interface ChipDueBadgesProps {
  dueToday: number
  overdue: number
  /**
   * Suppress the due-today pill even when `dueToday > 0` — the "Today" chip's own
   * total already IS the due-today count (see DueDateFilterBar), so a second pill
   * repeating it would be redundant. Project chips always show it.
   */
  showDueToday?: boolean
}

const PILL_CLASSES =
  'relative inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-semibold tabular-nums'

export function ChipDueBadges({ dueToday, overdue, showDueToday = true }: ChipDueBadgesProps) {
  const renderDueToday = showDueToday && dueToday > 0
  const renderOverdue = overdue > 0
  if (!renderDueToday && !renderOverdue) return null
  return (
    <>
      {renderDueToday && (
        <span
          data-chip-due-today={dueToday}
          className={cn(
            PILL_CLASSES,
            'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
          )}
        >
          {dueToday}
        </span>
      )}
      {renderOverdue && (
        <span
          data-chip-overdue={overdue}
          className={cn(PILL_CLASSES, 'bg-badge-destructive text-destructive-foreground')}
        >
          {overdue}
        </span>
      )}
    </>
  )
}

/**
 * Builds the accessible name / title for a chip carrying these badges, e.g.
 * "Personal: 29 open, 2 due today, 3 overdue" — spelled out because the pills
 * themselves carry no text a screen reader would read as "due today"/"overdue"
 * beyond a bare number. `totalLabel` is "open" for project chips (whose total
 * is every open task in the project) and omitted for the "Today" chip (whose
 * total already means "due today", not a generic "open" count).
 */
export function describeChipDueBadges({
  name,
  total,
  totalLabel,
  dueToday,
  overdue,
}: {
  name: string
  total: number
  totalLabel: string | null
  dueToday: number
  overdue: number
}): string {
  const parts = [totalLabel ? `${total} ${totalLabel}` : `${total} due today`]
  if (dueToday > 0 && totalLabel) parts.push(`${dueToday} due today`)
  if (overdue > 0) parts.push(`${overdue} overdue`)
  return `${name}: ${parts.join(', ')}`
}
