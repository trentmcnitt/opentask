'use client'

/**
 * THE LEAN ROW'S BUTTONS (Trent, 2026-10-28, today-mode rounds 4–6):
 *
 *   (deck) (deck tomorrow) (clock)
 *
 * ONE TIME BUTTON, the plain clock, no word (the sun is gone). A tap:
 * - untargeted: target today (`TargetTodayButton`, the old Today);
 * - a target already due: defer by the default (`useDeferPress`, the card
 *   row's clock);
 * - a target not yet due: the time menu (the same Defer logic).
 * A hold, or a right-click, opens the time menu: the Target menu on an
 * untargeted row, the Defer menu on a targeted one.
 *
 * DESKTOP (a fine pointer): hidden at rest, shown on the row's hover or
 * focus (keyboard focus too: `group-focus-within`). A DECKED row keeps its
 * lit deck icon at rest, PARKED in the rightmost slot (where the clock sits
 * on hover), so "on deck" never floats mid-column; on hover it slides left
 * into the deck slot (180ms ease-out) while deck-tomorrow and the clock fade
 * in after it starts (120ms, 60ms late). Leaving reverses it: the two fade
 * out first, the icon slides back (150ms ease-in). With reduced motion
 * nothing slides: the buttons just appear.
 *
 * PHONE (a coarse pointer): all three always visible, each a 44px target
 * with no gap between them, pulled up into the row's top padding (`-mt`) so
 * the icons sit on the title's first line. They float right and every title
 * line beside a target wraps short of it: no part of a target lies over the
 * title.
 */
import { Clock3 } from 'lucide-react'
import { useDayStart, useTaskQueue } from '@/components/PreferencesProvider'
import { OnDeckButton } from '@/components/OnDeckButton'
import { SnoozeMenu } from '@/components/SnoozeMenu'
import { TargetTodayButton } from '@/components/TargetMenu'
import type { TaskRowProps } from '@/components/TaskRow'
import { DeckTomorrowButton } from '@/components/TaskSegmentRow'
import { useDeferPress } from '@/hooks/useDeferPress'
import { useTimezone } from '@/hooks/useTimezone'
import { deckReplaces, offersDeck, todayReplaces } from '@/lib/deck-menu'
import { clockTap } from '@/lib/lean-clock'
import { cn } from '@/lib/utils'
import type { Task } from '@/types'

/** One slot: 32px with a mouse (34px apart), 44px with a finger (no gap). */
const SLOT =
  'flex size-8 shrink-0 items-center justify-center pointer-coarse:-mt-2.5 pointer-coarse:size-11'
/** The icons, one size in every slot. */
const ICON = 'size-[18px]'
/**
 * Hidden at rest on a fine pointer; shown on the row's hover or focus. The
 * hover's own timing applies on the way in (late and ease-out), the rest
 * state's on the way out (quick, ease-in), so they fade out first.
 */
const REVEAL =
  'transition-opacity duration-100 ease-in motion-reduce:transition-none pointer-fine:opacity-0 pointer-fine:group-hover/lean:opacity-100 pointer-fine:group-hover/lean:delay-[60ms] pointer-fine:group-hover/lean:duration-[120ms] pointer-fine:group-hover/lean:ease-out pointer-fine:group-focus-within/lean:opacity-100'
/**
 * The lit deck icon at rest: two slots right (2 × 34px), in the clock's
 * slot; on hover or focus, home. It slides back a beat after the others
 * start fading.
 */
const PARK =
  'transition-transform delay-[60ms] duration-150 ease-in motion-reduce:transition-none pointer-fine:translate-x-[68px] pointer-fine:group-hover/lean:translate-x-0 pointer-fine:group-hover/lean:delay-0 pointer-fine:group-hover/lean:duration-[180ms] pointer-fine:group-hover/lean:ease-[cubic-bezier(0.2,0.8,0.2,1)] pointer-fine:group-focus-within/lean:translate-x-0'

