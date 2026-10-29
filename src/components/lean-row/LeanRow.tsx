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
 *   [□]  Title !                                   (deck) (deck tomorrow) (clock)
 *        ⚑ Fri 5:00 PM  Mon 9:00 AM 2×  today 9:14 AM · Low · 📁 Project  labels  📝
 *        ↻ Weekly on Sunday
 *
 * - The left control (`DoneControl`): the done square, or the selection
 *   checkbox in selection mode. No circle, no card: a hairline between rows.
 * - High "!" / Urgent "!!" right after the title, bound to its last word.
 *   Medium is never shown; Low is a grey word on the meta line.
 * - The horizon: a hold or right-click on the done square changes it, on
 *   every one-off; the square DRAWS it only in Scan's Horizon sections
 *   (`horizonLook`, `DoneControl`, `src/lib/horizon-square.ts`).
 * - Deadline chip, then the target chip, each saying the moment alone
 *   (`leanChipWords`: "Today 6:00 PM", "Mon 9:00 AM", no "3h ago"; a
 *   deadline later today counts down, "in 5 hrs", and "Today" is said once
 *   per row) — the
 *   target chip (its move / remove menu) blue while ahead, pale plum once
 *   passed (M1, 2026-10-29); a passed deadline red with its flag — then,
 *   dot-separated, Low and the grey project; labels (the AI glyph rule,
 *   `LabelBadges`) and the yellow notes mark; and LAST the created date
 *   (`createdDateWords`, plain grey; moved to the end 2026-10-29 so it never
 *   sits against the target's words). One 6px gap between every item.
 * - Recurrence on its own line.
 * - The buttons (`LeanButtons`): On deck, On deck tomorrow and one clock —
 *   Today on an untargeted row, Defer on a targeted one. Hidden at rest with
 *   a mouse (shown on hover or focus; a decked row keeps its lit deck icon),
 *   always there and thumb-sized on a phone. They float right; from `md` up
 *   the title is a block formatting context (`md:flow-root`), so it keeps a
 *   clear column.
 * - The ROW STATE (`STATE_LOOK`, `leanRowState`): later today a faint blue;
 *   over target a blue tint and a dark slate-blue title; a passed deadline
 *   the red counterpart, which wins — 1.75× stronger when the target has
 *   passed too (`tintClass`). No bar, no plum stripe, no plum "N×"; the one
 *   plum is a passed target's chip.
 *
 * The attempts badge ("2×") follows the target chip in neutral grey; the
 * card's 3× "Remove target?" offer is not drawn (Remove target stays in the
 * chip's menu and the clock's). Dropped from the card on purpose: the corner
 * tabs, the right priority border. The shelved AI
 * features' props (insights, What's Next annotations) are not drawn.
 */
import { useMemo } from 'react'
import { FolderOpen, Repeat, StickyNote } from 'lucide-react'
import { DeadlineChip } from '@/components/DeadlineChip'
import { LabelBadges } from '@/components/LabelBadges'
import { useDayStart, useLabelConfig, useTaskQueue } from '@/components/PreferencesProvider'
import { PriorityTabMark } from '@/components/RowCorner'
import { TargetTimeText } from '@/components/TargetTimeText'
import type { TaskRowProps } from '@/components/TaskRow'
import { useRowHighlight } from '@/hooks/useRowHighlight'
import { useRowPress } from '@/hooks/useRowPress'
import { useHourTick } from '@/hooks/useHourTick'
import { useTimezone } from '@/hooks/useTimezone'
import { useTitleWeightOverride } from '@/hooks/useTitleWeightOverride'
import { createdDateWords } from '@/lib/created-date'
import { leanChipWords } from '@/lib/lean-chip-words'
import { leanRowState, type LeanRowState } from '@/lib/lean-row-state'
import { formatRRuleCompact } from '@/lib/format-rrule'
import { priorityTab } from '@/lib/row-corner'
import { effectiveAttempts } from '@/lib/task-segments'
import { cn } from '@/lib/utils'
import type { Task } from '@/types'
import { DoneControl } from './DoneControl'
import { LeanButtons } from './LeanButtons'

/**
 * The row's STATE LOOK (Trent 2026-10-28, today-mode round 6): a full-bleed
 * tint under the row's content, no bar (`leanRowState` picks it).
 * - Later today (a target or deadline, not yet over): a faint blue — light
 *   rgb(249,252,255) since 2026-10-29 (it was the target's blue at 2.5%),
 *   dark the blue at 3.125%; the title unchanged.
 * - Over target: a sky-leaning blue — light rgb(231,245,255) since
 *   2026-10-29 (Trent's E2, "bluer"; it was the target's blue at 10%), dark
 *   the target's blue at 12.5% — and a dark slate-blue title (light #263d4d,
 *   dark #d3dcec): present, not alarming, missing a target is not a mistake.
 * - A passed deadline: the red counterpart (a warm red, rgb 200 20 10 — the
 *   sheet's crimson read pink on white — at ×1.4 of its first strength:
 *   light 9.8%, dark 14%); the title unchanged. It WINS over the blue: a
 *   real miss outranks a target whose time has come. The red flag chip says
 *   which date it is.
 */
