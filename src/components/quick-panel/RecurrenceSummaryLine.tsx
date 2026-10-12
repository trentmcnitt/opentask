'use client'

import type { ReactNode } from 'react'
import { Repeat } from 'lucide-react'
import { cn } from '@/lib/utils'
import { TARGET_WORD } from '@/lib/task-model-words'

/** The id the summary line and the Repeat button point `aria-controls` at. */
export const RECURRENCE_EDITOR_ID = 'quick-panel-recurrence-editor'

/**
 * The editor's recurrence line ("Target Sundays at 9:00 AM · since yesterday",
 * or "One time"), and the way into the recurrence editor (2026-10-12).
 *
 * WHY THE TEXT IS THE CONTROL. The editor used to open only from the Repeat
 * button, which was painted solid blue whenever the task recurred. Blue-and-
 * filled reads as "on", so tapping it looked like it would turn recurrence OFF
 * — Trent couldn't tell whether it toggled, scrolled or opened something. Now
 * the summary itself opens the editor: a soft background box says it can be
 * tapped (Trent's rule: affordance from the text, not a glyph beside it), and
 * the box darkens while the editor is open, which is all the state it carries.
 *
 * WHY "TARGET". On a recurring task the rule's time of day is each
 * occurrence's target (when it starts nagging); a deadline, if any, is its own
 * line and moves with the occurrence. Saying so is what tells the user where a
 * "late morning, but before bed" pair goes.
 *
 * The "since" age stays OUTSIDE the button: it has its own tap (a popover with
 * the origin reset), and a tap on it must not also open the editor.
 */
export function RecurrenceSummaryLine({
  text,
  isRecurring,
  isOneTime,
  dirty,
  canEdit,
  expanded,
  onToggle,
  since,
  className,
}: {
  text: string
  /** A single task with a rule: prefixed with the target word. */
  isRecurring: boolean
  isOneTime: boolean
  dirty: boolean
  canEdit: boolean
  expanded: boolean
  onToggle: () => void
  since?: ReactNode
  className?: string
}) {
  const content = (
    <>
      {!isOneTime && <Repeat className="mr-1 inline size-3 align-[-2px]" />}
      {isRecurring && (
        <>
          <span className={cn(!dirty && 'text-muted-foreground/70')}>{TARGET_WORD}</span>{' '}
        </>
      )}
      {text}
    </>
  )
  return (
    <p
      className={cn(
        'text-xs select-text',
        dirty
          ? 'font-medium text-blue-500'
          : isOneTime
            ? 'text-muted-foreground/60'
            : 'text-muted-foreground',
        className,
      )}
    >
      {canEdit ? (
        <button
          type="button"
          data-quick-panel-recurrence
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={RECURRENCE_EDITOR_ID}
          aria-label={`${expanded ? 'Close' : 'Edit'} recurrence: ${isRecurring ? `${TARGET_WORD} ` : ''}${text}`}
          className={cn(
            '-mx-1.5 cursor-pointer rounded px-1.5 py-0.5 text-left transition-colors',
            expanded
              ? cn('bg-accent', !dirty && 'text-foreground')
              : 'bg-muted/60 hover:bg-accent active:bg-accent',
          )}
        >
          {content}
        </button>
      ) : (
        content
      )}
      {since}
    </p>
  )
}
