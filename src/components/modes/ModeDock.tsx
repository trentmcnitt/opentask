'use client'

/**
 * THE VIEW PILL (Trent, 2026-10-30, P1 of `.tmp/mode-switch/`: "getting to
 * the Today, Scan, and All buttons in the top left is way too far for my
 * thumb"; then "I wanted the one that I think just showed the current one…
 * I'm okay with the two taps. I like the more compact view that P1 had").
 * One pill, fixed bottom-left where the sort pill was, saying what you are
 * looking at — "Today ⌄", "Scan · Newest ⌄" (Scan's sort), "All · Now ⌄"
 * (All's order). A tap opens a small menu upward:
 *
 * - VIEW: Today, Scan, All, each with a one-line hint, the current one ✓.
 * - Then that view's own choices: Today, the sort of On deck; Scan, the sort
 *   of Pulled and the horizon sections, and "Sort every section"; All, its
 *   order — Now or Newest (the toggle that sat at the top of the list).
 *
 * It replaced the Today · Scan · All switch under the add box, the sort pill,
 * and All's Now / Newest toggle. The mode itself is unchanged
 * (`useDashboardMode`: per device, `?mode=`); All's order is the user's
 * `default_grouping`, saved as the toggle saved it. Placement mirrors the
 * right-hand FAB column (`DashboardFabStack`): on a phone 4.5rem above the
 * safe area, clear of the tab bar; from `md` up 1.5rem from the bottom,
 * right of the 14rem sidebar. The host hides it while a select bar is up.
 */