// The tint runs over the row's own (transparent) bottom border too
// (`-bottom-px`): stopped at the padding box, the 1px border showed the page
// through, a white seam between two tinted rows (Trent, 2026-10-29).
const TINT_BASE =
  "isolate border-b-transparent before:absolute before:inset-x-[-4px] before:top-0 before:-bottom-px before:-z-10 before:content-['']"
const STATE_LOOK: Record<LeanRowState, { row: string; title?: string }> = {
  soon: {
    row: `${TINT_BASE} before:bg-[rgb(249,252,255)] dark:before:bg-[rgba(81,162,255,0.03125)]`,
  },
  over: {
    row: `${TINT_BASE} before:bg-[rgb(231,245,255)] dark:before:bg-[rgba(81,162,255,0.125)]`,
    title: 'text-[#263d4d] dark:text-[#d3dcec]',
  },
  passed: {
    row: `${TINT_BASE} before:bg-[rgba(200,20,10,0.098)] dark:before:bg-[rgba(255,100,103,0.14)]`,
  },
}

/**
 * BOTH PASSED (Trent, 2026-10-29, r7 "1.75×"): the deadline AND the target
 * have passed — the red at 1.75× the passed-deadline tint (light 17.15%,
 * dark 24.5%), in place of the normal red. A passed deadline with its target
 * still ahead ("Return the rental car") keeps the normal red.
 */
const BOTH_PASSED_ROW = `${TINT_BASE} before:bg-[rgba(200,20,10,0.1715)] dark:before:bg-[rgba(255,100,103,0.245)]`

/** The row's state markers, for tests and the row's own selectors. */
function stateFlags(
  state: LeanRowState | null,
  isOverdue: boolean,
): { 'data-over-target'?: ''; 'data-both-passed'?: '' } {
  return {
    ...(isOverdue ? { 'data-over-target': '' as const } : {}),
    ...(state === 'passed' && isOverdue ? { 'data-both-passed': '' as const } : {}),
  }
}

/** The row's tint classes: the state's, or both-passed's stronger red. */
function tintClass(state: LeanRowState | null, isOverdue: boolean): string | undefined {
  if (state === 'passed' && isOverdue) return BOTH_PASSED_ROW
  return state ? STATE_LOOK[state].row : undefined
}

/**
 * The title's WEIGHT (Trent, 2026-10-29, after trying weights on dev: "500
 * feels pretty good… Maybe we do a 500/600 split"): medium on a plain row,
 * semibold on a tinted one — over target or a passed deadline. The faint
 * later-today row keeps medium (its tint is still in question). A dev build's
 * `?titleWeight=` override replaces both (`useTitleWeightOverride`).
 */
function titleWeight(state: LeanRowState | null): string {
  return state === 'over' || state === 'passed' ? 'font-semibold' : 'font-medium'
}

