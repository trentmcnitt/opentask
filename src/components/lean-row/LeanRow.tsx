'use client'

/**
 * THE LEAN TASK ROW (2026-10-28, Trent): the dashboard list's row when
 * Settings → Theme → Task rows says "Lean" (`useTaskRowStyle`). It takes
 * `TaskRow`'s props from `TaskList` and shares its behaviour through the
 * same hooks — the press (`useRowPress`: selection, activation, double-click
 * / tap for details, long-press) and the widget's highlight landing
 * (`useRowHighlight`) — so the two row styles cannot drift. Swipe is
 * `TaskList`'s `SwipeableRow`, on its flat surface. What changes is the look:
 *
 *   [□]  Title !                                (deck) (deck tomorrow) (☀ Today)
 *        ● ⚑ Fri 5:00 PM  Mon 9:00 AM  today 9:14 AM · Low · 📁 Project  labels  📝
 *        ↻ Weekly on Sunday
 *
 * - The left control (`DoneControl`): the done square, or the selection
 *   checkbox in selection mode. No circle, no card: a hairline between rows.
 * - High "!" / Urgent "!!" right after the title, bound to its last word.
 *   Medium is never shown; Low is a grey word on the meta line.
 * - The horizon mark (`HorizonMark`) leads the meta line on rows it governs.
 * - Deadline chip (with its time), then the target chip — always the blue
 *   target chip (its move / remove menu), never plum; a passed deadline is
 *   red with its flag — then the created date (`createdDateWords`) in plain
 *   grey with no dot before it. The dot comes after: Low, the grey project.
 *   Then labels (the AI glyph rule, `LabelBadges`) and the yellow notes mark.
 * - Recurrence on its own line.
 * - The buttons: On deck, On deck tomorrow, Today, 14px apart; no snooze
 *   clock (swipe left and the chip's menu move the target). On a phone they
 *   float right and the title wraps under them; from `md` up the title is a
 *   block formatting context (`md:flow-root`), so it keeps a clear column.
 * - OVER TARGET (sheet v12-4): the row's full width tinted ~8% in the target
 *   blue, a 3px bar down its left edge, the title in a dark slate-blue. No
 *   plum anywhere in the row (no stripe, no plum chip, no "N×").
 *
 * Dropped from the card on purpose: the attempts "N×" tab (and with it the
 * 3× "Remove target?" offer — Remove target stays in the chip's menu), the
 * corner tabs, the snooze button, the right priority border. The shelved AI
 * features' props (insights, What's Next annotations) are not drawn.
 */
import { FolderOpen, Repeat, StickyNote } from 'lucide-react'
import { DeadlineChip } from '@/components/DeadlineChip'
import { LabelBadges } from '@/components/LabelBadges'
import { OnDeckButton } from '@/components/OnDeckButton'
import { useDayStart, useLabelConfig, useTaskQueue } from '@/components/PreferencesProvider'
import { PriorityTabMark } from '@/components/RowCorner'
import { TargetTodayButton } from '@/components/TargetMenu'
import { TargetTimeText } from '@/components/TargetTimeText'
import type { TaskRowProps } from '@/components/TaskRow'
import { DeckTomorrowButton } from '@/components/TaskSegmentRow'
import { useRowHighlight } from '@/hooks/useRowHighlight'
import { useRowPress } from '@/hooks/useRowPress'
import { useTimezone } from '@/hooks/useTimezone'
import { createdDateWords } from '@/lib/created-date'
import { deckReplaces, offersDeck, todayReplaces } from '@/lib/deck-menu'
import { formatDueTimeParts } from '@/lib/format-date'
import { formatRRuleCompact } from '@/lib/format-rrule'
import { offersTargetToday, priorityTab } from '@/lib/row-corner'
import { cn } from '@/lib/utils'
import type { Task } from '@/types'
import { DoneControl } from './DoneControl'
import { HorizonMark } from './HorizonMark'

/** The over-target look (sheet v12-4): a full-bleed blue tint and bar, under the row's content. */
const OVER_ROW =
  "isolate border-b-transparent before:absolute before:inset-x-[-4px] before:inset-y-0 before:-z-10 before:bg-blue-600/[0.08] before:shadow-[inset_3px_0_0_var(--color-blue-600)] before:content-[''] dark:before:bg-blue-400/[0.10] dark:before:shadow-[inset_3px_0_0_var(--color-blue-400)]"
