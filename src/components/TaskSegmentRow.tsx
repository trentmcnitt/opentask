'use client'

import { Check, ChevronDown, FolderOpen } from 'lucide-react'
import { DateTime } from 'luxon'
import { cn } from '@/lib/utils'
import { recurrenceSummary } from '@/lib/recurrence-summary'
import { queuedRepeatOccurrence } from '@/lib/editor-target-labels'
import { TargetTodayButton } from '@/components/TargetMenu'
import { OnDeckButton } from '@/components/OnDeckButton'
import { deckTomorrowDay, offersDeck } from '@/lib/deck-menu'
import { DeckTomorrowIcon } from '@/components/icons/DeckTomorrowIcon'
import { RowPeekBody, RowPeekPopover } from '@/components/RowPeekPopover'
import { useLongPress } from '@/hooks/useLongPress'
import { useLastKnownQueueOn } from '@/lib/last-known-queue'
import { HorizonDotButton, HorizonMenuContent } from '@/components/HorizonDot'
import { getPriorityOption } from '@/lib/priority'
import { useProjects } from '@/components/ProjectsProvider'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  BACK_TO_AUTO,
  HORIZON_LABELS,
  HORIZON_UNSET_LABEL,
  HORIZON_WORD,
  QUEUE_PANEL_TITLES,
  SEGMENT_TITLES,
  TRY_TOMORROW_MARK,
  taskQueueTitle,
  UPCOMING_LABEL,
} from '@/lib/task-model-words'
import {
  SEGMENT_NUDGE_THRESHOLD,
  isQueueKind,
  type HorizonValue,
  type SegmentKind,
} from '@/lib/task-segments'
import { ageLabel, effectiveAttempts, upcomingGap, upcomingRowActions } from '@/lib/task-segments'
import { showsHorizonDot } from '@/lib/row-corner'
import { useTaskQueue } from '@/components/PreferencesProvider'
import type { SegmentRow, SegmentView, TaskSegmentActions } from '@/hooks/useTaskSegments'
import type { Task } from '@/types'
import { prominenceClasses } from '@/components/reminders/ReminderRow'

/**
 * A TASK SEGMENT's rows (2026-10-10, docs/TASK-MODEL.md § Task segments).
 *
 * Tasks whose target hasn't arrived, for awareness — one segment per horizon,
 * each on its own day. Since 2026-10-11 a segment is a SEGMENT of the
 * reminders structure rather than a card of its own (Trent: "why isn't tasks
 * segmented like reminders? days, weeks, etc. should be individual segments
 * and behave similarly to the segments for reminders"): a page of the
 * dashboard panel's pager after the slots (`DashboardRemindersPanel`), and a
 * section shaped like a slot's on /reminders (`reminders/TaskSegmentGroup`).
 * This file holds what both draw inside that frame: the row, its horizon chip,
 * the over-50 nudge, and the considered row with its put-back. Never counted
 * in the headline, the nav badge or "Considered all so far".
 *
 * The row copies the reminder row (`ReminderRow`) where it can — the circle on
 * the left in the same place, the 16px wrapping title, never truncated — and
 * the quota prompt row's square on the right for "done", because a task row
 * has the same two verbs a prompt has: the CIRCLE means "considered" (seen,
 * never a completion) and the CHECKBOX means done. A tap anywhere else on the
 * row considers it, as on a reminder, so the rapid-fire flow is unchanged.
 * "Today" (target today) sits just left of the checkbox; holding it, or a
 * right-click, picks the time instead (`TargetTodayButton`).
 *
 * HOLDING THE ROW (2026-10-20; it replaced the pencil) opens its PEEK BUBBLE
 * — the dashboard panel's reminder bubble, the same shell (`RowPeekPopover`):
 * title, the row's own meta line, the note, Open (the Quick panel) and a
 * trash can. See `useSegmentRowPress` for the gestures.
 *
 * The meta line shows the HORIZON (a chip that changes it — an unset one says
 * so rather than pretending to be "weeks"), a future target as a date chip
 * ("Nov 1"), and the deadline.
 *
 * Considered rows LEAVE the list like considered reminders, so the next row
 * moves up under the pointer; the segment's "X of Y" counts them. Deferred
 * ones leave for today. A segment with nothing left waiting is finished for
 * the day.
 */

/** A segment's rows still waiting — the only ones listed (Trent, 10-11: a
 *  considered row leaves, "that's how it works with Reminders"). */
export function waitingRows(segment: SegmentView): SegmentRow[] {
  return segment.rows.filter((r) => r.state === 'waiting')
}

/** Its considered and deferred rows, behind "Show N considered". */
export function handledRows(segment: SegmentView): SegmentRow[] {
  return segment.rows.filter((r) => r.state !== 'waiting')
}

/**
 * "X of Y" for a segment, the slots' count (Trent, 2026-10-11): X is what was
 * handled today — considered, or deferred by Defer all — and Y the segment's
 * size today, so the number climbs rather than counting down. A task marked
 * done leaves the segment altogether, so it is in neither.
 */
export function segmentCounts(segment: SegmentView): { handled: number; total: number } {
  return { handled: segment.considered + segment.deferred, total: segment.rows.length }
}

