'use client'

import { useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/**
 * "since X" age indicator with hover (desktop) and tap (mobile) popover.
 *
 * Extracted as a separate component to isolate the open state and event
 * handlers from the main QuickActionPanel render (avoids hooks-in-conditionals
 * and keeps the main component clean).
 */
export function SinceAge({
  label,
  timeAgo,
  fullDate,
  onReset,
}: {
  label: string
  timeAgo: string
  fullDate: string
  onReset?: () => void
}) {
  const [open, setOpen] = useState(false)
  const closeTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleOpen = () => {
    if (closeTimeout.current) clearTimeout(closeTimeout.current)
    setOpen(true)
  }
  const handleClose = () => {
    // Small delay so moving from trigger → content doesn't flicker
    closeTimeout.current = setTimeout(() => setOpen(false), 100)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <span
          className="text-muted-foreground/60 cursor-default"
          onClick={() => setOpen((o) => !o)}
          onMouseEnter={handleOpen}
          onMouseLeave={handleClose}
        >
          {' · since '}
          {label}
        </span>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        className="w-auto px-3 py-2 text-xs"
        sideOffset={4}
        onMouseEnter={handleOpen}
        onMouseLeave={handleClose}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col gap-0.5">
          <span>{fullDate}</span>
          <span className="text-muted-foreground">{timeAgo}</span>
          {onReset && (
            <button
              onClick={() => {
                onReset()
                setOpen(false)
              }}
              className="text-muted-foreground hover:text-foreground mt-1 flex items-center gap-1 text-xs"
            >
              <RotateCcw className="size-3" /> Reset origin to current due date
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
