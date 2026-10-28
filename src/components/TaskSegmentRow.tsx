'use client'

import { Check, ChevronDown, FolderOpen, Forward } from 'lucide-react'
import { DateTime } from 'luxon'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { recurrenceSummary } from '@/lib/recurrence-summary'
import { queuedRepeatOccurrence } from '@/lib/editor-target-labels'
import { TargetTodayButton } from '@/components/TargetMenu'
import { DECK_LIT, DeckMenu, OnDeckButton } from '@/components/OnDeckButton'
import {
  deckReplaces,
  deckTomorrowIfKnown,
  deferLeadDays,
  offersDeck,
  todayReplaces,
} from '@/lib/deck-menu'
import { ReplaceConfirm } from '@/components/ReplaceConfirm'
import { OptionMenu } from '@/components/OptionMenu'
import { DeckTomorrowIcon } from '@/components/icons/DeckTomorrowIcon'
import { RowPeekBody, RowPeekPopover } from '@/components/RowPeekPopover'
import { useLongPress, useSimpleLongPress } from '@/hooks/useLongPress'
import { useLastKnownQueueOn } from '@/lib/last-known-queue'
import { HorizonDotButton, HorizonMenuContent } from '@/components/HorizonDot'
import { getPriorityOption } from '@/lib/priority'
import { useProjects } from '@/components/ProjectsProvider'
import { useLabelConfig } from '@/components/PreferencesProvider'
import { LabelBadges } from '@/components/LabelBadges'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  HORIZON_LABELS,
  HORIZON_UNSET_LABEL,
  HORIZON_WORD,
  QUEUE_PANEL_TITLES,
  DEADLINES_PAGE_TITLE,
  REMOVE_TARGET,
  SEGMENT_TITLES,
  TRY_TOMORROW_MARK,
  taskQueueTitle,
  UPCOMING_LABEL,
} from '@/lib/task-model-words'
import {
  SEGMENT_NUDGE_THRESHOLD,
  isQueueKind,
  onlyWithQueue,
  segmentCounts,
  type HorizonValue,
  type SegmentKind,
  type SegmentLeft,
} from '@/lib/task-segments'
import { ageLabel, effectiveAttempts, upcomingGap, upcomingRowActions } from '@/lib/task-segments'
import { showsHorizonDot } from '@/lib/row-corner'
import { useDayStart, useDayStartKnown, useTaskQueue } from '@/components/PreferencesProvider'
import type { SegmentRow, SegmentView, TaskSegmentActions } from '@/hooks/useTaskSegments'
import type { Task } from '@/types'
import { prominenceClasses } from '@/components/reminders/ReminderRow'
import { usePriorityRowStyles } from '@/hooks/usePriorityRowStyles'
import { DeadlineChip } from '@/components/DeadlineChip'
import { TimeChip, timeChipClasses } from '@/components/TimeChip'
import { useTimezone } from '@/hooks/useTimezone'

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
 * in the nav badge or "Considered all so far"; with the task queue on, the
 * Reminders headline counts them as its tasks half (ruling "B", 2026-10-26,
 * `headlineCounts` in src/lib/reminders-summary.ts).
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
 * "X of Y" for a segment — `segmentCounts` in src/lib/task-segments.ts (pure,
 * so the Reminders headline's sum and its tests read the same numbers as
 * every segment header). Re-exported here, where the surfaces import it.
 */
export { segmentCounts }

/**
 * Whether the task queue's UI applies (PR 3): the switch from GET
 * /api/user/preferences (`useTaskQueue`) — or a queue panel (or the deadlines
 * page) itself, which the server sends only with the switch on, so its rows never wear the
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
  if (onlyWithQueue(kind)) return 'on'
  if (!loaded) return 'pending'
  return enabled ? 'on' : 'off'
}

/**
 * A segment kind's panel title (Trent, 2026-10-20): "Task queue · Today's
 * pulls", "… · Previous pulls" (2026-10-21), "… · Upcoming", "… · Daily", "Weekly", "Monthly",
 * "Quarterly" (`taskQueueTitle`) — one format, the whole header on both
 * surfaces (uppercased there), no hint after it.
 */
export function segmentTitle(kind: SegmentKind): string {
  if (isQueueKind(kind)) return taskQueueTitle(QUEUE_PANEL_TITLES[kind])
  if (kind === 'deadlines') return taskQueueTitle(DEADLINES_PAGE_TITLE)
  return taskQueueTitle(kind === 'upcoming' ? UPCOMING_LABEL : SEGMENT_TITLES[kind])
}

/**
 * Whether a segment has "Defer all" (off today's list, back tomorrow —
 * `segment_deferred_at`). Not the queue's two panels (spec rule 8: consider,
 * Today and done), and not the DEADLINES page (2026-10-22): its Defer moves a
 * row's lead day (`/api/task-segments/defer-lead`), one row at a time.
 */
