'use client'

import { useCallback, useEffect } from 'react'
import { Check } from 'lucide-react'
import { cn, fromRowControl } from '@/lib/utils'
import { cadenceMark } from '@/lib/reminder-rule'
import { scrollRowIntoView } from '@/lib/scroll-row-into-view'
import type { QuotaPrompt } from '@/lib/quota-prompts'
import { NotesMarker } from '@/components/NotesMarker'
import { Checkbox } from '@/components/ui/checkbox'
import { useLongPress } from '@/hooks/useLongPress'
import {
  focusAfterRow,
  measureLeavingRow,
  onSurfaceRowAnimationEnd,
} from '@/components/reminders/row-shell'
import type { Task } from '@/types'

/**
 * Everything a reminder row can ask the surface to do.
 *
 * One object rather than nine props, because the same set is threaded
 * unchanged through the slot groups and the search view, and a chain that long
 * drifts: it is how `onLeft` reached the rows in a slot before it reached the
 * ones in a search result.
 */
export interface ReminderRowHandlers {
  onSelect: (task: Task) => void
  onRangeSelect: (task: Task) => void
  onOpen: (task: Task) => void
  onComplete: (task: Task) => void
  onRetry: (task: Task) => void
  /** This row has finished collapsing and may leave the list. */
  onLeft: (id: number) => void
  /** The deep link's flash has played; it must not play again on a remount. */
  onHighlightDone: () => void
  /** Report that a row is on screen; returns its own deregistration. */
  onRegister: (id: number) => () => void
  /**
   * Draw one waiting quota prompt (2026-09-24). Threaded with the row
   * handlers because it goes everywhere they go — every slot group, the
   * search view — and is not spread onto `ReminderRow`.
   */
  renderPrompt: (prompt: QuotaPrompt) => React.ReactNode
  /** Put a handled quota prompt back (2026-09-25) — threaded the same way. */
  onPutBackPrompt: (prompt: QuotaPrompt) => void
}

/**
 * A row's own classes.
 *
 * The load-bearing part is the animation. `animation` is ONE property and three
 * of these set it, so they must never be on the row together: the last one
 * defined in the stylesheet would win and the others would simply not run.
 * That matters beyond looks — the leaving animation's `animationend` is what
 * removes the row and releases the surface's held refresh, so an AI pulse
 * quietly beating it would strand a struck-through row and switch refreshing
 * off for the rest of the session. While a row is leaving, leaving is the only
 * animation it gets.
 */
function reminderRowClasses({
  completing,
  selected,
  highlighted,
  aiProcessing,
}: {
  completing: boolean
  selected: boolean
  highlighted: boolean
  aiProcessing: boolean
}): string {
  return cn(
    // The border is always there, transparent, so the processing pulse has
    // something to color without the row shifting by a pixel.
    'group flex cursor-pointer items-start gap-3 rounded-xl border border-transparent px-2 py-2.5 select-none',
    'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
    selected ? 'ring-ring bg-accent ring-2' : 'hover:bg-foreground/[0.04]',
    completing && 'animate-reminder-leaving pointer-events-none',
    !completing && aiProcessing && 'animate-ai-processing',
    !completing && highlighted && 'animate-row-highlight',
  )
}

/**
 * A row's gestures (Trent, 2026-09-11): "I should be able to just tap reminders
 * pretty much anywhere to mark them done. I can press and hold any item to turn
 * on select mode, a little bit like the way tasks are set up… If you want to
 * actually get the details, I guess we just tap and hold and then click Details
 * with the item checked."
 *
 * So a tap considers, a hold selects, and details are one step further in. The
 * hold is the dashboard's own `useLongPress` at the same 400ms with the same
 * jitter tolerance; `didFire()` swallows the click the browser synthesises
 * afterwards, without which every hold would also consider the thought it had
 * just selected.
 *
 * It lives in a hook because the row is already near ESLint's function-length
 * limit, and because the two halves — what a pointer means and what a key
 * means — read better side by side than buried in the markup.
 */