export function LeanButtons({
  task,
  isOverdue,
  onDeck,
  onTargetAt,
  onSnooze,
  timeSlots,
}: {
  task: Task
  isOverdue: boolean
  onDeck?: TaskRowProps['onDeck']
  onTargetAt?: TaskRowProps['onTargetAt']
  onSnooze: TaskRowProps['onSnooze']
  timeSlots: NonNullable<TaskRowProps['timeSlots']>
}) {
  const timezone = useTimezone()
  const queue = useTaskQueue()
  const showDeck = !!onDeck && queue.loaded && queue.enabled && offersDeck(task)
  const decked = showDeck && !!task.on_deck_day
  const deck = (t: Task, day: string | null | undefined) => onDeck?.(t, day)
  return (
    <div
      data-lean-buttons
      className="float-right ml-2 flex items-center gap-0.5 pointer-coarse:-mr-1.5 pointer-coarse:gap-0"
    >
      {showDeck && (
        <>
          <OnDeckButton
            task={task}
            timezone={timezone}
            onDeck={deck}
            replaces={deckReplaces(task, timezone)}
            className={cn(SLOT, decked ? PARK : REVEAL)}
            iconClassName={ICON}
          />
          <DeckTomorrowButton
            task={task}
            onDeck={deck}
            timezone={timezone}
            panel
            className={cn(SLOT, REVEAL)}
          />
        </>
      )}
      <LeanTimeButton
        task={task}
        isOverdue={isOverdue}
        onTargetAt={onTargetAt}
        onSnooze={onSnooze}
        timeSlots={timeSlots}
      />
    </div>
  )
}

/** The clock: Today on an untargeted row, Defer on a targeted one. */
function LeanTimeButton({
  task,
  isOverdue,
  onTargetAt,
  onSnooze,
  timeSlots,
}: {
  task: Task
  isOverdue: boolean
  onTargetAt?: TaskRowProps['onTargetAt']
  onSnooze: TaskRowProps['onSnooze']
  timeSlots: NonNullable<TaskRowProps['timeSlots']>
}) {
  const timezone = useTimezone()
  const dayStart = useDayStart()
  // `clockTap` is the rule: Today on an untargeted row; else the Defer
  // button, whose press defers a due target and opens the menu otherwise.
  if (onTargetAt && clockTap(task, isOverdue) === 'target-today') {
    return (
      <TargetTodayButton
        task={task}
        timezone={timezone}
        onTargetToday={(t) => onTargetAt(t)}
        onTargetAt={(t, at) => onTargetAt(t, at)}
        replaces={todayReplaces(task, timezone, dayStart)}
        className={cn(SLOT, REVEAL)}
        face={<Clock3 className={ICON} aria-hidden />}
      />
    )
  }
  return (
    <LeanDeferButton task={task} isOverdue={isOverdue} onSnooze={onSnooze} timeSlots={timeSlots} />
  )
}

/** The clock on a targeted row: the card row's Defer button (`useDeferPress`). */
function LeanDeferButton({
  task,
  isOverdue,
  onSnooze,
  timeSlots,
}: {
  task: Task
  isOverdue: boolean
  onSnooze: TaskRowProps['onSnooze']
  timeSlots: NonNullable<TaskRowProps['timeSlots']>
}) {
  const { menuOpen, setMenuOpen, press } = useDeferPress({
    taskId: task.id,
    isOverdue,
    onSnooze,
    timeSlots,
  })
  return (
    <SnoozeMenu
      open={menuOpen}
      onOpenChange={setMenuOpen}
      onSnooze={(until) => onSnooze(task.id, until)}
      deadlineAt={task.deadline_at}
    >
      <button
        type="button"
        data-lean-defer
        data-no-row-press
        onClick={(e) => {
          e.stopPropagation()
          press.onClick()
        }}
        onPointerDown={(e) => {
          e.stopPropagation()
          press.onPointerDown(e)
        }}
        onPointerUp={(e) => {
          e.stopPropagation()
          press.onPointerUp(e)
        }}
        onPointerLeave={press.onPointerLeave}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setMenuOpen(true)
        }}
        aria-label={`Defer "${task.title}" (hold for options)`}
        title={isOverdue ? 'Defer · hold for options' : 'Move the target · hold for options'}
        className={cn(
          'text-muted-foreground hover:text-foreground hover:bg-foreground/5 touch-manipulation rounded-md select-none [-webkit-touch-callout:none]',
          SLOT,
          REVEAL,
        )}
      >
        <Clock3 className={ICON} aria-hidden />
      </button>
    </SnoozeMenu>
  )
}