export function offersDeferAll(kind: SegmentKind): boolean {
  return !isQueueKind(kind) && kind !== 'deadlines'
}

/** `segmentTitle` for a segment: its header, section and list names. */
export function segmentLabel(segment: SegmentView): string {
  return segmentTitle(segment.horizon)
}

/**
 * A segment's colour (2026-10-11, Trent's pick): one teal per horizon, darkest
 * for the soonest — the `--segment-*` tokens in globals.css, light and dark.
 * Since 2026-10-26 no bar fills in it (every bar fills in the reminders'
 * purple, `ReminderSlotBar`); the titles keep their teals
 * (`segmentTitleColor`), and the deadlines page finishes in its own
 * (`segmentDoneColor`).
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

/**
 * A segment's FINISHED colour, where it is not the done green. THE ONE PLACE
 * a segment kind opts out of green-when-done (2026-10-26, Trent: "change the
 * color on that one and see what that's like"): the deadlines page — usually
 * empty, so done from the start of the day — keeps its own teal when
 * finished. `undefined` for every other kind, which then draws the green
 * classes exactly as before. A considered ROW's green circle is the row's own
 * state and stays green on every page.
 *
 * Two flavours, because text needs more contrast than a graphic (globals.css,
 * `--deadlines` vs `--deadlines-fill`; one colour in dark mode):
 * - `segmentDoneColor` — the FILL (`--segment-deadlines`): the strip and
 *   day-bar fill, the hairline, and every ✓ glyph (the pager header's, the
 *   "N of N ✓" check, "Nothing today ✓"). Passed as `doneColor`, or as
 *   `doneAccent` where that prop colours only a check.
 * - `segmentDoneTextColor` — the TEXT (`--segment-title-deadlines`, the
 *   title's colour): the finished "N of N" count's numbers on /reminders.
 */
export function segmentDoneColor(horizon: SegmentKind): string | undefined {
  return horizon === 'deadlines' ? segmentColor(horizon) : undefined
}

/** A segment's finished TEXT colour in place of green — see `segmentDoneColor`. */
export function segmentDoneTextColor(horizon: SegmentKind): string | undefined {
  return horizon === 'deadlines' ? segmentTitleColor(horizon) : undefined
}

/** The pager page / section key of a segment — never a slot id ("tasks:days"). */
export function segmentKey(segment: SegmentView): string {
  return `tasks:${segment.horizon}`
}

/**
 * An EMPTY segment (Trent, 2026-10-24: "always show every queue segment,
 * every day, in fixed positions"): no rows today, so it is done from the
 * start of the day — green in the strip and the day bar, "0 of 0 ✓" in its
 * header, and this line where its rows would be. Not "Nothing left here",
 * which says a segment that had rows was worked through.
 */
export function segmentEmpty(segment: SegmentView): boolean {
  return segment.rows.length === 0
}

/**
 * "Nothing today ✓" — Trent's words — on an empty segment's page or section.
 * The muted text and the green check of every finished count here (the Tasks
 * card's done line, a finished slot's "N of N ✓") — the deadlines page's own
 * teal there instead (`segmentDoneColor`).
 */
