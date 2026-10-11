'use client'

import { useEffect, useState } from 'react'
import { ListChecks } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { cachedProcessData, fetchProcess, processItemCount } from '@/lib/process-client'

/**
 * The top bar menu's "Process" entry (2026-10-10, spec §5). In the menu
 * because it is the one control every surface's top bar shares, at every
 * width — the AI Status item's sibling.
 *
 * The count hint is read when the menu opens (the menu content mounts then),
 * never on page load, and fills the cache the modal paints from — so the
 * modal opened from here usually starts with its data. No number when there
 * is nothing to do.
 */
export function ProcessMenuItem({ onSelect }: { onSelect: () => void }) {
  const [count, setCount] = useState<number | null>(() => {
    const cached = cachedProcessData()
    return cached ? processItemCount(cached) : null
  })

  useEffect(() => {
    let cancelled = false
    fetchProcess()
      .then((d) => !cancelled && setCount(processItemCount(d)))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <DropdownMenuItem onClick={onSelect} data-process-menu-item>
      <ListChecks className="size-4" />
      Process
      {count !== null && count > 0 && (
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">{count}</span>
      )}
    </DropdownMenuItem>
  )
}
