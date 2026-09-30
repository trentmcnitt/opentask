'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { cadenceMark } from '@/lib/reminder-rule'
import { scrollRowIntoView } from '@/lib/scroll-row-into-view'
import type { Task } from '@/types'

/** Handlers the search view deliberately does nothing with. */
export const NO_OP = () => {}

/**
 * The reminders that are not today's — a weekly thought on its off day, a
 * monthly one mid-month — folded at the bottom, so every thought stays
 * reachable from its own surface. Rows carry their cadence mark (the reason
 * they are not today's) and open the editor on click; there is no circle,
 * because there is nothing to consider today.
 */
export function NotTodayFold({
  items,
  onOpen,
  forceOpen = false,
  requestOpen = false,
  highlightId = null,
  onHighlightDone = NO_OP,
}: {
  items: Task[]
  onOpen: (task: Task) => void
  /** Search results are shown, never folded away. */
  forceOpen?: boolean
  /**
   * A deep link landed on a thought that lives in here. Opens the fold once,
   * and then gets out of the way — unlike `forceOpen`, which also takes the
   * toggle away, and the user must be able to fold this again.
   */
  requestOpen?: boolean
  /** The deep-linked row: scrolled to and flashed, as in a slot. */
  highlightId?: number | null
  /** The flash has played and must not play again on a remount. */
  onHighlightDone?: () => void
}) {
  // `requestOpen` moves the DEFAULT rather than forcing the fold: a deep link
  // opens it, and the moment the user touches the caret their answer (null
  // until then) takes over, so the link can never hold it open against them.
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = forceOpen || (userOpen ?? requestOpen)
  const toggle = () => {
    if (!forceOpen) setUserOpen(!open)
  }
  return (
    <div className="bg-muted/30 mt-3 rounded-2xl pb-1" data-not-today>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="hover:text-foreground flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors"
      >
        <span className="text-muted-foreground flex size-6 shrink-0 items-center justify-center">
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </span>
        <span className="text-muted-foreground text-xs font-semibold tracking-wider uppercase">
          Not today
        </span>
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">{items.length}</span>
      </button>
      {open && (
        <ul className="space-y-0.5 px-1">
          {items.map((task) => {
            const mark = cadenceMark(task.rrule)
            const highlighted = highlightId === task.id
            return (
              <li
                key={task.id}
                data-not-today-id={task.id}
                data-reminder-highlight={highlighted ? '' : undefined}
                ref={highlighted ? scrollRowIntoView : undefined}
                onAnimationEnd={(e) => {
                  if (e.target === e.currentTarget && e.animationName === 'row-highlight') {
                    onHighlightDone()
                  }
                }}
                className={cn('rounded-xl', highlighted && 'animate-row-highlight')}
              >
                <button
                  type="button"
                  onClick={() => onOpen(task)}
                  className="hover:bg-foreground/[0.04] flex w-full items-start gap-3 rounded-xl px-2 py-2.5 text-left transition-colors"
                >
                  <span className="mt-[3px] size-6 shrink-0" aria-hidden />
                  <p className="text-foreground/70 min-w-0 flex-1 text-[16px] leading-6">
                    <span className="text-pretty">{task.title}</span>
                    {mark && (
                      <span
                        className="text-muted-foreground/60 ml-2 text-xs whitespace-nowrap"
                        title={mark.full}
                        data-cadence-mark
                      >
                        {mark.short}
                      </span>
                    )}
                  </p>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