export function EmptySegmentLine({
  className,
  doneAccent,
}: {
  className?: string
  /** The segment's finished colour in place of green (`segmentDoneColor`). */
  doneAccent?: string
}) {
  return (
    <p
      data-segment-empty
      className={cn('text-muted-foreground flex items-center gap-1 text-sm', className)}
    >
      Nothing today
      <Check
        data-done-check
        className={cn('size-3.5', !doneAccent && 'text-green-700 dark:text-green-400')}
        style={doneAccent ? { color: doneAccent } : undefined}
        strokeWidth={2.5}
        aria-hidden="true"
      />
    </p>
  )
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
  // The deadlines page's safety net (2026-10-22): a row already seen today
  // stays, waiting — another consider would change nothing.
  const seenInNet = !!row.safetyNet && !!row.seen
  const consider = () => {
    if (!considered && !seenInNet) void actions.consider(task)
  }
  const rowProps = useSegmentRowPress({
    onPeek: (viaKeyboard) => actions.openPeek(task, viaKeyboard),
    onConsider: consider,
    enabled: !considered,
    // A seen safety-net row: a tap changes nothing, so it doesn't say "tap".
    considerable: !seenInNet,
  })
  const peekOpen = actions.peek?.id === task.id
  // TRY TOMORROW's mark (task queue PR 3; designer 10-19): a left-edge mark,
  // like the priority tab, on a "Today's pulls" row only. The row is NOT
  // lifted to the top — it keeps its place in the priority sort. The rollover
  // clears the flag once the row moves to "Previous pulls".
  const tryTomorrow = segmentHorizon === 'queue_today' && task.try_tomorrow
  // "Color task titles" (Settings → Priority Display): the reminder rows
  // beside it take the hue (2026-10-26), so this title does too — the 10-11
  // rule that the two read the same colour.
  const priorityTitle = usePriorityRowStyles(task.priority).title
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
        data-safety-net={row.safetyNet ? '' : undefined}
        data-seen={row.seen ? '' : undefined}
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
            : cn(
                !seenInNet && 'cursor-pointer',
                panel ? 'hover:bg-foreground/5' : 'hover:bg-foreground/[0.04]',
              ),
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
        <SegmentRowCircle
          task={task}
          considered={considered}
          seenInNet={seenInNet}
          panel={panel}
          onConsider={consider}
        />
        <div className="min-w-0 flex-1">
          {/* THE TITLE WRAPS AROUND THE BUTTONS (Trent, 2026-10-26, mock "B").
              The buttons float right INSIDE the title's column, so its first
              line or two sit beside them and every later line takes the
              row's whole width — they used to be the row's own flex column,
              which on a phone at the app's 119% text left the title 76px and
              one word a line. A float, so the buttons come first in the
              DOM; the meta line below is a flex box, which keeps clear of
              the float on its own. */}
          {!considered && (
            <div data-segment-actions className="float-right ml-2">
              <TaskSegmentRowActions
                row={row}
                actions={actions}
                timezone={timezone}
                panel={panel}
                segmentHorizon={segmentHorizon}
              />
            </div>
          )}
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
              priorityTitle,
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

/**
 * The row's left circle: "considered" (seen, never a completion). On the
 * deadlines page's SAFETY NET (2026-10-22) a seen row keeps waiting — seeing
 * does not silence it — so its circle is a green RING with the check, not the
 * filled considered circle: seen, still on the page, still nagging.
 */
function SegmentRowCircle({
  task,
  considered,
  seenInNet = false,
  panel,
  onConsider,
}: {
  task: Task
  considered: boolean
  seenInNet?: boolean
  panel: boolean
  onConsider: () => void
}) {
  if (seenInNet) {
    return (
      <span
        role="img"
        data-seen-ring
        aria-label={`"${task.title}" seen today — the deadline is close, so it stays`}
        title="Seen today · the deadline is close: only a target or done takes it off"
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full border-2 border-green-600 text-green-700 dark:border-green-500 dark:text-green-400',
          panel ? 'size-[19px]' : 'mt-[3px] size-6',
        )}
      >
        <Check className={panel ? 'size-3' : 'size-3.5'} strokeWidth={3} />
      </span>
    )
  }
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

/** A seen safety-net row's (a tap changes nothing there). */
export const ROW_PEEK_ONLY_DESCRIPTION =
  'Seen today; the deadline is close. Hold, right-click or press Command-Enter for details.'

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
 * the circle, On deck, On deck tomorrow, Today and the done square carry
 * `data-no-row-press` (On deck, On deck tomorrow and Today keep their own
 * holds and right-click menus), as on the dashboard row (`TaskRow`), and so does the Upcoming
 * target chip — and any button counts, so a control added later can't open
 * the bubble from a hold meant for it. Events from outside the row's DOM — a portalled menu or dialog one of its
 * controls opened, whose React events still bubble here — are ignored too.
 */
