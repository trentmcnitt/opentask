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
 * - The horizon is the done square's border on rows it governs (`DoneControl`,
 *   `src/lib/horizon-square.ts`); a hold or right-click on it changes it.
 * - Deadline chip, then the target chip, each saying the moment alone
 *   (`leanChipWords`: "Today 6:00 PM", "Mon 9:00 AM", no "3h ago"; a
 *   deadline later today counts down, "in 5 hrs", and "Today" is said once
 *   per row) — the
 *   target always the blue target chip (its move / remove menu), never
 *   plum; a passed deadline red with its flag — then the created date (`createdDateWords`) in plain
 *   grey with no dot before it. The dot comes after: Low, the grey project.
 *   Then labels (the AI glyph rule, `LabelBadges`) and the yellow notes mark.
 * - Recurrence on its own line.
 * - The buttons (`LeanButtons`): On deck, On deck tomorrow and one clock —
 *   Today on an untargeted row, Defer on a targeted one. Hidden at rest with
 *   a mouse (shown on hover or focus; a decked row keeps its lit deck icon),
 *   always there and thumb-sized on a phone. They float right; from `md` up
 *   the title is a block formatting context (`md:flow-root`), so it keeps a
 *   clear column.
 * - The ROW STATE (`STATE_LOOK`, `leanRowState`): later today a faint blue;
 *   over target a blue tint and a dark slate-blue title; a passed deadline
 *   the red counterpart, which wins. No bar. No plum anywhere in the row (no
 *   stripe, no plum chip, no "N×").
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
import { createdDateWords } from '@/lib/created-date'
import { leanChipWords } from '@/lib/lean-chip-words'
import { leanRowState, type LeanRowState } from '@/lib/lean-row-state'
import { cardEdge, type CardEdge } from '@/lib/card-edge'
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
 * - Later today (a target or deadline, not yet over): a faint blue, 2.5%
 *   (dark ×1.25); the title unchanged.
 * - Over target: the target's blue, 10% (dark ×1.25), and a dark
 *   slate-blue title — present, not alarming: missing a target is not a
 *   mistake.
 * - A passed deadline: the red counterpart (a warm red, rgb 200 20 10 — the
 *   sheet's crimson read pink on white — at ×1.4 of its first strength:
 *   light 9.8%, dark 14%); the title unchanged. It WINS over the blue: a
 *   real miss outranks a target whose time has come. The red flag chip says
 *   which date it is.
 */
const TINT_BASE =
  "isolate border-b-transparent before:absolute before:inset-x-[-4px] before:inset-y-0 before:-z-10 before:content-['']"
const STATE_LOOK: Record<LeanRowState, { row: string; title?: string }> = {
  soon: {
    row: `${TINT_BASE} before:bg-[rgba(21,93,252,0.025)] dark:before:bg-[rgba(81,162,255,0.03125)]`,
  },
  over: {
    row: `${TINT_BASE} before:bg-[rgba(21,93,252,0.10)] dark:before:bg-[rgba(81,162,255,0.125)]`,
    title: 'text-[#26334d] dark:text-[#d3dcec]',
  },
  passed: {
    row: `${TINT_BASE} before:bg-[rgba(200,20,10,0.098)] dark:before:bg-[rgba(255,100,103,0.14)]`,
  },
}

/** One stable empty list, so a row without periods keeps its defer callback's identity. */
const NO_SLOTS: NonNullable<TaskRowProps['timeSlots']> = []

/**
 * The row's LOOK (Settings → Theme → Task rows): `lean` (the flat row above)
 * or `card-v2` — CARD V2 (Trent, 2026-10-29, mockup "C1 · Separate cards"):
 * the same contents (marks, chips, words, buttons, the horizon square) in a
 * separate card, 10px round, ~9×10px padding, 6px apart (`TaskList`).
 * - The STATE is a 3px left edge only (`cardEdge`): red for a passed
 *   deadline, blue for over target, none otherwise — no tint on the body,
 *   no slate title, no "later today" mark. The edge is 2px wider than the
 *   card's 1px border, so the left padding gives those 2px back (10 → 8px)
 *   and every card's square and title stay in one column. Dark: lean's dark
 *   tint hues (red-400 #ff6467, blue-400 #51a2ff).
 * - The title one weight up (medium, Trent: "bold the text a little bit").
 * - The attempts count ("2×") moves to the top-right corner, neutral grey,
 *   and the buttons drop below it when it is there. No priority tab.
 */
export type LeanLook = 'lean' | 'card-v2'

const CARD_SHELL = 'rounded-[10px] border px-2.5 py-[9px]'
const CARD_EDGE: Record<CardEdge, string> = {
  passed: 'border-l-[3px] border-l-[#e7000b] pl-2 dark:border-l-[#ff6467]',
  over: 'border-l-[3px] border-l-[#155dfc] pl-2 dark:border-l-[#51a2ff]',
}

/**
 * What the look changes in the row: card v2's edge, its corner count (the
 * meta line's "2×" moves there), and the title's colour or weight.
 */
