'use client'

/**
 * THE COMPACT ROW (Trent, 2026-10-28, today-mode rounds 3–4): On deck in the
 * Today mode. One line — two only for a long title:
 *
 *   [□]  Title !  ⚑ Fri  ↻  Project                 (deck) (deck tomorrow) (clock)
 *
 * - The lean row's done square: plain (no Horizon section draws a compact
 *   row), with the hold menu and tooltip naming the horizon (2026-10-29).
 * - The title, then "!" / "!!" (Medium hidden, Low not said), "⚑ <day>" for a
 *   deadline within a week (`compactDeadline`: the day only, never a time;
 *   red once passed), ↻ when it repeats, and the grey project name.
 * - Never on a compact row: labels (AI ones too), the created date, Low,
 *   notes, the target chip, the rrule line.
 * - The buttons are the lean row's own (`LeanButtons`): the lit deck icon at
 *   rest with a mouse, all three on a phone.
 * - The press is the lean row's (`useRowPress`): a tap on a phone, or a
 *   double-click, opens the details; selection and the keyboard as anywhere.
 */
import { Flag, Repeat } from 'lucide-react'
import { useDayStart } from '@/components/PreferencesProvider'
import { PriorityTabMark } from '@/components/RowCorner'
import type { TaskRowProps } from '@/components/TaskRow'
import { useHourTick } from '@/hooks/useHourTick'
import { useRowHighlight } from '@/hooks/useRowHighlight'
import { useRowPress } from '@/hooks/useRowPress'
import { useTimezone } from '@/hooks/useTimezone'
import { compactDeadline } from '@/lib/compact-row-words'
import { priorityTab } from '@/lib/row-corner'
import { cn } from '@/lib/utils'
import { DoneControl } from './DoneControl'
import { LeanButtons } from './LeanButtons'

/** One stable empty list, so a row without periods keeps its defer callback's identity. */
const NO_SLOTS: NonNullable<TaskRowProps['timeSlots']> = []

export function CompactRow({
  task,
  onDone,
  onSnooze,
  onSetHorizon,
  onTargetAt,
  onDeck,
  isOverdue = false,
  isSelected = false,
  isSelectionMode = false,
  onSelect,
  onSelectOnly,
  onRangeSelect,
  cancelLongPressRef,
  onFocus,
  isKeyboardFocused = false,
  onActivate,
  onDoubleClick,
  projectName,
  highlighted,
  onHighlightDone,
  timeSlots = NO_SLOTS,
}: TaskRowProps) {
  const { pointer, handleClick } = useRowPress({
    isSelectionMode,
    onSelect,
    onSelectOnly,
    onRangeSelect,
    onActivate,
    onDoubleClick,
    cancelLongPressRef,
  })
  const { rowRef, highlightProps, highlightClass } = useRowHighlight(highlighted, onHighlightDone)
  const timezone = useTimezone()
  const dayStart = useDayStart()
  // The deadline's day word moves with the clock: re-read on the hour.
  const hour = useHourTick(timezone)
  const deadline = compactDeadline(
    task.deadline_at,
    timezone,
    dayStart,
    hour ? new Date(hour) : new Date(),
  )
  const tab = task.priority >= 3 ? priorityTab(task.priority, 'icons') : null
  const cut = task.title.lastIndexOf(' ')

  return (
    <div
      ref={rowRef}
      id={`task-row-${task.id}`}
      role="option"
      aria-selected={isSelected}
      tabIndex={-1}
      data-lean-row={task.id}
      data-compact-row=""
      {...highlightProps}
      onClick={handleClick}
      onMouseEnter={onFocus}
      onMouseDown={(e) => e.stopPropagation()}
      // A press on one of the row's own controls is not a long-press.
      onPointerDown={(e) => {
        if ((e.target as Element).closest('[data-no-row-press]')) return
        pointer.onPointerDown(e)
      }}
      onPointerUp={pointer.onPointerUp}
      onPointerMove={pointer.onPointerMove}
      onPointerLeave={pointer.onPointerLeave}
      onPointerCancel={pointer.onPointerUp}
      className={cn(
        highlightClass,
        'group/lean border-border/40 relative flex items-start gap-3 border-b px-1 py-2.5 select-none',
        isSelectionMode && 'cursor-pointer',
        isSelected && 'bg-accent ring-ring rounded-lg ring-2',
        isKeyboardFocused && !isSelected && 'rounded-lg ring-2 ring-blue-500/50 ring-inset',
      )}
    >
      <DoneControl
        task={task}
        onDone={onDone}
        isSelectionMode={isSelectionMode}
        isSelected={isSelected}
        onSelect={onSelect}
        onSetHorizon={onSetHorizon ? (h) => onSetHorizon(task, h) : undefined}
      />
      <div className="min-w-0 flex-1">
        {!isSelectionMode && (
          <LeanButtons
            task={task}
            isOverdue={isOverdue}
            onDeck={onDeck}
            onTargetAt={onTargetAt}
            onSnooze={onSnooze}
            timeSlots={timeSlots}
          />
        )}
        <p data-lean-title className="text-[16px] leading-6 text-pretty md:flow-root">
          {task.title.slice(0, cut + 1)}
          {/* The last word and everything after it stay together. */}
          <span className="whitespace-nowrap">
            {task.title.slice(cut + 1)}
            {tab && <PriorityTabMark tab={tab} inline className="ml-1.5" />}
          </span>
          {deadline && (
            <span
              data-compact-deadline={deadline.passed ? 'passed' : 'ahead'}
              className={cn(
                'ml-2.5 inline-flex items-center gap-1 align-[1px] text-[13px] font-semibold whitespace-nowrap',
                deadline.passed
                  ? 'text-red-700 dark:text-red-400'
                  : 'text-teal-700 dark:text-teal-400',
              )}
            >
              <Flag className="size-3.5" aria-hidden />
              {deadline.words}
            </span>
          )}
          {task.rrule && (
            <Repeat
              data-compact-repeat
              aria-label="Repeats"
              className="text-muted-foreground ml-2.5 inline size-3.5 align-[-1px]"
            />
          )}
          {projectName && (
            <span
              data-compact-project
              className="text-muted-foreground ml-2.5 text-[13px] whitespace-nowrap"
            >
              {projectName}
            </span>
          )}
        </p>
      </div>
    </div>
  )
}