/**
 * Whether the task queue's UI applies (PR 3): the switch from GET
 * /api/user/preferences (`useTaskQueue`) — or a queue panel itself, which the
 * server sends only with the switch on, so its rows never wear the
 * switch-off controls in the moment before the preferences load.
 */
export function useQueueOn(kind: SegmentKind): boolean {
  return useQueueUi(kind) === 'on'
}

/**
 * `useQueueOn` with the third state: 'pending' while the preferences are
 * still loading on a row that isn't a queue panel's — then the row draws
 * neither the switch-on nor the switch-off control, so nothing swaps over
 * when they land (`useTaskQueue().loaded`).
 */
export function useQueueUi(kind: SegmentKind): 'on' | 'off' | 'pending' {
  const { loaded, enabled } = useTaskQueue()
  if (isQueueKind(kind)) return 'on'
  if (!loaded) return 'pending'
  return enabled ? 'on' : 'off'
}

/**
 * A segment kind's panel title (Trent, 2026-10-20): "Task queue · Staged",
 * "… · Previously staged", "… · Upcoming", "… · Daily", "Weekly", "Monthly",
 * "Quarterly" (`taskQueueTitle`) — one format, the whole header on both
 * surfaces (uppercased there), no hint after it.
 */
export function segmentTitle(kind: SegmentKind): string {
  if (isQueueKind(kind)) return taskQueueTitle(QUEUE_PANEL_TITLES[kind])
  return taskQueueTitle(kind === 'upcoming' ? UPCOMING_LABEL : SEGMENT_TITLES[kind])
}

/** `segmentTitle` for a segment: its header, section and list names. */
export function segmentLabel(segment: SegmentView): string {
  return segmentTitle(segment.horizon)
}

/**
 * A segment's colour (2026-10-11, Trent's pick): one teal per horizon, darkest
 * for the soonest — the `--segment-*` tokens in globals.css, light and dark.
 * It fills the segment's bar while it fills (finished is green, like a slot),
 * rings the bar of the page on screen, and colours the segment's title.
 */
export function segmentColor(horizon: SegmentKind): string {
  return `var(--segment-${horizon})`
}

/**
 * A segment TITLE's colour: `--segment-title-*`. Its own token so the title can
 * be tuned apart from the bar — in light mode every title is one darker teal
 * (the lighter fills are too faint for small text); in dark mode it is the fill.
 */
export function segmentTitleColor(horizon: SegmentKind): string {
  return `var(--segment-title-${horizon})`
}

/** The pager page / section key of a segment — never a slot id ("tasks:days"). */
export function segmentKey(segment: SegmentView): string {
  return `tasks:${segment.horizon}`
}

/**
 * Over SEGMENT_NUDGE_THRESHOLD waiting, a nudge toward Process or the AI.
 * Counted from what still waits, so it leaves as rows are considered, without
 * waiting for the next fetch (the server's `nudge` rule). A neutral grey box,
 * not amber (Trent, 2026-10-12): a long list is a suggestion, not a warning.
 */
export function SegmentNudge({ segment, className }: { segment: SegmentView; className?: string }) {
  if (segment.waiting <= SEGMENT_NUDGE_THRESHOLD) return null
  return (
    <p
      className={cn(
        'text-muted-foreground bg-muted mb-2 rounded-md px-2 py-1.5 text-xs',
        className,
      )}
    >
      Over {SEGMENT_NUDGE_THRESHOLD} tasks to consider. Use{' '}
      <button
        type="button"
        className="text-foreground underline underline-offset-2"
        onClick={() => window.dispatchEvent(new CustomEvent('open-process'))}
      >
        Process
      </button>{' '}
      or ask the AI to help thin this out.
    </p>
  )
}