import { useState, type ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { GroupingMode } from '@/lib/grouping'
import { MODE_LABELS, MODE_ORDER } from '@/lib/modes/registry'
import { SORT_ORDER, SORTS, type ModeSort } from '@/lib/modes/sorts'
import type { ModeId } from '@/lib/modes/types'
import { cn } from '@/lib/utils'

/** Each view's line in the menu (the mockup's words). */
const VIEW_HINTS: Record<ModeId, string> = {
  today: "What's late, today, and on deck",
  'pick-mode': 'Pulled, newest, coming up, by horizon',
  all: 'Every task: Now or Newest',
}

/** All's two orders, with their lines. */
const ALL_ORDERS: readonly { value: GroupingMode; label: string; hint: string }[] = [
  { value: 'project', label: 'Now', hint: 'What matters now, by project' },
  { value: 'new', label: 'Newest', hint: 'Everything, newest added first' },
]

/**
 * The menu keeps the page's 16px gutter from the screen's edges, plus the
 * safe-area inset (a phone held sideways), so it never touches the bezel.
 * The insets are read from a probe: `env()` only resolves inside a CSS
 * property.
 */
const GUTTER = 16
type Gutter = { left: number; right: number }
function menuGutter(): Gutter {
  const probe = document.createElement('div')
  probe.style.cssText =
    'position:fixed;visibility:hidden;padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px)'
  document.body.appendChild(probe)
  const style = getComputedStyle(probe)
  const gutter = {
    left: GUTTER + (parseFloat(style.paddingLeft) || 0),
    right: GUTTER + (parseFloat(style.paddingRight) || 0),
  }
  probe.remove()
  return gutter
}

/** What the pill says after the view: Scan's sort, or All's order. */
function pillWords(mode: ModeId, sort: ModeSort, grouping: GroupingMode): string | null {
  if (mode === 'pick-mode') return SORTS[sort.id].label
  if (mode === 'all') return ALL_ORDERS.find((o) => o.value === grouping)?.label ?? null
  return null
}

export function ModeDock({
  mode,
  onMode,
  sort,
  onSort,
  grouping,
  onGrouping,
}: {
  mode: ModeId
  onMode: (mode: ModeId) => void
  sort: ModeSort
  onSort: (sort: ModeSort) => void
  /** All's order: the dashboard's grouping (Now = 'project', Newest = 'new'). */
  grouping: GroupingMode
  onGrouping: (grouping: GroupingMode) => void
}) {
  const [gutter, setGutter] = useState<Gutter>({ left: GUTTER, right: GUTTER })
  const second = pillWords(mode, sort, grouping)
  return (
    <div
      data-mode-dock
      className="fixed bottom-[calc(env(safe-area-inset-bottom,0px)+4.5rem)] left-4 z-40 md:bottom-6 md:left-[calc(14rem+1.5rem)]"
    >
      <DropdownMenu onOpenChange={(open) => open && setGutter(menuGutter())}>
        <DropdownMenuTrigger
          data-mode-pill={mode}
          aria-label={`View: ${MODE_LABELS[mode]}${second ? `, ${second}` : ''}. Change`}
          className="bg-background/90 text-foreground flex h-10 items-center gap-1.5 rounded-full border border-black/12 px-3.5 text-sm font-medium shadow-md backdrop-blur hover:bg-white dark:border-white/15 dark:hover:bg-zinc-800"
        >
          {MODE_LABELS[mode]}
          {second && (
            <span className="text-muted-foreground font-normal">
              <span aria-hidden>· </span>
              {second}
            </span>
          )}
          <ChevronDown className="text-muted-foreground size-3.5" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          collisionPadding={gutter}
          className="w-72"
          data-mode-menu
        >
          <GroupLabel>View</GroupLabel>
          {MODE_ORDER.map((id) => (
            <Choice
              key={id}
              checked={mode === id}
              onSelect={() => onMode(id)}
              data={{ 'data-mode': id }}
              hint={VIEW_HINTS[id]}
            >
              {MODE_LABELS[id]}
            </Choice>
          ))}
          <DropdownMenuSeparator />
          {mode === 'all' ? (
            <>
              <GroupLabel>All: order</GroupLabel>
              {ALL_ORDERS.map((o) => (
                <Choice
                  key={o.value}
                  checked={grouping === o.value}
                  onSelect={() => onGrouping(o.value)}
                  data={{ 'data-all-order': o.value }}
                  hint={o.hint}
                >
                  {o.label}
                </Choice>
              ))}
            </>
          ) : (
            <SortChoices mode={mode} sort={sort} onSort={onSort} />
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/**
 * Today's and Scan's sort (Trent, 2026-10-28; `src/lib/modes/sorts.ts`): it
 * re-orders the category sections — On deck in Today; Pulled and the horizon
 * sections in Scan, where "Sort every section" also orders the sections that
 * ARE an order (Newest, Coming up). Two columns, as the mockup.
 */
function SortChoices({
  mode,
  sort,
  onSort,
}: {
  mode: ModeId
  sort: ModeSort
  onSort: (s: ModeSort) => void
}) {
  return (
    <>
      <GroupLabel>
        {mode === 'today' ? 'Sort On deck by' : 'Sort Pulled and horizons by'}
      </GroupLabel>
      <div className="grid grid-cols-2">
        {SORT_ORDER.map((id) => (
          <Choice
            key={id}
            checked={sort.id === id}
            onSelect={() => onSort({ ...sort, id })}
            data={{ 'data-sort-option': id }}
          >
            {SORTS[id].label}
          </Choice>
        ))}
      </div>
      {mode === 'pick-mode' && (
        <Choice
          checked={sort.everywhere}
          checkbox
          onSelect={() => onSort({ ...sort, everywhere: !sort.everywhere })}
          data={{ 'data-sort-everywhere': '' }}
        >
          Sort every section
        </Choice>
      )}
    </>
  )
}

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <DropdownMenuLabel className="text-muted-foreground text-xs tracking-wider uppercase">
      {children}
    </DropdownMenuLabel>
  )
}

/** One choice: a ✓ when it is the current one, its words, and an optional line under them. */
function Choice({
  checked,
  checkbox = false,
  onSelect,
  hint,
  data,
  children,
}: {
  checked: boolean
  /** An on/off choice ("Sort every section"), not one of a group. */
  checkbox?: boolean
  onSelect: () => void
  hint?: string
  data: Record<string, string>
  children: ReactNode
}) {
  return (
    <DropdownMenuItem
      role={checkbox ? 'menuitemcheckbox' : 'menuitemradio'}
      aria-checked={checked}
      data-state={checked ? 'checked' : 'unchecked'}
      onSelect={onSelect}
      className={cn('items-start gap-2 py-1.5 pl-2', checked && hint && 'bg-accent/60')}
      {...data}
    >
      <Check className={cn('mt-0.5 size-4 shrink-0', !checked && 'invisible')} aria-hidden />
      <span className="flex flex-col">
        <span>{children}</span>
        {hint && <span className="text-muted-foreground text-xs">{hint}</span>}
      </span>
    </DropdownMenuItem>
  )
}
