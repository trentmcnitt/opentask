'use client'

/**
 * THE SORT PILL (Trent, 2026-10-28): fixed bottom-left in Today and Scan,
 * "Sort: Newest". One sort for the mode (`src/lib/modes/sorts.ts`): it
 * re-orders the category sections (Pulled, the horizon sections, On deck);
 * the sections that ARE an order (Today, Newest, Coming up) keep theirs
 * unless "Sort every section" is on. Remembered per device
 * (`useDashboardMode`).
 *
 * Placement mirrors the right-hand FAB stack (`DashboardFabStack`): on a
 * phone 4.5rem above the safe area, clear of the bottom tab bar; from `md`
 * up 1.5rem from the bottom, just right of the 14rem sidebar. The host hides
 * it while rows are selected, when the action bar takes the bottom.
 */
import { ArrowUpDown, ChevronDown } from 'lucide-react'
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
import { isSortId, SORT_ORDER, SORTS, type ModeSort } from '@/lib/modes/sorts'

export function SortPill({ sort, onSort }: { sort: ModeSort; onSort: (s: ModeSort) => void }) {
  return (
    <div className="fixed bottom-[calc(env(safe-area-inset-bottom,0px)+4.5rem)] left-4 z-40 md:bottom-6 md:left-[calc(14rem+1.5rem)]">
      <DropdownMenu>
        <DropdownMenuTrigger
          data-sort-pill
          className="bg-background/90 text-foreground flex h-10 items-center gap-1.5 rounded-full border border-black/12 px-3.5 text-sm font-medium shadow-md backdrop-blur hover:bg-white dark:border-white/15 dark:hover:bg-zinc-800"
        >
          <ArrowUpDown className="text-muted-foreground size-4" aria-hidden />
          Sort: {SORTS[sort.id].label}
          <ChevronDown className="text-muted-foreground size-3.5" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-60">
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
      </DropdownMenu>
    </div>
  )
}