export function TaskSegmentRow({
  row,
  actions,
  timezone,
  panel,
  segmentHorizon,
  hiddenWhenNarrow = false,
}: {
  row: SegmentRow
  actions: TaskSegmentActions
  timezone: string
  panel: boolean
  segmentHorizon: SegmentKind
  /** Past the panel's narrow cap: in the DOM, on screen only from `xl` up —
   *  the panel's slot rows' own rule (`PanelRow`). */
  hiddenWhenNarrow?: boolean
}) {
  const { task } = row
  const considered = row.state === 'considered'
  const consider = () => {
    if (!considered) void actions.consider(task)
  }
  const rowProps = useSegmentRowPress({
    onPeek: (viaKeyboard) => actions.openPeek(task, viaKeyboard),
    onConsider: consider,
    enabled: !considered,
  })
  const peekOpen = actions.peek?.id === task.id
  // TRY TOMORROW's mark (task queue PR 3; designer 10-19): a left-edge mark,
  // like the priority tab, on a "Staged" row only. The row is NOT
  // lifted to the top — it keeps its place in the priority sort. The rollover
  // clears the flag once the row moves to "Previously staged".
  const tryTomorrow = segmentHorizon === 'queue_today' && task.try_tomorrow
  return (
    <RowPeekPopover
      open={peekOpen}
      onOpenChange={(open) => {
        if (!open) actions.closePeek()
      }}
      autoFocus={peekOpen && !!actions.peek?.viaKeyboard}
      contentProps={{ 'data-task-peek': task.id }}
      content={
        peekOpen ? (
          <SegmentRowPeek
            row={row}
            actions={actions}
            timezone={timezone}
            segmentHorizon={segmentHorizon}
          />
        ) : null
      }
    >
      <li
        data-segment-task={task.id}
        data-segment-state={row.state}
        tabIndex={considered ? -1 : 0}
        {...rowProps}
        // The SAME geometry as the rows around it (Trent, 2026-10-11: circles and
        // checkboxes must line up down the whole column): on the panel the
        // panel's reminder row (`gap-2.5 px-1 py-1.5`, 19px controls, 13.5px
        // title), on /reminders the page's (`gap-3 px-2 py-2.5`, 24px controls,
        // 16px title) — `QuotaPromptRow`'s two variants, exactly, including its
        // 1px transparent border (without it every circle here sat 1px left of
        // the reminder and prompt rows above it; every row in these lists,
        // considered ones too, now carries the same border).
        // `select-none` and no iOS callout: a held finger opens the bubble,
        // never a text selection or the system's copy sheet (the reminder
        // rows' `select-none`; the callout rule of the row's own buttons).
        className={cn(
          'group relative items-start rounded-xl border border-transparent select-none [-webkit-touch-callout:none]',
          hiddenWhenNarrow ? 'hidden xl:flex' : 'flex',
          panel ? 'gap-2.5 px-1 py-1.5' : 'gap-3 px-2 py-2.5',
          considered
            ? 'opacity-60'
            : cn('cursor-pointer', panel ? 'hover:bg-foreground/5' : 'hover:bg-foreground/[0.04]'),
        )}
      >
        {tryTomorrow && (
          <span
            role="img"
            data-try-tomorrow
            aria-label={TRY_TOMORROW_MARK}
            title={TRY_TOMORROW_MARK}
            className="absolute top-1.5 bottom-1.5 -left-px w-[3px] rounded-r-sm"
            style={{ backgroundColor: 'var(--segment-queue_today)' }}
          />
        )}
        <SegmentRowCircle task={task} considered={considered} panel={panel} onConsider={consider} />
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'text-pretty',
              // The title colour of the reminder row beside it (Trent, 10-11:
              // "make them the same"): on /reminders, `prominenceClasses` by
              // priority; on the panel, the panel reminder row's plain text.
              // The SEGMENT's own title in the header stays teal.
              panel
                ? 'text-foreground text-[13.5px] leading-[1.42]'
                : cn('text-[16px] leading-6', prominenceClasses(task.priority)),
            )}
          >
            {task.title}
          </p>
          {segmentHorizon === 'upcoming' ? (
            <UpcomingMeta row={row} actions={actions} timezone={timezone} />
          ) : (
            <TaskSegmentMeta
              task={task}
              timezone={timezone}
              segmentHorizon={segmentHorizon}
              onOpenDetails={() => actions.openDetails(task)}
            />
          )}
        </div>
        {!considered && (
          <TaskSegmentRowActions
            row={row}
            actions={actions}
            timezone={timezone}
            panel={panel}
            segmentHorizon={segmentHorizon}
          />
        )}
      </li>
    </RowPeekPopover>
  )
}

/**
 * The PEEK BUBBLE's body for a task row (2026-10-20): the reminder bubble's
 * (`RowPeekBody`) with the row's OWN meta line, drawn read-only — the same
 * components, so the bubble can never describe the task differently from the
 * row (a waiting repeating task's occurrence date included). Open → the Quick
 * panel the pencil used to open (`SegmentDetailsModal`); the trash can → a
 * soft delete with Undo, the reminder bubble's.
 */
function SegmentRowPeek({
  row,
  actions,
  timezone,
  segmentHorizon,
}: {
  row: SegmentRow
  actions: TaskSegmentActions
  timezone: string
  segmentHorizon: SegmentKind
}) {
  const { task } = row
  return (
    <RowPeekBody
      title={task.title}
      meta={
        segmentHorizon === 'upcoming' ? (
          <UpcomingMeta row={row} actions={actions} timezone={timezone} readOnly />
        ) : (
          <TaskSegmentMeta
            task={task}
            timezone={timezone}
            segmentHorizon={segmentHorizon}
            readOnly
          />
        )
      }
      notes={task.notes}
      onOpen={() => {
        // The bubble is done the moment the editor takes over — left open, it
        // would stack a popover behind a dialog (the reminder panel's rule).
        actions.closePeek()
        actions.openDetails(task)
      }}
      onDelete={() => {
        actions.closePeek()
        void actions.remove(task)
      }}
      deleteLabel={`Move "${task.title}" to Trash`}
    />
  )
}

