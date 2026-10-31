'use client'

/**
 * THE MODE DOCK (Trent, 2026-10-30, P2 of `.tmp/mode-switch/`: "getting to
 * the Today, Scan, and All buttons in the top left is way too far for my
 * thumb" … "P2 is what I like"). Fixed bottom-left, where the sort pill was:
 *
 * - Today | Scan | All, a compact segmented control — one tap switches, the
 *   mode shown filled. It replaced the switch under the add box.
 * - Sort, a round ⇅ at its right end, in Today (On deck's order) and Scan
 *   (Pulled and the horizon sections) — the same menu the "Sort: Newest" pill
 *   opened (`SortMenuContent`). All has none: its Now / Newest stays at the
 *   top of the list.
 *
 * The mode itself is unchanged (`useDashboardMode`: per device, `?mode=`).
 * Placement mirrors the right-hand FAB column (`DashboardFabStack`): on a
 * phone 4.5rem above the safe area, clear of the tab bar; from `md` up 1.5rem
 * from the bottom, right of the 14rem sidebar. The host hides it while a
 * select bar is up, which takes the bottom.
 */
import { ArrowUpDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { MODE_LABELS, MODE_ORDER } from '@/lib/modes/registry'
import { isSortId, SORT_ORDER, SORTS, type ModeSort } from '@/lib/modes/sorts'
import type { ModeId } from '@/lib/modes/types'
import { cn } from '@/lib/utils'

/** The floating surfaces' shared look: a translucent card with a hairline and a shadow. */
const FLOAT = 'bg-background/90 border border-black/12 shadow-md backdrop-blur dark:border-white/15'

export function ModeDock({
  mode,
  onMode,
  sort,
  onSort,
}: {
  mode: ModeId
  onMode: (mode: ModeId) => void
  sort: ModeSort
  onSort: (sort: ModeSort) => void
}) {
  // Today and Scan have a sort (`modes.sectioned`); All has its own view toggle.
  const sorts = mode !== 'all'
  return (
    <div
      data-mode-dock
      className="fixed bottom-[calc(env(safe-area-inset-bottom,0px)+4.5rem)] left-4 z-40 flex items-center gap-2 md:bottom-6 md:left-[calc(14rem+1.5rem)]"
    >
      <div
        role="group"
        aria-label="Dashboard mode"
        data-mode-switch
        className={cn(FLOAT, 'flex h-10 items-center gap-0.5 rounded-full p-1')}
      >
        {MODE_ORDER.map((id) => {
          const active = mode === id
          return (
            <button
              key={id}
              type="button"
              data-mode={id}
              onClick={() => onMode(id)}
              aria-pressed={active}
              className={cn(
                'h-8 rounded-full px-3 text-sm font-medium transition-colors',
                active
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {MODE_LABELS[id]}
            </button>
          )
        })}
      </div>
      {sorts && (
        <DropdownMenu>
          <DropdownMenuTrigger
            data-sort-button
            aria-label={`Sort: ${SORTS[sort.id].label}`}
            title={`Sort: ${SORTS[sort.id].label}`}
            className={cn(
              FLOAT,
              'text-foreground flex size-10 items-center justify-center rounded-full hover:bg-white dark:hover:bg-zinc-800',
            )}
          >
            <ArrowUpDown className="size-4" aria-hidden />
          </DropdownMenuTrigger>
          <SortMenuContent sort={sort} onSort={onSort} />
        </DropdownMenu>
      )}
    </div>
  )
}

/**
 * The mode's sort menu (Trent, 2026-10-28; `src/lib/modes/sorts.ts`): one sort
 * re-orders the category sections (Pulled, the horizon sections, On deck);
 * the sections that ARE an order (Today, Newest, Coming up) keep theirs
 * unless "Sort every section" is on. Remembered per device.
 */
function SortMenuContent({ sort, onSort }: { sort: ModeSort; onSort: (s: ModeSort) => void }) {
  return (
    <DropdownMenuContent side="top" align="end" className="w-60">
      <DropdownMenuLabel>Sort sections by</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={sort.id}
        onValueChange={(v) => {
          if (isSortId(v)) onSort({ ...sort, id: v })
        }}
      >
        {SORT_ORDER.map((id) => (
          <DropdownMenuRadioItem key={id} value={id} data-sort-option={id}>
            {SORTS[id].label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuCheckboxItem
        checked={sort.everywhere}
        onCheckedChange={(checked) => onSort({ ...sort, everywhere: checked === true })}
        data-sort-everywhere
      >
        Sort every section
      </DropdownMenuCheckboxItem>
    </DropdownMenuContent>
  )
}
