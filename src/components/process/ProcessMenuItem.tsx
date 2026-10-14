'use client'

import { useEffect } from 'react'
import { ListChecks } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { fetchProcess } from '@/lib/process-client'

/**
 * The top bar menu's "Process" entry (2026-10-10, spec §5). In the menu
 * because it is the one control every surface's top bar shares, at every
 * width — on a phone, its own block under Add Task (mockup P1, 2026-10-14).
 *
 * No count (2026-10-14, Trent: "I don't like the count"), the same plain row
 * as the left bar's Process. Opening the menu still reads `/api/process` (the
 * menu content mounts then, never on page load), which fills the cache the
 * modal paints from — so the modal opened from here usually starts with its
 * data.
 */
export function ProcessMenuItem({ onSelect }: { onSelect: () => void }) {
  useEffect(() => {
    fetchProcess().catch(() => {})
  }, [])

  return (
    <DropdownMenuItem onClick={onSelect} data-process-menu-item>
      <ListChecks className="size-4" />
      Process
    </DropdownMenuItem>
  )
}