/** The row's left circle: "considered" (seen, never a completion). */
function SegmentRowCircle({
  task,
  considered,
  panel,
  onConsider,
}: {
  task: Task
  considered: boolean
  panel: boolean
  onConsider: () => void
}) {
  if (considered) {
    return (
      <span
        aria-hidden
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full bg-green-600 text-white',
          panel ? 'size-[19px]' : 'mt-[3px] size-6',
        )}
      >
        <Check className={panel ? 'size-3' : 'size-3.5'} strokeWidth={3} />
      </span>
    )
  }
  return (
    <button
      type="button"
      tabIndex={-1}
      // A hold that starts on the circle is not the row's hold: the circle
      // keeps its one meaning (the reminder panel's circle, `PanelRow`).
      data-no-row-press
      onClick={(e) => {
        e.stopPropagation()
        onConsider()
      }}
      aria-label={`Mark "${task.title}" as considered`}
      title="Considered (seen — not done)"
      className={cn(
        'hover:border-foreground/60 hover:bg-foreground/5 flex shrink-0 cursor-pointer items-center justify-center rounded-full border-[1.5px] transition-colors',
        panel ? 'border-foreground/25 size-[19px]' : 'border-foreground/20 mt-[3px] size-6',
      )}
    >
      <Check
        className={cn(
          'group-hover:text-foreground/40 text-transparent transition-colors',
          panel ? 'size-3' : 'size-3.5',
        )}
        strokeWidth={3}
      />
    </button>
  )
}

/** Read to assistive tech on every waiting row: the peek's ways in. */
export const ROW_PEEK_DESCRIPTION =
  'Tap to mark considered. Hold, right-click or press Command-Enter for details.'

/**
 * The row's own gestures (2026-10-20, when the peek replaced the pencil):
 *
 * - TAP / click: considered (unchanged — the rapid-fire pass).
 * - HOLD, finger or mouse: the peek bubble. The app's `useLongPress` (400ms;
 *   a move past 10px cancels it, so a scroll that starts on a row never opens
 *   one), and `didFire()` swallows the click the hold leaves behind, so a
 *   hold never also considers. Primary button only: a right-click's
 *   pointerdown would otherwise start the timer too.
 * - RIGHT-CLICK: the bubble at once (the browser's menu suppressed). On
 *   Android a long touch also fires `contextmenu`; it opens the same bubble.
 * - Cmd/Ctrl+Enter on the focused row: the bubble, with focus moved into it
 *   (plain Enter and Space still consider). `aria-keyshortcuts` and the
 *   description say so.
 *
 * A press that starts on one of the row's own controls is that control's:
 * the circle, On deck tomorrow, On deck, Today and the done square carry
 * `data-no-row-press` (On deck and Today keep their own holds and right-click
 * menus), as on the dashboard row (`TaskRow`), and so does the Upcoming
 * target chip — and any button counts, so a control added later can't open
 * the bubble from a hold meant for it. Events from outside the row's DOM — a portalled menu or dialog one of its
 * controls opened, whose React events still bubble here — are ignored too.
 */
function useSegmentRowPress({
  onPeek,
  onConsider,
  enabled,
}: {
  onPeek: (viaKeyboard: boolean) => void
  onConsider: () => void
  enabled: boolean
}) {
  const press = useLongPress({ onLongPress: enabled ? () => onPeek(false) : undefined })
  const isOwn = (e: React.SyntheticEvent<HTMLElement>) => {
    const target = e.target as Element
    return e.currentTarget.contains(target) && !target.closest('[data-no-row-press], button')
  }
  return {
    'aria-keyshortcuts': enabled ? 'Meta+Enter Control+Enter' : undefined,
    'aria-description': enabled ? ROW_PEEK_DESCRIPTION : undefined,
    onClick: (e: React.MouseEvent<HTMLLIElement>) => {
      if (press.didFire()) {
        e.preventDefault()
        return
      }
      onConsider()
    },
    onPointerDown: (e: React.PointerEvent<HTMLLIElement>) => {
      if (e.button !== 0 || !isOwn(e)) return
      press.onPointerDown(e)
    },
    onPointerUp: press.onPointerUp,
    onPointerMove: press.onPointerMove,
    onPointerLeave: press.onPointerLeave,
    onPointerCancel: press.onPointerUp,
    onContextMenu: (e: React.MouseEvent<HTMLLIElement>) => {
      if (!enabled || !isOwn(e)) return
      e.preventDefault()
      onPeek(false)
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLLIElement>) => {
      // The row's own keys only: Enter or Space on a button inside it
      // (On deck, Today, done) is that button's, never a consider.
      if (e.target !== e.currentTarget) return
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        if (enabled) onPeek(true)
        return
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onConsider()
      }
    },
  }
}

/**
 * The row's right side: horizon dot, "On deck", "Today", and the done square
 * — On deck tomorrow · On deck · Today · checkbox with the queue on (spec
 * rule 8; each acts in one tap, for rapid-fire passes).
 *
 * On an UPCOMING row (2026-10-12) there is no horizon dot — a targeted task's
 * horizon decides nothing until the target is removed (spec §1).
 *
 * THE TASK QUEUE ON (PR 3, resolution 10): the horizon dot's place on EVERY
 * task-segment row — the queue's, the horizons' and Upcoming's — went to the
 * details icon (the pencil), and since 2026-10-20 to ON DECK TOMORROW
 * (`DeckTomorrowButton`): the details are now a hold on the row away (the
 * peek bubble's Open). The horizon itself is on the meta line as the row
 * corner's dot (`TaskSegmentMeta`). Switch off: the dot button, as before
 * the queue.
 */