function useReminderRowGestures({
  reminder,
  completing,
  highlighted,
  isSelectionMode,
  onComplete,
  onSelect,
  onRangeSelect,
  onOpen,
  onLeft,
  onHighlightDone,
}: {
  reminder: Task
  /** Already considered and on its way out — every gesture is a no-op. */
  completing: boolean
  highlighted: boolean
  isSelectionMode: boolean
  onComplete: (task: Task) => void
  onSelect: (task: Task) => void
  onRangeSelect: (task: Task) => void
  onOpen: (task: Task) => void
  onLeft: (id: number) => void
  onHighlightDone: () => void
}) {
  // In selection mode the hold extends the range from the anchor, exactly as on
  // the dashboard; out of it, the hold is what turns selection mode on.
  const onLongPress = useCallback(() => {
    if (isSelectionMode) onRangeSelect(reminder)
    else onSelect(reminder)
  }, [isSelectionMode, onRangeSelect, onSelect, reminder])
  const pointer = useLongPress({ onLongPress })

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      // The hold already acted; swallow the click it left behind.
      if (pointer.didFire()) {
        e.preventDefault()
        return
      }
      // The circle, the checkbox and Retry own their own clicks.
      if (fromRowControl(e)) return
      // A row on its way out is inert to pointers in CSS as well; this is the
      // same answer for anything that gets past that.
      if (completing) return
      // A held modifier never completes: it is the mouse's fast way into a
      // selection, and a slip that considered a thought is the one mistake
      // this surface should not make.
      if (e.shiftKey) onRangeSelect(reminder)
      else if (e.metaKey || e.ctrlKey || isSelectionMode) onSelect(reminder)
      else onComplete(reminder)
    },
    [pointer, completing, isSelectionMode, onComplete, onSelect, onRangeSelect, reminder],
  )

  /**
   * Keyboard: the row is the tab stop, Enter/Space is the tap (considered, or
   * the checkbox once selection mode is on), and Cmd/Ctrl+Enter opens details —
   * the one thing hold-then-Details cannot offer a keyboard.
   */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Enter on the circle or on Retry has already done its work; the same
      // keystroke bubbles here and must not do it a second time.
      if (e.target !== e.currentTarget) return
      // Focus stays on a row while it collapses (the browser does not move it
      // just because tabindex went to -1), so a second Enter inside those
      // 180ms would ask for a second completion — and a recurring reminder
      // would advance two occurrences for one intention.
      if (completing) return
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        onOpen(reminder)
        return
      }
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      if (isSelectionMode) {
        onSelect(reminder)
        return
      }
      // Hand focus on before the row goes, or it falls to <body> and the next
      // Tab starts again from the top of the page.
      focusAfterRow(e.currentTarget as HTMLElement)
      onComplete(reminder)
    },
    [completing, isSelectionMode, onComplete, onSelect, onOpen, reminder],
  )

  /**
   * What an animation ending on this row MEANS — the shared reading in
   * `onSurfaceRowAnimationEnd` (the list closes the gap once the row has
   * visibly gone; the deep link's flash is spent once it has played).
   */
  const onAnimationEnd = useCallback(
    (e: React.AnimationEvent) =>
      onSurfaceRowAnimationEnd(e, { id: reminder.id, highlighted, onLeft, onHighlightDone }),
    [highlighted, onHighlightDone, onLeft, reminder.id],
  )

  return { pointer, onClick, onKeyDown, onAnimationEnd }
}

/**
 * The 24px mark at the head of a row, in its three states.
 *
 * Leaving: a filled check, aria-hidden — it is the answer to the tap, not
 * something still to press. Selection mode: a check box, as the dashboard's
 * done button becomes. Otherwise: the circle, which considers this one item
 * and never touches the selection, so it stops the row's click from reaching
 * the row handler — and its pointer events too, or holding it would turn
 * selection mode on underneath and swap the button out mid-press.
 */
function ReminderRowMarker({
  reminder,
  completing,
  selected,
  isSelectionMode,
  onSelect,
  onComplete,
}: {
  reminder: Task
  completing: boolean
  selected: boolean
  isSelectionMode: boolean
  onSelect: (task: Task) => void
  onComplete: (task: Task) => void
}) {
  if (completing) {
    return (
      <span
        aria-hidden
        className="mt-[3px] flex size-6 shrink-0 items-center justify-center rounded-full bg-green-600 text-white"
      >
        <Check className="size-3.5" strokeWidth={3} />
      </span>
    )
  }
  if (isSelectionMode) {
    return (
      <Checkbox
        checked={selected}
        onCheckedChange={() => onSelect(reminder)}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        aria-label={`Select "${reminder.title}"`}
        className="mt-[3px] size-6 shrink-0 cursor-pointer"
      />
    )
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onComplete(reminder)
      }}
      onPointerDown={(e) => e.stopPropagation()}
      // The row itself is the tab stop and Enter/Space on it does exactly what
      // this button does, so a second stop per row would be pure duplication on
      // a surface that can hold seventy of them.
      tabIndex={-1}
      aria-label={`Mark "${reminder.title}" as considered`}
      title="Considered"
      className="border-foreground/20 hover:border-foreground/60 hover:bg-foreground/5 mt-[3px] flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full border-[1.5px] transition-colors"
    >
      <Check
        className="group-hover:text-foreground/40 size-3.5 text-transparent transition-colors"
        strokeWidth={3}
      />
    </button>
  )
}

