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
 *        ⚑ Fri 5:00 PM  Mon 9:00 AM 2×  today 9:14 AM · Low · 📁 Project  labels  📝
 *        ↻ Weekly on Sunday
 *
 * - The left control (`DoneControl`): the done square, or the selection
 *   checkbox in selection mode. No circle, no card: a hairline between rows.
 * - High "!" / Urgent "!!" right after the title, bound to its last word.
 *   Medium is never shown; Low is a grey word on the meta line.
 * - The horizon is the done square's border on rows it governs (`DoneControl`,
 *   `src/lib/horizon-square.ts`); change it in the editor.
 * - Deadline chip, then the target chip, each saying the moment alone
 *   (`momentChipWords`: "Today 6:00 PM", "Mon 9:00 AM", no "3h ago") — the
 *   target always the blue target chip (its move / remove menu), never
 *   plum; a passed deadline red with its flag — then the created date (`createdDateWords`) in plain
 *   grey with no dot before it. The dot comes after: Low, the grey project.
 *   Then labels (the AI glyph rule, `LabelBadges`) and the yellow notes mark.
 * - Recurrence on its own line.
 * - The buttons: On deck, On deck tomorrow, Today, 14px apart; no snooze
 *   clock (swipe left and the chip's menu move the target). On a phone they
 *   float right and the title wraps under them; from `md` up the title is a
 *   block formatting context (`md:flow-root`), so it keeps a clear column.
 * - The ROW STATE (sheet v13-2, `STATE_LOOK`): over target, a blue tint and a
 *   dark slate-blue title; a passed deadline, the red counterpart, which wins
 *   when both apply. No bar. No plum anywhere in the row (no stripe, no plum
 *   chip, no "N×").
 *
 * The attempts badge ("2×") follows the target chip in neutral grey; the
 * card's 3× "Remove target?" offer is not drawn (Remove target stays in the
 * chip's menu). Dropped from the card on purpose: the corner tabs, the
 * snooze button, the right priority border. The shelved AI
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
import { momentChipWords } from '@/lib/moment-chip-words'
import { formatRRuleCompact } from '@/lib/format-rrule'
import { offersTargetToday, priorityTab } from '@/lib/row-corner'
import { effectiveAttempts, isPastDeadline } from '@/lib/task-segments'
import { cn } from '@/lib/utils'
import type { Task } from '@/types'
import { DoneControl } from './DoneControl'

/**
 * The row's STATE LOOK (sheet v13-2, Trent 2026-10-28): a full-bleed tint
 * under the row's content and a tinted title, no bar.
 * - Over target: the target's blue (~8%) and a dark slate-blue title —
 *   present, not alarming: missing a target is not a mistake.
 * - A passed deadline: the red counterpart (~7% of a warm red, rgb 200 20 10:
 *   the sheet's crimson read pink on white, its blue above its green) and
 *   a dark red-tinted title. It WINS over the blue: a real miss outranks a
 *   target whose time has come. The red flag chip says which date it is.
 */
type RowState = 'over' | 'passed'
const TINT_BASE =
  "isolate border-b-transparent before:absolute before:inset-x-[-4px] before:inset-y-0 before:-z-10 before:content-['']"
const STATE_LOOK: Record<RowState, { row: string; title: string }> = {
  over: {
    row: `${TINT_BASE} before:bg-blue-600/[0.08] dark:before:bg-blue-400/[0.10]`,
    title: 'text-[#26334d] dark:text-[#d3dcec]',
  },
  passed: {
    row: `${TINT_BASE} before:bg-[rgba(200,20,10,0.07)] dark:before:bg-[rgba(255,100,103,0.10)]`,
    title: 'text-[#4d2629] dark:text-[#ecd3d4]',
  },
}

/** Which state look a row wears: a passed deadline first, then over target. */
function rowState(task: Task, isOverdue: boolean): RowState | null {
  if (isPastDeadline(task.deadline_at, new Date())) return 'passed'
  return isOverdue ? 'over' : null
}

export function LeanRow({
  task,
  onDone,
  onSnooze,
  onRemoveTarget,
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
  const state = rowState(task, isOverdue)

  return (
    <div
      ref={rowRef}
      id={`task-row-${task.id}`}
      role="option"
      aria-selected={isSelected}
      tabIndex={-1}
      data-lean-row={task.id}
      data-over-target={isOverdue ? '' : undefined}
      data-row-state={state ?? undefined}
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
        state && STATE_LOOK[state].row,
        isAiProcessing && !highlighted && 'animate-ai-processing',
      )}
    >
      <DoneControl
        task={task}
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
        <LeanTitle
          task={task}
          titleClass={state ? STATE_LOOK[state].title : undefined}
          justAddedBadge={justAddedBadge}
        />
        <LeanMeta
          task={task}
          onMove={(until) => onSnooze(task.id, until)}
          onRemoveTarget={onRemoveTarget}
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
  titleClass,
  justAddedBadge,
}: {
  task: Task
  /** The row state's title colour (`STATE_LOOK`), if any. */
  titleClass?: string
  justAddedBadge?: string
}) {
  const tab = task.priority >= 3 ? priorityTab(task.priority, 'icons') : null
  const cut = task.title.lastIndexOf(' ')
  return (
    <p data-lean-title className={cn('text-[16px] leading-6 text-pretty md:flow-root', titleClass)}>
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

/**
 * The meta line: deadline → target → created as one
 * run (no dots between), then "· Low · 📁 Project", labels and notes.
 */
function LeanMeta({
  task,
  onMove,
  onRemoveTarget,
  onLabelClick,
  onReprocess,
  projectName,
}: {
  task: Task
  onMove: (until: string) => void
  onRemoveTarget?: (task: Task) => void
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
      {task.deadline_at && (
        <DeadlineChip
          deadlineAt={task.deadline_at}
          timezone={timezone}
          label={momentChipWords(task.deadline_at, timezone, dayStart)}
        />
      )}
      {task.due_at && (
        <TargetTimeText
          task={task}
          timezone={timezone}
          text={momentChipWords(task.due_at, timezone, dayStart)}
          // Always the blue target chip: a missed target is not a mistake.
          over={false}
          onMove={onMove}
          onRemoveTarget={onRemoveTarget}
        />
      )}
      <AttemptsBadge task={task} />
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

/**
 * The attempts badge, "2×": OpenTask days the task has been over its target
 * (`effectiveAttempts`, the card row's own count, Trent 2026-10-28), right
 * after the target chip, in neutral grey — no plum. The badge only: the card's
 * 3× "Remove target?" offer stays out (Remove target is in the chip's menu).
 */
function AttemptsBadge({ task }: { task: Task }) {
  const timezone = useTimezone()
  const queue = useTaskQueue()
  if (!task.due_at) return null
  // Until the preferences load, the server's stored count stands (`TaskRow`).
  const attempts = queue.loaded
    ? effectiveAttempts(task, timezone, new Date(), queue.attemptsRolloverTime).attempts
    : (task.attempts ?? 0)
  if (attempts < 1) return null
  return (
    <span
      data-attempts={attempts}
      title={`Overdue on ${attempts} day${attempts === 1 ? '' : 's'}`}
      className="text-muted-foreground font-semibold tabular-nums"
    >
      {attempts}×
    </span>
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