/**
 * The height of On deck tomorrow's, On deck's and Today's HOVER BOX (2026-10-20): the
 * grey block a hover paints, inside the button's larger hit target. It must
 * lie inside the row (`tq-run-now.spec.ts` checks): 32px in a page row (24px
 * line, 10px padding); 26px in a panel row (19px line, 6px padding, the
 * controls lifted 3px to line up with the done square), where 32 poked 2px
 * above the row.
 */
const HOVER_BOX = { page: 'h-8', panel: 'h-6.5' } as const

/**
 * On deck's and Today's HIT TARGET (2026-10-20, Trent: tighten pencil · On
 * deck · Today): 44px tall always, and 44px wide for a finger — but with a
 * mouse only as wide as the hover box, the pencil's own rule (`size-8`, 44
 * only on `pointer-coarse`; On deck tomorrow, in the pencil's place, keeps
 * it: `SLOT_HIT`). The 44px width used to leave 6–9px of empty
 * button either side of each hover box, so the three read as spread apart.
 */
const CONTROL_HIT = '-my-3 h-11 min-w-11 pointer-fine:min-w-0'

/** On deck's hover box, and the empty slot's (`DeckSlotSpacer`). */
const DECK_BOX = { page: `${HOVER_BOX.page} w-8`, panel: `${HOVER_BOX.panel} w-6.5` } as const

function TaskSegmentRowActions({
  row,
  actions,
  timezone,
  panel,
  segmentHorizon,
}: {
  row: SegmentRow
  actions: TaskSegmentActions
  timezone: string
  panel: boolean
  segmentHorizon: SegmentKind
}) {
  const { task } = row
  const queueUi = useQueueUi(segmentHorizon)
  const showToday = segmentHorizon !== 'upcoming' || upcomingRowActions(row).today
  return (
    <div
      className={cn(
        // 8px between the hover boxes with a mouse; with a finger the 44px hit
        // targets abut and their own padding is the gap (2026-10-20).
        'flex shrink-0 items-center gap-2 pointer-coarse:gap-0',
        panel ? '-my-[3px]' : 'mt-[3px]',
      )}
    >
      {queueUi === 'on' ? (
        <DeckTomorrowSlot row={row} actions={actions} timezone={timezone} panel={panel} />
      ) : queueUi === 'pending' ? (
        // Preferences still loading: the slot both controls share, empty,
        // so the row doesn't shift when one of them arrives.
        segmentHorizon !== 'upcoming' && <span aria-hidden className={SLOT_HIT} />
      ) : (
        // The horizon dot (2026-10-14; it replaced the chevron chip): the
        // segment header names the segment, the dot the task's own horizon —
        // a bigger dot than its neighbours' when a deadline pulled it in.
        segmentHorizon !== 'upcoming' && (
          <HorizonDotButton
            task={task}
            variant="inline"
            onChange={(h) => void actions.setHorizon(task, h, segmentHorizon)}
          />
        )
      )}
      <SegmentDeckSlot
        row={row}
        actions={actions}
        timezone={timezone}
        panel={panel}
        queueUi={queueUi}
      />
      {showToday && (
        <TargetTodayButton
          task={task}
          timezone={timezone}
          onTargetToday={(t) => void actions.targetToday(t)}
          onTargetAt={(t, at) => void actions.targetAt(t, at)}
          showLabel
          // A full 44px hit target around a glyph the size of the circle and
          // the done square; the negative margin keeps the row's height. The
          // 12px `mr-3` after it is dead space, so its hit area never touches
          // the done square's (Trent mis-tapped Today for done, 2026-10-12).
          // The grey hover block is the inner box, the row buttons'
          // (`HOVER_BOX`), so it stays inside the row: the whole 44px button
          // used to paint it, poking out of every row (2026-10-20).
          className={`${CONTROL_HIT} mr-3`}
          boxClassName={
            panel ? `${HOVER_BOX.panel} min-w-6.5 sm:px-1.5` : `${HOVER_BOX.page} min-w-8 sm:px-2`
          }
          iconClassName={panel ? 'size-[19px]' : 'size-6'}
        />
      )}
      {/* The quota prompt's did-it square (`QuotaPromptRow`), not the
          stock checkbox: same size, radius, border and no shadow. */}
      <button
        type="button"
        // A hold or right-click here is never the row's peek.
        data-no-row-press
        onClick={(e) => {
          e.stopPropagation()
          void actions.done(task)
        }}
        aria-label={`Done: "${task.title}"`}
        title="Done"
        className={cn(
          'group/done border-foreground/25 hover:border-foreground/60 hover:bg-foreground/5 flex shrink-0 cursor-pointer items-center justify-center rounded-[5px] border-[1.5px] transition-colors',
          panel ? 'size-[19px]' : 'size-6',
        )}
      >
        <Check
          className={cn(
            'group-hover/done:text-foreground/50 text-transparent transition-colors',
            panel ? 'size-3' : 'size-3.5',
          )}
          strokeWidth={3}
        />
      </button>
    </div>
  )
}

/**
 * ON DECK (D2, spec rule 8) on a segment row: between On deck tomorrow and
 * Today, with the task queue on — never on a one-off beside a target the
 * user picked (rule 1). Repeating rows (queue waiting rows, Upcoming) have it
 * too since 2026-10-20: it decks the current occurrence (`offersDeck`). Today's hit target and hover box (`HOVER_BOX`), without its `mr-3`: that
 * dead space belongs between Today and the done square only. While the
 * preferences load, its place is kept empty only if the switch was on last
 * time (`DeckPlaceholder`).
 */