function lookParts(o: {
  look: LeanLook
  task: Task
  isOverdue: boolean
  now: Date
  state: LeanRowState | null
  attempts: number
}): {
  card: boolean
  edge: CardEdge | null
  corner: boolean
  titleClass: string | undefined
  metaAttempts: number | null
} {
  if (o.look === 'lean') {
    const titleClass = o.state ? STATE_LOOK[o.state].title : undefined
    return { card: false, edge: null, corner: false, titleClass, metaAttempts: o.attempts }
  }
  return {
    card: true,
    edge: cardEdge(o.task, o.isOverdue, o.now),
    corner: o.attempts >= 1,
    titleClass: 'font-medium',
    metaAttempts: null,
  }
}

/** The row box's classes for its look, state, selection and focus. */
function rowShell(o: {
  card: boolean
  edge: CardEdge | null
  state: LeanRowState | null
  isSelected: boolean
  isKeyboardFocused: boolean
}): string {
  const round = o.card ? undefined : 'rounded-lg'
  return cn(
    o.card ? CARD_SHELL : 'border-border/60 border-b px-1 py-2.5',
    o.edge && CARD_EDGE[o.edge],
    o.isSelected && cn('bg-accent ring-ring ring-2', round),
    o.isKeyboardFocused && !o.isSelected && cn('ring-2 ring-blue-500/50 ring-inset', round),
    // No outline while the row swipes (`SwipeableRow`'s `data-swiping`):
    // on the moving layer it rode along with the row (Trent, 2026-10-29).
    'group-data-swiping/swipe:ring-0',
    !o.card && o.state && STATE_LOOK[o.state].row,
  )
}

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
  look = 'lean',
}: TaskRowProps & { look?: LeanLook }) {
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
  const now = hour ? new Date(hour) : new Date()
  const state = leanRowState(task, isOverdue, timezone, dayStart, now)
  const attempts = useAttempts(task)
  const parts = lookParts({ look, task, isOverdue, now, state, attempts })

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
      data-row-look={look}
      data-card-edge={parts.edge ?? undefined}
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
        'group/lean relative flex items-start gap-3 select-none',
        rowShell({ ...parts, state, isSelected, isKeyboardFocused }),
        isSelectionMode && 'cursor-pointer',
        isAiProcessing && !highlighted && 'animate-ai-processing',
      )}
    >
      {parts.corner && <CornerAttempts attempts={attempts} />}
      <DoneControl
        task={task}
        onDone={onDone}
        isSelectionMode={isSelectionMode}
        isSelected={isSelected}
        onSelect={onSelect}
        onSetHorizon={onSetHorizon ? (h) => onSetHorizon(task, h) : undefined}
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
            // Card v2: below the corner's count, never over it.
            className={parts.corner ? 'mt-3.5' : undefined}
          />
        )}
        <LeanTitle task={task} titleClass={parts.titleClass} justAddedBadge={justAddedBadge} />
        <LeanMeta
          task={task}
          attempts={parts.metaAttempts}
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
  attempts,
  onMove,
  onRemoveTarget,
  onLabelClick,
  onReprocess,
  projectName,
}: {
  task: Task
  /** The "2×" count beside the target chip; null where the corner holds it (card v2). */
  attempts: number | null
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
          // Always the blue target chip: a missed target is not a mistake.
          over={false}
          onMove={onMove}
          onRemoveTarget={onRemoveTarget}
        />
      )}
      {task.due_at && attempts !== null && attempts >= 1 && <AttemptsBadge attempts={attempts} />}
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
 * The attempts count: OpenTask days the task has been over its target
 * (`effectiveAttempts`, the card row's own count, Trent 2026-10-28); 0 with
 * no target. Until the preferences load, the server's stored count stands
 * (`TaskRow`).
 */
function useAttempts(task: Task): number {
  const timezone = useTimezone()
  const queue = useTaskQueue()
  if (!task.due_at) return 0
  return queue.loaded
    ? effectiveAttempts(task, timezone, new Date(), queue.attemptsRolloverTime).attempts
    : (task.attempts ?? 0)
}

const attemptsTitle = (n: number) => `Overdue on ${n} day${n === 1 ? '' : 's'}`

/**
 * The attempts badge, "2×", right after the target chip, in neutral grey —
 * no plum. The badge only: the card's 3× "Remove target?" offer stays out
 * (Remove target is in the chip's menu).
 */
function AttemptsBadge({ attempts }: { attempts: number }) {
  return (
    <span
      data-attempts={attempts}
      title={attemptsTitle(attempts)}
      className="text-muted-foreground font-semibold tabular-nums"
    >
      {attempts}×
    </span>
  )
}

/**
 * Card v2's corner: the attempts count alone, a neutral grey tab flush with
 * the card's top-right corner (its rounding follows the card's).
 */
function CornerAttempts({ attempts }: { attempts: number }) {
  return (
    <span
      data-attempts={attempts}
      data-corner-attempts
      title={attemptsTitle(attempts)}
      className="absolute -top-px -right-px flex h-[18px] items-center rounded-tr-[10px] rounded-bl-md bg-[#f0f0f0] px-[7px] text-[11px] leading-none font-semibold text-[#525252] tabular-nums dark:bg-neutral-800 dark:text-neutral-300"
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