function useSegmentRowPress({
  onPeek,
  onConsider,
  enabled,
  considerable = true,
}: {
  onPeek: (viaKeyboard: boolean) => void
  onConsider: () => void
  enabled: boolean
  /** A tap still considers (not a seen safety-net row): the description says so. */
  considerable?: boolean
}) {
  const press = useLongPress({ onLongPress: enabled ? () => onPeek(false) : undefined })
  const isOwn = (e: React.SyntheticEvent<HTMLElement>) => {
    const target = e.target as Element
    return e.currentTarget.contains(target) && !target.closest('[data-no-row-press], button')
  }
  return {
    'aria-keyshortcuts': enabled ? 'Meta+Enter Control+Enter' : undefined,
    'aria-description': enabled
      ? considerable
        ? ROW_PEEK_DESCRIPTION
        : ROW_PEEK_ONLY_DESCRIPTION
      : undefined,
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
 * — On deck · On deck tomorrow · Today · checkbox with the queue on (spec
 * rule 8; each acts in one tap, for rapid-fire passes; On deck first since
 * Trent, 2026-10-21).
 *
 * On an UPCOMING row (2026-10-12) there is no horizon dot — a targeted task's
 * horizon decides nothing until the target is removed (spec §1).
 *
 * THE TASK QUEUE ON (PR 3, resolution 10): the horizon dot's place on EVERY
 * task-segment row — the queue's, the horizons' and Upcoming's — went to the
 * details icon (the pencil), and since 2026-10-20 to ON DECK TOMORROW
 * (`DeckTomorrowSlot`; second since 2026-10-21, after On deck): the details are now a hold on the row away (the
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
 *
 * COMPACT, IN PX (Trent, 2026-10-26, mock "B"): every size in the row's
 * button group is px, never rem, so the group stays 140px wide at any text
 * size — the iOS app scales the root font with Dynamic Type, and at 119% the
 * rem sizes made the group 200px and left the title a 76px column. 30px here
 * (32 before).
 */
const HOVER_BOX = { page: 'h-[30px]', panel: 'h-[26px]' } as const

/**
 * On deck's, On deck tomorrow's and Today's HIT TARGET: 34×44px, finger or
 * mouse — one rule (2026-10-26; before, 44px wide for a finger, in rem, and
 * only the hover box's width for a mouse). The negative margin lays it out
 * 22px tall, the done square's height: the group must be no taller than the
 * title's first line (24px), or the title's SECOND line wraps short beside
 * it too (it floats in the title's column); the 44px stands 11px above and
 * below.
 * Three of them, the 16px before the done square (12px of it dead space)
 * and its 22px: 140px.
 */
const CONTROL_HIT = '-my-[11px] h-[44px] min-w-[34px]'

/** On deck's hover box, and the empty slot's (`DeckSlotSpacer`). */
const DECK_BOX = {
  page: `${HOVER_BOX.page} w-[28px]`,
  panel: `${HOVER_BOX.panel} w-[26px]`,
} as const

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
  const dayStart = useDayStart()
  const showToday = segmentHorizon !== 'upcoming' || upcomingRowActions(row).today
  return (
    <div
      className={cn(
        // The hit targets abut; their own padding around each hover box is
        // the gap (finger or mouse, 2026-10-26).
        'flex shrink-0 items-center',
        // Down to the title's first line: by `top`, not a margin, which would
        // make the float taller than that line (see `CONTROL_HIT`).
        panel ? '-my-[4px]' : 'relative top-[4px]',
      )}
    >
      {/* On deck first, then On deck tomorrow (Trent, 2026-10-21): today's
          deck, the next day's, then Today. With the switch off On deck is
          absent and the horizon dot stands alone. */}
      <SegmentDeckSlot
        row={row}
        actions={actions}
        timezone={timezone}
        panel={panel}
        queueUi={queueUi}
      />
      {segmentHorizon === 'deadlines' ? (
        // The deadlines page (2026-10-22): Defer in On deck tomorrow's place —
        // both are "another day" — hidden in the safety net (the place kept).
        <DeferLeadSlot row={row} actions={actions} timezone={timezone} panel={panel} />
      ) : queueUi === 'on' ? (
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
      {showToday && (
        <TargetTodayButton
          task={task}
          timezone={timezone}
          onTargetToday={(t) => void actions.targetToday(t)}
          onTargetAt={(t, at) => void actions.targetAt(t, at)}
          // Faded on a decked row: a target takes it off deck (plan §5).
          replaces={todayReplaces(task, timezone, dayStart)}
          showLabel
          // A 34×44 hit target (`CONTROL_HIT`) around a glyph the size of the
          // done square; the negative margin keeps the row's height. The
          // `mr-[16px]` after it: 4px of it is the done square's own hit area
          // (its `after:` inset), and 12px is DEAD SPACE between the two hit
          // areas — Trent's own ruling after he mis-tapped Today for done
          // (2026-10-12; kept through the compact buttons). The grey hover
          // block is the inner box, the row buttons' (`HOVER_BOX`), so it
          // stays inside the row (2026-10-20). From `sm` up the box has room
          // for the word "Today" too (icon only on a phone, the word on a
          // desktop — Trent's ruling).
          className={`${CONTROL_HIT} mr-[16px]`}
          boxClassName={
            panel
              ? `${HOVER_BOX.panel} min-w-[26px] sm:px-1.5`
              : `${HOVER_BOX.page} min-w-[28px] sm:px-2`
          }
          iconClassName={panel ? 'size-[19px]' : 'size-[22px]'}
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
        // The square is drawn 22px (19 in a panel) and HIT 44px tall and 8px
        // wider (the `after:` box): a finger's target without a bigger square.
        className={cn(
          "group/done border-foreground/25 hover:border-foreground/60 hover:bg-foreground/5 relative flex shrink-0 cursor-pointer items-center justify-center rounded-[5px] border-[1.5px] transition-colors after:absolute after:-inset-x-[4px] after:content-['']",
          panel ? 'size-[19px] after:-inset-y-[13px]' : 'size-[22px] after:-inset-y-[11px]',
        )}
      >
        <Check
          className={cn(
            'group-hover/done:text-foreground/50 text-transparent transition-colors',
            panel ? 'size-[12px]' : 'size-[14px]',
          )}
          strokeWidth={3}
        />
      </button>
    </div>
  )
}

/**
 * ON DECK (D2, spec rule 8) on a segment row: the first of the row's
 * controls, before On deck tomorrow and Today (2026-10-21), with the task
 * queue on — on a one-off with a target the user picked FADED, asking before
 * it replaces that target (rule 1; plan §5, 2026-10-22). Repeating rows (queue waiting rows, Upcoming) have it
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
  // A row without the button keeps its place empty (Trent, 2026-10-20), so
  // the row's controls line up down the column. (Since 2026-10-22 every task
  // row has it; a picked target makes it faded — `replaces`.)
  if (!offersDeck(row.task)) return <DeckSlotSpacer panel={panel} empty />
  return (
    <OnDeckButton
      task={row.task}
      timezone={timezone}
      onDeck={(t, day) => void actions.deck(t, day)}
      replaces={deckReplaces(row.task, timezone)}
      // Lit for TODAY's deck only: tomorrow's lights On deck tomorrow
      // (`DeckTomorrowButton`), a later one neither (2026-10-27).
      litFor="today"
      // Icon only (Trent, 2026-10-20): the tooltip and the name say "On deck".
      className={CONTROL_HIT}
      boxClassName={panel ? DECK_BOX.panel : DECK_BOX.page}
      iconClassName={panel ? 'size-[18px]' : 'size-[20px]'}
    />
  )
}

/**
 * On deck tomorrow's HIT TARGET (the pencil's, which it took over, and the
 * empty place while the preferences load): `CONTROL_HIT`'s 34×44px, finger
 * or mouse (2026-10-26; 32px with a mouse and 44 with a finger before),
 * pulled back to the row's line height. The hover block is an inner box
 * (`HOVER_BOX`), so the taller hit target never paints outside the row.
 */
const SLOT_HIT = '-my-[11px] h-[44px] w-[34px] shrink-0'

/**
 * ON DECK TOMORROW (2026-10-20), in the pencil's place — second since
 * 2026-10-21, after On deck: one tap decks the task for tomorrow — the On
 * deck hold menu's own Tomorrow (`deckTomorrowDay` reads it from
 * `deckMenuDays`, so the two can never disagree), through the same
 * `actions.deck`: the same A1 refusals and toasts, the same Undo, and the row
 * leaves its panel like any action. Repeating rows too: it decks the current
 * occurrence for tomorrow, as On deck's Tomorrow does. On a one-off with a
 * target the user picked it is FADED and asks first (`deckReplaces`, plan §5,
 * 2026-10-22); a row it isn't offered on (`offersDeck`) keeps the place empty,
 * so the controls line up down the column.
 *
 * HOLD or RIGHT-CLICK (Trent, 2026-10-21): On deck's own day menu
 * (`DeckMenu` — Tomorrow, the next days, the check-in day, Pick a date…,
 * Remove while decked, deadline days greyed), the same gesture rule as On
 * deck's (`OnDeckButton`): the app's 400ms hold never also taps, a finger
 * that moves abandons it, and the tap acts on click.
 *
 * `data-no-row-press` and the stopped events: a press, hold or right-click
 * here is this button's, never the row's peek or consider. The wrapper stops
 * clicks and keys from the portalled menu reaching the row (whose click
 * considers); the pointerdown is not stopped (the panel pager's swipe).
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
  if (!offersDeck(row.task)) {
    return <span aria-hidden data-deck-tomorrow-empty className={SLOT_HIT} />
  }
  return <DeckTomorrowButton task={row.task} actions={actions} timezone={timezone} panel={panel} />
}

function DeckTomorrowButton({
  task,
  actions,
  timezone,
  panel,
}: {
  task: Task
  actions: TaskSegmentActions
  timezone: string
  panel: boolean
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const dayStart = useDayStart()
  // Until the browser knows the day start, the tap commits no day
  // (`deckTomorrowIfKnown`): midnight's tomorrow can be a day late.
  const dayKnown = useDayStartKnown()
  // A picked target this would replace (plan §5): faded, and it asks first.
  const replaces = deckReplaces(task, timezone)
  const [pending, setPending] = useState<string | null>(null)
  // Nothing to replace any more (the row changed under an open confirm): drop it.
  if (!replaces && pending) setPending(null)
  const act = (day: string | null) => {
    if (replaces && day !== null) setPending(day)
    else void actions.deck(task, day)
  }
  const tomorrow = deckTomorrowIfKnown(timezone, new Date(), dayStart, dayKnown)
  // LIT (2026-10-27, Trent): on deck for tomorrow — On deck's own active
  // state, its filled icon and teal (`DECK_LIT`), on the button that names
  // the day. A tap then takes it off deck, as a lit On deck does (one rule).
  const lit = tomorrow !== null && task.on_deck_day === tomorrow
  const press = useSimpleLongPress({
    onLongPress: () => setMenuOpen(true),
    onShortPress: () => {
      if (tomorrow !== null) act(lit ? null : tomorrow)
    },
    // The tap takes the row off its list (see `TargetTodayButton`).
    tapOn: 'click',
  })
  const button = (
    <button
      type="button"
      data-deck-tomorrow
      data-deck-tomorrow-active={lit ? '' : undefined}
      data-replaces={replaces ? '' : undefined}
      data-no-row-press
      onClick={(e) => {
        e.stopPropagation()
        press.onClick()
      }}
      onPointerDown={press.onPointerDown}
      onPointerUp={press.onPointerUp}
      onPointerLeave={press.onPointerLeave}
      onPointerMove={press.onPointerMove}
      onPointerCancel={press.onPointerCancel}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setMenuOpen(true)
      }}
      // The state is in aria-pressed; the name stays the same (On deck's).
      aria-pressed={lit}
      aria-label={`On deck tomorrow: “${task.title}” (hold for a day)`}
      title={
        replaces
          ? `On deck tomorrow — replaces ${replaces} · hold for a day`
          : lit
            ? 'On deck tomorrow · tap to take off · hold for a day'
            : 'On deck tomorrow · hold for a day'
      }
      className={cn(
        'group/deck-tomorrow relative flex cursor-pointer touch-manipulation items-center justify-center rounded-md transition-colors select-none [-webkit-touch-callout:none]',
        lit ? DECK_LIT : 'text-muted-foreground hover:text-foreground',
        replaces && 'opacity-45 hover:opacity-100',
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
          className={panel ? 'size-[18px]' : 'size-[20px]'}
          // On deck's `OnDeckIcon` weight beside it (`DeckFace`).
          strokeWidth={1.75}
          filled={lit}
        />
      </span>
    </button>
  )
  return (
    <span
      className="contents"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <DeckMenu
        task={task}
        timezone={timezone}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        onPick={act}
      >
        {replaces ? (
          <ReplaceConfirm
            open={pending !== null}
            onOpenChange={(open) => {
              if (!open) setPending(null)
            }}
            message={`Replaces ${replaces}`}
            confirmLabel="Deck"
            onConfirm={() => {
              if (pending) void actions.deck(task, pending)
            }}
          >
            {button}
          </ReplaceConfirm>
        ) : (
          button
        )}
      </DeckMenu>
    </span>
  )
}

/**
 * DEFER on a DEADLINES-PAGE row (2026-10-22, plan §3; A3: tap + pick), in On
 * deck tomorrow's place: a tap opens the day menu — tomorrow up to two days
 * before the deadline (`deferLeadDays`) — and the pick moves THIS instance's
 * lead day there (`actions.deferLead`); the row leaves until then. In the
 * SAFETY NET (from the day before the deadline) there is no Defer — only a
 * target or done takes the row off — and its place stays empty, so the
 * controls line up down the column; likewise when no day is left to pick.
 */
function DeferLeadSlot({
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
  const [open, setOpen] = useState(false)
  const { attemptsRolloverTime } = useTaskQueue()
  const { task } = row
  const days =
    row.safetyNet || !task.deadline_at
      ? []
      : deferLeadDays(task.deadline_at, timezone, new Date(), attemptsRolloverTime, task.lead_from)
  if (days.length === 0) {
    return <span aria-hidden data-defer-lead-empty className={SLOT_HIT} />
  }
  return (
    <span
      className="contents"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <OptionMenu
        open={open}
        onOpenChange={setOpen}
        title="Defer to"
        anchored
        options={days.map((d) => ({
          label: d.label,
          option: d.day,
          caption: d.caption,
          icon: <Forward />,
        }))}
        onSelect={(day) => {
          setOpen(false)
          void actions.deferLead(task, day)
        }}
      >
        <button
          type="button"
          data-defer-lead
          data-no-row-press
          onClick={(e) => {
            e.stopPropagation()
            setOpen(true)
          }}
          aria-label={`Defer “${task.title}” to a later day`}
          title="Defer · pick a day (up to two days before the deadline)"
          className={cn(
            'group/defer-lead text-muted-foreground hover:text-foreground relative flex cursor-pointer touch-manipulation items-center justify-center rounded-md transition-colors select-none [-webkit-touch-callout:none]',
            SLOT_HIT,
          )}
        >
          <span
            className={cn(
              'group-hover/defer-lead:bg-foreground/5 flex items-center justify-center rounded-md transition-colors',
              panel ? DECK_BOX.panel : DECK_BOX.page,
            )}
          >
            <Forward className={panel ? 'size-[18px]' : 'size-[20px]'} strokeWidth={1.75} />
          </span>
        </button>
      </OptionMenu>
    </span>
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
 * The second line, only when there is something to say: the project, the
 * DEADLINE right after it (`DeadlineChip`, 2026-10-22 — red passed, amber in
 * the safety net; after, so every row's project starts at the same x), a
 * future target date ("Nov 1") — a waiting repeating task's occurrence
 * instead (`queuedRepeatOccurrence`). Without either the row is one line, a
 * reminder row's height — the segment stays bite-size.
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
  const dayStart = useDayStart()
  const project = projects.find((p) => p.id === task.project_id)
  const priority = task.priority > 0 ? getPriorityOption(task.priority) : null
  // A repeating task waiting in the queue shows the occurrence it stands
  // for, not its moved target (`queuedRepeatOccurrence`, 2026-10-20).
  const queuedOccurrence = queueOn ? queuedRepeatOccurrence(task) : null
  const shownAt = queuedOccurrence ?? task.due_at
  const target = shownAt ? DateTime.fromISO(shownAt).setZone(timezone) : null
  // The dashboard row's context, compactly (Trent, 10-11): the project, the
  // deadline chip (2026-10-22), the priority and a future target.
  return (
    <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      {project && (
        <span data-segment-project className="inline-flex items-center gap-1">
          <FolderOpen className="size-3" aria-hidden />
          {project.name}
        </span>
      )}
      {/* The deadline chip right AFTER the project (Trent's 10-20 rule: every
          row's project starts at the same x), 2026-10-22. */}
      {task.deadline_at && <DeadlineChip deadlineAt={task.deadline_at} timezone={timezone} />}
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
          className="inline-flex items-center"
          title={`${queuedOccurrence ? '' : 'Target '}${target.toFormat('ccc LLL d, h:mm a')}`}
        >
          {/* A target is a time chip (`TimeChip`, 2026-10-28); the occurrence
              a waiting repeat stands for is not a target, so it stays text. */}
          {queuedOccurrence ? (
            target.toFormat('LLL d')
          ) : (
            <TimeChip tone="target">{target.toFormat('LLL d')}</TimeChip>
          )}
          {task.rrule && (
            <span className="text-muted-foreground">
              {' · '}
              {recurrenceSummary(task.rrule, task.anchor_time)}
            </span>
          )}
        </span>
      )}
      {/* The deadlines page (2026-10-22): a decked row stays on the page —
          it says its deck day. */}
      {segmentHorizon === 'deadlines' && task.on_deck_day && (
        <span data-deck-day-chip className="text-foreground/70 font-medium">
          {deckChipWords(task.on_deck_day, timezone, dayStart)}
        </span>
      )}
      {/* No badges on a queue row (designer, 10-19) — neither attempts nor
          age: the queue is read at a glance. A waiting repeating task keeps a
          target (its next occurrence) and its count, so it would read "226×". */}
      {!isQueueKind(segmentHorizon) && <BadgeChips task={task} timezone={timezone} />}
      <SegmentLabels task={task} />
    </div>
  )
}

/** "On deck Sat" / "On deck today" for a deck day (yyyy-MM-dd). */
function deckChipWords(day: string, timezone: string, dayStart: string): string {
  return todayReplaces({ on_deck_day: day }, timezone, dayStart) ?? 'On deck'
}

/**
 * The task's labels on a segment row's meta line (Trent's phone review,
 * 2026-10-22), with the dashboard row's chips (`LabelBadges`: two, then
 * "+N"), LAST on the line. A chip is never cut (Trent, 2026-10-24 — this
 * replaces 10-22's "clipped into what the line has left, so the row never
 * grows"): the meta line is `flex-wrap`, so the chips move whole to a second
 * meta line when they don't fit, exactly as on the dashboard's `TaskRow`
 * (its indicators line). The row's controls are top-aligned (`items-start`),
 * so a taller row leaves them where they are. Nothing when the task has none
 * to show. `-my-px`: a chip is 18px (its 1px border), the line 16px — the
 * chips overhang by a pixel each side rather than grow a one-line row.
 */
function SegmentLabels({ task }: { task: Task }) {
  const { labelConfig } = useLabelConfig()
  if (!task.labels.some((l) => l !== 'ai-to-process')) return null
  return <LabelBadges labels={task.labels} labelConfig={labelConfig} className="-my-px" />
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
          title={`Overdue on ${attempts} day${attempts === 1 ? '' : 's'}`}
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
 * An UPCOMING row's second line (2026-10-12, spec §2): the project, the
 * deadline chip (2026-10-22), the priority, then "Target Tue Nov 3" — on a
 * TOMORROW row (2026-10-25, the Upcoming split) just the time, "Target 9:00
 * AM": its section already says the day (`upcomingGap`) — but a deck, which
 * has no time, says "On deck tomorrow" (2026-10-27). A
 * target-less deadline task is never in Upcoming since rule 3 (2026-10-25:
 * the deadlines page alone holds it), so the "on the deadlines page from …"
 * hand-off it used to carry is gone. The "Target …" part is a chip that opens a one-item menu
 * (`targetReset`): "Remove target" — back to its horizon segment, or, with a
 * deadline (2026-10-22, it replaced "Back to auto"), onto the deadlines page
 * from its lead day. Undo on the toast. A repeating row's chip names its schedule ("every Wed", `recurrenceSummary`, the widget's words) and does nothing.
 * `readOnly` (the row's peek bubble): the same words, the chip a plain label.
 */
/** A target's chip words: `upcomingGap`'s "Target 9:00 AM" without the word (the chip says it). */
function chipWords(words: string): string {
  const time = words.replace(/^Target /, '')
  return time.charAt(0).toUpperCase() + time.slice(1)
}

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
  const dayStart = useDayStart()
  const gap = upcomingGap(task, timezone, dayStart, row.section)
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
      {/* The deadline chip right AFTER the project (Trent's 10-20 rule: every
          row's project starts at the same x), 2026-10-22. */}
      {task.deadline_at && <DeadlineChip deadlineAt={task.deadline_at} timezone={timezone} />}
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
              // A picked target's time chip (`TimeChip`), the menu's chevron
              // inside it (only a picked one-off has the menu).
              className={timeChipClasses(
                'target',
                'transition-opacity hover:opacity-80 data-[state=open]:opacity-80',
              )}
            >
              {chipWords(gap.target)}
              <ChevronDown className="size-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuItem data-remove-target onSelect={() => void actions.removeTarget(task)}>
                {REMOVE_TARGET}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <span data-target-chip className="text-foreground/70 inline-flex items-center">
            {/* A target is a time chip; a deck's words ("On deck tomorrow")
                are not a time, and stay text. */}
            {task.on_deck_day ? (
              gap.target
            ) : (
              <TimeChip tone="target">{chipWords(gap.target)}</TimeChip>
            )}
            {row.recurring && task.rrule && (
              <span className="text-muted-foreground">
                {' · '}
                {recurrenceSummary(task.rrule, task.anchor_time)}
              </span>
            )}
          </span>
        ))}
      <BadgeChips task={task} timezone={timezone} />
      <SegmentLabels task={task} />
    </div>
  )
}

/**
 * The horizon, visible and changeable (spec §3), in the editor
 * (`ThisOneFields`): its word and a chevron, opening the shared horizon menu
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

/** How a row that left its segment today was handled, after its title. */
const LEFT_WORDS: Record<Exclude<SegmentLeft, 'considered' | 'deferred'>, string> = {
  done: 'done',
  deck: 'on deck',
  target: 'targeted',
}

/**
 * The words for a row that left today: "done", "on deck", "targeted", or —
 * the deadlines page's Defer (2026-10-22) — "deferred to Thu" (its lead day).
 */
function leftWords(left: Exclude<SegmentLeft, 'considered'>, task: Task): string {
  if (left !== 'deferred') return LEFT_WORDS[left]
  const day = task.lead_from ? DateTime.fromISO(task.lead_from) : null
  return day?.isValid ? `deferred to ${day.toFormat('ccc')}` : 'deferred'
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
  const { task, state, left } = row
  const timezone = useTimezone()
  const dayStart = useDayStart()
  const circle = cn(
    'flex shrink-0 items-center justify-center rounded-full bg-green-600 text-white',
    panel ? 'size-[19px]' : 'mt-[3px] size-6',
  )
  return (
    <li
      data-considered-task-id={task.id}
      data-segment-left={left}
      className={cn(
        'flex items-start rounded-xl border border-transparent',
        panel ? 'gap-2.5 px-1 py-1.5' : 'gap-3 px-2 py-2.5',
      )}
    >
      {left ? (
        // Left the segment handled (the day roster): no put-back — a consider
        // stamp is all put-back clears, and this row's way back is the toast's
        // Undo. A plain filled circle, the same place and size.
        <span className={circle} aria-hidden>
          <Check className={panel ? 'size-3' : 'size-3.5'} strokeWidth={3} />
        </span>
      ) : (
        <button
          type="button"
          onClick={() => onPutBack(task)}
          aria-label={`Put back "${task.title}"`}
          title="Put back"
          className={cn(circle, 'transition-colors hover:bg-green-600/50')}
        >
          <Check className={panel ? 'size-3' : 'size-3.5'} strokeWidth={3} />
        </button>
      )}
      <p
        className={cn(
          'text-muted-foreground min-w-0 flex-1 text-pretty',
          panel ? 'text-[13.5px] leading-[1.42]' : 'text-[16px] leading-6',
        )}
      >
        {task.title}
        {state === 'deferred' && <span className="ml-1.5 text-xs">· deferred</span>}
        {/* A deadlines-page row decked for a later day: considered today,
            still on the page — it says its deck day (2026-10-22). */}
        {!left && task.on_deck_day && (
          <span data-considered-deck className="ml-1.5 text-xs">
            · {deckChipWords(task.on_deck_day, timezone, dayStart).replace('On deck', 'on deck')}
          </span>
        )}
        {left && left !== 'considered' && (
          <span className="ml-1.5 text-xs">· {leftWords(left, task)}</span>
        )}
      </p>
    </li>
  )
}