function SegmentDeckSlot({
  row,
  actions,
  timezone,
  panel,
  queueUi,
}: {
  row: SegmentRow
  actions: TaskSegmentActions
  timezone: string
  panel: boolean
  queueUi: 'on' | 'off' | 'pending'
}) {
  if (queueUi === 'off') return null
  if (queueUi === 'pending') return <DeckPlaceholder panel={panel} />
  // A row without the button (a one-off with a target the user picked) keeps
  // its place empty (Trent, 2026-10-20), so the row's controls line up down
  // the column.
  if (!offersDeck(row.task)) return <DeckSlotSpacer panel={panel} empty />
  return (
    <OnDeckButton
      task={row.task}
      timezone={timezone}
      onDeck={(t, day) => void actions.deck(t, day)}
      // Icon only (Trent, 2026-10-20): the tooltip and the name say "On deck".
      className={CONTROL_HIT}
      boxClassName={panel ? DECK_BOX.panel : DECK_BOX.page}
      iconClassName={panel ? 'size-[18px]' : 'size-[22px]'}
    />
  )
}

/**
 * The first slot's HIT TARGET (the pencil's, which On deck tomorrow took over,
 * and the empty place while the preferences load): 32px with a mouse, 44px
 * with a finger, pulled back to the row's line height — the inline horizon
 * dot's box (`HorizonDotButton`). The hover block is an inner box
 * (`HOVER_BOX`), so a finger's taller hit target never paints outside the row.
 */
const SLOT_HIT = '-my-2 size-8 shrink-0 pointer-coarse:-my-3 pointer-coarse:size-11'

/**
 * ON DECK TOMORROW (2026-10-20), in the pencil's place: one tap decks the task
 * for tomorrow — the On deck hold menu's own Tomorrow (`deckTomorrowDay` reads
 * it from `deckMenuDays`, so the two can never disagree), through the same
 * `actions.deck`: the same A1 refusals and toasts, the same Undo, and the row
 * leaves its panel like any action. No hold menu — On deck beside it has one.
 * Repeating rows too: it decks the current occurrence for tomorrow, as On
 * deck's Tomorrow does. A row On deck isn't offered on (a one-off with a
 * target the user picked, `offersDeck`) keeps the place empty, so the
 * controls line up down the column.
 *
 * `data-no-row-press` and the stopped events: a press, hold or right-click
 * here is this button's, never the row's peek or consider.
 */
function DeckTomorrowSlot({
  row,
  actions,
  timezone,
  panel,
}: {
  row: SegmentRow
  actions: TaskSegmentActions
  timezone: string
  panel: boolean
}) {
  const { task } = row
  if (!offersDeck(task)) {
    return <span aria-hidden data-deck-tomorrow-empty className={SLOT_HIT} />
  }
  return (
    <button
      type="button"
      data-deck-tomorrow
      data-no-row-press
      onClick={(e) => {
        e.stopPropagation()
        void actions.deck(task, deckTomorrowDay(timezone, new Date()))
      }}
      onKeyDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
      aria-label={`On deck tomorrow: “${task.title}”`}
      title="On deck tomorrow"
      className={cn(
        'group/deck-tomorrow text-muted-foreground hover:text-foreground relative flex cursor-pointer touch-manipulation items-center justify-center rounded-md transition-colors select-none [-webkit-touch-callout:none]',
        SLOT_HIT,
      )}
    >
      <span
        data-deck-tomorrow-box
        className={cn(
          'group-hover/deck-tomorrow:bg-foreground/5 flex items-center justify-center rounded-md transition-colors',
          panel ? DECK_BOX.panel : DECK_BOX.page,
        )}
      >
        <DeckTomorrowIcon
          className={panel ? 'size-[18px]' : 'size-[22px]'}
          // On deck's `Layers2` weight beside it (`DeckFace`).
          strokeWidth={1.75}
        />
      </span>
    </button>
  )
}

/**
 * On deck's place while the preferences load — only when this viewer last
 * saw the switch ON (`useLastKnownQueueOn`). Off, or unknown: nothing, so a
 * switch-off row never shifts by 44px when they land (review #4).
 */
function DeckPlaceholder({ panel }: { panel: boolean }) {
  const lastOn = useLastKnownQueueOn()
  return lastOn ? <DeckSlotSpacer panel={panel} /> : null
}

/**
 * Empty space exactly On deck's size: its hit target around its hover box
 * (`CONTROL_HIT`, `DECK_BOX`), so nothing beside it moves.
 */
function DeckSlotSpacer({ panel, empty = false }: { panel: boolean; empty?: boolean }) {
  return (
    <span
      aria-hidden
      data-deck-placeholder={empty ? undefined : ''}
      data-deck-slot-empty={empty ? '' : undefined}
      className={cn('flex shrink-0 items-center justify-center', CONTROL_HIT)}
    >
      <span className={panel ? DECK_BOX.panel : DECK_BOX.page} />
    </span>
  )
}