/** One stable empty list, so a row without periods keeps its defer callback's identity. */
const NO_SLOTS: NonNullable<TaskRowProps['timeSlots']> = []

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
  timeSlots = NO_SLOTS,
  horizonLook = false,
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
  const timezone = useTimezone()
  const dayStart = useDayStart()
  // "Later today" moves with the clock: re-read at each top of the hour (a
  // target's own time passing is `isOverdue`, a deadline's is read now).
  const hour = useHourTick(timezone)
  const state = leanRowState(
    task,
    isOverdue,
    timezone,
    dayStart,
    hour ? new Date(hour) : new Date(),
  )

  return (
    <div
      ref={rowRef}
      id={`task-row-${task.id}`}
      role="option"
      aria-selected={isSelected}
      tabIndex={-1}
      data-lean-row={task.id}
      data-row-state={state ?? undefined}
      {...stateFlags(state, isOverdue)}
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
        // The hairline: the border at 40% (Trent, 2026-10-29; it was 60%).
        'group/lean border-border/40 relative flex items-start gap-3 border-b px-1 py-2.5 select-none',
        isSelectionMode && 'cursor-pointer',
        isSelected && 'bg-accent ring-ring rounded-lg ring-2',
        isKeyboardFocused && !isSelected && 'rounded-lg ring-2 ring-blue-500/50 ring-inset',
        // No outline while the row swipes (`SwipeableRow`'s `data-swiping`):
        // on the moving layer it rode along with the row (Trent, 2026-10-29).
        'group-data-swiping/swipe:ring-0',
        tintClass(state, isOverdue),
        isAiProcessing && !highlighted && 'animate-ai-processing',
      )}
    >
      <DoneControl
        task={task}
        onDone={onDone}
        isSelectionMode={isSelectionMode}
        isSelected={isSelected}
        onSelect={onSelect}
        onSetHorizon={onSetHorizon ? (h) => onSetHorizon(task, h) : undefined}
        horizonLook={horizonLook}
      />
      <div className="min-w-0 flex-1">
        {/* DOM first: the buttons float right inside the body, so on a phone
            the title wraps under them (Trent's preference); from md up the
            title (`md:flow-root`) and the meta line keep a clear column. */}
        {!isSelectionMode && (
          <LeanButtons
            task={task}
            isOverdue={isOverdue}
            onDeck={onDeck}
            onTargetAt={onTargetAt}
            onSnooze={onSnooze}
            onRemoveTarget={onRemoveTarget}
            timeSlots={timeSlots}
          />
        )}
        <LeanTitle
          task={task}
          titleClass={cn(titleWeight(state), state && STATE_LOOK[state].title)}
          justAddedBadge={justAddedBadge}
        />
        <LeanMeta
          task={task}
          isOverdue={isOverdue}
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
  // TEMPORARY: a dev build's `?titleWeight=` override (`useTitleWeightOverride`).
  const weight = useTitleWeightOverride()
  return (
    <p
      data-lean-title
      className={cn('text-[16px] leading-6 text-pretty md:flow-root', titleClass)}
      style={weight ? { fontWeight: weight } : undefined}
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

/**
 * The meta line: deadline → target → created as one
 * run (no dots between), then "· Low · 📁 Project", labels and notes.
 */
function LeanMeta({
  task,
  isOverdue,
  onMove,
  onRemoveTarget,
  onLabelClick,
  onReprocess,
  projectName,
}: {
  task: Task
  /** The target has passed (the list's `isOverdue`): the chip goes plum. */
  isOverdue: boolean
  onMove: (until: string) => void
  onRemoveTarget?: (task: Task) => void
  onLabelClick?: (label: string) => void
  onReprocess?: () => void
  projectName?: string
}) {
  const timezone = useTimezone()
  const dayStart = useDayStart()
  const { labelConfig } = useLabelConfig()
  // The chips' words, re-read at each top of the hour (`useHourTick`: one
  // timer for every row) — the countdown changes only on the hour.
  const hour = useHourTick(timezone)
  const words = useMemo(
    // The server render and hydration have no tick (0): read the moment
    // there, as the card row does; after it, the tick is "now".
    () => leanChipWords(task, timezone, dayStart, hour ? new Date(hour) : new Date()),
    [task, timezone, dayStart, hour],
  )
  return (
    <div
      data-lean-meta
      className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs"
    >
      {task.deadline_at && (
        <DeadlineChip
          deadlineAt={task.deadline_at}
          timezone={timezone}
          label={
            // One span, a normal space: the countdown sits right after the
            // time, in the chip's colour at a lighter weight.
            <span>
              {words.deadline}
              {words.countdown && (
                <>
                  {' '}
                  <span data-countdown className="font-normal">
                    {words.countdown}
                  </span>
                </>
              )}
            </span>
          }
        />
      )}
      {words.target && (
        <TargetTimeText
          task={task}
          timezone={timezone}
          text={words.target}
          // M1 (Trent, 2026-10-29): a passed target's chip is the pale plum
          // 'over' tone; a target still ahead stays blue.
          over={isOverdue}
          onMove={onMove}
          onRemoveTarget={onRemoveTarget}
          // No hover ✕: Remove target is in the chip's menu, and the ✕'s
          // hidden box widened the gap before "2×" (Trent, 2026-10-29).
          removeX={false}
        />
      )}
      <AttemptsBadge task={task} />
      <MetaTail task={task} projectName={projectName} lead={!!task.deadline_at || !!words.target} />
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
      {/* The created date LAST (Trent, 2026-10-29, round 10): after the
          project, Low and notes, so it never sits against the target's
          words ("Today 3:00 PM was 1:00 PM today 11:53 AM"). */}
      {hasMetaBefore(task, words.target, projectName) && <MetaDot />}
      <span data-created className="text-muted-foreground/70" title="Created">
        {createdDateWords(task.created_at, timezone, dayStart)}
      </span>
    </div>
  )
}

/** Whether anything sits before the created date on the meta line (it takes a dot then). */
function hasMetaBefore(task: Task, target: string | null, projectName?: string): boolean {
  return (
    !!task.deadline_at ||
    !!target ||
    task.priority === 1 ||
    !!projectName ||
    task.labels.length > 0 ||
    !!task.notes?.trim()
  )
}

/** The meta line's separator dot. */
function MetaDot() {
  return (
    <span className="text-muted-foreground/50" aria-hidden>
      ·
    </span>
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
function MetaTail({
  task,
  projectName,
  lead,
}: {
  task: Task
  projectName?: string
  /** Something precedes the tail (a chip): its first part takes a dot too. */
  lead: boolean
}) {
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
          {(lead || i > 0) && <MetaDot />}
          {part}
        </span>
      ))}
    </>
  )
}