/** …and its title, a dark slate-blue: present, not alarming. */
const OVER_TITLE = 'text-[#26334d] dark:text-[#d3dcec]'

export function LeanRow({
  task,
  onDone,
  onSnooze,
  onRemoveTarget,
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
  onLabelClick,
  onFocus,
  isKeyboardFocused = false,
  onActivate,
  onDoubleClick,
  onReprocess,
  projectName,
  justAddedBadge,
  highlighted,
  onHighlightDone,
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
  const { rowRef, highlightProps } = useRowHighlight(highlighted, onHighlightDone)
  const isAiProcessing = task.labels.includes('ai-to-process')

  return (
    <div
      ref={rowRef}
      id={`task-row-${task.id}`}
      role="option"
      aria-selected={isSelected}
      tabIndex={-1}
      data-lean-row={task.id}
      data-over-target={isOverdue ? '' : undefined}
      {...highlightProps}
      onClick={handleClick}
      onMouseEnter={onFocus}
      onMouseDown={(e) => e.stopPropagation()}
      // A press on one of the row's own controls is not a long-press (`TaskRow`).
      onPointerDown={(e) => {
        if ((e.target as Element).closest('[data-no-row-press]')) return
        pointer.onPointerDown(e)
      }}
      onPointerUp={pointer.onPointerUp}
      onPointerMove={pointer.onPointerMove}
      onPointerLeave={pointer.onPointerLeave}
      onPointerCancel={pointer.onPointerUp}
      className={cn(
        'border-border/60 relative flex items-start gap-3 border-b px-1 py-2.5 select-none',
        isSelectionMode && 'cursor-pointer',
        isSelected && 'bg-accent ring-ring rounded-lg ring-2',
        isKeyboardFocused && !isSelected && 'rounded-lg ring-2 ring-blue-500/50 ring-inset',
        isOverdue && OVER_ROW,
        isAiProcessing && !highlighted && 'animate-ai-processing',
      )}
    >
      <DoneControl
        title={task.title}
        onDone={onDone}
        isSelectionMode={isSelectionMode}
        isSelected={isSelected}
        onSelect={onSelect}
      />
      <div className="min-w-0 flex-1">
        {/* DOM first: the buttons float right inside the body, so on a phone
            the title wraps under them (Trent's preference); from md up the
            title (`md:flow-root`) and the meta line keep a clear column. */}
        {!isSelectionMode && <LeanButtons task={task} onDeck={onDeck} onTargetAt={onTargetAt} />}
        <LeanTitle task={task} over={isOverdue} justAddedBadge={justAddedBadge} />
        <LeanMeta
          task={task}
          onMove={(until) => onSnooze(task.id, until)}
          onRemoveTarget={onRemoveTarget}
          onSetHorizon={isSelectionMode ? undefined : onSetHorizon}
          onLabelClick={onLabelClick}
          onReprocess={onReprocess}
          projectName={projectName}
        />
        {task.rrule && (
          <div className="text-muted-foreground mt-0.5 flex items-center gap-1 text-xs">
            <Repeat className="size-3" aria-hidden />
            {formatRRuleCompact(task.rrule, task.anchor_time)}
          </div>
        )}
      </div>
    </div>
  )
}

/** The title, with High "!" / Urgent "!!" and the just-now tag bound to its last word. */
function LeanTitle({
  task,
  over,
  justAddedBadge,
}: {
  task: Task
  over: boolean
  justAddedBadge?: string
}) {
  const tab = task.priority >= 3 ? priorityTab(task.priority, 'icons') : null
  const cut = task.title.lastIndexOf(' ')
  return (
    <p
      data-lean-title
      className={cn('text-[16px] leading-6 text-pretty md:flow-root', over && OVER_TITLE)}
    >
      {task.title.slice(0, cut + 1)}
      <span className="whitespace-nowrap">
        {task.title.slice(cut + 1)}
        {tab && <PriorityTabMark tab={tab} inline className="ml-1.5" />}
        {justAddedBadge && (
          <span
            data-just-added-badge
            className="ml-1.5 rounded bg-indigo-50 px-1.5 py-0.5 align-[2px] text-[11px] leading-none font-semibold text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-300"
          >
            {justAddedBadge}
          </span>
        )}
      </span>
    </p>
  )
}

/** "Tomorrow 9:00 AM", "3h ago · 5:00 PM": the card row's target words (`TaskRow`). */
function targetWords(dueAt: string, timezone: string, dayStart: string): string {
  const { relative, absolute } = formatDueTimeParts(dueAt, timezone, dayStart)
  const text = [relative, absolute].filter(Boolean).join(' · ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * The meta line: the horizon mark, then deadline → target → created as one
 * run (no dots between), then "· Low · 📁 Project", labels and notes.
 */
function LeanMeta({
  task,
  onMove,
  onRemoveTarget,
  onSetHorizon,
  onLabelClick,
  onReprocess,
  projectName,
}: {
  task: Task
  onMove: (until: string) => void
  onRemoveTarget?: (task: Task) => void
  onSetHorizon?: TaskRowProps['onSetHorizon']
  onLabelClick?: (label: string) => void
  onReprocess?: () => void
  projectName?: string
}) {
  const timezone = useTimezone()
  const dayStart = useDayStart()
  const { labelConfig } = useLabelConfig()
  return (
    <div
      data-lean-meta
      className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs"
    >
      <HorizonMark task={task} onChange={onSetHorizon ? (h) => onSetHorizon(task, h) : undefined} />
      {task.deadline_at && <DeadlineChip deadlineAt={task.deadline_at} timezone={timezone} />}
      {task.due_at && (
        <TargetTimeText
          task={task}
          timezone={timezone}
          text={targetWords(task.due_at, timezone, dayStart)}
          // Always the blue target chip: a missed target is not a mistake.
          over={false}
          onMove={onMove}
          onRemoveTarget={onRemoveTarget}
        />
      )}
      <span data-created className="text-muted-foreground/70" title="Created">
        {createdDateWords(task.created_at, timezone, dayStart)}
      </span>
      <MetaTail task={task} projectName={projectName} />
      {task.labels.length > 0 && (
        <LabelBadges
          labels={task.labels}
          labelConfig={labelConfig}
          onLabelClick={onLabelClick}
          onReprocess={onReprocess}
        />
      )}
      {task.notes?.trim() && (
        <span data-lean-notes className="inline-flex items-center text-amber-400" title="Has notes">
          <StickyNote className="size-3" />
        </span>
      )}
    </div>
  )
}

/** After the dates, dot-separated: Low (never Medium), then the grey project. */
function MetaTail({ task, projectName }: { task: Task; projectName?: string }) {
  const parts = [
    task.priority === 1 ? (
      <span key="low" data-lean-low>
        Low
      </span>
    ) : null,
    projectName ? (
      <span key="project" data-lean-project className="inline-flex items-center gap-1">
        <FolderOpen className="size-3" aria-hidden />
        {projectName}
      </span>
    ) : null,
  ].filter(Boolean)
  return (
    <>
      {parts.map((part, i) => (
        <span key={i} className="contents">
          <span className="text-muted-foreground/50" aria-hidden>
            ·
          </span>
          {part}
        </span>
      ))}
    </>
  )
}

/** On deck, On deck tomorrow and Today, 14px apart; no snooze clock. */
function LeanButtons({
  task,
  onDeck,
  onTargetAt,
}: {
  task: Task
  onDeck?: TaskRowProps['onDeck']
  onTargetAt?: TaskRowProps['onTargetAt']
}) {
  const timezone = useTimezone()
  const dayStart = useDayStart()
  const queue = useTaskQueue()
  const showDeck = !!onDeck && queue.loaded && queue.enabled && offersDeck(task)
  const showToday = !!onTargetAt && offersTargetToday(task)
  if (!showDeck && !showToday) return null
  const deck = (t: Task, day: string | null | undefined) => onDeck?.(t, day)
  return (
    <div data-lean-buttons className="float-right ml-2 flex items-center gap-3.5">
      {showDeck && (
        <>
          <OnDeckButton
            task={task}
            timezone={timezone}
            onDeck={deck}
            replaces={deckReplaces(task, timezone)}
            className="flex size-8 pointer-coarse:size-10"
            iconClassName="size-[18px]"
          />
          <DeckTomorrowButton task={task} onDeck={deck} timezone={timezone} panel={false} />
        </>
      )}
      {showToday && (
        <TargetTodayButton
          task={task}
          timezone={timezone}
          onTargetToday={(t) => onTargetAt?.(t)}
          onTargetAt={(t, at) => onTargetAt?.(t, at)}
          replaces={todayReplaces(task, timezone, dayStart)}
          iconClassName="size-[18px]"
        />
      )}
    </div>
  )
}