/**
 * The second line, only when there is something to say: a future target date
 * ("Nov 1") — a waiting repeating task's occurrence instead
 * (`queuedRepeatOccurrence`) — or a deadline. Without either the row is one line, a reminder row's
 * height — the segment stays bite-size.
 *
 * With the task queue on (PR 3) the horizon is here too, as the row corner's
 * dot (`showsHorizonDot`, the dashboard row's rule: a one-off with no picked
 * target), since the dot's place on the right went to the row's buttons — and
 * a repeating task waiting in the queue names its schedule ("every Wed").
 *
 * `readOnly` (the row's peek bubble, 2026-10-20): the same line, nothing to
 * press — the dot is just its mark.
 */
function TaskSegmentMeta({
  task,
  timezone,
  segmentHorizon,
  onOpenDetails,
  readOnly = false,
}: {
  task: Task
  timezone: string
  segmentHorizon: SegmentKind
  /** The meta dot opens the task's details (the Quick panel). */
  onOpenDetails?: () => void
  readOnly?: boolean
}) {
  const { projects } = useProjects()
  const queueOn = useQueueOn(segmentHorizon)
  const project = projects.find((p) => p.id === task.project_id)
  const priority = task.priority > 0 ? getPriorityOption(task.priority) : null
  // A repeating task waiting in the queue shows the occurrence it stands
  // for, not its moved target (`queuedRepeatOccurrence`, 2026-10-20).
  const queuedOccurrence = queueOn ? queuedRepeatOccurrence(task) : null
  const shownAt = queuedOccurrence ?? task.due_at
  const target = shownAt ? DateTime.fromISO(shownAt).setZone(timezone) : null
  const deadline = task.deadline_at ? DateTime.fromISO(task.deadline_at).setZone(timezone) : null
  // The dashboard row's context, compactly (Trent, 10-11): the project, the
  // priority, a future target and the deadline.
  return (
    <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {project && (
        <span data-segment-project className="inline-flex items-center gap-1">
          <FolderOpen className="size-3" aria-hidden />
          {project.name}
        </span>
      )}
      {/* The horizon dot AFTER the project (Trent, 2026-10-20), not before
          it: only one-offs wear it, so in front it pushed their project names
          right of the repeating rows'. Now every row's project starts at the
          same x. */}
      {queueOn && showsHorizonDot(task) && (
        <HorizonDotButton
          task={task}
          variant="meta"
          onOpen={readOnly ? undefined : onOpenDetails}
        />
      )}
      {priority && (
        <span data-segment-priority className={priority.color}>
          {priority.label}
        </span>
      )}
      {target && (
        <span
          data-target-chip
          title={`${queuedOccurrence ? '' : 'Target '}${target.toFormat('ccc LLL d, h:mm a')}`}
        >
          {target.toFormat('LLL d')}
          {task.rrule && (
            <span className="text-muted-foreground">
              {' · '}
              {recurrenceSummary(task.rrule, task.anchor_time)}
            </span>
          )}
        </span>
      )}
      {deadline && (
        <span data-deadline-chip className="text-amber-700 dark:text-amber-400">
          deadline {deadline.toFormat('LLL d')}
        </span>
      )}
      {/* No badges on a queue row (designer, 10-19) — neither attempts nor
          age: the queue is read at a glance. A waiting repeating task keeps a
          target (its next occurrence) and its count, so it would read "226×". */}
      {!isQueueKind(segmentHorizon) && <BadgeChips task={task} timezone={timezone} />}
    </div>
  )
}

/**
 * The two badges (spec §7), as quiet chips at the end of a segment row's
 * second line: the attempts ("2×", a task with a target that has been over
 * it — e.g. moved ahead after missing it) and the age (">1 mo", an undated
 * task past its horizon's threshold). Never both: age is undated only.
 */
function BadgeChips({ task, timezone }: { task: Task; timezone: string }) {
  const now = new Date()
  // OpenTask days with the task queue on, calendar days off — the server's
  // own count either way (`useTaskQueue`).
  // The server's stored count until the preferences (the switch) have loaded.
  const { loaded, attemptsRolloverTime } = useTaskQueue()
  const attempts = loaded
    ? effectiveAttempts(task, timezone, now, attemptsRolloverTime).attempts
    : (task.attempts ?? 0)
  const age = ageLabel(task, now, timezone)
  return (
    <>
      {task.due_at !== null && attempts >= 1 && (
        <span
          data-attempts={attempts}
          title={`Over target on ${attempts} day${attempts === 1 ? '' : 's'}`}
          className="text-over-target font-semibold tabular-nums"
        >
          {attempts}×
        </span>
      )}
      {age && (
        <span data-age-label={age} className="text-muted-foreground/80">
          {age}
        </span>
      )}
    </>
  )
}

/**
 * An UPCOMING row's second line (2026-10-12, spec §2): the gap text —
 * "Target Tue Nov 3 · deadline Sat Nov 7 (+4d)" — after the project and
 * priority. The "Target …" part is a chip that opens a one-item menu
 * (`targetReset`, §8.3): on a one-off with no deadline, "Remove target"
 * (back to its horizon segment); on one with a deadline, "Back to auto" (the
 * deadline's automatic target again — which leaves Upcoming). Undo on the
 * toast either way. A repeating row's chip names its schedule ("every Wed", `recurrenceSummary`, the widget's words) and does nothing.
 * `readOnly` (the row's peek bubble): the same words, the chip a plain label.
 */