export function ReminderRow({
  reminder,
  completing,
  selected,
  isSelectionMode,
  highlighted,
  onSelect,
  onRangeSelect,
  onOpen,
  onComplete,
  onRetry,
  onLeft,
  onHighlightDone,
  onRegister,
}: {
  reminder: Task
  completing: boolean
  selected: boolean
  isSelectionMode: boolean
  /** Deep-linked from the widget: scroll to it and flash it once. */
  highlighted: boolean
  onSelect: (task: Task) => void
  onRangeSelect: (task: Task) => void
  onOpen: (task: Task) => void
  onComplete: (task: Task) => void
  onRetry: (task: Task) => void
  /** This row has finished collapsing and may leave the list. */
  onLeft: (id: number) => void
  /** The deep link's flash has played; it must not play again on a remount. */
  onHighlightDone: () => void
  /** Report that this row is on screen; returns its own deregistration. */
  onRegister: (id: number) => () => void
}) {
  const hasNotes = !!reminder.notes?.trim()
  const mark = cadenceMark(reminder.rrule)
  // The AI's processing state, carried on the same labels a task uses. The
  // surface shows no labels, so the two states that matter get their own
  // marks: the pulse the task row wears while the AI is reading, and a line
  // under the title when it gave up. The second one is the important one —
  // the quick add already put this thought in a slot with a plausible daily
  // rule, so without a mark a failure would look exactly like success.
  const aiProcessing = reminder.labels.includes('ai-to-process')
  const aiFailed = reminder.labels.includes('ai-failed')

  const { pointer, onClick, onKeyDown, onAnimationEnd } = useReminderRowGestures({
    reminder,
    completing,
    highlighted,
    isSelectionMode,
    onComplete,
    onSelect,
    onRangeSelect,
    onOpen,
    onLeft,
    onHighlightDone,
  })

  // The animation is what normally releases the row, but a row can be taken
  // off screen before it ends — a slot folded, the surface navigated away
  // from. Reporting it on unmount too means a considered thought can never be
  // left half-gone, and can never hold the surface's refresh shut.
  const id = reminder.id
  useEffect(() => {
    if (!completing) return
    return () => onLeft(id)
  }, [completing, onLeft, id])

  // Being on screen is what qualifies a row to hold its place when it is
  // considered — and to hold the surface's refresh with it. A row that is not
  // rendered (a folded slot, or under a "Show all N" cap) cannot report its
  // animation finishing, so the surface must know which rows these are rather
  // than assume every completed id has one. See `completeIds`.
  useEffect(() => onRegister(id), [onRegister, id])

  return (
    <li
      data-reminder-id={reminder.id}
      data-reminder-highlight={highlighted ? '' : undefined}
      data-reminder-leaving={completing ? '' : undefined}
      ref={completing ? measureLeavingRow : highlighted ? scrollRowIntoView : undefined}
      role="option"
      aria-selected={selected}
      // Struck through, inert, and out of the tab order the moment it is
      // considered: what is on screen is a record of what just happened, not
      // something still to act on.
      aria-disabled={completing || undefined}
      // The row is the keyboard's way in — it has to be focusable for
      // Enter/Space to reach it at all, and it is what a screen reader reads.
      tabIndex={completing ? -1 : 0}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onPointerDown={pointer.onPointerDown}
      onPointerUp={pointer.onPointerUp}
      onPointerMove={pointer.onPointerMove}
      onPointerLeave={pointer.onPointerLeave}
      onPointerCancel={pointer.onPointerUp}
      onAnimationEnd={onAnimationEnd}
      className={reminderRowClasses({ completing, selected, highlighted, aiProcessing })}
      data-ai-state={aiProcessing ? 'processing' : aiFailed ? 'failed' : undefined}
    >
      <ReminderRowMarker
        reminder={reminder}
        completing={completing}
        selected={selected}
        isSelectionMode={isSelectionMode}
        onSelect={onSelect}
        onComplete={onComplete}
      />
      {/* The notes marker sits inline after the title — see `NotesMarker`. */}
      <p className={cn('min-w-0 flex-1 text-[16px] leading-6', completing && 'line-through')}>
        <span
          className={cn(
            'text-pretty',
            completing ? 'text-muted-foreground' : prominenceClasses(reminder.priority),
          )}
        >
          {reminder.title}
        </span>
        {/* Not every day: the day codes, "Monthly", "Once". Daily wears nothing. */}
        {mark && (
          <span
            className="text-muted-foreground/60 ml-2 text-xs whitespace-nowrap"
            title={mark.full}
            data-cadence-mark
          >
            {mark.short}
          </span>
        )}
        {hasNotes && <NotesMarker />}
        {aiFailed && (
          <span className="text-muted-foreground mt-0.5 block text-xs" data-ai-failed>
            The AI didn&rsquo;t read this. It&rsquo;s daily in this slot until you edit it.
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onRetry(reminder)
              }}
              onPointerDown={(e) => e.stopPropagation()}
              className="text-foreground/80 hover:text-foreground ml-1.5 underline underline-offset-2"
            >
              Retry
            </button>
          </span>
        )}
      </p>
    </li>
  )
}

/**
 * §6: priority is expressed as weight and contrast, never as alarm.
 *
 * The scale is deliberately shallow — three steps across five priorities — so
 * the top of a slot reads as "start here", not as "this one is shouting".
 */
function prominenceClasses(priority: number): string {
  if (priority >= 3) return 'text-foreground font-medium'
  if (priority === 2) return 'text-foreground'
  return 'text-foreground/70'
}