function UpcomingMeta({
  row,
  actions,
  timezone,
  readOnly = false,
}: {
  row: SegmentRow
  actions: TaskSegmentActions
  timezone: string
  readOnly?: boolean
}) {
  const { task } = row
  const { projects } = useProjects()
  const project = projects.find((p) => p.id === task.project_id)
  const priority = task.priority > 0 ? getPriorityOption(task.priority) : null
  const gap = upcomingGap(task, timezone)
  const reset = readOnly ? null : upcomingRowActions(row).reset
  return (
    <div
      data-upcoming-gap
      className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
    >
      {project && (
        <span data-segment-project className="inline-flex items-center gap-1">
          <FolderOpen className="size-3" aria-hidden />
          {project.name}
        </span>
      )}
      {priority && (
        <span data-segment-priority className={priority.color}>
          {priority.label}
        </span>
      )}
      {gap.target &&
        (reset ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
              data-no-row-press
              data-target-chip
              aria-label={`${gap.target}. Options`}
              className="text-foreground/70 hover:bg-foreground/5 -mx-1 inline-flex items-center gap-0.5 rounded px-1 py-0.5"
            >
              {gap.target}
              <ChevronDown className="size-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem
                data-remove-target={reset === 'remove' ? '' : undefined}
                data-back-to-auto={reset === 'auto' ? '' : undefined}
                onSelect={() => void actions.removeTarget(task)}
              >
                {reset === 'auto' ? BACK_TO_AUTO : 'Remove target'}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span data-target-chip className="text-foreground/70">
            {gap.target}
            {row.recurring && task.rrule && (
              <span className="text-muted-foreground">
                {' · '}
                {recurrenceSummary(task.rrule, task.anchor_time)}
              </span>
            )}
          </span>
        ))}
      {gap.target && gap.deadline && (
        <span aria-hidden className="-mx-1">
          ·
        </span>
      )}
      {gap.deadline && (
        <span data-deadline-chip className="text-amber-700 dark:text-amber-400">
          {gap.deadline}
        </span>
      )}
      <BadgeChips task={task} timezone={timezone} />
    </div>
  )
}

/**
 * The horizon, visible and changeable (spec §3), in the editor
 * (`TaskModelFields`): its word and a chevron, opening the shared horizon menu
 * (`HorizonMenuContent`, each option with its dot). Unset is never reported as
 * if the user had said "weeks". The rows use the dot itself instead
 * (`HorizonDotButton`).
 */
export function HorizonChip({
  task,
  onChange,
}: {
  task: Pick<Task, 'horizon' | 'title'>
  onChange: (horizon: HorizonValue | null) => void
}) {
  const label = task.horizon ? HORIZON_LABELS[task.horizon] : HORIZON_UNSET_LABEL
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        data-horizon-chip
        aria-label={`${HORIZON_WORD}: ${label}. Change`}
        title={`${HORIZON_WORD}: ${label}`}
        className={cn(
          'hover:bg-foreground/5 inline-flex items-center gap-0.5 rounded px-1 py-1 text-xs',
          task.horizon ? 'text-foreground/60' : 'text-muted-foreground/70 italic',
        )}
      >
        {label}
        <ChevronDown className="size-3" />
      </DropdownMenuTrigger>
      <HorizonMenuContent value={task.horizon} onChange={onChange} align="start" />
    </DropdownMenu>
  )
}

/**
 * One considered (or deferred) task behind a segment's "Show N considered" —
 * the slots' considered row on each surface (`ConsideredRow` on /reminders,
 * the panel's `ConsideredList` row), so the lists line up. Its filled circle
 * puts it back (`/api/task-segments/restore`, 2026-10-11): it waits again, and
 * comes back daily until it is considered.
 */
export function ConsideredSegmentRow({
  row,
  panel,
  onPutBack,
}: {
  row: SegmentRow
  panel: boolean
  onPutBack: (task: Task) => void
}) {
  const { task, state } = row
  return (
    <li
      data-considered-task-id={task.id}
      className={cn(
        'flex items-start rounded-xl border border-transparent',
        panel ? 'gap-2.5 px-1 py-1.5' : 'gap-3 px-2 py-2.5',
      )}
    >
      <button
        type="button"
        onClick={() => onPutBack(task)}
        aria-label={`Put back "${task.title}"`}
        title="Put back"
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full bg-green-600 text-white transition-colors hover:bg-green-600/50',
          panel ? 'size-[19px]' : 'mt-[3px] size-6',
        )}
      >
        <Check className={panel ? 'size-3' : 'size-3.5'} strokeWidth={3} />
      </button>
      <p
        className={cn(
          'text-muted-foreground min-w-0 flex-1 text-pretty',
          panel ? 'text-[13.5px] leading-[1.42]' : 'text-[16px] leading-6',
        )}
      >
        {task.title}
        {state === 'deferred' && <span className="ml-1.5 text-xs">· deferred</span>}
      </p>
    </li>
  )
}
